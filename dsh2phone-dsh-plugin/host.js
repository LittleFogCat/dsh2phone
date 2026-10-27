// Host half of the dsh2phone plugin.
//
// Exposes Typert Remote methods (namespace "dsh2phone") that the Client UI calls:
//   pairStart / pairInspect / pairRespond / pairCancel   — the pairing flow
//   devicesList / devicesSet / devicesRemove / devicesPanic — whitelist management
//   configGet / configSave / probe / newTunnelKey       — the settings tab
//
// The pairing flow opens its own admin connection to the dsh-relay control plane
// (protocol identical to tunnel/pair.cmd), mints the DSH browser cookie locally
// (token never crosses the public network) and renders the QR code with the
// `qrcode` package as a PNG data URL for the Client to display.
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
// Loads <repo>/.env — every endpoint/secret below comes from there, never from
// this file (see .env.example).
import { ENV_FILE, REPO_ROOT, env, envFlag, presetEnvKeys, updateEnvFile } from "../shared/env.mjs";
import { deviceNameFromUA, mintDshCookie, readBrowserSessionSecret } from "./dsh-cookie.js";
import { openControl, sendExpect } from "./relay-admin.js";

// A workspace-linked plugin sits outside the Host's package tree, so a plain
// `import '@deepseek-ai/dsh-typert-protocol'` would load a second copy of the
// Service/Typert classes. The Host Gateway validates receivers against its own
// class identities, so resolve the Host's exact copies first.
function hostRequire() {
  const candidates = [
    process.env.DSH_APP_DIR,
    join(dirname(process.execPath), "resources", "app"),
  ].filter((value) => typeof value === "string" && value.length > 0);
  for (const dir of candidates) {
    const pkg = join(dir, "package.json");
    if (!existsSync(pkg)) continue;
    try {
      return createRequire(pkg);
    } catch { /* try the next candidate */ }
  }
  return undefined;
}

const hostReq = hostRequire();
let Remote;
let TypertRemoteService;
let QRCode;
let WebSocketImpl;
try {
  if (!hostReq) throw new Error("host package tree not found");
  ({ Remote, TypertRemoteService } = hostReq("@deepseek-ai/dsh-typert-protocol"));
  QRCode = hostReq("qrcode");
  // `ws` supports TLS options (needed when the relay is addressed by IP);
  // Node's global WebSocket has no such options.
  WebSocketImpl = hostReq("ws").WebSocket;
} catch {
  ({ Remote, TypertRemoteService } = await import("@deepseek-ai/dsh-typert-protocol"));
  QRCode = createRequire(import.meta.url)("qrcode");
  WebSocketImpl = globalThis.WebSocket;
}

const NS = "dsh2phone";

// Shape only: every value that depends on the deployment (or is a secret) is
// resolved from .env in envValues(). Precedence, lowest to highest:
//   DEFAULTS → plugin config from cordis.patch.yml → real environment / .env
// .env wins on purpose: it is the documented single source, and the settings tab
// writes there. A stale profile row from an older install therefore cannot
// shadow what the user just saved.
const DEFAULTS = {
  relayUrl: "",
  publicKeyUrl: "",
  keyFile: "",
  tunnelKey: "",
  authority: "127.0.0.1:43120",
  credentialsFile: undefined,
  ttlDays: 30,
  // true when relayUrl/publicKeyUrl use an IP address: the certificate is
  // issued for the domain name, so verification must be relaxed.
  allowInvalidCert: false,
};

/** Values explicitly present in the environment/.env (absence stays absent). */
function envValues() {
  /** @type {Record<string, unknown>} */
  const values = {};
  const put = (key, name, parse = (value) => value) => {
    const raw = env(name);
    if (raw !== undefined) values[key] = parse(raw);
  };
  put("relayUrl", "RELAY_URL");
  put("publicKeyUrl", "PUBLIC_PAIR_URL");
  put("tunnelKey", "DSH_TUNNEL_KEY");
  put("keyFile", "DSH2PHONE_KEY_FILE");
  put("authority", "DSH_AUTHORITY");
  put("credentialsFile", "DSH_CREDENTIALS_FILE");
  put("ttlDays", "DSH2PHONE_TTL_DAYS", Number);
  if (env("DSH2PHONE_ALLOW_INVALID_CERT") !== undefined) {
    values.allowInvalidCert = envFlag("DSH2PHONE_ALLOW_INVALID_CERT");
  }
  return values;
}

/** Legacy key file location, used only when .env names no key at all. */
function defaultKeyFile() {
  const candidate = join(REPO_ROOT, "deploy", "server", "tunnel.key");
  return existsSync(candidate) ? candidate : "";
}

