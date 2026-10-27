// Renders relay-generated gate pages in light and dark to check they follow the
// phone's color scheme. Starts a throwaway relay on 13200/13201.
// usage: node tools/relay-pages-theme-check.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const OUT = "docs/theme";
mkdirSync(OUT, { recursive: true });
const stateDir = mkdtempSync(join(tmpdir(), "d2p-relay-"));

const relay = spawn(process.execPath, ["relay/src/relay.mjs"], {
  env: {
    ...process.env,
    RELAY_DATA_PORT: "13200",
    RELAY_CONTROL_PORT: "13201",
    DSH_TUNNEL_KEY: "theme-check-key",
    RELAY_STATE_DIR: stateDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
relay.stdout.on("data", (chunk) => process.stderr.write("[relay] " + chunk));
await new Promise((resolve) => setTimeout(resolve, 1200));

// Stand in for the PC tunnel so the data plane reaches the device gate instead
// of answering 503 (tunnel offline).
const { WebSocket } = await import("ws");
const fakeTunnel = new WebSocket("ws://127.0.0.1:13201/tunnel");
await new Promise((resolve, reject) => {
  fakeTunnel.on("open", () => fakeTunnel.send(JSON.stringify({ t: "hello", key: "theme-check-key" })));
  fakeTunnel.on("message", (data) => {
    if (JSON.parse(data.toString()).t === "hello.ok") resolve();
  });
  fakeTunnel.on("error", reject);
  setTimeout(() => reject(new Error("fake tunnel hello timeout")), 5000);
});

const report = {};
try {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 430, height: 860 } });
    const page = await context.newPage();
    const res = await page.goto("http://127.0.0.1:13200/dsh/", { waitUntil: "domcontentloaded" });
    report[scheme] = {
      status: res?.status(),
      background: await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
      color: await page.evaluate(() => getComputedStyle(document.body).color),
      text: (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 80),
    };
    await page.screenshot({ path: `${OUT}/gate-${scheme}.png` });
    await context.close();
  }
  await browser.close();
} finally {
  fakeTunnel.close();
  relay.kill();
  rmSync(stateDir, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
