// Light/dark visual + contrast audit for the dsh2phone pairing dialog.
//
// For each scheme it opens the real dialog, grabs a pairing code, impersonates a
// phone hitting the public pairing endpoint (so the "allow / deny" confirmation
// view renders), measures computed colors/contrast, denies the request (no
// device is registered), screenshots the devices tab, and closes the dialog.
//
// usage: node tools/plugin-theme-check.mjs
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { openPairDialog } from "./gui-entry.mjs";
import { env, requireEnv } from "../shared/env.mjs";

const OUT = "docs/theme";
mkdirSync(OUT, { recursive: true });

const { mintDshCookie, readBrowserSessionSecret } = await import("../dsh2phone-dsh-plugin/dsh-cookie.js");
const authCookie = mintDshCookie({ secret: readBrowserSessionSecret(), authority: env("DSH_AUTHORITY", "127.0.0.1:43120"), ttlDays: 1 });

const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const PAIR_URL = requireEnv("PUBLIC_PAIR_URL", "参考 .env.example 填写 .env");

const https = await import("node:https");
const phoneGet = (url) => new Promise((resolve, reject) => {
  const req = https.request(url, { headers: { "user-agent": PHONE_UA }, rejectUnauthorized: false }, (res) => {
    let body = "";
    res.on("data", (c) => { body += c; });
    res.on("end", () => resolve({ status: res.statusCode, body }));
  });
  req.on("error", reject);
  req.end();
});

// Reads colors and resolves the effective background by walking ancestors.
async function measure(page, selectors) {
  return page.evaluate((sels) => {
    const parse = (value) => {
      const rgb = /rgba?\(([^)]+)\)/.exec(value || "");
      if (rgb) {
        const parts = rgb[1].split(/[ ,/]+/).filter(Boolean).map(Number);
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
      }
      // color-mix() computes to color(srgb ...) with 0..1 channels in Chromium.
      const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/.exec(value || "");
      if (srgb) {
        return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255, a: srgb[4] ? Number(srgb[4]) : 1 };
      }
      return null;
    };
    const over = (top, bottom) => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    const bgOf = (el) => {
      let acc = null;
      for (let node = el; node; node = node.parentElement) {
        const c = parse(getComputedStyle(node).backgroundColor);
        if (!c || c.a === 0) continue;
        acc = acc ? over(acc, c) : c;
        if (acc.a === 1) break;
      }
      return acc ?? { r: 255, g: 255, b: 255, a: 1 };
    };
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return ((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)); };
    const out = {};
    for (const [name, selector] of Object.entries(sels)) {
      const el = document.querySelector(selector);
      if (!el) { out[name] = null; continue; }
      const style = getComputedStyle(el);
      const fg = parse(style.color);
      const bg = bgOf(el);
      out[name] = {
        color: style.color,
        background: style.backgroundColor,
        effectiveBg: "rgb(" + Math.round(bg.r) + "," + Math.round(bg.g) + "," + Math.round(bg.b) + ")",
        contrast: Number(ratio(fg, bg).toFixed(2)),
      };
    }
    return out;
  }, selectors);
}

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.addCookies([{ name: authCookie.name, value: authCookie.value, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Strict" }]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

const report = {};
try {
  await page.goto("http://127.0.0.1:43120/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(8000);

  const setScheme = (scheme) => page.evaluate((value) => {
    if (value === "dark") {
      document.body.dataset.dsDarkTheme = "";
      document.documentElement.style.colorScheme = "dark";
    } else {
      delete document.body.dataset.dsDarkTheme;
      document.documentElement.style.colorScheme = "light";
    }
  }, scheme);

  for (const scheme of ["light", "dark"]) {
    const entry = { scheme };
    await setScheme(scheme);
    await openPairDialog(page);
    await page.locator("img.d2p-qr").waitFor({ state: "visible", timeout: 25000 });
    const dialogText = await page.locator(".d2p-dialog").innerText();
    const code = /([0-9a-f]{8})/.exec(dialogText)?.[1];
    entry.code = code;
    await page.screenshot({ path: `${OUT}/pair-${scheme}.png` });

    if (!code) throw new Error("no pairing code for " + scheme);
    const phonePromise = phoneGet(`${PAIR_URL}?code=${code}`);
    await page.locator('.d2p-btnPrimary:has-text("允许接入")').waitFor({ state: "visible", timeout: 20000 });
    entry.confirmText = (await page.locator(".d2p-dialog").innerText()).replace(/\s+/g, " ").slice(0, 120);
    entry.confirm = await measure(page, {
      primary: ".d2p-btnPrimary",
      secondary: ".d2p-btn:not(.d2p-btnPrimary)",
      dialog: ".d2p-dialog",
      status: ".d2p-status",
      title: ".d2p-title",
    });
    await page.screenshot({ path: `${OUT}/confirm-${scheme}.png` });

    await page.locator('.d2p-btn:has-text("拒绝")').click();
    const phone = await phonePromise;
    entry.phoneStatus = phone.status;

    await page.locator('.d2p-tab:has-text("设备管理")').click();
    await page.waitForTimeout(2500);
    entry.devices = await measure(page, {
      badge: ".d2p-badge",
      device: ".d2p-device",
      meta: ".d2p-meta",
      actionBtn: ".d2p-deviceActions .d2p-btn",
      tab: ".d2p-tabActive",
    });
    await page.screenshot({ path: `${OUT}/devices-${scheme}.png` });

    await page.locator(".d2p-close").click();
    await page.waitForTimeout(400);
    entry.closed = (await page.locator(".d2p-dialog").count()) === 0;
    report[scheme] = entry;
  }
} catch (err) {
  report.failure = err.message;
} finally {
  await browser.close();
}
report.errors = errors.slice(0, 6);
console.log(JSON.stringify(report, null, 2));
process.exit(report.failure ? 1 : 0);
