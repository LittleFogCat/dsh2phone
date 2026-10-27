// Regression test for the plugin's settings/config path.
//
// Covers what a fresh install hits before any pairing can work:
//   - pairStart returns {configRequired, issues} instead of throwing
//   - placeholder values (your-domain.example) are reported, not attempted
//   - configSave rejects format errors and writes .env while preserving comments
//   - after a successful save the config issues are gone
//   - probe() returns three independent legs even when the relay is unreachable
//
// usage: node tools/plugin-config-check.mjs
//
// It never touches the real .env: DSH2PHONE_ENV_FILE points at a temp file, and
// the real one is only read (never imported) to discover DSH_APP_DIR.
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function fail(label, detail) {
  console.error(`CONFIG CHECK FAIL [${label}]`, detail ?? "");
  process.exit(1);
}
function ok(label) {
  console.log(`ok  ${label}`);
}

// --- locate the DSH app tree without importing shared/env.mjs (importing it
// would freeze ENV_FILE to the real .env before we override it).
function dshAppDir() {
  if (process.env.DSH_APP_DIR) return process.env.DSH_APP_DIR;
  try {
    const text = readFileSync(join(root, ".env"), "utf8");
    const match = /^DSH_APP_DIR=(.*)$/m.exec(text);
    return match?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}
process.env.DSH_APP_DIR = dshAppDir();
if (!process.env.DSH_APP_DIR) fail("locate DSH app", "set DSH_APP_DIR (see .env.example)");

// --- throwaway .env, pre-seeded with comments and placeholder endpoints
const dir = mkdtempSync(join(tmpdir(), "dsh2phone-config-"));
const envFile = join(dir, ".env");
writeFileSync(envFile, [
  "# hand-written comment that must survive",
  "RELAY_URL=wss://old.example/dsh-tunnel",
  "PUBLIC_PAIR_URL=https://old.example/dsh-pair",
  "",
].join("\n"), "utf8");
process.env.DSH2PHONE_ENV_FILE = envFile;
// A fresh install has no key file either; point at a path that cannot exist so
// the "missing key" branch is exercised regardless of the developer's workspace.
process.env.DSH2PHONE_KEY_FILE = join(dir, "tunnel.key");
// Exported by the launcher, i.e. present before .env is loaded: a save must
// report it as shadowed instead of pretending it took effect.
process.env.DSH_AUTHORITY = "127.0.0.1:43120";
for (const name of ["RELAY_URL", "PUBLIC_PAIR_URL", "DSH_TUNNEL_KEY", "DSH2PHONE_TTL_DAYS"]) {
  delete process.env[name];
}

const hostReq = createRequire(join(process.env.DSH_APP_DIR, "package.json"));
const { Context } = hostReq("@deepseek-ai/cordis");
const { Dsh2PhoneService } = await import("../dsh2phone-dsh-plugin/host.js");

const make = () => new Dsh2PhoneService(new Context(), {});

let service = make();
try {
  // 1. placeholder + missing key ⇒ configRequired, never a connection attempt
  const started = await service.pairStart();
  if (started?.configRequired !== true) fail("pairStart configRequired", JSON.stringify(started));
  const fields = started.issues.map((item) => item.field).sort();
  if (!fields.includes("relayUrl") || !fields.includes("publicKeyUrl") || !fields.includes("tunnelKey")) {
    fail("missing fields", JSON.stringify(started.issues));
  }
  if (!started.issues.some((item) => item.code === "placeholder")) fail("placeholder detection", JSON.stringify(started.issues));
  ok("pairStart → configRequired（占位符 + 缺密钥，未建立连接）");

  // 2. devicesList gives a readable error instead of "Invalid URL"
  let devicesError = "";
  try {
    await service.devicesList();
  } catch (err) {
    devicesError = err.message;
  }
  if (!/还缺配置/.test(devicesError)) fail("devicesList guard", devicesError);
  ok(`devicesList → 可读错误（${devicesError.slice(0, 24)}…）`);

  // 3. format errors block the write
  const bad = await service.configSave({ relayUrl: "relay.example/dsh-tunnel" });
  if (bad.saved !== false || !bad.errors?.some((item) => item.code === "scheme")) {
    fail("scheme validation", JSON.stringify(bad));
  }
  ok("configSave 拒绝缺少 wss:// 的地址");

  // 4. a valid save rewrites values in place and appends the new key
  const saved = await service.configSave({
    relayUrl: "wss://relay.test/dsh-tunnel",
    publicKeyUrl: "https://relay.test/dsh-pair",
    tunnelKey: "0123456789abcdef0123456789abcdef0123456789abcdef",
    authority: "127.0.0.1:43199",
    ttlDays: 30,
  });
  if (saved.saved !== true) fail("save", JSON.stringify(saved));
  if (saved.issues.length !== 0) fail("save leaves issues", JSON.stringify(saved.issues));
  if (!saved.shadowed.includes("DSH_AUTHORITY")) fail("shadowed detection", JSON.stringify(saved.shadowed));
  if (saved.snapshot.values.authority !== "127.0.0.1:43120") fail("preset env must win", saved.snapshot.values.authority);
  const text = readFileSync(envFile, "utf8");
  if (!text.includes("# hand-written comment that must survive")) fail("comment preserved", text);
  if (!/^RELAY_URL=wss:\/\/relay\.test\/dsh-tunnel$/m.test(text)) fail("relay rewritten", text);
  if (!/^DSH_TUNNEL_KEY=0123456789abcdef0123456789abcdef0123456789abcdef$/m.test(text)) fail("key appended", text);
  if (!saved.appended.includes("DSH_TUNNEL_KEY")) fail("appended list", JSON.stringify(saved.appended));
  if (saved.snapshot.values.hasTunnelKey !== true) fail("snapshot key", JSON.stringify(saved.snapshot.values));
  if (saved.snapshot.sources.relayUrl !== "env") fail("snapshot source", JSON.stringify(saved.snapshot.sources));
  ok("configSave 写入 .env（保留注释、追加密钥、快照更新）");

  // 5. the same instance is ready now: pairing attempts a connection instead of
  //    asking for config (it fails because relay.test does not resolve)
  let afterSave = null;
  try {
    afterSave = await service.pairStart();
  } catch (err) {
    afterSave = { threw: err.message };
  }
  if (afterSave?.configRequired === true) fail("still configRequired after save", JSON.stringify(afterSave));
  ok(`保存后 pairStart 进入连接阶段（${afterSave?.threw ? `预期失败：${afterSave.threw.slice(0, 32)}…` : "已连上"}）`);

  // 6. probe reports each leg independently
  const probed = await service.probe();
  for (const leg of ["local", "control", "public"]) {
    if (typeof probed[leg]?.ok !== "boolean") fail(`probe ${leg}`, JSON.stringify(probed));
  }
  if (probed.control.ok !== false) fail("probe control should fail for relay.test", JSON.stringify(probed.control));
  if (typeof probed.control.error !== "string") fail("probe control error", JSON.stringify(probed.control));
  ok(`probe 三段独立返回（control: ${probed.control.ok ? "ok" : "failed"}，public: ${probed.public.ok ? "ok" : "failed"}）`);

  console.log("CONFIG CHECK PASS");
} catch (err) {
  fail("unexpected", err?.stack ?? String(err));
} finally {
  try { service.closePair(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
