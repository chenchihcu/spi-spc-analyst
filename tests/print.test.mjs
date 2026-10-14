// 列印／存成 PDF 與頁籤顯示測試
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { JSDOM } = (() => { try { return require("jsdom"); } catch { return {}; } })();
const fs = require("fs");
const { HTML } = require("./_load.js");
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const html = () => fs.readFileSync(HTML, "utf8").replace(/<script src=[^>]+><\/script>/g, "");

function page(url, extra = {}) {
  return new JSDOM(html(), { runScripts: "dangerously", url, beforeParse(w) {
    w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === "measureText" ? () => ({ width: 1 }) : t[k] ?? (() => {})), set: (t, k, v) => ((t[k] = v), true) });
    Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { let e = this; while (e) { if (e.hidden) return null; e = e.parentElement; } return w.document.body; } });
    w.Element.prototype.scrollIntoView = () => {}; w.matchMedia = () => ({ matches: false, addEventListener() {} }); w.ResizeObserver = class { observe() {} }; w.scrollTo = () => {};
    w.Chart = class { constructor() {} destroy() {} static register() {} };
    Object.assign(w, extra);
  } });
}

test("hidden 屬性一律隱藏（避免未選取的頁籤也顯示），並有列印樣式", () => {
  const h = html();
  assert.match(h, /\[hidden\]\{display:none!important\}/);
  assert.match(h, /@media print\{/);
});

test("列印：一般網站顯示按鈕；列印前頁首帶回合與版本、改用淺色，列印後還原", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const dom = page("https://spi.example/");
  await tick(60);
  const w = dom.window, d = w.document;
  assert.equal(d.querySelector("#btnPrint").hidden, false);
  d.documentElement.setAttribute("data-theme", "dark");
  w.dispatchEvent(new w.Event("beforeprint"));
  assert.equal(d.documentElement.getAttribute("data-theme"), "light");
  const head = d.querySelector("#printHead").textContent;
  assert.match(head, /問題偵測/); assert.match(head, /回合：/); assert.match(head, new RegExp(d.querySelector("#appVer").textContent.replace(".", "\\.")));
  w.dispatchEvent(new w.Event("afterprint"));
  assert.equal(d.documentElement.getAttribute("data-theme"), "dark", "列印後還原原本主題");
});

test("列印：在 claude.ai 內不顯示列印按鈕", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const dom = page("https://example.test/", { claude: { use: async () => null } });
  await tick(60);
  assert.equal(dom.window.document.querySelector("#btnPrint").hidden, true);
});

test("匯出 CSV：以 = + - @ 開頭的文字前加 '，避免被試算表當成公式；數值不受影響", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const dom = page("https://spi.example/");
  await tick(60);
  const w = dom.window;
  let saved = null;
  w.URL.createObjectURL = (b) => { saved = b; return "blob:x"; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = () => {};
  // 讓第一個問題的標題以 = 開頭，匯出問題清單 CSV
  w.eval(`S.F[0].title='=1+2 惡意'`);
  w.document.querySelector("#btnIssCsv").click();
  for (let i = 0; i < 20 && !saved; i++) await tick(20);
  const text = await new Promise((ok) => { const r = new w.FileReader(); r.onload = () => ok(r.result); r.readAsText(saved); });
  assert.match(text, /,'=1\+2 惡意,/, "公式開頭應加上 '");
  assert.ok(!/,=1\+2/.test(text));
});
