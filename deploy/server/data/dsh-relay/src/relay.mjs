// dsh2phone relay v2 — public gate on the server (behind nginx, docker-compose).
//
// Data plane (:3200, behind nginx /dsh/ and /dsh-pair):
//   - peeks the HTTP request headers of every connection,
//   - rejects public token usage (?token=) — the token is never valid here,
//   - enforces the device allowlist: a valid `dshdev` cookie signed with the
//     tunnel key AND status=allow is required, everything else gets 403,
//   - serves the pairing endpoint (/pair): consumes a one-time pairing code,
//     asks the PC owner for confirmation through the control plane, and on
//     approval registers the device and sets device + DSH cookies.
//   - approved connections are then forwarded byte-transparently (unchanged).
//
// Control plane (:3201, /tunnel for the PC tunnel, /tunnel?mode=admin style
// hello for management connections, /healthz):
//   text frames   JSON: hello/hello.ok/open/close/pair.*/devices.*
//   binary frames [4B stream id BE][payload bytes]
import http from "node:http";
import net from "node:net";
import { randomBytes, createHmac } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";

// Local runs read <repo>/.env; the container image has no shared/ directory in
// its build context and gets its variables from docker-compose's env_file.
try {
  await import("../../shared/env.mjs");
} catch { /* container build context */ }

const DATA_PORT = Number(process.env.RELAY_DATA_PORT ?? 3200);
const CONTROL_PORT = Number(process.env.RELAY_CONTROL_PORT ?? 3201);
const TUNNEL_KEY = process.env.DSH_TUNNEL_KEY ?? "";
const STATE_DIR = process.env.RELAY_STATE_DIR ?? join(process.cwd(), "state");
const PUBLIC_PREFIX = process.env.RELAY_PUBLIC_PREFIX ?? "/dsh";
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const PAIR_CODE_TTL_MS = 5 * 60_000;
const PAIR_CONFIRM_TIMEOUT_MS = 120_000;
const REGISTRY_PATH = join(STATE_DIR, "devices.json");
const DEVICE_COOKIE = "dshdev";
const HEADER_PEEK_CAP = 64 * 1024;

if (!TUNNEL_KEY) {
  console.error("[relay] DSH_TUNNEL_KEY is required (docker env_file or .env)");
  process.exit(1);
}
mkdirSync(STATE_DIR, { recursive: true });

// ---------- device registry ----------
/** @type {Map<string, any>} */
const devices = new Map();
if (existsSync(REGISTRY_PATH)) {
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
    for (const d of parsed.devices ?? []) devices.set(d.id, d);
    console.log(`[relay] loaded ${devices.size} device(s) from registry`);
  } catch (e) {
    console.error(`[relay] registry unreadable, starting empty: ${e.message}`);
  }
}
let saveTimer = null;
function saveRegistry() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      writeFileSync(REGISTRY_PATH, JSON.stringify({ version: 1, devices: [...devices.values()] }, null, 2));
    } catch (e) {
      console.error(`[relay] registry save failed: ${e.message}`);
    }
  }, 250);
}
function deviceSummary(d) {
  const { id, name, ua, status, createdAt, lastSeen, lastIp } = d;
  return { id, name, ua, status, createdAt, lastSeen, lastIp };
}
function sign(v) {
  return createHmac("sha256", TUNNEL_KEY).update(v).digest().toString("base64url");
}
function deviceCookieValue(id) {
  return `${id}.${sign(id)}`;
}
function parseDeviceCookie(cookieHeader) {
  if (typeof cookieHeader !== "string") return undefined;
  // Callers pass either the raw header value or the whole `cookie: ...` line;
  // strip an optional header-name prefix so both forms parse the same way.
  const headerValue = cookieHeader.replace(/^\s*cookie\s*:/iu, "");
  for (const segment of headerValue.split(";")) {
    const at = segment.indexOf("=");
    if (at === -1 || segment.slice(0, at).trim() !== DEVICE_COOKIE) continue;
    const value = segment.slice(at + 1).trim();
    const dot = value.lastIndexOf(".");
    if (dot === -1) return undefined;
    const id = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    const expected = Buffer.from(sign(id));
    const actual = Buffer.from(sig);
    if (expected.byteLength !== actual.byteLength || !expected.equals(actual)) return undefined;
    return id;
  }
  return undefined;
}

// ---------- tunnel / admin connections ----------
/** @type {import("ws").WebSocket | null} */
let tunnel = null;
let tunnelPing = null;
/** @type {Set<import("ws").WebSocket>} */
const controlConns = new Set();
let nextStreamId = 1;
/** @type {Map<number, net.Socket>} */
const streams = new Map();
let pendingPair = null; // { code, expiresAt, ws, timer }

