// Dump the Plugins settings page text so plugin/bundle activation state is
// visible without images. usage: node tools/plugin-gui-settings.mjs
import { chromium } from "playwright";
import { env } from "../shared/env.mjs";

const { mintDshCookie, readBrowserSessionSecret } = await import("../dsh2phone-dsh-plugin/dsh-cookie.js");
const authCookie = mintDshCookie({ secret: readBrowserSessionSecret(), authority: env("DSH_AUTHORITY", "127.0.0.1:43120"), ttlDays: 1 });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.addCookies([{ name: authCookie.name, value: authCookie.value, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Strict" }]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto("http://127.0.0.1:43120/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(9000);

const out = { errors };
// open settings via the sidebar-foot settings trigger
const settingsBtn = page.locator('button[aria-label*="设置"], button:has-text("设置")').first();
out.settingsFound = (await settingsBtn.count()) > 0;
if (out.settingsFound) {
  await settingsBtn.click();
  await page.waitForTimeout(2500);
  out.panelText = ((await page.textContent("body")) ?? "").replace(/\s+/g, " ").slice(0, 1200);
  // find the Plugins nav/tab
  const pluginsTab = page.locator('button:has-text("插件"), [role="tab"]:has-text("插件"), a:has-text("插件")').first();
  if ((await pluginsTab.count()) > 0) {
    await pluginsTab.click();
    await page.waitForTimeout(3000);
    const body = ((await page.textContent("body")) ?? "").replace(/\s+/g, " ");
    out.pluginsIndex = body.indexOf("手机配对");
    out.pluginsAround = out.pluginsIndex >= 0 ? body.slice(Math.max(0, out.pluginsIndex - 400), out.pluginsIndex + 900) : null;
  } else {
    out.pluginsTabFound = false;
  }
}
console.log(JSON.stringify(out, null, 2));
await browser.close();