/** Template leftovers that parse as URLs but never connect anywhere. */
const PLACEHOLDER = /(?:^|[./])example(?:\.(?:com|org|net|invalid))?(?=[/:]|$)|your-domain|replace-with|change-me/iu;

const FIELD_LABELS = {
  relayUrl: "中继地址 RELAY_URL",
  publicKeyUrl: "配对地址 PUBLIC_PAIR_URL",
  tunnelKey: "隧道密钥 DSH_TUNNEL_KEY",
  authority: "authority DSH_AUTHORITY",
  ttlDays: "有效期 DSH2PHONE_TTL_DAYS",
};

function issue(field, code, message) {
  return { field, code, message };
}

/** Validate the connection-critical fields; empty array means "ready to pair". */
function configIssues(cfg) {
  const issues = [];
  const url = (field, value, schemes) => {
    if (!value) return issues.push(issue(field, "missing", `请填写${FIELD_LABELS[field]}`));
    if (!new RegExp(`^(?:${schemes}):\\/\\/`, "iu").test(value)) {
      return issues.push(issue(field, "scheme", `${FIELD_LABELS[field]} 需要以 ${schemes.split("|")[0]}:// 开头`));
    }
    try {
      new URL(value);
    } catch {
      return issues.push(issue(field, "invalid", `${FIELD_LABELS[field]} 不是合法地址`));
    }
    if (PLACEHOLDER.test(value)) {
      return issues.push(issue(field, "placeholder", `${FIELD_LABELS[field]} 还是模板占位值，请改成你自己的域名`));
    }
    return undefined;
  };
  url("relayUrl", cfg.relayUrl, "ws|wss");
  url("publicKeyUrl", cfg.publicKeyUrl, "http|https");
  if (!cfg.tunnelKey) {
    if (!cfg.keyFile) {
      issues.push(issue("tunnelKey", "missing", "请填写隧道密钥，或点“生成密钥”（需与服务器一致）"));
    } else if (!existsSync(cfg.keyFile)) {
      issues.push(issue("tunnelKey", "missing", `密钥文件不存在：${cfg.keyFile}`));
    }
  }
  if (cfg.authority && !/^[A-Za-z0-9.-]+:\d{2,5}$/u.test(cfg.authority)) {
    issues.push(issue("authority", "invalid", "authority 形如 127.0.0.1:43120"));
  }
  if (!Number.isFinite(cfg.ttlDays) || cfg.ttlDays < 1 || cfg.ttlDays > 365) {
    issues.push(issue("ttlDays", "invalid", "有效期需在 1–365 天之间"));
  }
  return issues;
}