function killTunnel(reason) {
  if (tunnelPing) { clearInterval(tunnelPing); tunnelPing = null; }
  if (!tunnel) return;
  const dead = tunnel;
  tunnel = null;
  for (const [id, sock] of streams) {
    sock.destroy();
    streams.delete(id);
  }
  try { dead.close(1011, reason); } catch { /* already closing */ }
  console.log(`[relay] tunnel dropped: ${reason}`);
}
function sendText(obj) {
  if (tunnel?.readyState === 1) tunnel.send(JSON.stringify(obj));
}
function sendData(id, chunk) {
  if (tunnel?.readyState !== 1) return;
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(id, 0);
  tunnel.send(Buffer.concat([head, chunk]), { binary: true });
}
function broadcast(obj) {
  for (const ws of controlConns) if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function notifyDeviceChange() {
  broadcast({ t: "devices", devices: [...devices.values()].map(deviceSummary) });
}

// ---------- HTTP helpers for relay-generated responses ----------
// Gate pages (unknown device / denied / token use) are plain HTML, so they must
// opt into `color-scheme` themselves; otherwise a phone in dark mode gets a
// bright white flash page that ignores the OS theme.
const DENY_CSS = `
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;text-align:center;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
  background:#f5f6f8;color:#1b1d21}
main{max-width:24rem}
h1{font-size:1.2rem;margin:0 0 10px}
p{margin:0 0 8px;line-height:1.55;font-size:.925rem;color:#5b6169}
p.hint{opacity:.72}
@media (prefers-color-scheme:dark){body{background:#141518;color:#e8eaed}p{color:#a7adb6}}`;
function httpRespond(socket, status, title, htmlBody, extraHeaders = []) {
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${DENY_CSS}</style></head><body><main><h1>${title}</h1>${htmlBody}</main></body></html>`;
  const head = [
    `HTTP/1.1 ${status}`,
    "content-type: text/html; charset=utf-8",
    "cache-control: no-store",
    "connection: close",
    ...extraHeaders,
    `content-length: ${Buffer.byteLength(body)}`,
    "",
    "",
  ].join("\r\n");
  socket.end(head + body);
}
function denyPage(reason, hint = "") {
  return `<p>${reason}</p>${hint ? `<p class="hint">${hint}</p>` : ""}`;
}

/** Send a complete HTML document (no wrapper); used by the phone entry pages. */
function pageRespond(socket, status, html, extraHeaders = []) {
  const head = [
    `HTTP/1.1 ${status}`,
    "content-type: text/html; charset=utf-8",
    "cache-control: no-store",
    "connection: close",
    ...extraHeaders,
    `content-length: ${Buffer.byteLength(html)}`,
    "",
    "",
  ].join("\r\n");
  socket.end(head + html);
}

// ---------- phone entry pages (landing / waiting) ----------
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

const PAGE_CSS = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;
  background:#f5f6f8;color:#1b1d21}
@media (prefers-color-scheme:dark){body{background:#141518;color:#e8eaed}}
main{width:100%;max-width:24rem;background:#fff;border-radius:16px;padding:28px 22px;
  box-shadow:0 12px 32px rgba(0,0,0,.10);text-align:center}
@media (prefers-color-scheme:dark){main{background:#1e2024;box-shadow:0 12px 32px rgba(0,0,0,.45)}}
h1{font-size:1.25rem;margin:0 0 8px}
p{margin:0 0 10px;line-height:1.55;font-size:.925rem;color:#5b6169}
@media (prefers-color-scheme:dark){p{color:#a7adb6}}
.device{font-weight:600;color:inherit}
.enter{display:block;margin:22px 0 18px;padding:15px 18px;border-radius:12px;background:#2f6df6;color:#fff;
  text-decoration:none;font-size:1.05rem;font-weight:600}
.enter:active{transform:scale(.99)}
.tip{margin-top:8px;padding-top:16px;border-top:1px solid rgba(128,128,128,.25);text-align:left}
.tip h2{font-size:.9rem;margin:0 0 6px}
.tip p{font-size:.85rem;margin:0}
.muted{font-size:.78rem;margin-top:16px;color:#8a9099}
.state{font-size:2rem;margin:0 0 6px}
`;

function pageShell(title, content, head = "") {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#f5f6f8" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#141518" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<title>${escapeHtml(title)}</title><style>${PAGE_CSS}</style>${head}</head><body><main>${content}</main></body></html>`;
}

function landingPage(name) {
  return pageShell("已连接 DSH", `
<p class="state">✅</p>
<h1>配对成功</h1>
<p><span class="device">${escapeHtml(name)}</span> 已加入设备白名单。</p>
<a class="enter" href="${PUBLIC_PREFIX}/">进入 DSH</a>
<div class="tip">
  <h2>把 DSH 加到主屏幕</h2>
  <p id="how">在浏览器菜单中选择“添加到主屏幕”。</p>
</div>
<p class="muted">本页可收藏。已配对设备再次打开本页，仍会显示“进入 DSH”。</p>
<script>
(function () {
  // Keep "add to home screen" bookmarks clean: drop the one-time code.
  if (location.search) history.replaceState(null, "", location.pathname);
  var ua = navigator.userAgent || "";
  var el = document.getElementById("how");
  if (!el) return;
  if (/iPhone|iPad|iPod/i.test(ua)) el.innerHTML = "点 Safari 底部的 <b>分享</b> 按钮，选择 <b>添加到主屏幕</b>。";
  else if (/Android/i.test(ua)) el.innerHTML = "点 Chrome 右上角的 <b>⋮</b> 菜单，选择 <b>添加到主屏幕</b>。";
  else el.innerHTML = "在浏览器菜单中选择 <b>添加到主屏幕</b>。";
})();
</script>`);
}

function waitingPage() {
  return pageShell("等待配对", `
<p class="state">📱</p>
<h1>需要先配对</h1>
<p>请在这台电脑上打开 DSH，点击左下角的 <b>“配对手机”</b>，再用手机扫描弹出的二维码。</p>
<p class="muted">二维码 5 分钟内有效；配对成功后本页会变成“进入 DSH”入口。</p>`);
}


// ---------- pairing ----------
function pairRequest(ws, code, { ua, ip, existing }) {
  return new Promise((resolve) => {
    const reqId = randomBytes(8).toString("hex");
    const onMessage = (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.t === "pair.response" && msg.reqId === reqId) {
        ws.off("message", onMessage);
        resolve(msg);
      }
    };
    ws.on("message", onMessage);
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      resolve({ approved: false, expired: true });
    }, PAIR_CONFIRM_TIMEOUT_MS);
    ws.once("close", () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve({ approved: false, expired: true });
    });
    ws.send(JSON.stringify({
      t: "pair.request", reqId, code, ua, ip,
      ...(existing === undefined ? {} : { existing }),
    }));
  });
}

