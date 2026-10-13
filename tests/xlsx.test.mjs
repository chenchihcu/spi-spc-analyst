// Excel（.xlsx）匯入測試：以 openpyxl 產生的檔案（tests/fixtures/spi-sample.xlsx）走完整匯入流程
// 檔案內容：第一個工作表只有說明（略過），第二個工作表「SPI資料」12 片板 × 20 焊墊，含日期時間欄與一格惡意字串
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { JSDOM } = (() => { try { return require("jsdom"); } catch { return {}; } })();
const fs = require("fs");
const { HTML } = require("./_load.js");
const FIX = new URL("./fixtures/spi-sample.xlsx", import.meta.url);
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function page() {
  const html = fs.readFileSync(HTML, "utf8").replace(/<script src=[^>]+><\/script>/g, "");
  const errs = [];
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://example.test/", beforeParse(w) {
    w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === "measureText" ? () => ({ width: 1 }) : t[k] ?? (() => {})), set: (t, k, v) => ((t[k] = v), true) });
    Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { let e = this; while (e) { if (e.hidden) return null; e = e.parentElement; } return w.document.body; } });
    w.Element.prototype.scrollIntoView = () => {}; w.matchMedia = () => ({ matches: false, addEventListener() {} }); w.ResizeObserver = class { observe() {} }; w.scrollTo = () => {};
    w.Chart = class { constructor() {} destroy() {} static register() {} };
    Object.assign(w, { Response, DecompressionStream, TextDecoder });
    w.addEventListener("error", (e) => errs.push(e.message));
  } });
  return { dom, errs };
}
async function pick(dom, name, bytes) {
  const w = dom.window, inp = w.document.querySelector("#fileIn");
  Object.defineProperty(inp, "files", { configurable: true, value: [new w.File([bytes], name)] });
  inp.dispatchEvent(new w.Event("change"));
  for (let i = 0; i < 100; i++) { await tick(20); if (!w.document.querySelector("#mapBox").hidden || w.document.querySelector("#parseErr").textContent) break; }
}

test("xlsx：略過空白說明頁、讀到資料頁、欄位自動對應、日期轉成文字、惡意字串過濾，套用後可偵測問題", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom, errs } = page();
  await tick(60);
  const w = dom.window, d = w.document;
  await pick(dom, "spi-sample.xlsx", fs.readFileSync(FIX));
  assert.equal(d.querySelector("#parseErr").textContent, "", "不應有錯誤");
  assert.equal(d.querySelector("#mapBox").hidden, false, "應顯示欄位對應");
  assert.match(d.querySelector("#mapPrev").textContent, /240 筆、12 片板/);
  assert.match(d.querySelector("#mapPrev").textContent, /已依日期時間排序/, "Excel 日期時間欄應被辨識");
  assert.match(d.querySelector("#toast")?.textContent || "", /SPI資料.*共 2 個工作表/);
  assert.equal(d.querySelector("#inRunName").value, "spi-sample");
  d.querySelector("#btnApply").click();
  for (let i = 0; i < 50 && w.eval("S.rows.length") !== 240; i++) await tick(20);
  assert.equal(w.eval("S.rows.length"), 240);
  assert.ok(!w.eval("S.rows.some(r=>/[<>]/.test(r.pad))"), "焊墊名稱已過濾");
  assert.ok(w.eval("S.F.length") > 0, "應偵測到 C 0402 後段體積偏高");
  assert.deepEqual(errs, []);
});

test("xlsx：舊版 .xls 與損毀檔給出清楚訊息", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom } = page();
  await tick(60);
  const d = dom.window.document;
  await pick(dom, "old.xls", Buffer.from("xx"));
  assert.match(d.querySelector("#parseErr").textContent, /另存為 \.xlsx 或 CSV/);
  d.querySelector("#parseErr").textContent = "";
  await pick(dom, "broken.xlsx", Buffer.from("this is not a zip file at all, just text"));
  assert.match(d.querySelector("#parseErr").textContent, /不是有效的 \.xlsx/);
});
