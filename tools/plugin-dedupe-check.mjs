// End-to-end dedupe check against the real GUI + production relay.
//
// Pairs a simulated phone twice: the first scan creates a device, the second
// scan (same browser cookie) must reuse that entry — the relay returns the same
// dshdev cookie and the whitelist keeps a single row. The test device is removed
// again afterwards through the admin plane.
//
// usage: node tools/plugin-dedupe-check.mjs
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import https from "node:https";
import { WebSocket } from "ws";
import { openControl, sendExpect } from "../dsh2phone-dsh-plugin/relay-admin.js";
import { REPO_ROOT, env, requireEnv } from "../shared/env.mjs";

const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const PHONE_NAME = "iPhone · iOS 17.0 Safari";
const PAIR_URL = requireEnv("PUBLIC_PAIR_URL", "参考 .env.example 填写 .env");
const AUTHORITY = env("DSH_AUTHORITY", "127.0.0.1:43120");

const { mintDshCookie, readBrowserSessionSecret } = await import("../dsh2phone-dsh-plugin/dsh-cookie.js");
const authCookie = mintDshCookie({ secret: readBrowserSessionSecret(), authority: AUTHORITY, ttlDays: 1 });
const keyFile = env("DSH2PHONE_KEY_FILE", REPO_ROOT + "/deploy/server/tunnel.key");
const key = env("DSH_TUNNEL_KEY") ?? readFileSync(keyFile, "utf8").trim();

const phoneGet = (url, cookie) => new Promise((resolve, reject) => {
  const req = https.request(url, {
    headers: { "user-agent": PHONE_UA, ...(cookie ? { cookie } : {}) },
    rejectUnauthorized: false,
  }, (res) => {
    let body = "";
    res.on("data", (c) => { body += c; });
    res.on("end", () => resolve({ status: res.statusCode, body, cookies: res.headers["set-cookie"] ?? [] }));
  });
  req.on("error", reject);
  req.end();
});
const dshdev = (cookies) => {
  const pair = cookies.find((c) => c.startsWith("dshdev="));
  return pair ? pair.split(";")[0] : "";
};

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.addCookies([{ name: authCookie.name, value: authCookie.value, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Strict" }]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

const result = {};
let firstCookie = "";
try {
  await page.goto("http://127.0.0.1:43120/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(8000);

  // Round 1: open the dialog from the account menu, then answer the phone.
  await page.locator('button[aria-haspopup="menu"][data-signed-out]').first().click();
  await page.locator("[data-d2p-menu-entry]").first().click();
  const dialog = page.locator(".d2p-dialog");
  let code = (await page.locator(".d2p-code").innerText({ timeout: 25000 })).trim();
  let phonePromise = phoneGet(`${PAIR_URL}?code=${code}`);
  await dialog.locator('.d2p-btnPrimary:has-text("允许接入")').waitFor({ state: "visible", timeout: 20000 });
  result.firstConfirm = (await dialog.innerText()).replace(/\s+/g, " ").slice(0, 160);
  await dialog.locator('.d2p-btnPrimary:has-text("允许接入")').click();
  let phone = await phonePromise;
  firstCookie = dshdev(phone.cookies);
  result.firstPair = { status: phone.status, hasCookie: firstCookie !== "", landing: phone.body.includes("进入 DSH") };

  // Whitelist after round 1.
  await page.locator('.d2p-tab:has-text("设备管理")').click();
  await page.waitForTimeout(2500);
  result.rowsAfterFirstPair = await page.locator(`.d2p-device:has-text("${PHONE_NAME}")`).count();

  // Round 2: same browser (device cookie) scans again.
  await page.locator('.d2p-tab:has-text("配对")').click();
  code = (await page.locator(".d2p-code").innerText({ timeout: 25000 })).trim();
  phonePromise = phoneGet(`${PAIR_URL}?code=${code}`, firstCookie);
  await dialog.locator('.d2p-btnPrimary:has-text("允许接入")').waitFor({ state: "visible", timeout: 20000 });
  result.secondConfirm = (await dialog.innerText()).replace(/\s+/g, " ").slice(0, 220);
  result.secondShowsExisting = result.secondConfirm.includes("已在白名单");
  await dialog.locator('.d2p-btnPrimary:has-text("允许接入")').click();
  phone = await phonePromise;
  result.secondPair = { status: phone.status, sameDeviceCookie: dshdev(phone.cookies) === firstCookie };

  await page.locator('.d2p-tab:has-text("设备管理")').click();
  await page.waitForTimeout(2500);
  result.rowsAfterSecondPair = await page.locator(`.d2p-device:has-text("${PHONE_NAME}")`).count();

  await page.locator(".d2p-close").click();
} catch (err) {
  result.failure = err.message;
} finally {
  await browser.close();
  try {
    const ws = await openControl({ relayUrl: requireEnv("RELAY_URL", "参考 .env.example 填写 .env"), key, WebSocketImpl: WebSocket });
    const list = await sendExpect(ws, { t: "devices.list" }, "devices");
    for (const device of list.devices ?? []) {
      if (device.name === PHONE_NAME && device.ua === PHONE_UA) {
        await sendExpect(ws, { t: "devices.remove", id: device.id }, "ok");
        result.cleanedUp = (result.cleanedUp ?? 0) + 1;
      }
    }
    ws.close();
  } catch (err) {
    result.cleanupError = err.message;
  }
}

result.errors = errors.slice(0, 4);
result.ok = result.firstPair?.status === 200
  && result.firstPair?.hasCookie === true
  && result.secondPair?.sameDeviceCookie === true
  && result.rowsAfterFirstPair === 1
  && result.rowsAfterSecondPair === 1;
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
