// Minimal git runner shared by the version tooling (tools/version-check.mjs,
// tools/install-git-hooks.mjs).
//
// Output is captured through a real file descriptor instead of a pipe: some
// sandboxes (including the one this repo is developed in) refuse to create the
// pipes child_process needs, while plain fd redirection always works. That keeps
// the release gate runnable in CI too.
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let calls = 0;

/**
 * Run `git` and return stdout (trimmed), or null when `allowFail` and git fails.
 * @param {string[]} args
 * @param {{ allowFail?: boolean, cwd?: string }} [options]
 * @returns {string | null}
 */
export function git(args, { allowFail = false, cwd = ROOT } = {}) {
  const sink = join(tmpdir(), `dsh2phone-git-${process.pid}-${calls++}.out`);
  let fd;
  try {
    fd = openSync(sink, "w");
    execFileSync("git", args, { cwd, stdio: ["ignore", fd, "ignore"] });
    return readFileSync(sink, "utf8").trim();
  } catch {
    if (allowFail) return null;
    throw new Error(`git ${args.join(" ")} 执行失败`);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    rmSync(sink, { force: true });
  }
}