async function handlePair(socket, target, ip, ua, cookieHeader) {
  const u = new URL(target, "http://x");
  const code = u.searchParams.get("code") ?? "";

  // Already paired: /dsh-pair doubles as the phone's entry page, so a paired
  // device gets the landing page without a code. With a code we fall through to
  // the confirmation round-trip, because only the PC can mint a fresh DSH cookie
  // — and the device identity is reused instead of registering a duplicate.
  const knownId = parseDeviceCookie(cookieHeader);
  const known = knownId !== undefined ? devices.get(knownId) : undefined;
  if (known !== undefined && known.status === "allow" && !code) {
    known.lastSeen = Date.now();
    known.lastIp = ip;
    saveRegistry();
    pageRespond(socket, 200, landingPage(known.name ?? "此设备"));
    socket.destroy();
    return;
  }
  if (!code) {
    pageRespond(socket, 200, waitingPage());
    socket.destroy();
    return;
  }
  if (!pendingPair || pendingPair.code !== code || Date.now() > pendingPair.expiresAt || pendingPair.ws.readyState !== 1) {
    httpRespond(socket, 403, "配对失败", denyPage("配对码无效或已过期。", "请在这台电脑上打开 DSH → 左下角“配对手机”，重新生成二维码后扫码。"));
    socket.destroy();
    return;
  }
  const answer = await pairRequest(pendingPair.ws, code, {
    ua,
    ip,
    existing: known === undefined ? undefined : { id: known.id, name: known.name },
  });
  if (!answer.approved) {
    httpRespond(socket, 403, "配对被拒绝", denyPage(answer.expired ? "确认超时或会话中断。" : "电脑端拒绝了这个设备。"));
    socket.destroy();
    return;
  }
  // Deduplicate: one registry row per device. The device cookie is the exact
  // identity (works even when the phone later reports a different UA string —
  // Chrome's reduced UA does); the UA fallback keeps a re-scan from duplicating
  // when the cookie is missing (cleared, in-app browser, first time after the
  // cookie policy change).
  const partner = known ?? [...devices.values()].find((d) => d.ua === ua);
  const id = partner?.id ?? answer.device?.id ?? randomBytes(8).toString("hex");
  const name = answer.device?.name ?? partner?.name ?? "unknown device";
  const prior = devices.get(id);
  devices.set(id, {
    id, name, ua,
    status: "allow",
    createdAt: prior?.createdAt ?? Date.now(),
    lastSeen: Date.now(),
    lastIp: ip,
  });
  saveRegistry();
  const cookies = [
    // SameSite=Lax (not Strict): the pairing link is opened as a top-level
    // navigation from the camera / another app, and a Strict cookie would not be
    // sent — the relay would see an anonymous request and register a duplicate.
    `${DEVICE_COOKIE}=${deviceCookieValue(id)}; Max-Age=${30 * 24 * 3600}; Path=/; Expires=${new Date(Date.now() + 30 * 24 * 3600 * 1000).toUTCString()}; HttpOnly; SameSite=Lax`,
  ];
  if (typeof answer.dshCookie === "string" && answer.dshCookie.length > 0 && answer.dshCookie.length < 4096) {
    cookies.push(answer.dshCookie);
  }
  console.log(prior
    ? `[relay] device re-paired (deduplicated): ${name} (${id.slice(0, 8)})`
    : `[relay] device paired: ${name} (${id.slice(0, 8)})`);
  notifyDeviceChange();
  // Land on the entry page instead of redirecting: the user explicitly taps
  // "进入 DSH", and the page doubles as a bookmarkable entry point.
  pageRespond(socket, 200, landingPage(name), cookies.map((c) => "set-cookie: " + c));
  socket.destroy();
}

