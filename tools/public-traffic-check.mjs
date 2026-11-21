// 看“真机这一次冷启动”实际从公网下了多少字节。
//
// usage: node tools/public-traffic-check.mjs [--minutes 10]
//
// 读 .env 的 DSH2PHONE_SSH_KEY / USER / SERVER_IP，用 docker logs 取 nginx 访问日志，
// 汇总 /dsh/ 请求的 body_bytes_sent（压缩后线上字节）。用来确认：
//   - gzip 在 proxy 路径是否真的生效（总量 ~2.9 MB vs ~10.2 MB）；
//   - WebView 磁盘缓存是否命中（二次冷启动应远小于 2.9 MB）。
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { env, requireEnv } from "../shared/env.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const raw = process.argv[i];
  if (!raw.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(raw.slice(2), next);
    i += 1;
  } else {
    args.set(raw.slice(2), "1");
  }
}

const minutes = Number(args.get("minutes") ?? "10");
const key = requireEnv("DSH2PHONE_SSH_KEY", "SSH 私钥路径").replace(/^~(?=$|[\\/])/, homedir());
const user = requireEnv("DSH2PHONE_SSH_USER", "SSH 用户");
const host = requireEnv("DSH2PHONE_SERVER_IP", "服务器 IP");

const result = spawnSync("ssh", [
  "-n",
  "-i", key,
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=15",
  `${user}@${host}`,
  `docker logs --since ${minutes}m nginx 2>&1`,
], { encoding: "utf8" });
if (result.error) {
  console.error("SSH FAIL:", result.error.message);
  process.exit(1);
}
if (result.status !== 0) {
  console.error("SSH FAIL:", (result.stderr || "").slice(0, 500));
  process.exit(1);
}

// combined: $remote_addr - - [$time] "$request" $status $body_bytes_sent ...
const pattern = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+) [^"]*" (\d{3}) (\d+)/;
const paths = new Map();
let totalBytes = 0;
let requests = 0;
let lastTime = "";

for (const line of (result.stdout || "").split(/\r?\n/)) {
  if (!line.includes("/dsh/")) continue;
  const match = pattern.exec(line);
  if (!match) continue;
  const [, , time, , requestPath, status, bytes] = match;
  if (status !== "200" && status !== "206") continue;
  requests += 1;
  totalBytes += Number(bytes);
  lastTime = time;
  const clean = requestPath.split("?")[0];
  const row = paths.get(clean) ?? { bytes: 0, count: 0 };
  row.bytes += Number(bytes);
  row.count += 1;
  paths.set(clean, row);
}

if (requests === 0) {
  console.log(`最近 ${minutes} 分钟没有 /dsh/ 的 200 请求（先把手机 App 打开一次再跑）。`);
  process.exit(0);
}

const mb = totalBytes / 1024 / 1024;
console.log(`最近 ${minutes} 分钟：${requests} 个 /dsh/ 请求，线上共 ${mb.toFixed(2)} MB（最后一条 ${lastTime}）`);
console.log("最大的请求：");
for (const [path, row] of [...paths.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 10)) {
  console.log(`  ${(row.bytes / 1024).toFixed(0).padStart(6)} KB  x${String(row.count).padStart(2)}  ${path.slice(0, 100)}`);
}

if (mb > 8) {
  console.log("判断：像“未压缩或缓存全冷”——10 MB 级下载；确认 /dsh/ 的响应是否带 Content-Encoding。");
} else if (mb > 1.5) {
  console.log("判断：gzip 生效、缓存冷；首次冷启动的传输量应在 2–3 MB 左右。");
} else {
  console.log("判断：缓存命中（传输量远小于全量）；二次冷启动应该很快。");
}
