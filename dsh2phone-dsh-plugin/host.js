// Host half of the dsh2phone plugin.
//
// Exposes Typert Remote methods (namespace "dsh2phone") that the Client UI calls:
//   pairStart / pairInspect / pairRespond / pairCancel   — the pairing flow
//   devicesList / devicesSet / devicesRemove / devicesPanic — whitelist management
//
// The pairing flow opens its own admin connection to the dsh-relay control plane
// (protocol identical to tunnel/pair.cmd), mints the DSH browser cookie locally
// (token never crosses the public network) and renders the QR code with the
// `qrcode` package as a PNG data URL for the Client to display.
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
// Loads <repo>/.env — every endpoint/secret below comes from there, never from
// this file (see .env.example).
import { REPO_ROOT, env, envFlag } from "../shared/env.mjs";
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
// resolved from .env in configuredDefaults().
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

/** Defaults from <repo>/.env; explicit plugin config still wins. */
function configuredDefaults() {
  const keyFile = env("DSH2PHONE_KEY_FILE")
    ?? (existsSync(join(REPO_ROOT, "deploy", "server", "tunnel.key"))
      ? join(REPO_ROOT, "deploy", "server", "tunnel.key")
      : "");
  const ttlDays = Number(env("DSH2PHONE_TTL_DAYS", "30"));
  return {
    relayUrl: env("RELAY_URL", ""),
    publicKeyUrl: env("PUBLIC_PAIR_URL", ""),
    keyFile,
    tunnelKey: env("DSH_TUNNEL_KEY", ""),
    authority: env("DSH_AUTHORITY", DEFAULTS.authority),
    credentialsFile: env("DSH_CREDENTIALS_FILE"),
    ttlDays: Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 30,
    allowInvalidCert: envFlag("DSH2PHONE_ALLOW_INVALID_CERT"),
  };
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
    // cordis may hand over `undefined` (omitted YAML option) or an empty string
    // (placeholder left in .env); neither may clobber the env-derived defaults.
    const overrides = Object.fromEntries(
      Object.entries(config ?? {}).filter(([, value]) => value !== undefined && value !== ""),
    );
    this.cfg = { ...DEFAULTS, ...configuredDefaults(), ...overrides };
    this.pair = null;
    ctx.effect(() => () => this.closePair(), "dsh2phone.pairDispose");
  }

  relayKey() {
    if (this.cfg.tunnelKey) return this.cfg.tunnelKey;
    if (!this.cfg.keyFile) {
      throw new Error("dsh2phone: 未配置隧道密钥 — 在 .env 里设置 DSH_TUNNEL_KEY（或 DSH2PHONE_KEY_FILE）");
    }
    return readFileSync(this.cfg.keyFile, "utf8").trim();
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
    if (!this.cfg.relayUrl || !this.cfg.publicKeyUrl) {
      throw new Error("dsh2phone: 未配置 RELAY_URL / PUBLIC_PAIR_URL — 参考 .env.example 填写 .env");
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
  async adminCall(request, expectT) {
    const ws = await openControl({ relayUrl: this.cfg.relayUrl, key: this.relayKey(), WebSocketImpl, insecure: this.cfg.allowInvalidCert === true });
    try {
      return await sendExpect(ws, request, expectT);
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
]) {
  markRemote(Dsh2PhoneService, method);
}

export function apply(ctx, config) {
  ctx.plugin(Dsh2PhoneService, config);
}

// Exported for tests/smoke checks only.
export { Dsh2PhoneService, PairSession };
