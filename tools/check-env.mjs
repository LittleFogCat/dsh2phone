// Print the configuration the tunnel / plugin / relay will actually use.
//
// usage: node tools/check-env.mjs
//
// Secrets are masked. Exits non-zero when a required value is missing, so this
// works as a pre-flight check before starting the tunnel or pairing a phone.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ENV_FILE, REPO_ROOT, env } from "../shared/env.mjs";

const pluginVersion = JSON.parse(
  readFileSync(join(REPO_ROOT, "dsh2phone-dsh-plugin", "package.json"), "utf8"),
).version;

const mask = (value) => {
  if (!value) return "(unset)";
  if (value.length <= 12) return `*** (${value.length} chars)`;
  return `${value.slice(0, 6)}…${value.slice(-4)} (${value.length} chars)`;
};

const rows = [
  { name: "env file", value: ENV_FILE, note: existsSync(ENV_FILE) ? "found" : "MISSING — copy .env.example to .env" },
  { name: "repo root", value: REPO_ROOT, note: "" },
  { name: "plugin version", value: pluginVersion, note: "bump before every push (see CHANGELOG.md)" },
  { name: "RELAY_URL", value: env("RELAY_URL"), required: true, note: "tunnel + plugin control plane" },
  { name: "PUBLIC_PAIR_URL", value: env("PUBLIC_PAIR_URL"), required: true, note: "QR code target" },
  { name: "DSH_TUNNEL_KEY", value: mask(env("DSH_TUNNEL_KEY")), required: true, note: "shared with the relay" },
  { name: "DSH_AUTHORITY", value: env("DSH_AUTHORITY", "127.0.0.1:43120"), note: "Host header DSH sees" },
  { name: "UPSTREAM_HOST", value: env("UPSTREAM_HOST", "127.0.0.1"), note: "" },
  { name: "UPSTREAM_PORT", value: env("UPSTREAM_PORT", "43120"), note: "" },
  { name: "DSH_APP_DIR", value: env("DSH_APP_DIR"), note: "DSH Desktop app tree" },
  { name: "DSH_CREDENTIALS_FILE", value: env("DSH_CREDENTIALS_FILE"), note: "empty = ~/.dsh/.credentials.yaml" },
  { name: "DSH2PHONE_TTL_DAYS", value: env("DSH2PHONE_TTL_DAYS", "30"), note: "" },
  { name: "allow invalid cert", value: env("DSH2PHONE_ALLOW_INVALID_CERT", "0"), note: "1 = skip TLS verification" },
];

let failed = 0;
for (const row of rows) {
  const empty = row.value === undefined || row.value === "" || row.value === "(unset)";
  const flag = empty ? (row.required ? "MISSING" : "-") : "ok";
  if (row.required && empty) failed += 1;
  const value = empty ? "(unset)" : String(row.value);
  console.log(`${flag.padEnd(8)} ${row.name.padEnd(24)} ${value}${row.note ? `   # ${row.note}` : ""}`);
}
process.exit(failed > 0 ? 1 : 0);
