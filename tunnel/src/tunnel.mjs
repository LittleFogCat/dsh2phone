// dsh2phone tunnel v2 — PC side.
//
//   node tunnel.mjs              run the tunnel (control + data forwarding)
//   node tunnel.mjs pair [--yes] start a pairing session: QR for the phone,
//                                confirmation prompt on this machine, mints
//                                the DSH cookie locally (token never public)
//   node tunnel.mjs devices      list registered devices
//   node tunnel.mjs allow <id>   re-enable a device
//   node tunnel.mjs deny <id>    blacklist a device (instant)
//   node tunnel.mjs remove <id>  forget a device
//   node tunnel.mjs panic        revoke every device immediately
import net from "node:net";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
// Loads <repo>/.env before anything reads process.env (see shared/env.mjs).
import "../../shared/env.mjs";
import { env, envFlag } from "../../shared/env.mjs";
import { WebSocket } from "ws";
import { dshAuthority, mintDshCookie } from "./dsh-cookie.mjs";

const RELAY_URL = env("RELAY_URL", "");
const TUNNEL_KEY = env("DSH_TUNNEL_KEY", "");
const UPSTREAM_HOST = env("UPSTREAM_HOST", "127.0.0.1");
const UPSTREAM_PORT = Number(env("UPSTREAM_PORT", "43120"));
const PUBLIC_PAIR_URL = env("PUBLIC_PAIR_URL", "");
// When the relay is addressed by IP, its certificate (issued for a domain name)
// cannot validate; set TUNNEL_INSECURE=1 to skip verification.
const WS_OPTIONS = {
  perMessageDeflate: false,
  ...(envFlag("TUNNEL_INSECURE") || envFlag("DSH2PHONE_ALLOW_INVALID_CERT") ? { rejectUnauthorized: false } : {}),
};
const AUTO_APPROVE = process.argv.includes("--yes") || envFlag("TUNNEL_AUTO_APPROVE");

const mode = process.argv[2] ?? "run";
if (!RELAY_URL || !TUNNEL_KEY) {
  console.error("[tunnel] RELAY_URL and DSH_TUNNEL_KEY are required — set them in .env (see .env.example)");
  process.exit(1);
}

function log(...args) {
  console.log(new Date().toLocaleTimeString(), "[tunnel]", ...args);
}

function shortUA(ua) {
  if (/iphone|ipad|ipod/iu.test(ua)) return `iOS ${/OS ([\d_]+)/iu.exec(ua)?.[1]?.replace(/_/g, ".") ?? ""} ${/EdgiOS|CriOS|FxiOS|Safari/iu.exec(ua)?.[0] ?? ""}`.trim();
  if (/android/iu.test(ua)) return `Android ${/Android ([\d.]+)/iu.exec(ua)?.[1] ?? ""} ${/EdgA|Chrome|Firefox/iu.exec(ua)?.[0] ?? ""}`.trim();
  if (/windows/iu.test(ua)) return `Windows ${/Edg|Chrome|Firefox/iu.exec(ua)?.[0] ?? ""}`.trim();
  return (ua.split(" ")[0] ?? "unknown").slice(0, 40);
}

function deviceNameFromUA(ua) {
  const base = shortUA(ua);
  if (/iphone|ipad/iu.test(ua)) return `iPhone · ${base}`;
  if (/android/iu.test(ua)) return `Android · ${base}`;
  if (/mobile/iu.test(ua)) return `Mobile · ${base}`;
  return `Desktop · ${base}`;
}

// ---------- one control connection, shared by all modes ----------
function connectControl({ onData, onClose }) {
  const ws = new WebSocket(RELAY_URL, WS_OPTIONS);
  let authed = false;
  ws.on("open", () => ws.send(JSON.stringify({ t: "hello", key: TUNNEL_KEY, mode: mode === "run" ? undefined : "admin" })));
  ws.on("message", (data, isBinary) => {
    if (!authed) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.t === "hello.ok") {
        authed = true;
        onData({ type: "ready", msg });
      } else {
        console.error("[tunnel] relay rejected the key");
        process.exit(1);
      }
      return;
    }
    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      onData({ type: "json", msg });
    }
  });
  ws.on("close", () => onClose?.());
  ws.on("error", (err) => log("ws error:", err.message));
  return ws;
}

