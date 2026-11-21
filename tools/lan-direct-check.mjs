// LAN direct end-to-end check: local relay + fake DSH + REAL tunnel with the
// LAN edge, driven like the phone App would.
//
//   node tools/lan-direct-check.mjs
//
// 链路（全部本地，不碰生产）：
//   1. relay(13200/13201, key=lan-check-key)，注册表预置一台 allow 设备；
//   2. 假 DSH(13400) 回显 Host/Origin/Cookie；
//   3. 真 tunnel（run 模式）连 relay，UPSTREAM 指向假 DSH，LAN 端口 13220；
//   4. 模拟手机：relay /dsh-lan 查询 → hello 探活（校验通告指纹）→ 直连加载
//      /dsh/（校验 Host 重写 / Origin 剥离 / cookie 透传）→ WS upgrade 穿透；
//   5. deny 设备 → 直连立即 403（白名单广播实时性）；allow 恢复 → 200；
//   6. 无 cookie / 伪造签名 → 403。
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const KEY = "lan-check-key";
const DATA_PORT = 13200;
const CONTROL_PORT = 13201;
const LAN_PORT = 13220;
const DSH_PORT = 13400;
const AUTHORITY = "127.0.0.1:43120";
const STATE_DIR = join(root, ".lan-check-state");
const DEVICE_ID = "landevice0001";
const DEVICE_COOKIE = `${DEVICE_ID}.${createHmac("sha256", KEY).update(DEVICE_ID).digest("base64url")}`;

let relay = null;
let tunnel = null;
let fakeDsh = null;

function log(...args) {
  console.log("[lan-check]", ...args);
}

function fail(label, err) {
  console.error(`LAN CHECK FAIL [${label}]`, err?.message ?? err);
  cleanup();
  process.exit(1);
}

function cleanup() {
  try { tunnel?.kill(); } catch { /* ignore */ }
  try { relay?.kill(); } catch { /* ignore */ }
  try { fakeDsh?.close(); } catch { /* ignore */ }
}

