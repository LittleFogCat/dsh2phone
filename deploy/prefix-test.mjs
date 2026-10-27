// Local pre-flight: simulate the public chain  browser -> [prefix-strip proxy] -> DSH loopback
// This is a stand-in for: nginx (TLS + /dsh/ strip) -> dsh-relay (WSS) -> tunnel -> DSH 127.0.0.1:43120
// Usage: node deploy/prefix-test.mjs   then open https://127.0.0.1:9443/dsh/?token=<your-token>
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM = process.env.UPSTREAM ?? "http://127.0.0.1:43120";
const PREFIX = "/dsh";
const PORT = 9999;         // plain HTTP
const TLS_PORT = 9443;     // TLS (mirrors nginx in production)
const tlsDir = join(dirname(fileURLToPath(import.meta.url)), "tls");
const tlsOpts = {
  key: readFileSync(join(tlsDir, "key.pem")),
  cert: readFileSync(join(tlsDir, "cert.pem")),
};

function stripPrefix(pathname) {
  if (pathname === PREFIX) return "/";
  if (pathname.startsWith(PREFIX + "/")) return pathname.slice(PREFIX.length);
  // mirror nginx's separate /dsh-pair location (strip to /pair)
  if (pathname === "/dsh-pair") return "/pair";
  if (pathname.startsWith("/dsh-pair/")) return "/pair/" + pathname.slice("/dsh-pair/".length);
  return pathname;
}

function handler(req, res) {
  const u = new URL(req.url, "http://x");
  const path = stripPrefix(u.pathname);
  const target = UPSTREAM + path + u.search;

  const headers = { ...req.headers };
  // In production nginx passes the public Host header. For this local test we keep
  // the loopback Host so DSH's trust fence accepts it without config changes.
  headers.host = "127.0.0.1:43120";
  delete headers.origin; // avoid origin mismatch in this local simulation

  const proxied = http.request(target, { method: req.method, headers }, (up) => {
    // rewrite any absolute redirects that would escape the prefix
    const loc = up.headers.location;
    if (loc && loc.startsWith("/") && !loc.startsWith(PREFIX + "/") && loc !== PREFIX) {
      up.headers.location = PREFIX + loc;
    }
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  proxied.on("error", (e) => {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("upstream error: " + e.message);
  });
  req.pipe(proxied);
}

function upgradeHandler(req, socket, head) {
  const u = new URL(req.url, "http://x");
  const path = stripPrefix(u.pathname);
  const headers = { ...req.headers, host: "127.0.0.1:43120" };
  const upstream = http.request(`${UPSTREAM}${path}${u.search}`, { headers });
  upstream.on("upgrade", (upRes, upSock, upHead) => {
    const lines = [`HTTP/1.1 101 Switching Protocols`];
    for (const [k, v] of Object.entries(upRes.headers)) lines.push(`${k}: ${v}`);
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (upHead?.length) socket.write(upHead);
    upSock.pipe(socket);
    socket.pipe(upSock);
  });
  upstream.on("error", () => socket.destroy());
  upstream.end();
}

const httpServer = http.createServer(handler);
httpServer.on("upgrade", upgradeHandler);
httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`prefix-strip proxy (http)  on http://127.0.0.1:${PORT}${PREFIX}/ -> ${UPSTREAM}`);
});

const tlsServer = https.createServer(tlsOpts, handler);
tlsServer.on("upgrade", upgradeHandler);
tlsServer.listen(TLS_PORT, "127.0.0.1", () => {
  console.log(`prefix-strip proxy (https) on https://127.0.0.1:${TLS_PORT}${PREFIX}/ -> ${UPSTREAM}`);
  console.log(`open: https://127.0.0.1:${TLS_PORT}${PREFIX}/?token=<token-from-desktop-settings> (accept the self-signed warning)`);
});
