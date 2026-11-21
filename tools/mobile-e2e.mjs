// Android 客户端端到端验证：本地 relay + 假隧道 + 模拟 DSH，驱动真机/模拟器里的 App。
//
//   adb devices                       # 需要一台已启动的 Android 设备/模拟器
//   node tools/mobile-e2e.mjs         # 默认包名 tech.xiaoniu.dsh2phone
//
// 验证链路：
//   1. App 内深链进入配对确认页；
//   2. 原生 HTTPS/HTTP 请求 /pair 拿到 dshdev + 假 DSH cookie；
//   3. Relay 的 PC 确认由脚本自动批准（模拟电脑端）；
//   4. WebView 先开入口页、再进 /dsh/，假隧道返回 "DSH E2E OK"。
//
// 这是本地验证工具，不访问生产环境，也不会在真实设备白名单里留下条目（结束前 panic）。
//
// 注意：所有 adb 调用必须是异步（execFile）。脚本同时扮演“假隧道”，relay 每 25s
// ping 一次、10s 没等到 pong 就踢链路；spawnSync 会阻塞事件循环导致 pong 迟到，
// 表现为偶发 "tunnel dropped: pong timeout" → 配对 503。
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const execFileP = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const APP_ID = process.env.MOBILE_APP_ID ?? "tech.xiaoniu.dsh2phone";
const ACTIVITY = `${APP_ID}/.MainActivity`;
const KEY = "mobile-e2e-key";
const DATA_PORT = 13200;
const CONTROL_PORT = 13201;
const STATE_DIR = join(root, ".mobile-e2e-state");
const DIST_DIR = join(root, "mobile", "dist");
const RELAY_URL = `ws://127.0.0.1:${CONTROL_PORT}/tunnel`;
// MOBILE_E2E_LAN=1：额外起一个真 LAN 直连边缘（复用 tunnel/src/lan-edge.mjs），
// 并让假隧道通告 10.0.2.2（模拟器到宿主机 loopback），验证 App 真正走直连。
const LAN_MODE = process.env.MOBILE_E2E_LAN === "1";
const LAN_PORT = 13220;
const EDGE_DSH_PORT = 13400;
const E2E_DEVICE_ID = "e2e0000000000001";
const PAGE_BODY = process.env.MOBILE_E2E_DARK === "1"
  ? 'style="background:#141518;color:#e8eaed"'
  : "";
const THEME_CHANGE_SCRIPT = process.env.MOBILE_E2E_THEME_CHANGE === "1"
  ? `<script>setTimeout(function(){document.body.style.background='#141518';document.body.style.color='#e8eaed';},1500);</script>`
  : "";
const DSH_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>DSH E2E OK</title></head>
<body ${PAGE_BODY}><h1>DSH E2E OK</h1><p id="cookies">webview reached the mock DSH</p>
<input id="test-input" autofocus placeholder="autofocus test"
  style="position:fixed;top:16px;left:16px;right:16px;height:56px;font-size:20px;padding:8px;z-index:9999">
<div id="select-text" style="position:fixed;top:300px;left:20px;right:20px;font-size:24px">Long press to select this sentence</div>
<button id="send-test" style="position:fixed;top:600px;left:20px;width:260px;height:70px;font-size:22px">Send test</button>
<div style="position:fixed;left:0;right:0;bottom:0;height:56px;background:#ffcc00;color:#000;font:20px sans-serif;text-align:center;line-height:56px">BOTTOM</div>
${THEME_CHANGE_SCRIPT}
</body></html>`;

let relay;
let tunnel;
let admin;
let dshCookieHeader = "";
let dshPageRequests = 0;
let lanEdgeCtl = null;
let edgeDsh = null;
let lanRequests = 0;
let lanCookieHeader = "";

function log(message) {
  console.log(`[mobile-e2e] ${message}`);
}

function fail(message, error) {
  console.error(`MOBILE E2E FAIL: ${message}`, error?.message ?? error ?? "");
  cleanup();
  process.exit(1);
}

/** 异步 adb（绝不阻塞事件循环：本脚本同时扮演假隧道，见文件头说明）。 */
async function adb(args) {
  const { stdout } = await execFileP("adb", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return stdout ?? "";
}

async function waitFor(check, { timeoutMs = 30_000, intervalMs = 700, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? ` (${lastError.message})` : ""}`);
}

function openWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    const timer = setTimeout(() => reject(new Error("websocket open timeout")), 8000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(new Error(`websocket error: ${event.message ?? "unknown"}`));
    });
  });
}

function nextJson(ws, predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("websocket message timeout"));
    }, timeoutMs);
    function onMessage(event) {
      if (typeof event.data !== "string") return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(msg);
    }
    ws.addEventListener("message", onMessage);
  });
}

async function startRelay() {
  rmSync(STATE_DIR, { recursive: true, force: true });
  relay = spawn(process.execPath, [join(root, "relay", "src", "relay.mjs")], {
    env: {
      ...process.env,
      RELAY_DATA_PORT: String(DATA_PORT),
      RELAY_CONTROL_PORT: String(CONTROL_PORT),
      DSH_TUNNEL_KEY: KEY,
      RELAY_STATE_DIR: STATE_DIR,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ready;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  relay.stdout.on("data", (chunk) => {
    const text = String(chunk);
    if (text.includes("[relay]")) process.stdout.write(`[relay] ${text}`);
    if (text.includes("control on")) ready();
  });
  relay.stderr.on("data", (chunk) => process.stderr.write(`[relay!] ${chunk}`));
  relay.on("exit", (code, signal) => log(`relay exited code=${code} signal=${signal}`));
  await Promise.race([
    readyPromise,
    sleep(10_000).then(() => Promise.reject(new Error("relay start timeout"))),
  ]);
  log(`relay started on ${DATA_PORT}/${CONTROL_PORT}`);
}

async function connectTunnel() {
  tunnel = await openWs();
  tunnel.binaryType = "arraybuffer";
  tunnel.addEventListener("message", onTunnelMessage);
  tunnel.addEventListener("close", () => log("fake tunnel websocket closed"));
  const hello = nextJson(tunnel, (m) => m.t === "hello.ok", 8000);
  tunnel.send(JSON.stringify({ t: "hello", key: KEY }));
  await hello;
  log("fake tunnel online");
}

function onTunnelMessage(event) {
  if (typeof event.data === "string") {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.t === "open") {
      streams.set(msg.id, { buffer: Buffer.alloc(0), answered: false });
    } else if (msg.t === "close") {
      streams.delete(msg.id);
    }
    return;
  }
  const data = Buffer.from(event.data);
  if (data.length < 4) return;
  const id = data.readUInt32BE(0);
  const stream = streams.get(id);
  if (!stream) return;
  stream.buffer = Buffer.concat([stream.buffer, data.subarray(4)]);
  const headEnd = stream.buffer.indexOf("\r\n\r\n");
  if (headEnd === -1 || stream.answered) return;
  stream.answered = true;
  const header = stream.buffer.subarray(0, headEnd).toString("latin1");
  const requestLine = header.split("\r\n")[0] ?? "";
  log(`fake DSH request: ${requestLine}`);
  if (requestLine.includes("/dsh/")) {
    dshCookieHeader = header;
    dshPageRequests++;
  }
  const body = Buffer.from(DSH_HTML, "utf8");
  const response = Buffer.concat([
    Buffer.from(
      `HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n` +
      `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
      "latin1",
    ),
    body,
  ]);
  const frame = Buffer.alloc(4);
  frame.writeUInt32BE(id, 0);
  tunnel.send(Buffer.concat([frame, response]));
  // 给 relay 一点时间把数据写回 socket，再发 close。
  setTimeout(() => {
    try {
      if (tunnel.readyState === 1) tunnel.send(JSON.stringify({ t: "close", id }));
    } catch { /* ignore */ }
    streams.delete(id);
  }, 30);
}

const streams = new Map();

async function startAdmin() {
  admin = await openWs();
  admin.addEventListener("close", () => log("admin websocket closed"));
  const hello = nextJson(admin, (m) => m.t === "hello.ok", 8000);
  admin.send(JSON.stringify({ t: "hello", key: KEY, mode: "admin" }));
  await hello;
  const sessionPromise = nextJson(admin, (m) => m.t === "pair.session", 8000);
  admin.send(JSON.stringify({ t: "pair.start" }));
  const session = await sessionPromise;
  log(`pair code: ${session.code}`);
  return session.code;
}

function autoApprove() {
  admin.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.t !== "pair.request") return;
    log(`pair.request from ${msg.ua ?? "?"} (${msg.ip ?? "?"}) -> approve`);
    admin.send(JSON.stringify({
      t: "pair.response",
      reqId: msg.reqId,
      approved: true,
      device: { id: "e2e0000000000001", name: "E2E Phone" },
      dshCookie: "dsh-auth-e2e=v1.e2e; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict",
    }));
  });
}

async function dumpUi() {
  let lastError;
  for (let i = 0; i < 3; i++) {
    try {
      await adb(["shell", "uiautomator", "dump", "/sdcard/mobile-e2e.xml"]);
      return await adb(["shell", "cat", "/sdcard/mobile-e2e.xml"]);
    } catch (error) {
      lastError = error;
      await sleep(400);
    }
  }
  throw lastError;
}

async function clickText(texts, timeoutMs = 15_000) {
  return waitFor(async () => {
    const xml = await dumpUi();
    for (const text of texts) {
      const needle = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`text="${needle}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`);
      const match = xml.match(re);
      if (!match) continue;
      const x = Math.round((Number(match[1]) + Number(match[3])) / 2);
      const y = Math.round((Number(match[2]) + Number(match[4])) / 2);
      await adb(["shell", "input", "tap", String(x), String(y)]);
      log(`tapped "${text}" at ${x},${y}`);
      return true;
    }
    return false;
  }, { timeoutMs, label: `UI text ${texts.join("/")}` });
}

async function waitForText(texts, timeoutMs = 20_000) {
  return waitFor(async () => {
    const xml = await dumpUi();
    for (const text of texts) {
      if (xml.includes(`text="${text}`)) return true;
      // WebView 可能只把标题暴露为 content-desc。
      if (xml.includes(`content-desc="${text}`)) return true;
    }
    return false;
  }, { timeoutMs, label: `UI text ${texts.join("/")}` });
}

async function imeShown() {
  const dump = await adb(["shell", "dumpsys", "input_method"]);
  const match = dump.match(/mInputShown=(true|false)/);
  return match ? match[1] : "unknown";
}

async function textBounds(xml, text) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`text="${escaped}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`));
  if (!match) return null;
  return { x1: Number(match[1]), y1: Number(match[2]), x2: Number(match[3]), y2: Number(match[4]) };
}

