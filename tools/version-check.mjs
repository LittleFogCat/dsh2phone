// Enforce "every push bumps the plugin version".
//
//   node tools/version-check.mjs              compare the working tree with origin/master (or HEAD)
//   node tools/version-check.mjs --baseline <ref>
//   node tools/version-check.mjs --pre-push   read ref updates from stdin (installed as a hook)
//
// Rules:
//   1. any change other than CHANGELOG.md requires a version different from the
//      pushed baseline (docs-only pushes included — that is the requested rule);
//   2. the version must not go backwards;
//   3. CHANGELOG.md must document the current version, newest section first, and
//      the entry must not still contain the TODO marker.
//
// Escape hatch for an emergency: `git push --no-verify` (bypasses all hooks).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, git } from "./git.mjs";

const PLUGIN_PKG_REL = "dsh2phone-dsh-plugin/package.json";
const CHANGELOG_REL = "CHANGELOG.md";
const TODO_MARKERS = ["（待补充", "TODO"];
const ZERO_SHA = /^0+$/u;

function readJsonVersion(text) {
  const match = /"version"\s*:\s*"([^"]+)"/u.exec(text ?? "");
  return match ? match[1] : null;
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(String(value ?? "").trim());
  return match ? { major: +match[1], minor: +match[2], patch: +match[3] } : null;
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
}

function changelogPath() {
  return join(ROOT, CHANGELOG_REL);
}

/** @returns {{ newest: string | null, body: string | null }} */
function changelogIndex(text) {
  const headings = [...text.matchAll(/^## \[([^\]]+)\][^\n]*$/gmu)];
  if (headings.length === 0) return { newest: null, body: null };
  const first = headings[0];
  const start = first.index + first[0].length;
  const nextStart = headings.length > 1 ? headings[1].index : text.length;
  return { newest: first[1], body: text.slice(start, nextStart) };
}

/** Files that differ between `baseline` and the working tree (committed + dirty + untracked). */
function changedFiles(baseline) {
  const files = new Set();
  if (baseline) {
    for (const line of (git(["diff", "--name-only", baseline], { allowFail: true }) ?? "").split("\n")) {
      if (line.trim()) files.add(line.trim());
    }
  } else {
    for (const line of (git(["ls-files"], { allowFail: true }) ?? "").split("\n")) {
      if (line.trim()) files.add(line.trim());
    }
  }
  for (const line of (git(["ls-files", "--others", "--exclude-standard"], { allowFail: true }) ?? "").split("\n")) {
    if (line.trim()) files.add(line.trim());
  }
  return [...files];
}

function describeBaseline(baseline) {
  if (!baseline) return "（无基线：首次推送或新分支）";
  const short = git(["rev-parse", "--short", baseline], { allowFail: true }) ?? baseline;
  return short;
}

function fail(lines) {
  console.error("\n版本检查未通过：\n");
  for (const line of lines) console.error(`  ${line}`);
  console.error("");
  console.error("  修复：node tools/version.mjs bump <patch|minor|major> --note \"一句话说明\"");
  console.error("        然后补齐 CHANGELOG.md 的条目，重试。");
  console.error("  规则见 AGENTS.md「版本管理（强制）」与 CHANGELOG.md 开头。");
  console.error("  紧急情况可 `git push --no-verify` 绕过。\n");
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const prePush = args.includes("--pre-push");
  const quiet = prePush || args.includes("--quiet");
  const baselineArg = args.indexOf("--baseline") === -1 ? null : args[args.indexOf("--baseline") + 1];

  const current = readJsonVersion(readFileSync(join(ROOT, PLUGIN_PKG_REL), "utf8"));
  if (!current || !parseVersion(current)) fail([`${PLUGIN_PKG_REL} 里没有合法的 version`]);

  let baselineRef = baselineArg;
  let changed = [];

  if (prePush) {
    let stdin = "";
    try {
      stdin = readFileSync(0, "utf8");
    } catch {
      stdin = "";
    }
    for (const line of stdin.split("\n")) {
      const [localRef, localSha, , remoteSha] = line.trim().split(/\s+/u);
      if (!localRef?.startsWith("refs/heads/") || !localSha || ZERO_SHA.test(localSha)) continue;
      const newBranch = !remoteSha || ZERO_SHA.test(remoteSha);
      baselineRef = newBranch ? null : remoteSha;
      changed = newBranch
        ? (git(["ls-tree", "-r", "--name-only", localSha], { allowFail: true }) ?? "").split("\n").filter(Boolean)
        : (git(["diff", "--name-only", `${remoteSha}..${localSha}`], { allowFail: true }) ?? "").split("\n").filter(Boolean);
      break;
    }
    if (!changed.length) {
      if (!quiet) console.log("版本检查：本次没有需要推送的提交。");
      return;
    }
  } else {
    if (!baselineRef) {
      baselineRef = git(["rev-parse", "--verify", "--quiet", "origin/master"], { allowFail: true }) || "HEAD";
    }
    changed = changedFiles(baselineRef);
  }

  const baselineVersion = baselineRef
    ? readJsonVersion(git(["show", `${baselineRef}:${PLUGIN_PKG_REL}`], { allowFail: true }))
    : null;

  const relevant = changed.filter((file) => file !== CHANGELOG_REL);
  if (relevant.length === 0) {
    if (!quiet) console.log(`版本检查：只有 ${CHANGELOG_REL} 变化，无需升级版本。`);
    return;
  }

  if (baselineVersion && current === baselineVersion) {
    fail([
      `基线 ${describeBaseline(baselineRef)} 的插件版本是 ${baselineVersion}，当前仍是 ${current}。`,
      `本次改动 ${relevant.length} 个文件（示例：${relevant.slice(0, 3).join("、")}${relevant.length > 3 ? " …" : ""}），必须升级版本。`,
    ]);
  }
  if (baselineVersion && compareVersions(current, baselineVersion) < 0) {
    fail([`版本号不能回退：基线 ${baselineVersion} → 当前 ${current}。`]);
  }

  const changelog = readFileSync(changelogPath(), "utf8");
  const { newest, body } = changelogIndex(changelog);
  if (newest !== current) {
    fail([`${CHANGELOG_REL} 最新条目是 ${newest ?? "（无）"}，但插件版本是 ${current}。`, "请把当前版本写在最上面，并补齐条目。"]);
  }
  if (!body || !/^[-*] /mu.test(body)) fail([`${CHANGELOG_REL} 的 ${current} 条目没有内容。`]);
  if (TODO_MARKERS.some((marker) => body.includes(marker))) {
    fail([`${CHANGELOG_REL} 的 ${current} 条目还是占位内容（${TODO_MARKERS.join(" / ")}）。`]);
  }

  if (!quiet) {
    console.log(`版本检查通过：${baselineVersion ?? "（新分支）"} -> ${current}，${relevant.length} 个文件。`);
  }
}

try {
  main();
} catch (err) {
  console.error(`版本检查出错：${err.message}`);
  process.exit(1);
}
