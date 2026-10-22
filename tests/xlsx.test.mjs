// Excel（.xlsx）匯入測試：以 openpyxl 產生的檔案（tests/fixtures/spi-sample.xlsx）走完整匯入流程
// 檔案內容：第一個工作表是 3 列說明文字（標題列對不到量測欄位，應略過），第二個工作表「SPI資料」12 片板 × 20 焊墊，含日期時間欄與一格惡意字串
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { JSDOM } = (() => { try { return require("jsdom"); } catch { return {}; } })();
const fs = require("fs");
const { HTML, withIdb, seedPartSpec } = require("./_load.js");
const FIX = new URL("./fixtures/spi-sample.xlsx", import.meta.url);
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function page(limits) {
  const html = fs.readFileSync(HTML, "utf8").replace(/<script src=[^>]+><\/script>/g, "");
  const errs = [];
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://example.test/", beforeParse(w) {
    w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === "measureText" ? () => ({ width: 1 }) : t[k] ?? (() => {})), set: (t, k, v) => ((t[k] = v), true) });
    Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { let e = this; while (e) { if (e.hidden) return null; e = e.parentElement; } return w.document.body; } });
    w.Element.prototype.scrollIntoView = () => {}; w.matchMedia = () => ({ matches: false, addEventListener() {} }); w.ResizeObserver = class { observe() {} }; w.scrollTo = () => {};
    w.Chart = class { constructor() {} destroy() {} static register() {} };
    Object.assign(w, { Response, DecompressionStream, TextDecoder });
    if (limits) w.SPI_TEST_LIMITS = limits;
    w.addEventListener("error", (e) => errs.push(e.message));
    withIdb(w);
    w.SPI_TEST_HOOK = {};
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
  d.querySelector("#inLot").value = "X1"; d.querySelector("#inPart").value = "P1";
  await seedPartSpec(w, "P1");
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

test("xlsx：第一個工作表用廠商自訂欄名時，不會被只有一個通用欄名的摘要頁取代", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom } = page();
  await tick(60);
  const d = dom.window.document;
  await pick(dom, "vendor.xlsx", fs.readFileSync(new URL("./fixtures/vendor-first-sheet.xlsx", import.meta.url)));
  assert.equal(d.querySelector("#mapBox").hidden, false, d.querySelector("#parseErr").textContent);
  const head = [...d.querySelectorAll("#map-board option")].map((o) => o.textContent);
  assert.ok(head.includes("VolPct_Vendor"), "應讀到第一個工作表（Raw）：" + head.join(","));
});

// 自行組出最小 zip（deflate），用來產生「解壓後過大」的惡意 .xlsx
function zip(entries, stored = false) {
  const { deflateRawSync } = require("node:zlib");
  const loc = [], cen = []; let off = 0;
  for (const [name, data] of entries) {
    const n = Buffer.from(name), c = stored ? data : deflateRawSync(data, { level: 9 }), meth = stored ? 0 : 8;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(meth, 8); h.writeUInt32LE(c.length, 18); h.writeUInt32LE(data.length >>> 0, 22); h.writeUInt16LE(n.length, 26);
    loc.push(h, n, c);
    const d = Buffer.alloc(46); d.writeUInt32LE(0x02014b50, 0); d.writeUInt16LE(20, 4); d.writeUInt16LE(20, 6); d.writeUInt16LE(meth, 10); d.writeUInt32LE(c.length, 20); d.writeUInt32LE(data.length >>> 0, 24); d.writeUInt16LE(n.length, 28); d.writeUInt32LE(off, 42);
    cen.push(d, n); off += 30 + n.length + c.length;
  }
  const cd = Buffer.concat(cen), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...loc, cd, e]);
}

// 測試用較小的上限（1 MB），避免測試本身占用大量記憶體；正式環境為 150 MB
const SMALL = { xlsxEntry: 1048576, xlsxTotal: 2 * 1048576 };
test("xlsx：解壓後過大的惡意檔案會被拒絕，不會讓分頁當掉", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom } = page(SMALL);
  await tick(60);
  const wb = '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
  const bomb = zip([["xl/workbook.xml", Buffer.from(wb)], ["xl/_rels/workbook.xml.rels", Buffer.from(rels)], ["xl/worksheets/sheet1.xml", Buffer.alloc(3 * 1048576, 32)]]);
  assert.ok(bomb.length < 100_000, `惡意檔大小 ${bomb.length}`);
  await pick(dom, "bomb.xlsx", bomb);
  for (let i = 0; i < 200 && !dom.window.document.querySelector("#parseErr").textContent; i++) await tick(25);
  assert.match(dom.window.document.querySelector("#parseErr").textContent, /解壓後過大/);
});

test("xlsx：未壓縮（stored）但過大的工作表同樣會被拒絕", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom } = page(SMALL);
  await tick(60);
  const wb = '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
  const big = zip([["xl/workbook.xml", Buffer.from(wb)], ["xl/_rels/workbook.xml.rels", Buffer.from(rels)], ["xl/worksheets/sheet1.xml", Buffer.alloc(1.5 * 1048576, 32)]], true);
  await pick(dom, "stored.xlsx", big);
  for (let i = 0; i < 200 && !dom.window.document.querySelector("#parseErr").textContent; i++) await tick(25);
  assert.match(dom.window.document.querySelector("#parseErr").textContent, /解壓後過大/);
});
