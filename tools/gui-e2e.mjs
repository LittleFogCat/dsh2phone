// GUI e2e: real browser (local Edge) through the gated chain
// usage: node tools/gui-e2e.mjs <jar-cookie-string>
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";

const jarPath = process.argv[2] ?? ".e2e-jar.txt";
if (!existsSync(jarPath)) { console.error("jar not found:", jarPath); process.exit(1); }

// parse Netscape cookie jar (curl marks httponly cookies with a "#HttpOnly_" prefix)
const cookies = [];
for (const raw of readFileSync(jarPath, "utf8").split("\n")) {
  const line = raw.trim();
  if (!line) continue;
  let httpOnly = false;
  let content = line;
  if (content.startsWith("#HttpOnly_")) { httpOnly = true; content = content.slice("#HttpOnly_".length); }
  else if (content.startsWith("#")) continue;
  const parts = content.split(/\t/);
  if (parts.length < 7) continue;
  const [domain, , path, , , name, value] = parts;
  const at = value.indexOf("=");
  cookies.push({
    domain,
    name: name,
    value: value.slice(at + 1),
    path: path,
    secure: true,
    httpOnly,
    sameSite: "Strict",
  });
}
console.log("loaded cookies:", cookies.map((c) => c.name).join(", "));

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 900, height: 1600 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });
await context.addCookies(cookies.map((c) => ({ domain: "127.0.0.1", path: "/", name: c.name, value: c.value, secure: true, httpOnly: c.httpOnly, sameSite: "Strict" })));
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 200)); });

await page.goto("https://127.0.0.1:9443/dsh/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(8000); // let the SPA boot and connect the mux
const title = await page.title();
const bodyText = (await page.textContent("body")) ?? "";
const nodeCount = (await page.$$eval("*", (els) => els.length));
await page.screenshot({ path: "docs/gui-e2e.png", fullPage: false });

console.log(JSON.stringify({
  title,
  nodeCount,
  denied: bodyText.includes("未知设备") || bodyText.includes("已被停用"),
  unauthorized: bodyText.includes("authentication required") || bodyText.includes("401"),
  hasChineseUI: /会话|设置|聊天|新/.test(bodyText),
  errors: errors.slice(0, 8),
}, null, 2));
await browser.close();
