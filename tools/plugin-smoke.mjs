// Local smoke test for the dsh2phone plugin host logic.
// Usage: node tools/plugin-smoke.mjs
// Starts a local relay (ports 13200/13201), then exercises:
//   1. module load of the plugin index.js (Typert Remote markers apply)
//   2. remoteMethods() discovery of all 8 Remote methods
//   3. openControl + devices.list / devices.set / devices.remove
//   4. full pair flow: pair.start → simulated phone /pair → pair.request →
//      pair.response(approved, minted cookie) → relay "ok" → device registered
//   5. DSH cookie mint format sanity
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { env } from "../shared/env.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pluginDir = join(root, "dsh2phone-dsh-plugin");
const pluginUrl = (name) => pathToFileURL(join(pluginDir, name)).href;

let relay = { kill() {} };
function fail(label, err) {
  console.error(`SMOKE FAIL [${label}]`, err?.message ?? err);
  process.exitCode = 1;
  relay.kill();
  process.exit(1);
}

// 1) module load (validates imports + markRemote against the real package).
// The plugin resolves @deepseek-ai packages from the Host's own tree when it
// can find it (DSH_APP_DIR or <execPath>/resources/app); point it at the
// installed Desktop app so this test uses the exact Host copies. DSH_APP_DIR
// comes from .env when the app is not installed next to this node binary.
if (!process.env.DSH_APP_DIR) {
  process.env.DSH_APP_DIR = env("DSH_APP_DIR", join(dirname(process.execPath), "resources", "app"));
}
if (!existsSync(join(process.env.DSH_APP_DIR, "package.json"))) {
  fail("locate DSH app", new Error(`DSH_APP_DIR does not look like the Desktop app dir: ${process.env.DSH_APP_DIR} (set it in .env)`));
}
let index;
try {
  index = await import(pluginUrl("host.js"));
} catch (err) {
  fail("import host.js", err);
}
console.log("host.js loaded, apply:", typeof index.apply);

const KEY = "e2e-plugin-key";
const DATA_PORT = 13200;
const CONTROL_PORT = 13201;
const STATE_DIR = join(root, ".plugin-smoke-state");
rmSync(STATE_DIR, { recursive: true, force: true });

// 2) Remote marker discovery (through the Host's own protocol copy)
const { createRequire } = await import("node:module");
const hostReq = createRequire(`${process.env.DSH_APP_DIR.replaceAll("\\", "/")}/package.json`);
const { remoteMethods } = hostReq("@deepseek-ai/dsh-typert-protocol");
const markers = remoteMethods(Object.create(index.Dsh2PhoneService.prototype));
const expected = ["pairStart", "pairInspect", "pairRespond", "pairCancel", "devicesList", "devicesSet", "devicesRemove", "devicesPanic"];
const got = markers.map((m) => m.exportName ?? m.method).sort();
if (JSON.stringify(got) !== JSON.stringify([...expected].sort())) fail("remoteMethods", new Error(`got ${JSON.stringify(got)}`));
console.log("remoteMethods:", got.join(", "));

// 3+4) relay protocol flows (relay must already be running when
// SMOKE_EXTERNAL_RELAY=1; otherwise it is spawned here)
if (process.env.SMOKE_EXTERNAL_RELAY !== "1") {
  rmSync(STATE_DIR, { recursive: true, force: true });
  relay = spawn(process.execPath, [join(root, "relay/src/relay.mjs")], {
  env: {
    ...process.env,
    RELAY_DATA_PORT: String(DATA_PORT),
    RELAY_CONTROL_PORT: String(CONTROL_PORT),
    DSH_TUNNEL_KEY: KEY,
    RELAY_STATE_DIR: STATE_DIR,
  },
  stdio: ["ignore", "pipe", "pipe"],
  });
  relay.stdout.on("data", (d) => process.stdout.write(`[relay] ${d}`));
  relay.stderr.on("data", (d) => process.stderr.write(`[relay!] ${d}`));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("relay did not start")), 8000);
    relay.stdout.on("data", (d) => { if (String(d).includes("control on")) { clearTimeout(timer); resolve(); } });
  });
}

const { openControl, sendExpect } = await import(pluginUrl("relay-admin.js"));
const { mintDshCookie, readBrowserSessionSecret } = await import(pluginUrl("dsh-cookie.js"));

const cfg = { relayUrl: `ws://127.0.0.1:${CONTROL_PORT}/tunnel`, key: KEY };

// The relay data plane (which serves /pair) only accepts requests while a
// tunnel-mode control connection is online — connect a fake tunnel first.
const tunnelWs = new WebSocket(cfg.relayUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("fake tunnel hello timeout")), 8000);
  tunnelWs.addEventListener("open", () => tunnelWs.send(JSON.stringify({ t: "hello", key: KEY })));
  tunnelWs.addEventListener("message", (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.t === "hello.ok") { clearTimeout(timer); resolve(); }
  });
  tunnelWs.addEventListener("error", () => { clearTimeout(timer); reject(new Error("fake tunnel connect failed")); });
});
console.log("fake tunnel online");

