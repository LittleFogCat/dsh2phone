// Verify where the pairing entry lives: inside the sidebar-foot account popup
// (设置 / 意见反馈 / 配对手机 / 退出登录), never as its own button in the sidebar
// foot, and that it still opens and closes the dialog correctly.
import { chromium } from "playwright";
import { accountTrigger, pairMenuItem } from "./gui-entry.mjs";
import { env } from "../shared/env.mjs";

const { mintDshCookie, readBrowserSessionSecret } = await import("../dsh2phone-dsh-plugin/dsh-cookie.js");
const authCookie = mintDshCookie({ secret: readBrowserSessionSecret(), authority: env("DSH_AUTHORITY", "127.0.0.1:43120"), ttlDays: 1 });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.addCookies([{ name: authCookie.name, value: authCookie.value, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Strict" }]);
const page = await context.newPage();
await page.goto("http://127.0.0.1:43120/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(8000);

const compact = (text) => (text ?? "").replace(/\s+/g, " ").trim();
const out = {};

// The old footer button must be gone; the popup row must be the only entry.
out.footerButtons = await page.evaluate(() => Array.from(
  document.querySelectorAll('.d2p-trigger, footer button[aria-label="配对手机"]'),
).length);
out.footerSlotButtons = await page.evaluate(() => document.querySelectorAll('.d2p-trigger').length);

const trigger = accountTrigger(page);
out.triggerCount = await trigger.count();
out.triggerLabel = compact(await trigger.innerText().catch(() => ""));
out.triggerHasPopup = await trigger.getAttribute("aria-haspopup");

await trigger.click();
const item = pairMenuItem(page);
await item.waitFor({ state: "visible", timeout: 10000 });
out.menuRows = (await page.locator('[role="menu"] button[role="menuitem"]').allInnerTexts()).map(compact);
out.rowText = compact(await item.innerText());
out.rowBox = await item.boundingBox();
out.rowRole = await item.getAttribute("role");
out.menuStillOpenBeforeClick = (await page.locator('[role="menu"]').count()) > 0;

// The row joins the menu's keyboard walk: 设置 → 意见反馈 → 配对手机.
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
out.keyboardReachesRow = await page.evaluate(() => document.activeElement?.hasAttribute("data-d2p-menu-entry") ?? false);

await item.click();
await page.waitForTimeout(1200);
out.menuClosedAfterClick = (await page.locator('[role="menu"]').count()) === 0;
out.dialogRole = await page.locator('[role="dialog"]').count();
out.ariaModal = await page.locator('[role="dialog"]').first().getAttribute("aria-modal");
out.tabList = await page.locator('[role="tablist"] .d2p-tab').allInnerTexts();

await page.keyboard.press("Escape");
await page.waitForTimeout(500);
out.escapeClosed = (await page.locator(".d2p-dialog").count()) === 0;

// The entry must be reusable: reopening the popup grafts the row again, and
// Enter on the focused row opens the dialog like a click does.
await trigger.click();
await pairMenuItem(page).waitFor({ state: "visible", timeout: 10000 });
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
await page.waitForTimeout(800);
out.dialogOpenFromKeyboard = (await page.locator(".d2p-dialog").count()) > 0;
await page.mouse.click(5, 5);
await page.waitForTimeout(400);
out.outsideClickClosed = (await page.locator(".d2p-dialog").count()) === 0;

await trigger.click();
await page.waitForTimeout(400);
await page.screenshot({ path: "docs/plugin-gui-menu.png" });
out.rowPresentOnSecondOpen = await pairMenuItem(page).isVisible().catch(() => false);
await page.keyboard.press("Escape");

console.log(JSON.stringify(out, null, 2));
await browser.close();
