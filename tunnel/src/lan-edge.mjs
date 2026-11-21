// LAN direct edge for the dsh2phone tunnel.
//
// 手机与 PC 在同一局域网时，App 可以直连本机而不绕公网 relay。本模块在 PC 上
// 起一个 HTTPS 反向代理（自签证书）：
//
//   手机 ──HTTPS(自签, App 按指纹锁定)──► 0.0.0.0:LAN_PORT ──HTTP──► 127.0.0.1:43120 (DSH)
//
// 转发行为与公网链路的 nginx 配置逐项对齐：Host 重写为 DSH_AUTHORITY、剥离
// Origin，所以铸造的 DSH cookie（authority=127.0.0.1:43120）在两条链路上都
// 有效；WS upgrade 原样穿透（只改 Host、去 Origin）。
//
// 门禁与 relay 数据面一致：dshdev cookie（DSH_TUNNEL_KEY 的 HMAC）+ 设备白名单
// status=allow。白名单由 tunnel 的控制连接实时同步（relay 在注册表变化时会向
// 所有控制连接广播 devices 帧）。未同步到注册表前一律拒绝（fail closed）。
//
// 证书：首次启动用 node-forge 生成 RSA-2048 自签证书并持久化到 tunnel/state/，
// 指纹（SHA-256 of DER）经 relay 转介给 App，App 端锁定指纹，LAN 内中间人无法
// 伪造本机身份。
import https from "node:https";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import forge from "node-forge";

// 免认证探活端点：App 用它快速确认“这是 dsh2phone 的直连边缘”。
const HELLO_PATH = "/dsh2phone-lan-hello";
// 逐跳头不能原样转发（http.request 自己管理连接语义）。
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);
const DEVICE_COOKIE = "dshdev";

function log(...args) {
  console.log(new Date().toLocaleTimeString(), "[tunnel][lan]", ...args);
}

// ---------- self-signed certificate ----------

function certificateFingerprint(cert) {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return createHash("sha256").update(Buffer.from(der, "binary")).digest("hex");
}

/** Load the persisted self-signed certificate or create one on first run. */
function ensureCert(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  const keyPath = join(stateDir, "lan-edge-key.pem");
  const certPath = join(stateDir, "lan-edge-cert.pem");
  if (existsSync(keyPath) && existsSync(certPath)) {
    try {
      const keyPem = readFileSync(keyPath, "utf8");
      const certPem = readFileSync(certPath, "utf8");
      const cert = forge.pki.certificateFromPem(certPem);
      // 证书还在有效期内才复用，否则重新生成（指纹会变，App 会重新从 relay 拿）。
      const now = new Date();
      if (cert.validity.notBefore <= now && now <= cert.validity.notAfter) {
        return { keyPem, certPem, fp: certificateFingerprint(cert) };
      }
      log("lan edge certificate expired, regenerating");
    } catch (e) {
      log(`lan edge certificate unreadable, regenerating: ${e.message}`);
    }
  }
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomBytes(16).toString("hex");
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 5 * 365 * 24 * 3600 * 1000);
  const attrs = [{ name: "commonName", value: "dsh2phone-lan" }, { name: "organizationName", value: "dsh2phone" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  // 这个证书只为“指纹锁定”服务，浏览器不会信任它；不需要 SAN/扩展。
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);
  writeFileSync(keyPath, keyPem, { mode: 0o600 });
  writeFileSync(certPath, certPem);
  const fp = certificateFingerprint(cert);
  log(`lan edge certificate ready (fp ${fp.slice(0, 16)}…), stored in ${stateDir}`);
  return { keyPem, certPem, fp };
}

// ---------- addresses ----------

/** 本机私有网段 IPv4（10/172.16-31/192.168），按地址排序保证通告稳定。 */
export function privateLanIps() {
  const found = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (!ni || ni.family !== "IPv4" || ni.internal) continue;
      if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/u.test(ni.address)) found.add(ni.address);
    }
  }
  return [...found].sort();
}

// ---------- gate ----------

/** 从 Cookie 头解析 dshdev 的 id 与签名（与 relay 的解析一致，值形如 <id>.<hmac>）。 */
function parseDeviceCookie(header) {
  if (typeof header !== "string") return undefined;
  for (const segment of header.split(";")) {
    const at = segment.indexOf("=");
    if (at === -1 || segment.slice(0, at).trim() !== DEVICE_COOKIE) continue;
    const value = segment.slice(at + 1).trim();
    const dot = value.lastIndexOf(".");
    if (dot === -1) return undefined;
    return { id: value.slice(0, dot), sig: value.slice(dot + 1) };
  }
  return undefined;
}