function assert(cond, label) {
  if (!cond) fail(label, new Error("assertion failed"));
  log(`ok: ${label}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// ---------- fake DSH: echo Host / Origin / Cookie so we can verify rewrites ----------
function startFakeDsh() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const html = `<!doctype html><html><head><title>FAKE DSH</title></head><body>` +
        `<p id="host">${escapeHtml(req.headers.host ?? "")}</p>` +
        `<p id="origin">${req.headers.origin ? escapeHtml(req.headers.origin) : "absent"}</p>` +
        `<p id="cookie">${escapeHtml(req.headers.cookie ?? "")}</p>` +
        `<p id="url">${escapeHtml(req.url)}</p>` +
        `<p id="body-len">${body.length}</p></body></html>`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
  });
  // 接受任意 upgrade 并回显一小段数据，验证直连边缘的 WS 管道是双向通的。
  server.on("upgrade", (req, socket, head) => {
    const key = req.headers["sec-websocket-key"] ?? "";
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write("pong-from-dsh");
    socket.on("error", () => socket.destroy());
    if (head?.length) socket.write(head);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(DSH_PORT, "127.0.0.1", () => resolve(server));
  });
}

/** TCP 端口可连接轮询（替代读子进程日志：沙箱禁止管道捕获，子进程用 stdio inherit）。 */
function waitPort(port, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error(`port ${port} not reachable within ${timeoutMs}ms`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

// ---------- HTTP(S) helpers（不用 fetch：需要精确控制原始头 / 忽略自签证书） ----------
/** 明文 HTTP（relay 数据面本地端口就是明文）。 */
function httpRequest({ port, path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ statusLine: `HTTP/1.1 ${res.statusCode}`, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** TLS（直连边缘；自签证书所以默认跳过校验）。 */
function tlsRequest({ port, path, headers = {}, rejectUnauthorized = false }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized }, () => {
      const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: close", "Accept: */*"];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      socket.write(lines.join("\r\n") + "\r\n\r\n");
    });
    socket.setNoDelay(true);
    const chunks = [];
    socket.on("data", (c) => chunks.push(c));
    socket.on("end", () => {
      const raw = Buffer.concat(chunks);
      const split = raw.indexOf("\r\n\r\n");
      resolve({
        statusLine: raw.subarray(0, raw.indexOf("\r\n")).toString(),
        headers: raw.subarray(0, split).toString(),
        body: raw.subarray(split + 4).toString("utf8"),
        raw,
      });
    });
    socket.on("error", reject);
  });
}

function upgradeRequest({ port, path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      const key = createHash("sha1").update(String(Math.random())).digest("base64");
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "Origin: https://lan-check.example",
      ];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      socket.write(lines.join("\r\n") + "\r\n\r\n");
    });
    let buffer = Buffer.alloc(0);
    socket.on("data", (c) => {
      buffer = Buffer.concat([buffer, c]);
      if (buffer.includes("pong-from-dsh")) {
        socket.destroy();
        resolve(buffer.toString("latin1"));
      }
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error(`upgrade timeout, got: ${buffer.toString("latin1").slice(0, 200)}`)), 8000);
  });
}

/** 服务端叶子证书的 DER（与 App 端一致地自己算 SHA-256，而不是用 node 的 fingerprint256）。 */
function peerRawCert(port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (cert?.raw) resolve(cert.raw);
      else reject(new Error("no raw certificate from peer"));
    });
    socket.on("error", reject);
  });
}

async function main() {
  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(STATE_DIR, { recursive: true });
  // 预置注册表：relay 启动时加载（与生产 state/devices.json 同格式）。
  writeFileSync(join(STATE_DIR, "devices.json"), JSON.stringify({
    version: 1,
    devices: [{ id: DEVICE_ID, name: "LAN Check Device", ua: "lan-check", status: "allow", createdAt: Date.now(), lastSeen: 0, lastIp: "203.0.113.9" }],
  }, null, 2));

  fakeDsh = await startFakeDsh();
  log(`fake DSH on :${DSH_PORT}`);

  relay = spawn(process.execPath, [join(root, "relay/src/relay.mjs")], {
    env: {
      ...process.env,
      RELAY_DATA_PORT: String(DATA_PORT),
      RELAY_CONTROL_PORT: String(CONTROL_PORT),
      DSH_TUNNEL_KEY: KEY,
      RELAY_STATE_DIR: STATE_DIR,
    },
    stdio: "inherit",
  });
  await waitPort(CONTROL_PORT);
  log(`relay on :${DATA_PORT}/:${CONTROL_PORT}`);

  tunnel = spawn(process.execPath, [join(root, "tunnel/src/tunnel.mjs"), "run"], {
    env: {
      ...process.env,
      RELAY_URL: `ws://127.0.0.1:${CONTROL_PORT}/tunnel`,
      DSH_TUNNEL_KEY: KEY,
      UPSTREAM_HOST: "127.0.0.1",
      UPSTREAM_PORT: String(DSH_PORT),
      DSH_AUTHORITY: AUTHORITY,
      DSH2PHONE_LAN_PORT: String(LAN_PORT),
    },
    stdio: "inherit",
  });
  // 就绪 = LAN 边缘可连 且 relay 已经收到并存储了 lan.announce（/dsh-lan 能给出非空 lan）。
  await waitPort(LAN_PORT);
  let announced = false;
  for (let i = 0; i < 40 && !announced; i++) {
    const res = await httpRequest({ port: DATA_PORT, path: "/dsh-lan", headers: { cookie: `dshdev=${DEVICE_COOKIE}` } });
    try { announced = JSON.parse(res.body).lan !== null; } catch { announced = false; }
    if (!announced) await sleep(250);
  }
  if (!announced) fail("announce", new Error("relay /dsh-lan never returned a non-null lan"));
  log("tunnel online with LAN edge");

  // 1. relay /dsh-lan（公网 URL /dsh/dsh-lan，nginx 剥前缀后的形态）
  const lanRes = await httpRequest({ port: DATA_PORT, path: "/dsh-lan", headers: { cookie: `dshdev=${DEVICE_COOKIE}` } });
  assert(lanRes.statusLine.includes("200"), "relay /dsh-lan returns 200 for allowlisted device");
  let lan;
  try { lan = JSON.parse(lanRes.body).lan; } catch { lan = null; }
  assert(lan && lan.port === LAN_PORT, "relay /dsh-lan announces the LAN edge port");
  assert(lan && /^[0-9a-f]{64}$/.test(lan.fp), "relay /dsh-lan announces a sha256 fingerprint");
  assert(lan && Array.isArray(lan.ips) && lan.ips.length > 0, "relay /dsh-lan announces at least one private IP");

  const noCookie = await httpRequest({ port: DATA_PORT, path: "/dsh-lan" });
  assert(noCookie.statusLine.includes("403"), "relay /dsh-lan requires the device cookie");

  // 2. hello 探活 + 通告指纹必须与实际证书一致（App 的锁定依据）
  const hello = await tlsRequest({ port: LAN_PORT, path: "/dsh2phone-lan-hello" });
  assert(hello.statusLine.includes("200"), "LAN edge hello responds without credentials");
  assert(hello.body.includes('"dsh2phone-lan"'), "LAN edge hello identifies the service");
  const fp = createHash("sha256").update(await peerRawCert(LAN_PORT)).digest("hex");
  assert(fp === lan.fp, "announced fingerprint matches the served certificate");

  // 3. 直连加载 /dsh/：Host 重写、Origin 剥离、cookie 透传
  const page = await tlsRequest({
    port: LAN_PORT,
    path: "/dsh/",
    headers: {
      cookie: `dshdev=${DEVICE_COOKIE}; dsh-auth-fake=v1.fake`,
      origin: "https://192.0.2.9:13220",
      "user-agent": "dsh2phone-lan-check",
    },
  });
  assert(page.statusLine.includes("200"), "LAN edge serves the DSH page for a paired device");
  assert(page.body.includes(`<p id="host">${AUTHORITY}</p>`), "Host rewritten to the DSH authority");
  assert(page.body.includes('<p id="origin">absent</p>'), "Origin header stripped before DSH");
  assert(page.body.includes(`dshdev=${DEVICE_COOKIE}`) && page.body.includes("dsh-auth-fake=v1.fake"), "both cookies forwarded to DSH");
  assert(page.body.includes('<p id="url">/dsh/</p>'), "request path passed through unchanged");

  // 4. WS upgrade 穿透（DSH GUI 的 WebSocket 走这条链路）
  const upgraded = await upgradeRequest({ port: LAN_PORT, path: "/ws", headers: { cookie: `dshdev=${DEVICE_COOKIE}` } });
  assert(upgraded.includes("101 Switching Protocols"), "LAN edge passes WebSocket upgrade through");
  assert(upgraded.includes("pong-from-dsh"), "WebSocket data flows in both directions");

  // 5. deny → 直连立即失效；allow → 恢复（白名单实时广播）
  const { WebSocket } = await import("ws");
  const control = new WebSocket(`ws://127.0.0.1:${CONTROL_PORT}/tunnel`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("admin hello timeout")), 8000);
    control.on("open", () => control.send(JSON.stringify({ t: "hello", key: KEY, mode: "admin" })));
    control.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (msg.t === "hello.ok") { clearTimeout(timer); resolve(); }
    });
    control.on("error", reject);
  });
  const sendExpect = (obj, type) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type} reply`)), 8000);
    const onMessage = (data) => {
      const msg = JSON.parse(String(data));
      if (msg.t === type) { clearTimeout(timer); control.off("message", onMessage); resolve(msg); }
    };
    control.on("message", onMessage);
    control.send(JSON.stringify(obj));
  });
  await sendExpect({ t: "devices.set", id: DEVICE_ID, status: "deny" }, "ok");
  await sleep(400);
  const denied = await tlsRequest({
    port: LAN_PORT, path: "/dsh/",
    headers: { cookie: `dshdev=${DEVICE_COOKIE}` },
  });
  assert(denied.statusLine.includes("403"), "deny propagates to the LAN edge instantly");
  assert(denied.body.includes("设备已被停用"), "denied page explains the revoked device");
  await sendExpect({ t: "devices.set", id: DEVICE_ID, status: "allow" }, "ok");
  await sleep(400);
  const restored = await tlsRequest({
    port: LAN_PORT, path: "/dsh/",
    headers: { cookie: `dshdev=${DEVICE_COOKIE}` },
  });
  assert(restored.statusLine.includes("200"), "allow propagates to the LAN edge instantly");

  // 6. 无 cookie / 伪造签名 → 403
  const anon = await tlsRequest({ port: LAN_PORT, path: "/dsh/" });
  assert(anon.statusLine.includes("403"), "LAN edge rejects anonymous requests");
  const forged = await tlsRequest({
    port: LAN_PORT, path: "/dsh/",
    headers: { cookie: `dshdev=${DEVICE_ID}.${"A".repeat(43)}` },
  });
  assert(forged.statusLine.includes("403"), "LAN edge rejects forged device cookies");

  control.close();
  log("LAN CHECK PASS");
  cleanup();
  process.exit(0);
}

try {
  await main();
} catch (err) {
  fail("unexpected", err);
}
