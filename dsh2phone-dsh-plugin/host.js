// Host half of the dsh2phone plugin.
//
// Exposes Typert Remote methods (namespace "dsh2phone") that the Client UI calls:
//   pairStart / pairInspect / pairRespond / pairCancel   — the pairing flow
//   devicesList / devicesSet / devicesRemove / devicesPanic — whitelist management
//   configGet / configSave / probe / newTunnelKey       — the settings tab
//   healthCheck                                          — startup self-check
//
// The pairing flow opens its own admin connection to the dsh-relay control plane
// (protocol identical to tunnel/pair.cmd), mints the DSH browser cookie locally
// (token never crosses the public network) and renders the QR code with the
// `qrcode` package as a PNG data URL for the Client to display.
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
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
//
// Two Host layouts exist: DSH Desktop 1.x ships an `app` directory, DSH 2.x
// ships `app.asar`. The running app comes first — .env may still point at an
// older install, and its protocol copy would not match the running Gateway.
function hostRequireRoots() {
  const candidates = [
    join(dirname(process.execPath), "resources", "app.asar"),
    join(dirname(process.execPath), "resources", "app"),
    process.env.DSH_APP_DIR,
  ].filter((value) => typeof value === "string" && value.length > 0);
  /** @type {Array<(name: string) => any>} */
  const roots = [];
  for (const dir of candidates) {
    const pkg = join(dir, "package.json");
    if (!existsSync(pkg)) continue;
    try {
      roots.push(createRequire(pkg));
    } catch { /* try the next candidate */ }
  }
  return roots;
}

const hostRoots = hostRequireRoots();
const pluginRequire = createRequire(import.meta.url);
let Remote;
let TypertRemoteService;
let QRCode;
let WebSocketImpl;

/** 从 Host 的包树里找；`qrcode` 这类插件自带依赖最后回落到仓库自己的 node_modules。 */
function requireAnywhere(name) {
  for (const req of hostRoots) {
    try {
      return req(name);
    } catch { /* not in this root */ }
  }
  return pluginRequire(name);
}

try {
  if (hostRoots.length === 0) throw new Error("host package tree not found");
  ({ Remote, TypertRemoteService } = requireAnywhere("@deepseek-ai/dsh-typert-protocol"));
  QRCode = requireAnywhere("qrcode");
  // `ws` supports TLS options (needed when the relay is addressed by IP);
  // Node's global WebSocket has no such options.
  WebSocketImpl = requireAnywhere("ws").WebSocket;
} catch {
  ({ Remote, TypertRemoteService } = await import("@deepseek-ai/dsh-typert-protocol"));
  QRCode = pluginRequire("qrcode");
  WebSocketImpl = globalThis.WebSocket;
}

const NS = "dsh2phone";

// Host-API 探测：缺 typert 类时模块仍要能加载完（驼峰：class extends undefined
// 会在 import 阶段就炸掉，连一条日志都留不下）。真正决定“能不能干活”的地方是
// apply()，不在模块顶层。
const HOST_API_READY = typeof Remote === "function" && typeof TypertRemoteService === "function";
const ServiceBase = HOST_API_READY ? TypertRemoteService : class {};

// 这些依赖只影响配对（二维码 / 中继连接），缺了也照样能进设置页，算“软问题”。
function softDependencyProblems() {
  const problems = [];
  if (typeof QRCode?.toDataURL !== "function") problems.push("qrcode 不可用（配对二维码生成不了）");
  if (typeof WebSocketImpl !== "function") problems.push("WebSocket 不可用（连不上中继）");
  return problems;
}

// Startup self-check (healthCheck()): the report is reused for a minute, and
// every TCP leg is short enough that the dialog never waits on it visibly.
const HEALTH_TTL_MS = 60_000;
const HEALTH_PROBE_TIMEOUT_MS = 1200;
const HEALTH_RELAY_TIMEOUT_MS = 5000;