// ---------- data plane: peek, decide, then pipe ----------
const dataServer = net.createServer((conn) => {
  const ip = conn.remoteAddress?.replace(/^::ffff:/u, "") ?? "";
  if (!tunnel || tunnel.readyState !== 1) {
    // A bare destroy surfaces as ERR_EMPTY_RESPONSE ("无法显示此网页") in the
    // phone browser; answer with a retry page instead.
    pageRespond(conn, 503, pageShell("电脑端连接中", `
<p class="state">🔌</p>
<h1>电脑端连接中</h1>
<p>电脑上的隧道暂时没有连上，正在自动重试。请稍等几秒后刷新。</p>
<p><a class="enter" href="">重新加载</a></p>`));
    return;
  }
  let buffered = Buffer.alloc(0);
  let decided = false;
  conn.on("data", function onData(chunk) {
    if (decided) return; // once piped, the stream handler owns data
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf("\r\n\r\n");
    if (end === -1) {
      if (buffered.length > HEADER_PEEK_CAP) conn.destroy();
      return;
    }
    decided = true;
    conn.removeListener("data", onData);
    const headerText = buffered.subarray(0, end).toString("latin1");
    const requestLine = headerText.split("\r\n")[0] ?? "";
    const cookieHeader = headerText.split("\r\n").find((l) => /^cookie:/iu.test(l));
    const uaHeader = headerText.split("\r\n").find((l) => /^user-agent:/iu.test(l)) ?? "";
    const ua = uaHeader.slice(uaHeader.indexOf(":") + 1).trim();
    const rest = buffered.subarray(end + 4);

    const [method, target] = requestLine.split(" ");
    if (method === "GET" && target?.startsWith("/pair")) {
      handlePair(conn, target, ip, ua, cookieHeader);
      return;
    }
    if (target?.includes("token=")) {
      console.log(`[relay] rejected public token use from ${ip}`);
      httpRespond(conn, 403, "无效的访问方式", denyPage("此入口不接受 token 登录。", "请使用电脑端生成的配对二维码完成设备授权。"));
      conn.destroy();
      return;
    }
    const deviceId = parseDeviceCookie(cookieHeader);
    const device = deviceId !== undefined ? devices.get(deviceId) : undefined;
    if (device === undefined || device.status !== "allow") {
      const denied = device !== undefined;
      httpRespond(conn, 403, denied ? "设备已被停用" : "未知设备", denyPage(
        denied ? "该设备已被禁止访问。" : "此设备尚未配对。",
        "请在电脑端运行 pair 生成配对二维码，扫码完成授权。",
      ));
      conn.destroy();
      return;
    }
    device.lastSeen = Date.now();
    device.lastIp = ip;
    saveRegistry();

    // approved — become a transparent byte pipe
    const id = nextStreamId++;
    streams.set(id, conn);
    sendText({ t: "open", id });
    // forward the ENTIRE peeked buffer (headers + any early body), not just the rest
    if (buffered.length > 0) sendData(id, buffered);
    conn.on("data", (c) => sendData(id, c));
    conn.on("close", () => { if (streams.delete(id)) sendText({ t: "close", id }); });
    conn.on("error", () => { if (streams.delete(id)) sendText({ t: "close", id }); });
  });
  conn.on("error", () => conn.destroy());
});

