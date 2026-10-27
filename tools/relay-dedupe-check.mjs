// Deduplication check for the relay's pairing flow (no DSH, no GUI needed).
//
// Plays the PC side (admin control connection that starts pairing sessions and
// auto-approves), a fake tunnel, and a phone with a cookie jar. Asserts that
// re-pairing the same browser reuses its registry entry instead of adding one.
//
// usage: node tools/relay-dedupe-check.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import http from "node:http";

const KEY = "dedupe-check-key";
const DATA_PORT = 13300;
const CONTROL_PORT = 13301;
const UA_A = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36";
const UA_B = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const stateDir = mkdtempSync(join(tmpdir(), "d2p-dedupe-"));
const relay = spawn(process.execPath, ["relay/src/relay.mjs"], {
  env: {
    ...process.env,
    RELAY_DATA_PORT: String(DATA_PORT),
    RELAY_CONTROL_PORT: String(CONTROL_PORT),
    DSH_TUNNEL_KEY: KEY,
    RELAY_STATE_DIR: stateDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
relay.stdout.on("data", (c) => process.stderr.write("[relay] " + c));
relay.stderr.on("data", (c) => process.stderr.write("[relay] " + c));
await wait(1200);

function connect(mode) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${CONTROL_PORT}/tunnel`);
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", key: KEY, ...(mode ? { mode } : {}) })));
    ws.on("message", (data) => {
      if (JSON.parse(data.toString()).t === "hello.ok") resolve(ws);
    });
    ws.on("error", reject);
  });
}

// Minimal phone: GET the pairing URL with an optional device cookie.
function get(path, { cookie, ua } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: DATA_PORT, path, method: "GET", headers: { ...(cookie ? { cookie } : {}), "user-agent": ua ?? "" } },
      (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode, body, cookies: res.headers["set-cookie"] ?? [] }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const tunnel = await connect();
const admin = await connect("admin");
const seen = [];
admin.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.t !== "pair.request") return;
  seen.push(msg);
  admin.send(JSON.stringify({
    t: "pair.response",
    reqId: msg.reqId,
    approved: true,
    device: { id: randomUUID(), name: "Test Phone" },
    dshCookie: "dsh-auth-test=1; Path=/; HttpOnly; SameSite=Strict",
  }));
});

function startPair() {
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.t === "pair.session") { admin.off("message", onMessage); resolve(msg.code); }
    };
    admin.on("message", onMessage);
    admin.send(JSON.stringify({ t: "pair.start" }));
    setTimeout(() => reject(new Error("pair.start timeout")), 5000);
  });
}

// The relay debounces registry writes by 250ms.
async function devicesNow() {
  await wait(400);
  try {
    return JSON.parse(readFileSync(join(stateDir, "devices.json"), "utf8")).devices;
  } catch {
    return [];
  }
}
const deviceCookie = (cookies) => {
  const pair = cookies.find((c) => c.startsWith("dshdev="));
  return pair ? pair.split(";")[0] : "";
};

const result = {};
try {
  // 1) first pairing -> a new entry
  let code = await startPair();
  let res = await get(`/pair?code=${code}`, { ua: UA_A });
  const cookieA = deviceCookie(res.cookies);
  result.firstPair = {
    status: res.status,
    hasCookie: cookieA !== "",
    cookieSameSiteLax: /SameSite=Lax/i.test(res.cookies.find((c) => c.startsWith("dshdev=")) ?? ""),
    devices: (await devicesNow()).length,
  };

  // 2) same browser with its device cookie -> must reuse the entry
  code = await startPair();
  res = await get(`/pair?code=${code}`, { ua: UA_A, cookie: cookieA });
  result.secondPair = {
    status: res.status,
    devices: (await devicesNow()).length,
    requestHadExisting: seen.at(-1)?.existing?.id?.length > 0,
  };

  // 3) same browser, cookie lost -> the UA fallback still reuses the entry
  code = await startPair();
  res = await get(`/pair?code=${code}`, { ua: UA_A });
  result.thirdPairNoCookie = { status: res.status, devices: (await devicesNow()).length };

  // 4) a genuinely different device still gets its own entry
  code = await startPair();
  res = await get(`/pair?code=${code}`, { ua: UA_B });
  result.otherDevice = { status: res.status, devices: (await devicesNow()).length };

  result.deviceIds = (await devicesNow()).map((d) => d.id.slice(0, 8));
  result.ok = result.firstPair.devices === 1
    && result.secondPair.devices === 1
    && result.thirdPairNoCookie.devices === 1
    && result.otherDevice.devices === 2
    && result.secondPair.requestHadExisting === true
    && result.firstPair.cookieSameSiteLax === true;
} catch (err) {
  result.failure = err.message;
} finally {
  try { admin.close(); tunnel.close(); } catch { /* ignore */ }
  relay.kill();
  await wait(300);
  rmSync(stateDir, { recursive: true, force: true });
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
