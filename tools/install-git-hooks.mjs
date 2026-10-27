// Install the repository's git hooks (currently just pre-push → version-check).
//
//   node tools/install-git-hooks.mjs
//
// Wired to `npm run prepare`, so a normal `npm install` keeps the hooks current.
// Hooks are not part of the clone, which is why this is a script: the version
// gate must be re-created on every checkout, and a machine without git (exported
// tarball) must still be able to `npm install`.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, git } from "./git.mjs";

const HOOK = [
  "#!/bin/sh",
  "# Installed by tools/install-git-hooks.mjs - edit tools/version-check.mjs instead.",
  "# Bypass once with: git push --no-verify",
  'exec node "$(git rev-parse --show-toplevel)/tools/version-check.mjs" --pre-push',
  "",
].join("\n");

try {
  // `--git-path hooks` honours core.hooksPath, so a customised setup keeps working.
  const hooksDir = git(["rev-parse", "--git-path", "hooks"]);
  if (!hooksDir) throw new Error("not a git checkout");
  const dir = join(ROOT, hooksDir);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "pre-push");
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (existing === HOOK) {
    console.log(`hooks already current: ${target}`);
  } else {
    writeFileSync(target, HOOK, "utf8");
    try {
      chmodSync(target, 0o755);
    } catch {
      /* windows: git honours the shebang anyway */
    }
    console.log(`installed ${target}`);
  }
} catch (err) {
  console.log(`git hooks not installed (${String(err.message).split("\n")[0]})`);
}
