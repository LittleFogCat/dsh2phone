// Reproduce the production device gate locally: same relay code, same key, a
// copy of the production registry, and a fake tunnel so data-plane requests are
// evaluated (the gate decision happens before piping).
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import http from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, env } from "../shared/env.mjs";

const keyFile = env("DSH2PHONE_KEY_FILE", join(REPO_ROOT, "deploy", "server", "tunnel.key"));
const key = env("DSH_TUNNEL_KEY") ?? readFileSync(keyFile, "utf8").trim();
const stateDir = join(process.cwd(), ".gate-repro-state");
rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });

// one allowed device, written exactly the way the relay persists it
const id = "0f7b9db7-694f-4c23-9d4f-c8b8890e6fc5";
const sign = (value) => createHmac("sha256", key).update(value).digest("base64url");
const cookie = `${id}.${sign(id)}`;
writeFileSync(join(stateDir, "devices.json"), JSON.stringify({
  version: 1,
  devices: [{ id, name: "probe", ua: "probe", status: "allow", createdAt: Date.now(), lastSeen: Date.now(), lastIp: "203.0.113.9" }],
}, null, 2));

const relay = spawn(process.execPath, ["relay/src/relay.mjs"], {
  env: {
    ...process.env,
    RELAY_DATA_PORT: "13300",
    RELAY_CONTROL_PORT: "13301",
    DSH_TUNNEL_KEY: key,
    RELAY_STATE_DIR: stateDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
relay.stdout.on("data", (d) => process.stdout.write(`[relay] ${d}`));
relay.stderr.on("data", (d) => process.stderr.write(`[relay!] ${d}`));
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("relay start timeout")), 8000);
  relay.stdout.on("data", (d) => { if (String(d).includes("data on")) { clearTimeout(timer); resolve(); } });
});

// fake tunnel: hello without mode, listen for open frames
const frames = [];
const tunnel = new WebSocket("ws://127.0.0.1:13301/tunnel");
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("tunnel hello timeout")), 8000);
  tunnel.addEventListener("open", () => tunnel.send(JSON.stringify({ t: "hello", key })));
  tunnel.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") {
      const msg = JSON.parse(ev.data);
      if (msg.t === "hello.ok") { clearTimeout(timer); resolve(); }
      else frames.push(msg);
    }
  });
});

function request(headers) {
  // An approved request is piped to the (fake) tunnel and never answered, so a
  // timeout is the expected "gate let it through" outcome; a 403 is a denial.
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: 13300, path: "/", method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 80) }));
    });
    req.on("error", () => resolve({ status: "error" }));
    req.setTimeout(2000, () => { req.destroy(); resolve({ status: "piped" }); });
    req.end();
  });
}

const results = {};
results.withCookie = await request({ cookie: `dshdev=${cookie}`, host: "127.0.0.1:43120" });
await new Promise((r) => setTimeout(r, 300));
results.framesAfter = frames.map((f) => f.t);
results.withoutCookie = await request({ host: "127.0.0.1:43120" });

console.log(JSON.stringify(results, null, 2));
tunnel.close();
relay.kill();
rmSync(stateDir, { recursive: true, force: true });
