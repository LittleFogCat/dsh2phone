// 手机冷启动测量：用 Chromium（Edge）模拟 CPU 降速 + 蜂窝网络，量 DSH 页面从导航到“可输入”的耗时。
//
// usage:
//   node tools/mobile-coldstart.mjs                     # 本机、4x CPU、无限速
//   node tools/mobile-coldstart.mjs --cpu 4 --rtt 80 --down 12000
//   node tools/mobile-coldstart.mjs --persistent        # 保留磁盘缓存，测“二次冷启动”
//
// 说明：
// - 只测本机 DSH（http://127.0.0.1:43120），cookie 由 tunnel/src/dsh-cookie.mjs 铸造；
//   公网 origin 的 device cookie 拿不到，不在本工具范围内。
// - “可输入”= 页面出现 textarea / contenteditable，近似用户能开始打字的时刻。
// - CPU 倍率不是真机换算：1x≈桌面，2x≈旗舰，4x≈中端，6x≈低端；看数量级与相对占比。
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const raw = process.argv[i];
  if (!raw.startsWith("--")) continue;
  const key = raw.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    i += 1;
  } else {
    args.set(key, "1");
  }
}

const url = args.get("url") ?? "http://127.0.0.1:43120/";
const cpu = Number(args.get("cpu") ?? "4");
const rtt = Number(args.get("rtt") ?? "0");
const downKbps = Number(args.get("down") ?? "1000000");
const upKbps = Number(args.get("up") ?? "1000000");
const channel = args.get("channel") ?? "msedge";
const persistent = args.get("persistent") === "1";
const runs = Math.max(1, Number(args.get("runs") ?? "1"));

const { mintDshCookie } = await import(pathToFileURL("./tunnel/src/dsh-cookie.mjs").href);
const cookie = mintDshCookie();
const origin = new URL(url).origin;

const profileDir = persistent ? mkdtempSync(join(tmpdir(), "dsh-coldstart-")) : null;

async function newSession() {
  const launchOpts = { channel, headless: true, ignoreHTTPSErrors: true };
  let browser = null;
  let context;
  if (persistent) {
    context = await chromium.launchPersistentContext(profileDir, launchOpts);
  } else {
    browser = await chromium.launch(launchOpts);
    context = await browser.newContext(launchOpts);
  }
  await context.addCookies([{ name: cookie.name, value: cookie.value, url: origin + "/", httpOnly: true }]);
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  if (rtt > 0 || downKbps < 1000000) {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: rtt,
      downloadThroughput: Math.round((downKbps * 1024) / 8),
      uploadThroughput: Math.round((upKbps * 1024) / 8),
      connectionType: "cellular4g",
    });
  }
  if (cpu !== 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  await page.addInitScript(() => {
    window.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__longTasks.push(Math.round(entry.duration));
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      // 老内核不支持 longtask：忽略。
    }
  });
  return { browser, context, page };
}

async function measure() {
  const { browser, context, page } = await newSession();
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "commit", timeout: 120000 });
  const commit = Date.now() - t0;

  let interactiveAt = null;
  for (let i = 0; i < 300; i++) {
    await page.waitForTimeout(100);
    const ready = await page
      .evaluate(() => !!document.querySelector('textarea, [contenteditable="true"]'))
      .catch(() => false);
    if (ready) {
      interactiveAt = Date.now() - t0;
      break;
    }
  }

  const perf = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] ?? {};
    const paint = performance.getEntriesByType("paint");
    const entries = performance.getEntriesByType("resource");
    return {
      fcp: Math.round(paint.find((p) => p.name === "first-contentful-paint")?.startTime ?? 0),
      load: Math.round(nav.loadEventEnd ?? 0),
      requests: entries.length,
      transferKb: Math.round(entries.reduce((sum, r) => sum + (r.transferSize || 0), 0) / 1024),
      decodedKb: Math.round(entries.reduce((sum, r) => sum + (r.decodedBodySize || 0), 0) / 1024),
      longTaskTotal: window.__longTasks.reduce((sum, d) => sum + d, 0),
      longTasks: window.__longTasks.slice(0, 10),
    };
  });

  await context.close();
  if (browser) await browser.close();
  return { commit, fcp: perf.fcp, interactiveAt, load: perf.load, ...perf };
}

const label = [
  `cpu=${cpu}x`,
  `rtt=${rtt}ms`,
  `down=${downKbps}kbps`,
  persistent ? "persistent" : "fresh",
].join(" ");
console.log(`# ${label}  ${url}`);

const samples = [];
for (let i = 0; i < runs; i++) {
  const result = await measure();
  samples.push(result);
  if (runs > 1) {
    console.log(
      `run ${i + 1}: fcp=${result.fcp}ms input=${result.interactiveAt ?? "n/a"}ms load=${result.load}ms transfer=${result.transferKb}KB`,
    );
  }
}

if (runs > 1) {
  const median = (key) => {
    const values = samples.map((s) => s[key]).filter((v) => typeof v === "number").sort((a, b) => a - b);
    return values.length ? values[Math.floor(values.length / 2)] : null;
  };
  console.log(`median: fcp=${median("fcp")}ms input=${median("interactiveAt")}ms load=${median("load")}ms`);
} else {
  const s = samples[0];
  console.log(`FCP        ${s.fcp} ms`);
  console.log(`可输入     ${s.interactiveAt ?? "n/a"} ms`);
  console.log(`load       ${s.load} ms`);
  console.log(`传输       ${s.transferKb} KB（解码 ${s.decodedKb} KB，${s.requests} 个请求）`);
  console.log(`长任务     ${s.longTaskTotal} ms  ${JSON.stringify(s.longTasks)}`);
}

if (profileDir) rmSync(profileDir, { recursive: true, force: true });
process.exit(samples.some((s) => s.interactiveAt === null) ? 1 : 0);
