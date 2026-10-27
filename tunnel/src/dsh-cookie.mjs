// Mint DSH browser-session cookies locally, exactly replicating
// @deepseek-ai/dsh-client-connection's browser-auth format:
//   payload  = {version:1, authority, issuedAt, expiresAt}
//   value    = "v1." + b64url(JSON payload) + "." + b64url(HMAC-SHA256(secret, body))
//   name     = "dsh-auth-" + b64url(sha256(authority))
//   authority(for our chain) = the Host header DSH sees = "127.0.0.1:43120"
// Secret source: the persisted grant record in $DSH_HOME/.credentials.yaml
// (record key "client-connection/browser-session", payload.secret, 32-byte b64url).
// Only that single record is read; every other secret in the file is ignored.
import { createHash, createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "../../shared/env.mjs";

const COOKIE_PREFIX = "dsh-auth-";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function credentialsPath() {
  return env("DSH_CREDENTIALS_FILE") ?? join(homedir(), ".dsh", ".credentials.yaml");
}

/** Extract only the browser-session grant secret. Returns a Buffer (32 bytes). */
export function readBrowserSessionSecret() {
  const path = credentialsPath();
  if (!existsSync(path)) throw new Error(`credentials file not found: ${path}`);
  const text = readFileSync(path, "utf8");
  const m = text.match(/client-connection\/browser-session:\s*\n\s*kind:\s*grant\s*\n\s*payload:\s*\n\s*version:\s*1\s*\n\s*secret:\s*([A-Za-z0-9_-]+)/u);
  if (!m) throw new Error(`browser-session secret not found in ${path}`);
  const secret = Buffer.from(m[1].replaceAll("-", "+").replaceAll("_", "/"), "base64");
  if (secret.byteLength !== 32) throw new Error("browser-session secret has unexpected length");
  return secret;
}

/** The authority DSH computes for the tunneled chain (Host header as DSH sees it). */
export function dshAuthority() {
  return env("DSH_AUTHORITY", "127.0.0.1:43120");
}

/**
 * Mint a browser cookie valid for the tunneled DSH chain.
 * @returns {{ name: string, value: string, setCookie: string, expiresAt: number }}
 */
export function mintDshCookie({ ttlDays = 30 } = {}) {
  const secret = readBrowserSessionSecret();
  const authority = dshAuthority();
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
