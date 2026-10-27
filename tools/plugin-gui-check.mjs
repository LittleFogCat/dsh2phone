// GUI verification for the installed dsh2phone plugin.
// usage: node tools/plugin-gui-check.mjs [--prod|--local]
//   --prod  (default) connect the dialog to the relay configured in .env
//   --local      point the dialog at a local relay on 13200/13201 via localStorage config override
// Opens the real DSH Web GUI at http://127.0.0.1:43120, finds the sidebar
// "配对手机" entry, opens the dialog, and verifies the QR renders.
// It closes the dialog at the end (cancelling any pairing session).
import { chromium } from "playwright";
import { accountTrigger, pairMenuItem } from "./gui-entry.mjs";
import { env } from "../shared/env.mjs";

const local = process.argv.includes("--local");
const base = "http://127.0.0.1:43120/";

// The loopback GUI is cookie-gated; mint a browser-session cookie the same way
// the plugin host does and inject it into the browser context.
const { mintDshCookie, readBrowserSessionSecret } = await import("../dsh2phone-dsh-plugin/dsh-cookie.js");
const authCookie = mintDshCookie({ secret: readBrowserSessionSecret(), authority: env("DSH_AUTHORITY", "127.0.0.1:43120"), ttlDays: 1 });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.addCookies([{
  name: authCookie.name,
  value: authCookie.value,
  domain: "127.0.0.1",
  path: "/",
  httpOnly: true,
  sameSite: "Strict",
}]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text().slice(0, 240));
});

await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(9000); // SPA boot + client module injection

const bodyText = (await page.textContent("body")) ?? "";
const trigger = accountTrigger(page);
const triggerCount = await trigger.count();
// The entry moved into the account popup: nothing pairing-related may sit in
// the sidebar foot any more.
const strayFooterEntry = await page.evaluate(() => Array.from(
  document.querySelectorAll('button[aria-label="配对手机"], .d2p-trigger',
)).filter((node) => node.closest('[role="menu"]') === null).length);

const result = { triggerCount, strayFooterEntry, errors_before_click: errors.slice(0, 6) };
result.title = await page.title();
result.bodySample = bodyText.replace(/\s+/g, " ").slice(0, 400);
result.hasChineseUI = /会话|设置|新/.test(bodyText);
result.loader = await page.evaluate(() => typeof window.__ModuleLoader__);
result.bootRows = await page.evaluate(() => {
  const boot = window.__DSH_BOOT__;
  const json = JSON.stringify(boot) ?? "";
  const idx = json.indexOf("dsh2phone");
  return {
    dsh2phoneInBoot: idx >= 0,
    around: idx >= 0 ? json.slice(Math.max(0, idx - 200), idx + 300) : null,
    rowNames: boot && boot.modules ? Object.keys(boot.modules).filter((k) => !k.startsWith("@deepseek-ai/")) : null,
  };
});
result.clientResources = await page.evaluate(() =>
  performance.getEntriesByType("resource").map((r) => r.name).filter((n) => /dsh2phone|client/i.test(n)).slice(0, 12));

if (triggerCount > 0) {
  await trigger.click();
  const menuItem = pairMenuItem(page);
  result.menuRowVisible = await menuItem.isVisible().catch(() => false);
  result.menuRowText = ((await menuItem.innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
  result.menuRows = (await page.locator('[role="menu"] button[role="menuitem"]').allInnerTexts())
    .map((text) => text.replace(/\s+/g, " "));
  await page.screenshot({ path: "docs/plugin-gui-menu.png" });
  await menuItem.click();
  await page.waitForTimeout(500);
  result.menuClosedAfterClick = (await page.locator('[role="menu"]').count()) === 0;
  const overlay = page.locator(".d2p-dialog");
  result.dialogOpen = (await overlay.count()) > 0;
  // pairStart connects to the relay; allow time for WSS + QR
  const qr = page.locator("img.d2p-qr");
  try {
    await qr.waitFor({ state: "visible", timeout: 20000 });
    result.qrVisible = true;
    result.qrIsPng = ((await qr.getAttribute("src")) ?? "").startsWith("data:image/png");
    result.dialogText = ((await overlay.first().innerText()) ?? "").slice(0, 300);
  } catch {
    result.qrVisible = false;
    result.dialogText = ((await overlay.first().innerText()) ?? "").slice(0, 500);
    result.dialogError = (await page.locator(".d2p-error").allInnerTexts()).join(" | ").slice(0, 500);
  }
  await page.screenshot({ path: "docs/plugin-gui-pair.png" });

  // devices tab (read-only devices.list against the relay)
  const devicesTab = page.locator('.d2p-tab', { hasText: "设备管理" });
  if ((await devicesTab.count()) > 0) {
    await devicesTab.first().click();
    await page.waitForTimeout(3000);
    const list = page.locator(".d2p-deviceList, .d2p-empty");
    result.devicesText = ((await list.first().textContent().catch(() => "")) ?? "").slice(0, 200);
    result.devicesRendered = (await list.count()) > 0;
  }
  await page.screenshot({ path: "docs/plugin-gui-devices.png" });

  // close the dialog (cancels the pairing session)
  const close = page.locator(".d2p-close");
  if ((await close.count()) > 0) await close.first().click();
  await page.waitForTimeout(400);
  result.dialogClosed = (await page.locator(".d2p-dialog").count()) === 0;
} else {
  await page.screenshot({ path: "docs/plugin-gui-missing.png" });
}

result.errors_final = errors.slice(0, 8);
console.log(JSON.stringify(result, null, 2));
await browser.close();
