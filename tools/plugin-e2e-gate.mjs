// Public entry honours whatever .env points at (domain, or an IP during the
// mainland SNI-reset window); TLS verification is relaxed for the phone role
// because the relay may be addressed by IP while its certificate is per-domain.
import { chromium } from "playwright";
import { openPairDialog } from "./gui-entry.mjs";
import { env, requireEnv } from "../shared/env.mjs";

const { mintDshCookie, readBrowserSessionSecret } = await import("../dsh2phone-dsh-plugin/dsh-cookie.js");
const AUTHORITY = env("DSH_AUTHORITY", "127.0.0.1:43120");
const authCookie = mintDshCookie({ secret: readBrowserSessionSecret(), authority: AUTHORITY, ttlDays: 1 });
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const PAIR_URL = requireEnv("PUBLIC_PAIR_URL", "参考 .env.example 填写 .env");
const PUBLIC_ORIGIN = new URL(PAIR_URL).origin;
const ENTRY_URL = `${PUBLIC_ORIGIN}/dsh/`;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const gui = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await gui.addCookies([{ name: authCookie.name, value: authCookie.value, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Strict" }]);
const page = await gui.newPage();

const out = {};
try {
  await page.goto("http://127.0.0.1:43120/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(8000);
  await openPairDialog(page);
  await page.locator("img.d2p-qr").waitFor({ state: "visible", timeout: 25000 });
  const code = /([0-9a-f]{8})/.exec(await page.locator(".d2p-dialog").innerText())?.[1];

  const phone = await browser.newContext({ userAgent: PHONE_UA, ignoreHTTPSErrors: true });
  const phonePage = await phone.newPage();
  // The pairing request is intentionally held open by the relay until this
  // computer answers, so start the navigation without awaiting it.
  const pairNavigation = phonePage
    .goto(`${PAIR_URL}?code=${code}`, { waitUntil: "domcontentloaded", timeout: 90000 })
    .catch((err) => ({ navigationError: err.message }));
  await page.locator('.d2p-btnPrimary:has-text("允许接入")').waitFor({ state: "visible", timeout: 30000 });
  await page.locator('.d2p-btnPrimary:has-text("允许接入")').click();
  await pairNavigation;
  await phonePage.waitForTimeout(3000);
  out.pairFinalUrl = phonePage.url();
  out.pairBody = ((await phonePage.textContent("body")) ?? "").replace(/\s+/g, " ").slice(0, 80);
  const cookies = await phone.cookies(PUBLIC_ORIGIN);
  const deviceCookie = cookies.find((c) => c.name === "dshdev")?.value ?? "";
  out.hasDeviceCookie = Boolean(deviceCookie);
  out.cookieNames = cookies.map((c) => c.name);

  // the pairing response is the entry page, not a redirect
  out.entryPage = {
    url: phonePage.url(),
    hasEntry: /进入 DSH/.test((await phonePage.textContent("body")) ?? ""),
    hasHomeScreenTip: /添加到主屏幕/.test((await phonePage.textContent("body")) ?? ""),
  };
  await phonePage.click("a.enter");
  await phonePage.waitForTimeout(3000);

  // a paired device that reopens /dsh-pair (no code) still gets the entry page
  const revisit = await phonePage.goto(PAIR_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
  out.revisitEntry = {
    status: revisit?.status(),
    hasEntry: /进入 DSH/.test((await phonePage.textContent("body")) ?? ""),
  };

  // device allowed: the GUI itself should load
  out.allowed = await (async () => {
    const r = await phonePage.goto(ENTRY_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => ({ status: () => e.message }));
    const body = ((await phonePage.textContent("body")) ?? "").replace(/\s+/g, " ");
    return { status: r?.status(), hasApp: /会话|设置|新/.test(body), denied: /未知设备|已被停用/.test(body) };
  })();

  // deny through the plugin UI (scope to this simulated phone: the user's own
  // device may be paired already and must not be touched)
  await page.locator('.d2p-tab:has-text("设备管理")').click();
  const testDevice = page.locator('.d2p-device:has-text("iPhone")').first();
  await testDevice.waitFor({ state: "visible", timeout: 15000 });
  await testDevice.locator('.d2p-btn:has-text("停用")').first().click();
  await page.waitForTimeout(2500);
  out.denied = await (async () => {
    const r = await phonePage.goto(ENTRY_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => ({ status: () => -1 }));
    const body = ((await phonePage.textContent("body")) ?? "").replace(/\s+/g, " ");
    return { status: r?.status(), deniedText: /设备已被停用/.test(body), snippet: body.slice(0, 80) };
  })();

  // allow again
  await testDevice.locator('.d2p-btn:has-text("启用")').first().click();
  await page.waitForTimeout(2500);
  out.reenabled = await (async () => {
    const r = await phonePage.goto(ENTRY_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => ({ status: () => -1 }));
    const body = ((await phonePage.textContent("body")) ?? "").replace(/\s+/g, " ");
    return { status: r?.status(), hasApp: /会话|设置|新/.test(body) };
  })();

  // remove
  await testDevice.locator('.d2p-btn:has-text("移除")').first().click();
  await page.locator('.d2p-btn:has-text("确认移除？")').first().click();
  await page.waitForTimeout(2500);
  out.removed = await (async () => {
    const r = await phonePage.goto(ENTRY_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => ({ status: () => -1 }));
    const body = ((await phonePage.textContent("body")) ?? "").replace(/\s+/g, " ");
    return { status: r?.status(), deniedText: /未知设备|设备已被停用/.test(body) };
  })();
  // the simulated iPhone is gone; other (real) devices may legitimately remain
  out.cleanedUp = (await page.locator('.d2p-device:has-text("iPhone")').count()) === 0;
  await phone.close();
  await page.locator(".d2p-close").click();
} catch (err) {
  out.failure = err.message;
  out.dialogText = await page.locator(".d2p-dialog").innerText().catch(() => "");
} finally {
  await browser.close();
}
console.log(JSON.stringify(out, null, 2));
