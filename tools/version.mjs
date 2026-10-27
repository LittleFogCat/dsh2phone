// Bump the dsh2phone plugin version and open a CHANGELOG entry.
//
//   node tools/version.mjs                     show the current version + last entry
//   node tools/version.mjs bump patch          0.1.0 -> 0.1.1
//   node tools/version.mjs bump minor          0.1.1 -> 0.2.0
//   node tools/version.mjs bump major          0.2.0 -> 1.0.0
//   node tools/version.mjs bump minor --note "新增 xxx"   seed the first bullet
//
// The plugin version is the product version: it is what DSH's plugin manager
// shows and what the user must be able to quote in a bug report. The root
// package.json is kept in lockstep so `npm`/tags agree; relay/ and tunnel/ keep
// their own independent versions (they are deployment artifacts, not releases).
//
// After bumping, fill in the CHANGELOG entry: version-check refuses a release
// whose entry still contains the TODO marker.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../shared/env.mjs";

const PLUGIN_PKG = join(REPO_ROOT, "dsh2phone-dsh-plugin", "package.json");
const ROOT_PKG = join(REPO_ROOT, "package.json");
const CHANGELOG = join(REPO_ROOT, "CHANGELOG.md");
const TODO = "（待补充：一句话说明本次改动）";

const KINDS = ["major", "minor", "patch"];

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJsonVersion(file, version) {
  const text = readFileSync(file, "utf8");
  const next = text.replace(/("version"\s*:\s*")[^"]*(")/u, `$1${version}$2`);
  if (next === text) throw new Error(`cannot find a "version" field in ${file}`);
  writeFileSync(file, next, "utf8");
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(String(value).trim());
  if (!match) throw new Error(`not a semver version: ${value}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function bump(version, kind) {
  const parts = parseVersion(version);
  if (kind === "major") return `${parts.major + 1}.0.0`;
  if (kind === "minor") return `${parts.major}.${parts.minor + 1}.0`;
  return `${parts.major}.${parts.minor}.${parts.patch + 1}`;
}

function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function lastEntry(text) {
  const match = /^## \[([^\]]+)\][^\n]*\n([\s\S]*?)(?=^## \[|$(?![\s\S]))/mu.exec(text);
  if (!match) return null;
  const lines = match[2].split("\n").map((line) => line.trim()).filter(Boolean);
  return { version: match[1], lines: lines.slice(0, 4) };
}

function insertEntry(text, version, note) {
  if (new RegExp(`^## \\[${version.replace(/\./gu, "\\.")}\\]`, "mu").test(text)) {
    throw new Error(`CHANGELOG already has an entry for ${version}`);
  }
  const header = `## [${version}] - ${today()}`;
  const body = [
    "",
    "### 变更",
    "",
    note ? `- ${note}` : `- ${TODO}`,
    "",
  ].join("\n");
  const at = text.search(/^## \[/mu);
  if (at === -1) return `${text.trimEnd()}\n\n${header}\n${body}`;
  return `${text.slice(0, at)}${header}\n${body}\n${text.slice(at)}`;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const noteIndex = rest.indexOf("--note");
  const note = noteIndex === -1 ? "" : rest[noteIndex + 1] ?? "";
  const changelog = readFileSync(CHANGELOG, "utf8");

  if (!command || command === "show") {
    const { version } = readJson(PLUGIN_PKG);
    const last = lastEntry(changelog);
    console.log(`plugin version: ${version}`);
    if (last) {
      console.log(`latest entry:   ${last.version}`);
      for (const line of last.lines) console.log(`  ${line}`);
    }
    if (last && last.version !== version) {
      console.log(`\n! CHANGELOG 最新条目是 ${last.version}，与 package.json 的 ${version} 不一致`);
    }
    return;
  }

  if (command !== "bump") throw new Error(`unknown command: ${command} (expected bump|show)`);
  const kind = rest.find((item) => KINDS.includes(item));
  if (!kind) throw new Error("usage: node tools/version.mjs bump <major|minor|patch> [--note \"...\"]");

  const current = readJson(PLUGIN_PKG).version;
  const next = bump(current, kind);
  writeJsonVersion(PLUGIN_PKG, next);
  writeJsonVersion(ROOT_PKG, next);
  writeFileSync(CHANGELOG, insertEntry(changelog, next, note), "utf8");

  console.log(`bumped ${current} -> ${next} (${kind})`);
  console.log(`  ${PLUGIN_PKG}`);
  console.log(`  ${ROOT_PKG}`);
  console.log(`  ${CHANGELOG}`);
  console.log(`\n下一步：补齐 CHANGELOG 的「### 变更」小节（当前${note ? "已写入 note" : "是 TODO 占位"}），`);
  console.log("       然后 node tools/version-check.mjs 自检，再提交。");
}

try {
  main();
} catch (err) {
  console.error(`version: ${err.message}`);
  process.exit(1);
}
