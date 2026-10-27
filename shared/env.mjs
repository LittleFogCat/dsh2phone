// Shared .env loader for every dsh2phone entry point.
//
// Why hand-rolled: the tunnel runs from a bare `node src\tunnel.mjs` launcher,
// the plugin runs inside the DSH Desktop host process, and the relay runs in a
// container that gets its variables from `env_file`. A 40-line parser keeps all
// three on the same code path without adding a dependency to any of them.
//
// Loading is a side effect of importing this module: import it once at the top
// of an entry point, then read `process.env` (or use env()/envFlag()).
//
// Resolution order:
//   1. DSH2PHONE_ENV_FILE — explicit path (launchers set it, so a tunnel started
//      from another working directory still finds the same file)
//   2. <repo root>/.env   — normal local runs
// A variable that already exists in the real environment always wins, so
// `RELAY_URL=... node src/tunnel.mjs` keeps working as a one-off override.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root — this file lives in <root>/shared/env.mjs. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ENV_FILE = process.env.DSH2PHONE_ENV_FILE || join(REPO_ROOT, ".env");

/**
 * Parse dotenv syntax: `KEY=value`, optional `export`, `#` comments, single or
 * double quotes, CRLF line endings. Returns a plain object.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      // Unquoted: an inline " #" starts a comment; Windows paths keep their
      // backslashes verbatim (no escape processing in dotenv).
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash);
      value = value.trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load a .env file into process.env (missing file is not an error).
 * @param {string} [file]
 * @param {{ override?: boolean }} [options]
 * @returns {Record<string, string>} the parsed entries
 */
export function loadEnv(file = ENV_FILE, { override = false } = {}) {
  if (!file || !existsSync(file)) return {};
  let parsed;
  try {
    parsed = parseEnv(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (override || process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
  return parsed;
}

/**
 * Read an environment variable, treating empty strings as unset.
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string | undefined}
 */
export function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

/**
 * Read a boolean flag (`1/true/yes/on`, case-insensitive).
 * @param {string} name
 * @param {boolean} [fallback]
 */
export function envFlag(name, fallback = false) {
  const value = env(name);
  if (value === undefined) return fallback;
  return /^(?:1|true|yes|on)$/i.test(value);
}

/**
 * Read a required variable, failing with an actionable message.
 * @param {string} name
 * @param {string} [hint]
 * @returns {string}
 */
export function requireEnv(name, hint) {
  const value = env(name);
  if (value === undefined) {
    throw new Error(`${name} is not set${hint ? ` — ${hint}` : ""} (copy .env.example to .env)`);
  }
  return value;
}

// Load on import: callers only need `import "../shared/env.mjs";`.
loadEnv();