try {
  // clean slate (an external relay may carry state from an earlier run)
  const wsClean = await openControl(cfg);
  await sendExpect(wsClean, { t: "devices.panic" }, "ok");
  wsClean.close();

  // devices.list on empty state
  const wsAdmin = await openControl(cfg);
  const empty = await sendExpect(wsAdmin, { t: "devices.list" }, "devices");
  if ((empty.devices ?? []).length !== 0) fail("devices.list empty", new Error(JSON.stringify(empty.devices)));
  console.log("devices.list (empty) ok");
  wsAdmin.close();

  // pair.start
  const wsPair = await openControl(cfg);
  const session = await sendExpect(wsPair, { t: "pair.start" }, "pair.session");
  console.log("pair.session:", session.code, "expires", new Date(session.expiresAt).toISOString());

  // cookie mint sanity (local machine credentials)
  const cookie = mintDshCookie({ secret: readBrowserSessionSecret(), authority: env("DSH_AUTHORITY", "127.0.0.1:43120"), ttlDays: 30 });
  if (!/^dsh-auth-[A-Za-z0-9_-]+=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Max-Age=\d+;/.test(cookie.setCookie)) {
    fail("cookie format", new Error(cookie.setCookie.slice(0, 60)));
  }
  console.log("cookie minted:", cookie.name.slice(0, 24) + "…", `(${cookie.setCookie.length} chars)`);

  // simulated phone hits /pair on the data server
  const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const phonePromise = fetch(`http://127.0.0.1:${DATA_PORT}/pair?code=${session.code}&ua=${encodeURIComponent(ua)}&ip=203.0.113.9`, { redirect: "manual" });

  const request = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no pair.request frame")), 10000);
    const onMessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.t === "pair.request") { clearTimeout(timer); wsPair.removeEventListener("message", onMessage); resolve(m); }
    };
    wsPair.addEventListener("message", onMessage);
  });
  console.log("pair.request:", request.reqId, "ua-iPhone:", /iPhone/.test(request.ua));

  wsPair.send(JSON.stringify({
    t: "pair.response",
    reqId: request.reqId,
    approved: true,
    device: { id: "smoke-device-1", name: "iPhone · iOS 17 Safari" },
    dshCookie: cookie.setCookie,
  }));

  const phoneRes = await phonePromise;
  const phoneBody = await phoneRes.text();
  console.log("phone response:", phoneRes.status, phoneRes.headers.get("set-cookie") ? "+cookie" : "no-cookie");
  if (phoneRes.status !== 200) fail("phone landing page", new Error(String(phoneRes.status)));
  if (!phoneBody.includes("进入 DSH")) fail("landing page entry link", new Error(phoneBody.slice(0, 160)));
  if (!/href="\/dsh\/"/.test(phoneBody)) fail("landing page href", new Error(phoneBody.slice(0, 160)));
  console.log("phone landing page ok (+ 进入 DSH entry)");

  // The landing page doubles as the phone's entry point: a paired device gets it
  // again without a code (and even with a stale one).
  const deviceCookie = /dshdev=([^;]+)/.exec(
    (phoneRes.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("dshdev=")) ?? "",
  )?.[1];
  if (!deviceCookie) fail("device cookie", new Error("no dshdev cookie"));
  const httpMod = await import("node:http");
  const getPairPage = (path, withCookie) => new Promise((resolve, reject) => {
    const req = httpMod.request({
      host: "127.0.0.1", port: DATA_PORT, path, method: "GET",
      headers: { "user-agent": ua, ...(withCookie ? { cookie: `dshdev=${deviceCookie}` } : {}) },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
  const revisit = await getPairPage("/pair", true);
  if (revisit.status !== 200 || !revisit.body.includes("进入 DSH")) fail("revisit landing page", new Error(`${revisit.status}`));
  const waiting = await getPairPage("/pair", false);
  if (waiting.status !== 200 || !waiting.body.includes("需要先配对")) fail("waiting page", new Error(`${waiting.status}`));
  console.log("revisit landing page + waiting page ok");

  // Registration happens before the landing page is sent; the relay sends no
  // extra ack for pair.response — verify through the registry instead.
  const wsAdmin2 = await openControl(cfg);
  const after = await sendExpect(wsAdmin2, { t: "devices.list" }, "devices");
  const found = (after.devices ?? []).find((d) => d.id === "smoke-device-1");
  if (!found || found.status !== "allow") fail("device registered", new Error(JSON.stringify(after.devices)));
  console.log("device registered:", found.name, found.status);
  await sendExpect(wsAdmin2, { t: "devices.set", id: "smoke-device-1", status: "deny" }, "ok");
  await sendExpect(wsAdmin2, { t: "devices.remove", id: "smoke-device-1" }, "ok");
  const cleaned = await sendExpect(wsAdmin2, { t: "devices.list" }, "devices");
  if ((cleaned.devices ?? []).some((d) => d.id === "smoke-device-1")) fail("devices.remove", new Error("device still present"));
  console.log("deny + remove ok");
  wsAdmin2.close();
  wsPair.close();
  tunnelWs.close();

  console.log("SMOKE PASS");
  relay.kill();
  process.exit(0);
} catch (err) {
  fail("protocol flow", err);
}
