// 公网链路自检：出口带宽 + JS/CSS 是否被 nginx 压缩 + 压缩后体积。
//
// usage: node tools/public-link-check.mjs
//
// 只读：下载发布页的 APK 估算出口带宽，再取主站的一个 JS/CSS 看 content-encoding
// 和线上传输字节。用来判断“公网冷启动慢”是带宽、压缩还是别的原因；改完 nginx 后重跑对比。
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { requireEnv } from "../shared/env.mjs";

const origin = new URL(requireEnv("PUBLIC_PAIR_URL", "参考 .env.example 填写 .env")).origin;
const mask = (url) => url.replace(origin, "<PUBLIC_ORIGIN>");

async function timedDownload(url) {
  const t0 = performance.now();
  const res = await fetch(url);
  if (!res.ok) return { status: res.status, bytes: 0, seconds: 0, mbps: 0 };
  let bytes = 0;
  let firstByteAt = 0;
  for await (const chunk of res.body) {
    if (!firstByteAt) firstByteAt = performance.now() - t0;
    bytes += chunk.length;
  }
  const seconds = (performance.now() - t0) / 1000;
  return { status: res.status, bytes, firstByteAt: Math.round(firstByteAt), seconds, mbps: (bytes * 8) / 1e6 / seconds };
}

// 拿“线上字节”和“解压后字节”，fetch 会自动解压，所以这里用 node:http(s)。
function rawGet(url) {
  return new Promise((resolve, reject) => {
    const request = url.startsWith("https:") ? httpsRequest : httpRequest;
    const req = request(
      url,
      { headers: { "Accept-Encoding": "gzip, br", "User-Agent": "dsh2phone-public-link-check" } },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const encoding = res.headers["content-encoding"] ?? "(none)";
          let decoded = raw;
          try {
            if (encoding === "gzip") decoded = gunzipSync(raw);
            else if (encoding === "br") decoded = brotliDecompressSync(raw);
          } catch {
            // 解压失败就按原样算，不影响 encoding 的判断。
          }
          resolve({ status: res.statusCode, encoding, wire: raw.length, decoded: decoded.length });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

const apk = await timedDownload(`${origin}/dsh2phone/dsh2phone-latest.apk`);
if (apk.bytes > 0) {
  console.log(
    `出口带宽   ${(apk.bytes / 1024 / 1024).toFixed(2)} MB / ${apk.seconds.toFixed(2)}s = ` +
      `${apk.mbps.toFixed(1)} Mbps（TTFB ${apk.firstByteAt}ms）`,
  );
} else {
  console.log(`出口带宽   跳过：APK 下载失败（HTTP ${apk.status}）`);
}

// 主站与 /dsh/ 共用同一个 nginx；主站 JS 的压缩状态就是 /dsh/ 的压缩状态。
const html = await (await fetch(`${origin}/`)).text();
const asset = [...html.matchAll(/<(?:script|link)[^>]*(?:src|href)="([^"]+\.(?:js|css)[^"]*)"/g)]
  .map((match) => match[1])
  .find(Boolean);

let ratio = 1;
if (asset) {
  const url = new URL(asset, origin).href;
  const res = await rawGet(url);
  ratio = res.decoded / Math.max(1, res.wire);
  console.log(
    `JS/CSS     ${mask(url)}  线上 ${res.wire} B / 原始 ${res.decoded} B ` +
      `= ${ratio.toFixed(1)}x  content-encoding=${res.encoding}`,
  );
  console.log(
    res.encoding === "(none)"
      ? "结论       静态 JS/CSS 未压缩：/dsh/ 的 10.2 MB 会原样过公网，先开 gzip_types。"
      : `结论       静态资源已压缩（${res.encoding}）：/dsh/ 的 10.2 MB 线上约 ${(10.2 / ratio).toFixed(1)} MB。`,
  );
} else {
  console.log("JS/CSS     跳过：主站首页没有找到 .js/.css 资源");
}

const gate = await fetch(`${origin}/dsh/`);
console.log(
  `门禁       GET /dsh/ -> HTTP ${gate.status}，content-encoding=${gate.headers.get("content-encoding") ?? "(none)"}`,
);

if (apk.bytes > 0 && apk.mbps > 0) {
  const pageWireMb = 10.2 / ratio;
  console.log(
    `带宽推算   10.2 MB 页面资源按 ${apk.mbps.toFixed(1)} Mbps 约需 ${(10.2 / (apk.mbps / 8)).toFixed(0)}s；` +
      `压缩后约 ${pageWireMb.toFixed(1)} MB ≈ ${(pageWireMb / (apk.mbps / 8)).toFixed(0)}s。`,
  );
}