// ---------- control plane ----------
const controlServer = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(tunnel ? "tunnel:online\n" : "tunnel:offline\n");
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });
controlServer.on("upgrade", (req, socket, head) => {
  if (req.url !== "/tunnel") { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    let authed = false;
    let isAdmin = false;
    ws.on("message", (data, isBinary) => {
      if (!authed) {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { ws.close(4001, "unauthorized"); return; }
        if (msg.t !== "hello" || msg.key !== TUNNEL_KEY) { ws.close(4001, "unauthorized"); return; }
        authed = true;
        isAdmin = msg.mode === "admin";
        controlConns.add(ws);
        if (isAdmin) {
          ws.send(JSON.stringify({ t: "hello.ok", mode: "admin" }));
          console.log("[relay] admin console connected");
        } else {
          if (tunnel) killTunnel("replaced by new tunnel");
          tunnel = ws;
          ws.send(JSON.stringify({ t: "hello.ok", mode: "tunnel" }));
          tunnelPing = setInterval(() => {
            if (tunnel?.readyState !== 1) return;
            let ponged = false;
            tunnel.once("pong", () => { ponged = true; });
            tunnel.ping();
            setTimeout(() => { if (!ponged && tunnel === ws) killTunnel("pong timeout"); }, PONG_TIMEOUT_MS);
          }, PING_INTERVAL_MS);
          console.log("[relay] tunnel online");
        }
        return;
      }
      if (isBinary) {
        if (data.length < 4) return;
        const id = data.readUInt32BE(0);
        const sock = streams.get(id);
        if (sock && !sock.destroyed && data.length > 4) sock.write(data.subarray(4));
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      switch (msg.t) {
        case "close": {
          const sock = streams.get(msg.id);
          if (sock) { sock.end(); streams.delete(msg.id); }
          break;
        }
        case "pair.start": {
          if (pendingPair?.timer) clearTimeout(pendingPair.timer);
          const code = String(randomBytes(4).toString("hex")); // 8 chars
          pendingPair = { code, expiresAt: Date.now() + PAIR_CODE_TTL_MS, ws };
          pendingPair.timer = setTimeout(() => { if (pendingPair?.code === code) pendingPair = null; }, PAIR_CODE_TTL_MS);
          ws.send(JSON.stringify({ t: "pair.session", code, expiresAt: pendingPair.expiresAt }));
          console.log(`[relay] pairing session started (${code})`);
          break;
        }
        case "pair.response": {
          // consumed by the promise in pairRequest(); nothing to do here
          break;
        }
        case "devices.list":
          ws.send(JSON.stringify({ t: "devices", devices: [...devices.values()].map(deviceSummary) }));
          break;
        case "devices.set": {
          const d = devices.get(msg.id);
          if (d && (msg.status === "allow" || msg.status === "deny")) {
            d.status = msg.status;
            saveRegistry();
            ws.send(JSON.stringify({ t: "ok", op: msg.t, id: msg.id }));
            notifyDeviceChange();
          } else {
            ws.send(JSON.stringify({ t: "error", op: msg.t, message: "unknown device or status" }));
          }
          break;
        }
        case "devices.remove": {
          if (devices.delete(msg.id)) {
            saveRegistry();
            ws.send(JSON.stringify({ t: "ok", op: msg.t, id: msg.id }));
            notifyDeviceChange();
          } else {
            ws.send(JSON.stringify({ t: "error", op: msg.t, message: "unknown device" }));
          }
          break;
        }
        case "devices.panic": {
          devices.clear();
          saveRegistry();
          ws.send(JSON.stringify({ t: "ok", op: msg.t }));
          notifyDeviceChange();
          console.log("[relay] PANIC: all devices revoked");
          break;
        }
        default:
          break;
      }
    });
    ws.on("close", () => {
      controlConns.delete(ws);
      if (!isAdmin && tunnel === ws) killTunnel("closed");
      if (pendingPair?.ws === ws) pendingPair = null;
    });
    ws.on("error", () => {
      controlConns.delete(ws);
      if (!isAdmin && tunnel === ws) killTunnel("error");
    });
  });
});

controlServer.listen(CONTROL_PORT, () => console.log(`[relay] control on :${CONTROL_PORT} (/tunnel, /healthz)`));
dataServer.listen(DATA_PORT, () => console.log(`[relay] data on :${DATA_PORT} (device gate: ${devices.size} registered)`));