function maskSecret(value) {
  if (!value) return "";
  if (value.length <= 12) return "***";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Reject instead of hanging when a probe target is unreachable. */
async function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${message}（${ms}ms 超时）`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** dsh-relay admin session behind one pairing flow. */
class PairSession {
  constructor(ws, { code, expiresAt, qrImage }) {
    this.id = randomUUID();
    this.ws = ws;
    this.status = "pending_scan"; // pending_scan | pending_confirm | approved | rejected | expired | closed
    this.code = code;
    this.expiresAt = expiresAt;
    this.qrImage = qrImage;
    this.request = null; // { reqId, ua, ip, name } while pending_confirm
    this.error = null;
  }

  snapshot() {
    return {
      id: this.id,
      status: this.status,
      code: this.code,
      expiresAt: this.expiresAt,
      qrImage: this.qrImage,
      request: this.request,
      error: this.error,
    };
  }
}

class Dsh2PhoneService extends TypertRemoteService {
  // NOTE: cordis invokes service methods with a traced Proxy as `this`, so
  // ECMAScript private methods/fields (#x) fail V8's brand check there
  // ("Receiver must be an instance of class …"). Keep helpers public.
  constructor(ctx, config) {
    super(ctx, NS);
    // cordis may hand over `undefined` (omitted YAML option) or an empty string;
    // neither may clobber a real value.
    this.configOverrides = Object.fromEntries(
      Object.entries(config ?? {}).filter(([, value]) => value !== undefined && value !== ""),
    );
    this.reloadConfig();
    this.pair = null;
    ctx.effect(() => () => this.closePair(), "dsh2phone.pairDispose");
  }

  /** Recompute cfg: DEFAULTS → plugin config → .env (highest). */
  reloadConfig() {
    const merged = { ...DEFAULTS, ...this.configOverrides, ...envValues() };
    if (!merged.keyFile && !merged.tunnelKey) merged.keyFile = defaultKeyFile();
    if (!Number.isFinite(merged.ttlDays) || merged.ttlDays <= 0) merged.ttlDays = DEFAULTS.ttlDays;
    this.cfg = merged;
    return merged;
  }

  /** Where each connection field came from (shown in the settings tab). */
  configSources() {
    const fromEnv = envValues();
    const pick = (key) => (Object.hasOwn(fromEnv, key) ? "env" : (Object.hasOwn(this.configOverrides, key) ? "config" : "default"));
    const keyFromEnv = Object.hasOwn(fromEnv, "tunnelKey") || Object.hasOwn(fromEnv, "keyFile");
    const keyFromConfig = Object.hasOwn(this.configOverrides, "tunnelKey") || Object.hasOwn(this.configOverrides, "keyFile");
    return {
      relayUrl: pick("relayUrl"),
      publicKeyUrl: pick("publicKeyUrl"),
      authority: pick("authority"),
      ttlDays: pick("ttlDays"),
      tunnelKey: keyFromEnv ? "env" : keyFromConfig ? "config" : (this.cfg.keyFile ? "file" : "default"),
    };
  }

  /** The key in effect: DSH_TUNNEL_KEY, else the legacy key file. */
  tunnelKeyValue() {
    if (this.cfg.tunnelKey) return this.cfg.tunnelKey;
    if (!this.cfg.keyFile) return "";
    try {
      return readFileSync(this.cfg.keyFile, "utf8").trim();
    } catch (err) {
      throw new Error(`隧道密钥文件读不出来（${this.cfg.keyFile}）：${err.message}`);
    }
  }

  relayKey() {
    const key = this.tunnelKeyValue();
    if (!key) throw new Error("dsh2phone: 还没有隧道密钥 — 在“设置”里生成并保存，或设置 DSH_TUNNEL_KEY");
    return key;
  }

  /** Throw a readable error instead of a raw "Invalid URL" when config is incomplete. */
  requireConfigured() {
    const issues = configIssues(this.cfg);
    if (issues.length === 0) return;
    throw new Error(`还缺配置：${issues.map((item) => item.message).join("；")}。打开“设置”填写后保存。`);
  }

  /** The key in effect, or "" — never throws (used by the settings snapshot). */
  safeTunnelKey() {
    try {
      return this.tunnelKeyValue();
    } catch {
      return "";
    }
  }

  /** Everything the settings tab renders. Never includes the raw key. */
  configSnapshot() {
    const key = this.safeTunnelKey();
    return {
      envFile: ENV_FILE,
      repoRoot: REPO_ROOT,
      values: {
        relayUrl: this.cfg.relayUrl,
        publicKeyUrl: this.cfg.publicKeyUrl,
        authority: this.cfg.authority,
        ttlDays: this.cfg.ttlDays,
        allowInvalidCert: this.cfg.allowInvalidCert === true,
        hasTunnelKey: key !== "",
        tunnelKeyMask: maskSecret(key),
        keyFile: this.cfg.keyFile,
      },
      sources: this.configSources(),
      issues: configIssues(this.cfg),
    };
  }

  async configGet() {
    return this.configSnapshot();
  }

  /**
   * Persist the settings tab form into .env.
   * Format errors block the write; missing fields do not (the user may fill the
   * relay first and the pairing URL later).
   */
  async configSave(patch = {}) {
    const candidate = { ...this.cfg };
    if (typeof patch.relayUrl === "string") candidate.relayUrl = patch.relayUrl.trim();
    if (typeof patch.publicKeyUrl === "string") candidate.publicKeyUrl = patch.publicKeyUrl.trim();
    if (typeof patch.authority === "string") candidate.authority = patch.authority.trim();
    if (typeof patch.tunnelKey === "string" && patch.tunnelKey.trim() !== "") candidate.tunnelKey = patch.tunnelKey.trim();
    if (patch.ttlDays !== undefined && patch.ttlDays !== "") candidate.ttlDays = Number(patch.ttlDays);
    if (patch.allowInvalidCert !== undefined) candidate.allowInvalidCert = Boolean(patch.allowInvalidCert);

    const issues = configIssues(candidate);
    const hard = issues.filter((item) => item.code !== "missing" && item.code !== "placeholder");
    if (hard.length > 0) {
      return { saved: false, errors: hard, snapshot: this.configSnapshot(), issues };
    }

    /** @type {Record<string, string>} */
    const updates = {};
    if (patch.relayUrl !== undefined) updates.RELAY_URL = candidate.relayUrl;
    if (patch.publicKeyUrl !== undefined) updates.PUBLIC_PAIR_URL = candidate.publicKeyUrl;
    if (typeof patch.tunnelKey === "string" && patch.tunnelKey.trim() !== "") updates.DSH_TUNNEL_KEY = candidate.tunnelKey;
    if (patch.authority !== undefined) updates.DSH_AUTHORITY = candidate.authority;
    if (patch.ttlDays !== undefined) updates.DSH2PHONE_TTL_DAYS = String(candidate.ttlDays);
    if (patch.allowInvalidCert !== undefined) updates.DSH2PHONE_ALLOW_INVALID_CERT = candidate.allowInvalidCert ? "1" : "0";

    if (Object.keys(updates).length === 0) {
      return { saved: true, changed: 0, file: ENV_FILE, shadowed: [], snapshot: this.configSnapshot(), issues };
    }

    let written;
    try {
      written = updateEnvFile(ENV_FILE, updates);
    } catch (err) {
      return { saved: false, errors: [{ field: "envFile", code: "write", message: `写不进 ${ENV_FILE}：${err.message}` }], snapshot: this.configSnapshot(), issues };
    }
    // Apply immediately. Values exported by the launcher (present before .env was
    // loaded) still win at the OS level, so those are reported, not faked.
    const preset = presetEnvKeys();
    const shadowed = [];
    for (const [name, value] of Object.entries(updates)) {
      if (preset.has(name) && process.env[name] !== value) {
        shadowed.push(name);
        continue;
      }
      process.env[name] = value;
    }
    this.reloadConfig();

    return {
      saved: true,
      changed: Object.keys(updates).length,
      file: written.file,
      created: written.created,
      appended: written.appended,
      shadowed,
      snapshot: this.configSnapshot(),
      issues: configIssues(this.cfg),
    };
  }

  /** Fresh 48-hex key for the settings form (not persisted until saved). */
  async newTunnelKey() {
    return { key: randomBytes(24).toString("hex") };
  }

  /**
   * Connectivity self-test: local DSH, relay control plane, public pairing page.
   * Each leg reports independently so a partial outage still produces answers.
   */
  async probe() {
    const at = Date.now();
    const timed = async (fn) => {
      const started = Date.now();
      try {
        return { ok: true, ms: Date.now() - started, ...(await fn()) };
      } catch (err) {
        return { ok: false, ms: Date.now() - started, error: err?.message ?? String(err) };
      }
    };
    const local = await timed(async () => {
      const res = await withTimeout(fetch(`http://${this.cfg.authority}/`), 5000, "本机 DSH 无响应");
      return { status: res.status };
    });
    const control = await timed(async () => {
      const reply = await this.adminCall({ t: "devices.list" }, "devices", { timeoutMs: 10000 });
      return { devices: (reply.devices ?? []).length };
    });
    const publicPage = await timed(async () => {
      if (!this.cfg.publicKeyUrl) throw new Error("未填写 PUBLIC_PAIR_URL");
      const res = await withTimeout(fetch(this.cfg.publicKeyUrl, { redirect: "manual" }), 8000, "公网配对页无响应");
      return { status: res.status };
    });
    return { at, local, control, public: publicPage };
  }

  closePair() {
    const session = this.pair;
    this.pair = null;
    if (!session) return;
    try { session.ws.close(); } catch { /* ignore */ }
    if (session.status === "pending_scan" || session.status === "pending_confirm") session.status = "closed";
  }

  requirePair(id) {
    const session = this.pair;
    if (!session || session.id !== id) throw new Error("配对会话不存在或已结束，请重新发起配对");
    return session;
  }

  /** Start a pairing session: admin WSS → pair.start → QR data URL. */
  async pairStart() {
    // Incomplete configuration is not an exception here: the client switches to
    // its settings tab and fills the gaps, so return the issues instead.
    const issues = configIssues(this.cfg);
    if (issues.length > 0) {
      return { configRequired: true, issues, snapshot: this.configSnapshot() };
    }
    // Fail fast: verify the DSH cookie can be minted before showing any QR.
    const secret = readBrowserSessionSecret(this.cfg.credentialsFile);
    mintDshCookie({ secret, authority: this.cfg.authority, ttlDays: this.cfg.ttlDays });
    this.closePair();

    const ws = await openControl({ relayUrl: this.cfg.relayUrl, key: this.relayKey(), WebSocketImpl, insecure: this.cfg.allowInvalidCert === true });
    let reply;
    try {
      reply = await sendExpect(ws, { t: "pair.start" }, "pair.session");
    } catch (err) {
      try { ws.close(); } catch { /* ignore */ }
      throw err;
    }
    const url = `${this.cfg.publicKeyUrl}?code=${encodeURIComponent(reply.code)}`;
    const qrImage = await QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 3, width: 320 });

    const session = new PairSession(ws, { code: reply.code, expiresAt: reply.expiresAt, qrImage });
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.t === "pair.request") {
        session.status = "pending_confirm";
        session.request = {
          reqId: msg.reqId,
          ua: msg.ua ?? "",
          ip: msg.ip ?? "",
          name: deviceNameFromUA(msg.ua ?? ""),
          // Present when the relay recognised this browser as an already-paired
          // device: approving refreshes that entry instead of adding a new one.
          existing: msg.existing ?? null,
        };
      } else if (msg.t === "error") {
        session.error = String(msg.message ?? "relay error");
      }
    });
    ws.addEventListener("close", () => {
      if (this.pair === session && (session.status === "pending_scan" || session.status === "pending_confirm")) {
        session.status = "closed";
      }
    });
    this.pair = session;
    return session.snapshot();
  }

  /** Poll the pairing session; also expires it past its deadline. */
  async pairInspect(id) {
    const session = this.requirePair(id);
    if ((session.status === "pending_scan" || session.status === "pending_confirm") && Date.now() > session.expiresAt) {
      session.status = "expired";
    }
    return session.snapshot();
  }

  /** Answer a pending pair.request; minting a fresh cookie when approved. */
  async pairRespond(id, reqId, approved) {
    const session = this.requirePair(id);
    if (session.status !== "pending_confirm" || session.request?.reqId !== reqId) {
      throw new Error("配对请求已失效，请让对方重新扫码");
    }
    const device = approved ? { id: randomUUID(), name: session.request.name } : undefined;
    const dshCookie = approved
      ? mintDshCookie({ secret: readBrowserSessionSecret(this.cfg.credentialsFile), authority: this.cfg.authority, ttlDays: this.cfg.ttlDays }).setCookie
      : undefined;
    session.ws.send(JSON.stringify({ t: "pair.response", reqId, approved, device, dshCookie }));
    session.status = approved ? "approved" : "rejected";
    return session.snapshot();
  }

  /** Drop the current pairing session (dialog closed by the user). */
  async pairCancel(id) {
    const session = this.requirePair(id);
    try { session.ws.close(); } catch { /* ignore */ }
    if (this.pair === session) this.pair = null;
    session.status = "closed";
    return session.snapshot();
  }

  /** One-shot admin connection for whitelist operations (same as the CLI). */
  async adminCall(request, expectT, { timeoutMs } = {}) {
    this.requireConfigured();
    const ws = await openControl({
      relayUrl: this.cfg.relayUrl,
      key: this.relayKey(),
      WebSocketImpl,
      insecure: this.cfg.allowInvalidCert === true,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    try {
      return await sendExpect(ws, request, expectT, timeoutMs === undefined ? {} : { timeoutMs });
    } finally {
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  async devicesList() {
    const reply = await this.adminCall({ t: "devices.list" }, "devices");
    return { devices: reply.devices ?? [] };
  }

  async devicesSet(id, status) {
    await this.adminCall({ t: "devices.set", id, status }, "ok");
    return { ok: true };
  }

  async devicesRemove(id) {
    await this.adminCall({ t: "devices.remove", id }, "ok");
    return { ok: true };
  }

  async devicesPanic() {
    await this.adminCall({ t: "devices.panic" }, "ok");
    return { ok: true };
  }
}

// The @Remote decorator needs a stage-3 method context; apply the same markers
// programmatically (see @deepseek-ai/dsh-typert-protocol lib/index.js mark()).
function markRemote(Ctor, method) {
  let initializer;
  Remote(method)(Ctor.prototype[method], {
    kind: "method",
    name: method,
    static: false,
    private: false,
    access: { has: (obj) => method in obj, get: (obj) => obj[method] },
    metadata: undefined,
    addInitializer(fn) { initializer = fn; },
  });
  initializer.call(Object.create(Ctor.prototype));
}

for (const method of [
  "pairStart",
  "pairInspect",
  "pairRespond",
  "pairCancel",
  "devicesList",
  "devicesSet",
  "devicesRemove",
  "devicesPanic",
  "configGet",
  "configSave",
  "newTunnelKey",
  "probe",
]) {
  markRemote(Dsh2PhoneService, method);
}

export function apply(ctx, config) {
  ctx.plugin(Dsh2PhoneService, config);
}

// Exported for tests/smoke checks only.
export { Dsh2PhoneService, PairSession };
