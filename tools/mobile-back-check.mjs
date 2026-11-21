// 返回键的「页面浮层」契约检查（无设备、无浏览器依赖）。
//
// WebAppActivity.BACK_DISMISS_JS 负责：返回键按下时找页面最上层浮层（DSH 的
// `[role=dialog][aria-modal=true]` / `[role=menu]`，以及 alertdialog），向它派发
// 冒泡的 Escape keydown，由 DSH 自己的 document 捕获监听关掉浮层。
//
// JVM 单测跑不到 Activity 里的 JS，模拟器 e2e 又需要 adb 设备，所以这里把 Java
// 源码里的这段 JS 抽出来，用极简 DOM 夹具验证「有无浮层 / 隐藏浮层 / 关不掉 /
// 最上层优先」等分支。真实 WebView 的 Escape 冒泡仍需在真机上复验（见
// docs/HANDOFF.md 的 Android 1.2.1 小节）。
//
//   node tools/mobile-back-check.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

import { REPO_ROOT } from "../shared/env.mjs";

const ACTIVITY = join(REPO_ROOT, "mobile", "android", "app", "src", "main", "java",
  "tech", "xiaoniu", "dsh2phone", "WebAppActivity.java");

/** 抽出 `String BACK_DISMISS_JS = "…" + "…";` 的拼接结果。 */
function extractBackJs(source) {
  const decl = /String\s+BACK_DISMISS_JS\s*=/.exec(source);
  if (!decl) throw new Error("BACK_DISMISS_JS not found in WebAppActivity.java");
  const literals = [];
  let inString = false;
  let current = "";
  for (let i = decl.index + decl[0].length; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") {
        current += source[++i] ?? "";
      } else if (ch === "\"") {
        literals.push(current);
        current = "";
        inString = false;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === ";") break;
  }
  const js = literals.join("");
  if (!js.startsWith("(function()")) throw new Error(`unexpected BACK_DISMISS_JS: ${js.slice(0, 80)}`);
  return js;
}

// ---------------- 极简 DOM：只实现 BACK_DISMISS_JS 用到的 API ----------------
class KeyboardEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.key = init.key;
    this.bubbles = init.bubbles !== false;
    this.defaultPrevented = false;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.stopped = true;
  }
}

class Element {
  constructor(tag, { attrs = {}, className = "", style = {}, rect = { width: 100, height: 100 } } = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.className = className;
    this.style = { display: "block", visibility: "visible", opacity: "1", ...style };
    this.rect = rect;
    this.children = [];
    this.parentNode = null;
    this.listeners = [];
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  /** 按真实 DOM 的相位顺序派发：document 捕获 → 目标 → 冒泡回 document。 */
  dispatchEvent(event) {
    event.target = this;
    const path = [];
    for (let node = this; node; node = node.parentNode) path.unshift(node);
    const fire = (node, phase) => {
      for (const listener of node.listeners) {
        if (listener.type !== event.type) continue;
        if (phase === "capture" && !listener.capture) continue;
        if (phase === "bubble" && listener.capture) continue;
        listener.fn(event);
        if (event.stopped) return true;
      }
      return false;
    };
    for (let n = 0; n < path.length - 1 && !event.stopped; n++) {
      if (fire(path[n], "capture")) return;
    }
    if (!event.stopped) fire(event.target, "target");
    for (let n = path.length - 2; n >= 0 && !event.stopped; n--) {
      if (fire(path[n], "bubble")) return;
    }
  }
}

class Document extends Element {
  constructor() {
    super("#document");
    this.body = new Element("body");
    this.body.parentNode = this;
    this.children = [this.body];
  }

  addEventListener(type, fn, capture = false) {
    this.listeners.push({ type, fn, capture: capture === true });
  }

  removeEventListener(type, fn, capture = false) {
    this.listeners = this.listeners.filter(
      (l) => !(l.type === type && l.fn === fn && l.capture === (capture === true)));
  }

  /** 只支持本检查用到的选择器：`[attr=value]` / `[attr=value][attr2=value2]` / `.class`，逗号并集。 */
  querySelectorAll(selector) {
    const matchers = selector.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
      const attrs = [...part.matchAll(/\[([\w-]+)=([^\]]+)\]/gu)].map((m) => [m[1], m[2]]);
      const classes = [...part.matchAll(/\.([\w-]+)/gu)].map((m) => m[1]);
      return (el) => attrs.every(([k, v]) => el.getAttribute(k) === v)
        && classes.every((c) => String(el.className).split(/\s+/u).includes(c));
    });
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matchers.some((match) => match(child))) found.push(child);
        walk(child);
      }
    };
    walk(this.body);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function createPage() {
  const document = new Document();
  const window = {};
  const sandbox = {
    window,
    document,
    KeyboardEvent,
    Date,
    String,
    Number,
    parseFloat,
    isNaN,
    getComputedStyle: (el) => ({
      display: el.style.display,
      visibility: el.style.visibility,
      opacity: String(el.style.opacity),
    }),
  };
  return { document, window, sandbox };
}

/** 模拟 DSH 前端：document 捕获阶段处理 Escape，关掉最上层浮层（对话/菜单）。 */
function installDshEscape(document) {
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const overlays = document.querySelectorAll("[role=dialog][aria-modal=true],[role=menu]");
    if (!overlays.length) return;
    const top = overlays[overlays.length - 1];
    top.parentNode.children = top.parentNode.children.filter((node) => node !== top);
    event.preventDefault();
  }, true);
}

function addOverlay(document, attrs, style = {}, className = "") {
  const el = new Element("div", { attrs, className, style });
  el.parentNode = document.body;
  document.body.children.push(el);
  return el;
}

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

function main() {
  const js = extractBackJs(readFileSync(ACTIVITY, "utf8"));
  const { document, window, sandbox } = createPage();
  installDshEscape(document);
  const run = () => vm.runInNewContext(js, sandbox);

  check("没有浮层 → 交回原生（回主页）", run(), false);

  addOverlay(document, { role: "dialog", "aria-modal": "true" });
  check("有对话框 → 页面接管", run(), true);
  check("对话框被 Escape 关掉", document.querySelectorAll("[role=dialog]").length, 0);

  addOverlay(document, { role: "dialog", "aria-modal": "true" }, { display: "none" });
  check("隐藏的浮层不算（不吞返回键）", run(), false);
  document.body.children = [];

  addOverlay(document, { role: "alertdialog" }, {}, "stubborn");
  check("关不掉的浮层：第一次仍交给页面", run(), true);
  check("关不掉的浮层：连按第二次交回原生", run(), false);
  window.__dsh2phoneBack.at = 0;
  check("冷却窗口过后重新给页面一次机会", run(), true);
  document.body.children = [];

  addOverlay(document, { role: "dialog", "aria-modal": "true" }, {}, "test-dialog");
  addOverlay(document, { role: "menu" }, {}, "top-menu");
  check("最上层浮层优先关闭", run(), true);
  check("只关最上面那一层",
    document.querySelectorAll("[role=dialog],[role=menu]").map((el) => el.className),
    ["test-dialog"]);

  const failed = results.filter((r) => !r.ok);
  console.log("");
  if (failed.length) {
    console.log(`BACK CHECK FAIL: ${failed.length}/${results.length} 项不通过`);
    process.exit(1);
  }
  console.log(`BACK CHECK PASS: ${results.length}/${results.length} 项通过`);
}

main();