// ---------- HTTP plumbing ----------

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(JSON.stringify(body));
}

const DENY_CSS = `body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;text-align:center;
font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#1b1d21}
@media (prefers-color-scheme:dark){body{background:#141518;color:#e8eaed}}`;

function denyPage(title, reason) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${DENY_CSS}</style></head><body><main><h1>${title}</h1><p>${reason}</p></main></body></html>`;
}

function sendDeny(res, title, reason) {
  const body = denyPage(title, reason);
  res.writeHead(403, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(body);
}

function sendBadGateway(res) {
  const body = denyPage("电脑端暂时不可达", "局域网直连已到达本机，但 DSH 没有应答。请确认 DSH Desktop 正在运行。");
  res.writeHead(502, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(body);
}

export async function startLanEdge({ port, upstreamHost, upstreamPort, authority, stateDir, gateDevice }) {
  const { keyPem, certPem, fp } = ensureCert(stateDir);

  /** gateDevice(cookieHeader) → "ok" | "unknown" | "denied"（由 tunnel 提供）。 */
  function gate(req) {
    return gateDevice(req.headers.cookie);
  }

  function proxyRequest(req, res) {
    const headers = { ...req.headers };
    for (const name of Object.keys(headers)) {
      if (HOP_BY_HOP.has(name.toLowerCase())) delete headers[name];
    }
    // 与 nginx 的行为一致：Host 固定为 DSH authority，剥离 Origin。
    headers.host = authority;
    delete headers.origin;
    let upstream;
    try {
      upstream = http.request(
        { host: upstreamHost, port: upstreamPort, method: req.method, path: req.url, headers },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
    } catch (e) {
      log(`proxy setup failed: ${e.message}`);
      if (!res.headersSent) sendBadGateway(res);
      return;
    }
    upstream.on("error", (err) => {
      log(`upstream error: ${err.message}`);
      if (!res.headersSent) sendBadGateway(res);
      else res.destroy();
      upstream.destroy();
    });
    req.pipe(upstream);
  }

  function proxyUpgrade(req, socket, head) {
    const upstream = net.connect(upstreamPort, upstreamHost, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(req.headers)) {
        const lower = name.toLowerCase();
        if (lower === "host") { lines.push(`Host: ${authority}`); continue; }
        if (lower === "origin") continue;
        if (Array.isArray(value)) for (const v of value) lines.push(`${name}: ${v}`);
        else lines.push(`${name}: ${value}`);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head && head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    const cleanup = () => { socket.destroy(); upstream.destroy(); };
    socket.on("error", cleanup);
    upstream.on("error", (err) => {
      log(`upgrade upstream error: ${err.message}`);
      try { socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch { /* ignore */ }
      cleanup();
    });
    socket.on("close", cleanup);
    upstream.on("close", cleanup);
  }

  const server = https.createServer({ key: keyPem, cert: certPem }, (req, res) => {
    if (req.method === "GET" && req.url.split("?")[0] === HELLO_PATH) {
      sendJson(res, 200, { ok: true, service: "dsh2phone-lan" });
      return;
    }
    const verdict = gate(req);
    if (verdict !== "ok") {
      log(`gate reject (${verdict}): ${req.socket.remoteAddress} ${req.method} ${req.url}`);
      // 文案与 relay 的门禁页一致，WebApp 的“授权失效”横幅靠标题识别。
      if (verdict === "denied") sendDeny(res, "设备已被停用", "该设备已被禁止访问（局域网直连）。");
      else sendDeny(res, "未知设备", "此设备尚未配对，或电脑端还没有同步设备列表。");
      return;
    }
    proxyRequest(req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    if (gate(req) !== "ok") { socket.destroy(); return; }
    proxyUpgrade(req, socket, head);
  });
  server.on("clientError", (err, socket) => {
    try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch { socket.destroy(); }
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  }).catch((err) => {
    log(`NOT listening: ${err.message} — LAN direct disabled (public relay path unaffected)`);
    return false;
  });
  if (!server.listening) {
    return { info: () => null, close() {} };
  }

  log(`edge listening on 0.0.0.0:${port} → ${upstreamHost}:${upstreamPort} (Host: ${authority})`);

  return {
    /** 通告给 relay / App 的直连信息；没有私有网段地址时返回 null。 */
    info() {
      const ips = privateLanIps();
      if (ips.length === 0) return null;
      return { port, fp, ips };
    },
    close() {
      for (const socket of sockets) socket.destroy();
      try { server.close(); } catch { /* ignore */ }
    },
  };
}