async function webViewBounds(xml) {
  const match = xml.match(/resource-id="tech\.xiaoniu\.dsh2phone:id\/webView"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!match) return null;
  const x1 = Number(match[1]);
  const y1 = Number(match[2]);
  const x2 = Number(match[3]);
  const y2 = Number(match[4]);
  return { x1, y1, x2, y2, width: x2 - x1, height: y2 - y1 };
}

async function screenshot(name) {
  mkdirSync(DIST_DIR, { recursive: true });
  try {
    const { stdout } = await execFileP("adb", ["exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(join(DIST_DIR, name), stdout);
    log(`screenshot: mobile/dist/${name}`);
  } catch { /* 截图失败不阻断流程 */ }
}

function cleanup() {
  try {
    if (admin?.readyState === 1) {
      admin.send(JSON.stringify({ t: "devices.panic" }));
      admin.close();
    }
  } catch { /* ignore */ }
  try { tunnel?.close(); } catch { /* ignore */ }
  try { relay?.kill(); } catch { /* ignore */ }
  try { lanEdgeCtl?.close(); } catch { /* ignore */ }
  try { edgeDsh?.close(); } catch { /* ignore */ }
}

/** LAN 直连夹具：宿主机上起真边缘 + 假 DSH，经假隧道通告给 relay/App。 */
async function startLanFixture() {
  edgeDsh = http.createServer((req, res) => {
    lanCookieHeader = req.headers.cookie ?? "";
    lanRequests++;
    const body = Buffer.from(DSH_HTML, "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": body.length });
    res.end(body);
  });
  await new Promise((resolve, reject) => {
    edgeDsh.once("error", reject);
    edgeDsh.listen(EDGE_DSH_PORT, "127.0.0.1", resolve);
  });
  const { startLanEdge } = await import(pathToFileURL(join(root, "tunnel", "src", "lan-edge.mjs")).href);
  lanEdgeCtl = await startLanEdge({
    port: LAN_PORT,
    upstreamHost: "127.0.0.1",
    upstreamPort: EDGE_DSH_PORT,
    authority: "127.0.0.1:43120",
    stateDir: STATE_DIR,
    gateDevice: (cookieHeader) => {
      // 与 relay 相同的 dshdev 校验（HMAC 用同一个 KEY），但只认 e2e 设备。
      if (typeof cookieHeader !== "string") return "unknown";
      for (const segment of cookieHeader.split(";")) {
        const at = segment.indexOf("=");
        if (at === -1 || segment.slice(0, at).trim() !== "dshdev") continue;
        const value = segment.slice(at + 1).trim();
        const dot = value.lastIndexOf(".");
        if (dot === -1) return "unknown";
        const id = value.slice(0, dot);
        const sig = value.slice(dot + 1);
        const expected = createHmac("sha256", KEY).update(id).digest().toString("base64url");
        return id === E2E_DEVICE_ID && expected === sig ? "ok" : "unknown";
      }
      return "unknown";
    },
    log: (...args) => console.log("[lan-edge]", ...args),
  });
  const info = lanEdgeCtl.info();
  if (!info) fail("lan fixture", new Error("LAN edge has no private address"));
  tunnel.send(JSON.stringify({
    t: "lan.announce",
    lan: { port: info.port, fp: info.fp, ips: ["10.0.2.2"] },
  }));
  log(`lan fixture: edge on :${info.port}, announced 10.0.2.2:${info.port} fp=${info.fp.slice(0, 12)}…`);
}

async function reportFailure() {
  try {
    console.error("--- app logcat ---");
    console.error((await adb(["logcat", "-d", "-s", "Dsh2PhoneWeb:D", "Dsh2PhonePair:D", "AndroidRuntime:E", "*:S"])).slice(-6000));
    console.error("--- ui dump ---");
    const dump = await dumpUi();
    console.error(dump.slice(0, 5000));
  } catch { /* ignore diagnostics */ }
}

async function main() {
  mkdirSync(DIST_DIR, { recursive: true });
  const adbOut = await adb(["devices"]);
  if (!adbOut.split(/\r?\n/).some((line) => line.includes("\tdevice"))) {
    fail("no Android device/emulator connected");
  }

  await adb(["shell", "pm", "clear", APP_ID]);
  await adb(["shell", "am", "force-stop", APP_ID]);
  await adb(["logcat", "-c"]);
  await startRelay();
  await connectTunnel();
  if (LAN_MODE) await startLanFixture();
  const code = await startAdmin();
  autoApprove();

  const pairUrl = `http://10.0.2.2:${DATA_PORT}/pair?code=${code}`;
  const deepLink = `dsh2phone://pair?url=${encodeURIComponent(pairUrl)}`;
  await adb(["shell", "am", "force-stop", APP_ID]);
  await sleep(500);
  const startOutput = await adb([
    "shell", "am", "start", "-n", ACTIVITY,
    "-a", "android.intent.action.VIEW", "-d", deepLink,
  ]);
  log(`app launch: ${startOutput.trim()}`);
  await screenshot("e2e-01-home.png");

  // Android 12+ 对未验证深链会先弹系统确认；这里同时兼容直接进入 App。
  await sleep(1200);
  const first = await dumpUi();
  if (first.includes("Open with") || first.includes("打开方式")) {
    await clickText(["DSH 随身", "DSH Pocket"]);
  }

  await waitForText(["Pair with", "配对到"], 20_000);
  await clickText(["Start pairing", "开始配对"], 20_000);
  await screenshot("e2e-02-pairing.png");
  await waitForText(["Paired successfully", "配对成功"], 30_000);
  await screenshot("e2e-03-paired.png");
  await sleep(400);
  await clickText(["Open DSH", "进入 DSH"]);
  await waitFor(async () => {
    const logs = await adb(["logcat", "-d", "-s", "Dsh2PhoneWeb:D", "*:S"]);
    return logs.includes("DSH E2E OK");
  }, { timeoutMs: 30_000, label: "WebView reached mock DSH" });
  if (!LAN_MODE && (!dshCookieHeader.includes("dshdev=") || !dshCookieHeader.includes("dsh-auth-e2e="))) {
    fail("WebView reached /dsh/ but cookies were not sent");
  }
  log("WebView sent dshdev + dsh-auth-e2e cookies to /dsh/");
  await sleep(800);
  await screenshot("e2e-04-webview.png");

  if (LAN_MODE) {
    if (lanRequests === 0) fail("lan direct", new Error("WebView never used the LAN direct edge"));
    if (!lanCookieHeader.includes("dshdev=") || !lanCookieHeader.includes("dsh-auth-e2e=")) {
      fail("lan direct", new Error("LAN edge request was missing cookies"));
    }
    await screenshot("e2e-lan-direct.png");
    log(`LAN DIRECT VERIFIED: ${lanRequests} request(s) through the pinned edge (cookies ok)`);
  }

  if (process.env.MOBILE_E2E_THEME_CHANGE === "1") {
    await sleep(2500);
    await screenshot("theme-change.png");
    log("theme-change screenshot captured");
  }

  if (process.env.MOBILE_E2E_SELECTION === "1") {
    await sleep(800);
    const bounds = await textBounds(await dumpUi(), "Long press to select this sentence");
    const x = bounds ? Math.round((bounds.x1 + bounds.x2) / 2) : 300;
    const y = bounds ? Math.round((bounds.y1 + bounds.y2) / 2) : 500;
    await adb(["shell", "input", "swipe", String(x), String(y), String(x), String(y), "1200"]);
    await sleep(1000);
    const xml = await dumpUi();
    const selected = /Copy|复制|Select all|全选/.test(xml);
    log(`selection action mode after long press: ${selected} at ${x},${y}`);
    await screenshot("selection-test.png");
    await adb(["shell", "input", "keyevent", "4"]);
    if (!selected) {
      // WebView 的文本选择浮层画在 WebView surface 里，uiautomator 有时拿不到节点；
      // 以 selection-test.png 人工确认为准，不在这里硬失败。
      log("selection toolbar not exposed to uiautomator; check selection-test.png");
    }
  }

  if (process.env.MOBILE_E2E_IME === "1") {
    await sleep(2500);
    const imeBefore = await imeShown();
    const before = await webViewBounds(await dumpUi());
    await screenshot("ime-before.png");
    // 输入框固定在页面顶部，直接点它；点不到再走文本查找。
    await adb(["shell", "input", "tap", "400", "220"]);
    await sleep(1200);
    const imeAfter = await imeShown();
    const after = await webViewBounds(await dumpUi());
    await screenshot("ime-after.png");
    log(`IME before=${imeBefore} after=${imeAfter} webBefore=${before} webAfter=${after}`);
    if (imeBefore === "true") fail("soft keyboard was shown on entering the session");
    if (imeAfter !== "true") fail("soft keyboard did not appear after tapping the input");
    if (before && after && before.height === after.height) {
      fail("WebView did not resize when the IME opened");
    }
    // 点击页面里的“发送”按钮（短 click），应自动收起键盘。
    await clickText(["Send test"], 5000);
    await sleep(700);
    const imeAfterSend = await imeShown();
    log(`IME after send=${imeAfterSend}`);
    if (imeAfterSend !== "false") fail("soft keyboard was not hidden after sending");
    await screenshot("ime-after-send.png");
  }

  if (process.env.MOBILE_E2E_REENTRY === "1") {
    const before = dshPageRequests;
    await adb(["shell", "input", "keyevent", "4"]);
    await sleep(1000);
    await clickText(["Open DSH", "进入 DSH"]);
    await sleep(1500);
    const after = dshPageRequests;
    log(`re-entry /dsh/ requests ${before} -> ${after}`);
    await screenshot("e2e-reentry.png");
    if (after !== before) fail("re-entry reloaded /dsh/ instead of reusing the WebView");
  }

  await adb(["shell", "input", "keyevent", "4"]);
  await sleep(1200);
  await screenshot("e2e-05-home-paired.png");
  log("SMOKE PASS: native pairing + cookie injection + WebView entry verified");
}

try {
  await main();
  cleanup();
  process.exit(0);
} catch (error) {
  await reportFailure();
  fail("unexpected error", error);
}
