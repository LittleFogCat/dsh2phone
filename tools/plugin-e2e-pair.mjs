// End-to-end pairing verification for the installed dsh2phone plugin.
// The script plays both sides: it opens the real DSH GUI (Playwright), extracts
// the pairing code from the rendered dialog, then impersonates the phone by
// calling the public pairing endpoint. It expects the in-GUI confirmation to
// appear, approves it, verifies the phone receives its 303 + cookies, checks the
// device in the whitelist view, then removes it again.
// usage: node tools/plugin-e2e-pair.mjs
import { chromium } from "playwright";
import { openPairDialog } from "./gui-entry.mjs";
import { env, requireEnv } from "../shared/env.mjs";

const { mintDshCookie, readBrowserSessionSecret } = await import("../dsh2phone-dsh-plugin/dsh-cookie.js");
const authCookie = mintDshCookie({ secret: readBrowserSessionSecret(), authority: env("DSH_AUTHORITY", "127.0.0.1:43120"), ttlDays: 1 });

const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const PAIR_URL = requireEnv("PUBLIC_PAIR_URL", "参考 .env.example 填写 .env");
const ENTRY_URL = `${new URL(PAIR_URL).origin}/dsh/`;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.addCookies([{ name: authCookie.name, value: authCookie.value, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Strict" }]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

const result = { errors };
try {
  await page.goto("http://127.0.0.1:43120/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(8000);
  await openPairDialog(page);
  const qr = page.locator("img.d2p-qr");
  await qr.waitFor({ state: "visible", timeout: 25000 });
  const dialog = page.locator(".d2p-dialog");
  const text = await dialog.innerText();
  const code = /([0-9a-f]{8})/.exec(text)?.[1];
  result.code = code;
  if (!code) throw new Error("pairing code not found in dialog: " + text.slice(0, 200));

  // phone side: hits the public pairing endpoint and waits for approval.
  // Node's fetch drops the `cookie` header, so use the raw https client for the
  // phone role (needed for the follow-up entry-page request).
  const https = await import("node:https");
  const phoneGet = (url, cookie) => new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: { "user-agent": PHONE_UA, ...(cookie ? { cookie } : {}) },
      rejectUnauthorized: false,
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });

  const phonePromise = phoneGet(`${PAIR_URL}?code=${code}&ua=${encodeURIComponent(PHONE_UA)}&ip=203.0.113.9`);

  // the GUI must show the confirmation view for this request
  await page.locator('.d2p-btnPrimary:has-text("允许接入")').waitFor({ state: "visible", timeout: 20000 });
  result.confirmText = (await dialog.innerText()).replace(/\s+/g, " ").slice(0, 160);
  result.confirmShown = /新设备请求接入/.test(result.confirmText);
  await page.locator('.d2p-btnPrimary:has-text("允许接入")').click();

  const phoneResponse = await phonePromise;
  result.phoneStatus = phoneResponse.status;
  result.landingShown = /进入 DSH/.test(phoneResponse.body);
  result.landingHasEntryLink = /href="\/dsh\/"/.test(phoneResponse.body);

  const setCookies = [].concat(phoneResponse.headers["set-cookie"] ?? []);
  const deviceCookie = /dshdev=([^;]+)/.exec(setCookies.find((c) => c.startsWith("dshdev=")) ?? "")?.[1];
  const authSetCookie = setCookies.find((c) => c.startsWith("dsh-auth-"));
  const authPair = authSetCookie ? authSetCookie.split(";")[0] : "";
  result.phoneCookies = setCookies.map((c) => c.split("=")[0]);

  // tapping the entry should load the DSH app
  if (deviceCookie && authPair) {
    const app = await phoneGet(ENTRY_URL, `dshdev=${deviceCookie}; ${authPair}`);
    result.entryLoadsApp = app.status === 200 && /会话|设置/.test(app.body);
    result.entryStatus = app.status;
  }

  // device must appear in the whitelist view (scope to this simulated phone:
  // other real devices may already be paired)
  await page.locator('.d2p-tab:has-text("设备管理")').click();
  const testDevice = page.locator('.d2p-device:has-text("iPhone")').first();
  await testDevice.waitFor({ state: "visible", timeout: 15000 });
  result.deviceText = (await testDevice.innerText()).replace(/\s+/g, " ");
  result.deviceListed = /已允许/.test(result.deviceText);

  // clean up: remove the test device (two-step confirmation)
  const removeBtn = testDevice.locator('.d2p-btn:has-text("移除")').first();
  await removeBtn.click();
  await page.locator('.d2p-btn:has-text("确认移除？")').first().click();
  await page.waitForTimeout(2500);
  result.devicesAfterCleanup = ((await page.locator(".d2p-dialog").innerText()) ?? "").replace(/\s+/g, " ").slice(0, 160);
  result.cleanedUp = !/已允许|停用/.test((await page.locator(".d2p-dialog").innerText()) ?? "") || !(await page.locator('.d2p-device:has-text("iPhone")').count());

  await page.locator(".d2p-close").click();
  await page.waitForTimeout(500);
  result.dialogClosed = (await page.locator(".d2p-dialog").count()) === 0;
} catch (err) {
  result.failure = err.message;
  result.dialogTextAtFailure = await page.locator(".d2p-dialog").innerText().catch(() => "");
} finally {
  await browser.close();
}

result.errors = errors.slice(0, 6);
console.log(JSON.stringify(result, null, 2));
process.exit(result.failure ? 1 : 0);