// The version shown in the settings tab; bumped by tools/version.mjs on every
// push (enforced by tools/version-check.mjs).
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

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

/**
 * TCP 探活：只回答“这个端口有没有受理连接”。隧道上游和局域网边缘都是纯
 * TCP 转发，所以这里不需要完整的 HTTP 请求（还能顺带发现半开连接）。
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
function tcpProbe(host, port, timeoutMs = HEALTH_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    /** @type {import("node:net").Socket | undefined} */
    let socket;
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve(ok ? { ok: true } : { ok: false, error: error ?? "连接失败" });
    };
    socket = connect({ host, port });
    socket.setTimeout(timeoutMs, () => finish(false, `${timeoutMs}ms 超时`));
    socket.once("connect", () => finish(true));
    socket.once("error", (err) => finish(false, err.code ?? err.message));
  });
}

/** 把一次健康检查写进 Host 日志；桌面端的日志里能直接看到。 */
function logHealth(report) {
  const attention = report.checks.filter((check) => check.status === "fail" || check.status === "warn");
  if (attention.length === 0) {
    console.log(`[dsh2phone] health ok（${report.checks.length} 项）`);
    return;
  }
  console.warn(`[dsh2phone] health ${report.level}：${attention.map((check) => `${check.title} ${check.detail}`).join("；")}`);
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

/** The live service instance, so apply() can kick off the startup health pass. */
let runningService = null;

class Dsh2PhoneService extends ServiceBase {
  // NOTE: cordis invokes service methods with a traced Proxy as `this`, so
  // ECMAScript private methods/fields (#x) fail V8's brand check there
  // ("Receiver must be an instance of class …"). Keep helpers public.
  constructor(ctx, config) {
    super(ctx, NS);
    // Kept for webPort(): the Host's own listener port is not part of `config`,
    // and the webServer service is only reachable through the context.
    this.hostContext = ctx;
    runningService = this;
    // cordis may hand over `undefined` (omitted YAML option) or an empty string;
    // neither may clobber a real value.
    this.configOverrides = Object.fromEntries(
      Object.entries(config ?? {}).filter(([, value]) => value !== undefined && value !== ""),
    );
    this.reloadConfig();
    this.pair = null;
    this.health = null;
    this.healthRun = null;
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
      version: PLUGIN_VERSION,
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

  // --------------------------------------------------------------- health check
  //
  // The failure this exists for: a DSH build that picks a random web port (DSH
  // NEXT ships `port: 0`) while the tunnel keeps forwarding to a fixed
  // UPSTREAM_PORT. The phone then reports "电脑端暂时不可达" and nothing on the
  // desktop says why. One startup pass over the local legs points at the exact
  // mismatch; the relay leg is best-effort.

  /** DSH 自己的监听端口：优先用 Host 注入的 DSH_WEB_URL，其次问 webServer 服务。 */
  webPort() {
    const advertised = process.env.DSH_WEB_URL;
    if (advertised) {
      try {
        const url = new URL(advertised);
        if (url.port !== "") return Number(url.port);
        if (url.protocol === "https:") return 443;
        if (url.protocol === "http:") return 80;
      } catch { /* fall through to the service */ }
    }
    try {
      const server = typeof this.hostContext?.get === "function" ? this.hostContext.get("webServer") : undefined;
      const port = Number(server?.port);
      if (Number.isInteger(port) && port > 0) return port;
    } catch { /* service not mounted in this Host */ }
    return undefined;
  }

  /** 隧道把请求转发到哪里（默认值与 tunnel/src/tunnel.mjs 一致）。 */
  upstreamTarget() {
    const host = env("UPSTREAM_HOST", "127.0.0.1");
    const port = Number(env("UPSTREAM_PORT", "43120"));
    return { host, port: Number.isInteger(port) && port > 0 ? port : 43120 };
  }

  /** 局域网直连边缘（与 tunnel 对 DSH2PHONE_LAN_* 的解析保持一致）。 */
  lanEdgeTarget() {
    const enabled = !/^(0|false|no|off)$/iu.test(String(env("DSH2PHONE_LAN_EDGE", "1")).trim());
    const port = Number(env("DSH2PHONE_LAN_PORT", "43220"));
    return { enabled, port: Number.isInteger(port) && port > 0 ? port : 43220 };
  }

  /** 一次完整的健康检查；不缓存、不抛错（每一项独立成行）。 */
  async collectHealth() {
    /** @type {Array<{id: string, title: string, status: "ok"|"warn"|"fail"|"skip", detail: string, hint?: string}>} */
    const checks = [];
    const add = (id, title, status, detail, hint) => checks.push({ id, title, status, detail, ...(hint === undefined ? {} : { hint }) });
    const upstream = this.upstreamTarget();
    const actual = this.webPort();

    // 1) 隧道上游端口 == DSH 实际监听端口？今天这类故障的唯一现场证据。
    const dsh = await tcpProbe(upstream.host, upstream.port);
    if (actual !== undefined && actual !== upstream.port) {
      add("dsh", "电脑端 DSH 端口", "fail",
        `DSH 正在 ${actual} 上监听，隧道却转发到 ${upstream.host}:${upstream.port}`,
        `把 DSH 的网页端口固定为 ${upstream.port}（DSH NEXT 改 ~/.dsh/desktop-preferences.json 里的 "port"），或把 .env 的 UPSTREAM_PORT 改成 ${actual} 后重启隧道`);
    } else if (!dsh.ok) {
      add("dsh", "电脑端 DSH 端口", "fail",
        `${upstream.host}:${upstream.port} 没有应答（${dsh.error}）`,
        `手机只会看到“电脑端暂时不可达”。把 DSH 的端口固定为 ${upstream.port}，或把 UPSTREAM_PORT 改成实际端口并重启隧道`);
    } else {
      add("dsh", "电脑端 DSH 端口", "ok", `${upstream.host}:${upstream.port} 已监听`);
    }

    // 2) 隧道进程：局域网直连边缘由它提供，端口不监听说明它没跑。
    const edge = this.lanEdgeTarget();
    if (!edge.enabled) {
      add("lan", "局域网直连通道", "skip", "已在 .env 关闭（DSH2PHONE_LAN_EDGE=0）");
    } else {
      const probe = await tcpProbe("127.0.0.1", edge.port);
      add("lan", "局域网直连通道", probe.ok ? "ok" : "fail",
        probe.ok ? `127.0.0.1:${edge.port} 已监听` : `127.0.0.1:${edge.port} 没在监听（${probe.error}）`,
        probe.ok ? undefined : "隧道进程没在运行：启动 tunnel（tunnel\\start.cmd），或检查开机自启的 dsh2phone-tunnel.vbs");
    }

    // 3) 配对所需的配置（缺项只影响配对，不影响已配对设备）。
    const issues = configIssues(this.cfg);
    add("config", "连接配置", issues.length === 0 ? "ok" : "warn",
      issues.length === 0 ? "中继地址、配对地址、隧道密钥都已就绪" : issues.map((item) => item.message).join("；"),
      issues.length === 0 ? undefined : "打开“设置”补齐后保存");

    // 4) 铸造 DSH cookie 用的浏览器会话密钥。
    try {
      readBrowserSessionSecret(this.cfg.credentialsFile);
      add("credentials", "浏览器会话密钥", "ok", "已读到，配对时能铸造 DSH cookie");
    } catch (err) {
      add("credentials", "浏览器会话密钥", "warn", `读不到：${err?.message ?? String(err)}`,
        "检查 DSH_CREDENTIALS_FILE，或在 DSH 里重新登录一次");
    }

    // 5) 中继控制面：配置不完整时没有意义，直接跳过。
    if (issues.length > 0) {
      add("relay", "中继控制面", "skip", "配置不完整，未测试");
    } else {
      try {
        const reply = await this.adminCall({ t: "devices.list" }, "devices", { timeoutMs: HEALTH_RELAY_TIMEOUT_MS });
        add("relay", "中继控制面", "ok", `已配对 ${(reply.devices ?? []).length} 台设备`);
      } catch (err) {
        add("relay", "中继控制面", "warn", `连不上：${err?.message ?? String(err)}`,
          "公网链路会不可用；手机在同网时仍可走局域网直连");
      }
    }

    // 6) 插件自带依赖（qrcode / ws）：缺了只影响配对，设置页照常。
    const soft = softDependencyProblems();
    if (soft.length > 0) {
      add("deps", "插件依赖", "warn", soft.join("；"), "配对会失败；设置页与设备管理不受影响");
    }

    const level = checks.some((check) => check.status === "fail")
      ? "fail"
      : checks.some((check) => check.status === "warn") ? "warn" : "ok";
    return { at: Date.now(), level, ok: level === "ok", checks };
  }

  /** 缓存的健康报告；refresh 时重跑。并发调用共用一次检查。 */
  async healthCheck(refresh = false) {
    const cached = this.health;
    if (refresh !== true && cached !== null && Date.now() - cached.at < HEALTH_TTL_MS) return cached;
    if (this.healthRun !== null) return this.healthRun;
    this.healthRun = this.collectHealth()
      .then((report) => {
        this.health = report;
        logHealth(report);
        return report;
      })
      .finally(() => { this.healthRun = null; });
    return this.healthRun;
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

/**
 * 降级壳：正常服务注册失败时只保留 healthCheck，让界面能显示原因，而不是让
 * 整个入口消失。它自身不再引用任何业务代码，所以不会把故障带进后续流程。
 */
class Dsh2PhoneDiagnostics extends ServiceBase {
  constructor(ctx, options = {}) {
    super(ctx, NS);
    this.error = String(options?.error ?? "插件激活失败");
  }

  async healthCheck() {
    return {
      at: Date.now(),
      level: "fail",
      ok: false,
      checks: [{
        id: "plugin",
        title: "插件自检",
        status: "fail",
        detail: `插件激活失败，已降级为诊断壳：${this.error}`,
        hint: "多半是当前 DSH 版本与插件不兼容。查看 Desktop 日志里的 [dsh2phone]，或升级/回退插件版本。",
      }],
    };
  }
}

if (HOST_API_READY) {
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
    "healthCheck",
  ]) {
    markRemote(Dsh2PhoneService, method);
  }
  markRemote(Dsh2PhoneDiagnostics, "healthCheck");
}

export function apply(ctx, config) {
  // 结构性不可用：没有任何 typert 类，连诊断壳都注册不了——只能留日志。
  if (!HOST_API_READY) {
    console.error("[dsh2phone] Host API 不可用（@deepseek-ai/dsh-typert-protocol 缺失或形状不符）：插件不注册任何功能。");
    return;
  }
  try {
    ctx.plugin(Dsh2PhoneService, config);
  } catch (err) {
    // 只加载空壳：不再触发任何配对/设置逻辑，界面仍能看到健康检查的失败原因。
    console.error(`[dsh2phone] 激活失败，降级为诊断壳：${err?.stack ?? err}`);
    try {
      ctx.plugin(Dsh2PhoneDiagnostics, { error: err?.message ?? String(err) });
    } catch (fallbackError) {
      console.error(`[dsh2phone] 诊断壳注册失败：${fallbackError?.message ?? fallbackError}`);
    }
    return;
  }
  // 启动自检：每次 Host 起来跑一次，结果进日志；客户端打开时直接读缓存。
  // 5s 足够让 webServer 完成监听，太早会把自己的端口误判成“没有应答”。
  const timer = setTimeout(() => { void runningService?.healthCheck(true).catch(() => {}); }, 5000);
  timer.unref?.();
}

// Exported for tests/smoke checks only.
export { Dsh2PhoneService, PairSession };