// ---------- run mode ----------
function runTunnel() {
  /** @type {Map<number, net.Socket>} */
  const streams = new Map();
  let online = false;
  let retry = 0;
  let closedByUs = false;
  let ws = null;

  function connect() {
    log(`connecting ${RELAY_URL} (attempt ${retry + 1})`);
    ws = new WebSocket(RELAY_URL, WS_OPTIONS);
    // Silent half-open links (ISP path change, NAT timeout, sleep/resume) never
    // emit "close": the socket stays writable while nothing arrives. Track
    // inbound traffic and force a reconnect when the link has gone quiet, so
    // the process can never wedge in the "online" state again.
    let lastInbound = Date.now();
    const heartbeat = setInterval(() => {
      if (ws?.readyState !== 1) return;
      if (Date.now() - lastInbound > 70_000) {
        log(`no traffic from relay for ${Math.round((Date.now() - lastInbound) / 1000)}s, forcing reconnect`);
        try { ws.terminate(); } catch { /* ignore */ }
        return;
      }
      try { ws.ping(); } catch { /* ignore */ }
    }, 15_000);
    ws.on("ping", () => { lastInbound = Date.now(); });
    ws.on("pong", () => { lastInbound = Date.now(); });
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", key: TUNNEL_KEY })));
    ws.on("message", (data, isBinary) => {
      lastInbound = Date.now();
      if (!online) {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.t === "hello.ok") {
          online = true;
          retry = 0;
          log("relay online, forwarding to", `${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
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
      if (msg.t === "open") {
        const id = msg.id;
        const sock = net.connect(UPSTREAM_PORT, UPSTREAM_HOST);
        streams.set(id, sock);
        sock.on("data", (chunk) => {
          if (ws?.readyState !== 1) return;
          const head = Buffer.allocUnsafe(4);
          head.writeUInt32BE(id, 0);
          ws.send(Buffer.concat([head, chunk]), { binary: true });
        });
        sock.on("close", () => {
          if (streams.delete(id) && ws?.readyState === 1) ws.send(JSON.stringify({ t: "close", id }));
        });
        sock.on("error", (err) => {
          log(`stream ${id} upstream error: ${err.message}`);
          if (streams.delete(id) && ws?.readyState === 1) ws.send(JSON.stringify({ t: "close", id }));
        });
      } else if (msg.t === "close") {
        const sock = streams.get(msg.id);
        if (sock) { sock.destroy(); streams.delete(msg.id); }
      } else if (msg.t === "device.registered") {
        log(`🔔 新设备已配对: ${msg.device?.name} (${String(msg.device?.id).slice(0, 8)})`);
      }
    });
    ws.on("close", () => {
      clearInterval(heartbeat);
      online = false;
      for (const [id, sock] of streams) { sock.destroy(); streams.delete(id); }
      if (closedByUs) return;
      const delay = Math.min(10_000, 500 * 2 ** retry++) * (0.8 + Math.random() * 0.4);
      log(`disconnected; retry in ${Math.round(delay)}ms`);
      setTimeout(connect, delay);
    });
    ws.on("error", (err) => log("ws error:", err.message));
  }

  process.on("SIGINT", () => {
    closedByUs = true;
    try { ws?.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  connect();
}

// ---------- admin helper ----------
function withAdmin(onMessage) {
  const ref = { ws: null };
  ref.ws = connectControl({
    onData: ({ type, msg }) => {
      if (type === "ready") onMessage({ type: "ready" }, ref.ws);
      else if (type === "json") {
        if (msg.t === "error") {
          console.error("relay error:", msg.message);
          process.exit(1);
        }
        onMessage({ type: "json", msg }, ref.ws);
      }
    },
    onClose: () => process.exit(0),
  });
}

// ---------- pair mode ----------
function runPair() {
  if (!PUBLIC_PAIR_URL) {
    console.error("[tunnel] PUBLIC_PAIR_URL is required for pairing — set it in .env (see .env.example)");
    process.exit(1);
  }
  const ws = connectControl({
    onData: async ({ type, msg }) => {
      if (type === "ready") {
        // mint the DSH cookie up-front so failures surface before the QR shows
        try {
          const cookie = mintDshCookie();
          log("minted DSH cookie for authority:", dshAuthority(), `(name ${cookie.name.slice(0, 18)}…)`);
        } catch (err) {
          console.error("[tunnel] 无法铸造 DSH cookie:", err.message);
          process.exit(1);
        }
        ws.send(JSON.stringify({ t: "pair.start" }));
        return;
      }
      if (type !== "json") return;
      switch (msg.t) {
        case "pair.session": {
          const url = `${PUBLIC_PAIR_URL}?code=${msg.code}`;
          console.log("\n================ 手机扫码配对 ================");
          console.log(" 有效期 5 分钟 · 需要你在此窗口确认\n");
          console.log(url, "\n");
          try {
            const QRCode = (await import("qrcode")).default;
            console.log(await QRCode.toString(url, { type: "terminal", small: true }));
          } catch { /* qr optional */ }
          console.log("等待手机扫码…");
          break;
        }
        case "pair.request": {
          const name = deviceNameFromUA(msg.ua ?? "");
          console.log(`\n⚠️  新设备请求接入: ${name}`);
          console.log(`   IP: ${msg.ip || "未知"}   时间: ${new Date().toLocaleTimeString()}`);
          if (msg.existing) console.log(`   该设备已在白名单（${msg.existing.name ?? msg.existing.id}），确认后刷新授权`);
          let approved = AUTO_APPROVE;
          if (AUTO_APPROVE) {
            log("--yes 生效，自动允许");
          } else {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            approved = await new Promise((resolve) => {
              rl.question("允许该设备接入? (Y/n) > ", (answer) => {
                rl.close();
                resolve(!/^\s*n/iu.test(answer));
              });
            });
            setTimeout(() => process.exit(0), 120_000);
          }
          const device = approved ? { id: randomUUID(), name } : undefined;
          const dshCookie = approved ? mintDshCookie().setCookie : undefined;
          ws.send(JSON.stringify({ t: "pair.response", reqId: msg.reqId, approved, device, dshCookie }));
          if (!approved) log("已拒绝");
          break;
        }
        case "ok":
          log("配对完成 ✅ 手机上应已进入 DSH");
          process.exit(0);
          break;
        default:
          break;
      }
    },
    onClose: () => process.exit(0),
  });
}

// ---------- device management ----------
function printDevices(devices) {
  if (devices.length === 0) { console.log("(no devices)"); return; }
  for (const d of devices) {
    console.log(`${d.status === "allow" ? "✓" : "✗"} ${d.id}  ${d.name}`);
    console.log(`   状态: ${d.status}  最后在线: ${d.lastSeen ? new Date(d.lastSeen).toLocaleString() : "-"}  IP: ${d.lastIp ?? "-"}`);
    console.log(`   UA: ${d.ua?.slice(0, 80) ?? "-"}`);
  }
}

function runDevices() {
  withAdmin(({ type, msg }, ws) => {
    if (type === "ready") ws.send(JSON.stringify({ t: "devices.list" }));
    else if (msg.t === "devices") {
      printDevices(msg.devices ?? []);
      process.exit(0);
    }
  });
}
function runSet(id, status) {
  if (!id) { console.error("usage: node tunnel.mjs allow|deny|remove <deviceId>"); process.exit(1); }
  withAdmin(({ type, msg }, ws) => {
    if (type === "ready") ws.send(JSON.stringify({ t: status === "remove" ? "devices.remove" : "devices.set", id, status }));
    else if (msg.t === "ok") {
      console.log(`done: ${msg.op} ${msg.id ?? ""}`);
      process.exit(0);
    }
  });
}
function runPanic() {
  withAdmin(({ type, msg }, ws) => {
    if (type === "ready") ws.send(JSON.stringify({ t: "devices.panic" }));
    else if (msg.t === "ok") {
      console.log("panic done: all devices revoked");
      process.exit(0);
    }
  });
}

switch (mode) {
  case "run": runTunnel(); break;
  case "pair": runPair(); break;
  case "devices": runDevices(); break;
  case "allow": runSet(process.argv[3], "allow"); break;
  case "deny": runSet(process.argv[3], "deny"); break;
  case "remove": runSet(process.argv[3], "remove"); break;
  case "panic": runPanic(); break;
  default:
    console.error(`unknown mode: ${mode}`);
    process.exit(1);
}
