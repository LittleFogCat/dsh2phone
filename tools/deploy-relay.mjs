// 把本仓库的 relay 源码同步到服务器并重建 dsh-relay 容器。
//
//   node tools/deploy-relay.mjs            # 上传 + md5 校验 + docker compose up -d --build
//   node tools/deploy-relay.mjs --check    # 只比较远端 md5，不做修改
//
// 依赖 .env 的 DSH2PHONE_SSH_KEY / DSH2PHONE_SSH_USER / DSH2PHONE_SERVER_IP。
// 这是运维脚本，会短暂重启生产 relay；执行前请确认当前没有正在进行的发布。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../shared/env.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const localFile = join(root, "relay", "src", "relay.mjs");
const remoteFile = "/usr/local/compose/data/dsh-relay/src/relay.mjs";
const composeDir = "/usr/local/compose";
const checkOnly = process.argv.includes("--check");

const key = env("DSH2PHONE_SSH_KEY", "").replace(/^~(?=$|[\\/])/, homedir());
const user = env("DSH2PHONE_SSH_USER", "");
const host = env("DSH2PHONE_SERVER_IP", "");
if (!key || !user || !host) {
  console.error("DEPLOY FAIL: DSH2PHONE_SSH_KEY / DSH2PHONE_SSH_USER / DSH2PHONE_SERVER_IP missing");
  process.exit(1);
}

function ssh(command, options = {}) {
  const result = spawnSync("ssh", [
    "-i", key,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    `${user}@${host}`,
    command,
  ], { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ssh failed (${result.status}): ${(result.stderr || "").trim().slice(0, 800)}`);
  }
  return result.stdout ?? "";
}

function md5(buffer) {
  return createHash("md5").update(buffer).digest("hex");
}

const localBuffer = readFileSync(localFile);
const localMd5 = md5(localBuffer);
console.log(`local md5: ${localMd5}`);

const remoteMd5 = ssh(`md5sum ${remoteFile} | cut -d' ' -f1`).trim();
console.log(`remote md5: ${remoteMd5}`);
if (localMd5 === remoteMd5) {
  console.log("DEPLOY SKIP: relay source already up to date");
  process.exit(0);
}
if (checkOnly) {
  console.log("DEPLOY DIFF: --check only, remote not updated");
  process.exit(1);
}

console.log("uploading relay/src/relay.mjs ...");
const base64 = localBuffer.toString("base64");
ssh(`base64 -d > ${remoteFile}.tmp && mv ${remoteFile}.tmp ${remoteFile}`, { input: base64 + "\n" });
const uploadedMd5 = ssh(`md5sum ${remoteFile} | cut -d' ' -f1`).trim();
if (uploadedMd5 !== localMd5) {
  console.error(`DEPLOY FAIL: md5 mismatch after upload (${uploadedMd5})`);
  process.exit(1);
}
console.log("md5 verified");

console.log("rebuilding dsh-relay ...");
const build = ssh(`cd ${composeDir} && docker compose up -d --build dsh-relay 2>&1 | tail -20`);
console.log(build.trim());

console.log("health check (waiting up to 90s for the PC tunnel to reconnect) ...");
let health = "";
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  health = ssh("docker exec dsh-relay wget -qO- http://127.0.0.1:3201/healthz 2>&1 || true").trim();
  if (health.includes("tunnel:online")) break;
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
console.log(health);
const logs = ssh("docker logs --tail 20 dsh-relay 2>&1").trim();
console.log(logs);

if (!health.includes("tunnel:online")) {
  console.error("DEPLOY WARN: relay rebuilt but healthz is still not tunnel:online after 90s (check the PC tunnel/log)");
  process.exit(2);
}
console.log("DEPLOY PASS: relay updated and tunnel online");
