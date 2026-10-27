// Mint DSH browser-session cookies locally, exactly replicating
// @deepseek-ai/dsh-client-connection's browser-auth format:
//   payload  = {version:1, authority, issuedAt, expiresAt}
//   value    = "v1." + b64url(JSON payload) + "." + b64url(HMAC-SHA256(secret, body))
//   name     = "dsh-auth-" + b64url(sha256(authority))
//   authority(for our chain) = the Host header DSH sees = "127.0.0.1:43120"
// Secret source: the persisted grant record in $DSH_HOME/.credentials.yaml
// (record key "client-connection/browser-session", payload.secret, 32-byte b64url).
// Ported from tunnel/src/dsh-cookie.mjs; secret and authority are parametrized
// so the plugin service can feed them from its config.
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const COOKIE_PREFIX = "dsh-auth-";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function defaultCredentialsPath() {
  // An empty DSH_CREDENTIALS_FILE means "use the default" — .env normally
  // carries `DSH_CREDENTIALS_FILE=` as a commented-out placeholder.
  const configured = process.env.DSH_CREDENTIALS_FILE;
  return configured ? configured : join(homedir(), ".dsh", ".credentials.yaml");
}

/** Extract only the browser-session grant secret. Returns a Buffer (32 bytes). */
export function readBrowserSessionSecret(credentialsFile) {
  const path = credentialsFile ? credentialsFile : defaultCredentialsPath();
  if (!existsSync(path)) throw new Error(`credentials file not found: ${path}`);
  const text = readFileSync(path, "utf8");
  const m = text.match(/client-connection\/browser-session:\s*\n\s*kind:\s*grant\s*\n\s*payload:\s*\n\s*version:\s*1\s*\n\s*secret:\s*([A-Za-z0-9_-]+)/u);
  if (!m) throw new Error(`browser-session secret not found in ${path}`);
  const secret = Buffer.from(m[1].replaceAll("-", "+").replaceAll("_", "/"), "base64");
  if (secret.byteLength !== 32) throw new Error("browser-session secret has unexpected length");
  return secret;
}

/**
 * Mint a browser cookie valid for the tunneled DSH chain.
 * @returns {{ name: string, value: string, setCookie: string, expiresAt: number }}
 */
export function mintDshCookie({ secret, authority = "127.0.0.1:43120", ttlDays = 30 }) {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ttlDays * 24 * 3600 * 1000;
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), "utf8"));
  const sig = b64url(createHmac("sha256", secret).update(body).digest());
  const value = `v1.${body}.${sig}`;
  const name = COOKIE_PREFIX + b64url(createHash("sha256").update(authority).digest());
  const maxAge = Math.floor((expiresAt - issuedAt) / 1000);
  const setCookie = `${name}=${value}; Max-Age=${maxAge}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`;
  return { name, value, setCookie, expiresAt };
}

/** Human-readable device name derived from the phone's User-Agent. */
export function deviceNameFromUA(ua) {
  const shortUA = (() => {
    if (/iphone|ipad|ipod/iu.test(ua)) return `iOS ${/OS ([\d_]+)/iu.exec(ua)?.[1]?.replace(/_/g, ".") ?? ""} ${/EdgiOS|CriOS|FxiOS|Safari/iu.exec(ua)?.[0] ?? ""}`.trim();
    if (/android/iu.test(ua)) return `Android ${/Android ([\d.]+)/iu.exec(ua)?.[1] ?? ""} ${/EdgA|Chrome|Firefox/iu.exec(ua)?.[0] ?? ""}`.trim();
    if (/windows/iu.test(ua)) return `Windows ${/Edg|Chrome|Firefox/iu.exec(ua)?.[0] ?? ""}`.trim();
    return (ua.split(" ")[0] ?? "unknown").slice(0, 40);
  })();
  if (/iphone|ipad/iu.test(ua)) return `iPhone · ${shortUA}`;
  if (/android/iu.test(ua)) return `Android · ${shortUA}`;
  if (/mobile/iu.test(ua)) return `Mobile · ${shortUA}`;
  return `Desktop · ${shortUA}`;
}
