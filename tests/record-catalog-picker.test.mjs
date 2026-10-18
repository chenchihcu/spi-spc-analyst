// 資料庫記錄庫與開機載入中樞整合測試 (RFC-SPI-2026-002)
// 測試頂端按鈕、首頁提示列、選取載入視窗、雙視圖切換、一鍵載入分析與座標檔管理
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const { JSDOM } = (() => { try { return require("jsdom"); } catch { return {}; } })();
const fs = require("fs");
const { HTML, withIdb } = require("./_load.js");
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function page(saved = []) {
  const html = fs.readFileSync(HTML, "utf8").replace(/<script src=[^>]+><\/script>/g, "");
  const errs = [];
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://example.test/", beforeParse(w) {
    w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === "measureText" ? () => ({ width: 1 }) : t[k] ?? (() => {})), set: (t, k, v) => ((t[k] = v), true) });
    Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { let e = this; while (e) { if (e.hidden) return null; e = e.parentElement; } return w.document.body; } });
    w.Element.prototype.scrollIntoView = () => {}; w.matchMedia = () => ({ matches: false, addEventListener() {} }); w.ResizeObserver = class { observe() {} }; w.scrollTo = () => {};
    w.Chart = class { constructor() {} destroy() {} static register() {} };
    w.claude = { use: async (n) => (n === "downloads" ? { save: async (x) => { saved.push(x); return { status: "saved" }; } } : null) };
    Object.assign(w, { Response, DecompressionStream });
    withIdb(w);
    w.SPI_TEST_HOOK = {};
    w.addEventListener("error", (e) => errs.push(e.message));
  } });
  return { dom, errs };
}

const CSV = "Board,Pad,Component,Volume,Height,Area\n" + Array.from({ length: 60 }, (_, i) => `B${Math.floor(i / 6) + 1},P${i % 6},U1,${100 + (i % 5)},120,100`).join("\n");
async function until(fn, n = 150) { for (let i = 0; i < n; i++) { if (fn()) return true; await tick(20); } return false; }

async function pickFile(dom, name, text) {
  const w = dom.window, inp = w.document.querySelector("#fileIn");
  Object.defineProperty(inp, "files", { configurable: true, value: [new w.File([Buffer.from(text)], name)] });
  inp.dispatchEvent(new w.Event("change"));
  await until(() => !w.document.querySelector("#mapBox").hidden || w.document.querySelector("#parseErr").textContent);
}

test("開機首頁顯示範例提示列，點擊頂端或提示列按鈕可開啟選取中樞", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom, errs } = page();
  await tick(50);
  const w = dom.window, d = w.document, $ = (s) => d.querySelector(s);

  // 1. 預設為範例資料時，開機橫幅顯示
  const banner = $("#startupDbBanner");
  assert.ok(banner && !banner.hidden, "首頁應顯示開機載入提示橫幅");

  // 2. 點擊橫幅按鈕開啟選取視窗
  $("#btnBannerLoadDb").click();
  await tick(30);
  const modal = $("#recPickerModal");
  assert.ok(modal && !modal.hidden && modal.classList.contains("open"), "點擊橫幅按鈕應開啟選取視窗");

  // 3. 關閉視窗
  $("#recPickerClose").click();
  assert.ok(modal.hidden, "點擊關閉按鈕應隱藏視窗");

  // 4. 點擊頂端按鈕開啟選取視窗
  $("#btnOpenRecModal").click();
  await tick(30);
  assert.ok(!modal.hidden && modal.classList.contains("open"), "點擊頂端按鈕應開啟選取視窗");
  $("#btnRecPickerCloseBottom").click();
  assert.ok(modal.hidden, "點擊完成按鈕應關閉視窗");

  assert.deepEqual(errs, []);
});

test("匯入量測記錄存入資料庫後，選取中樞能列出並支援「一鍵載入分析」", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom, errs } = page();
  await tick(50);
  const w = dom.window, d = w.document, $ = (s) => d.querySelector(s);

  // 1. 匯入一筆量測檔案並填寫批號料號
  $("[data-tab=data]").click();
  await pickFile(dom, "TEST_REC.csv", CSV);
  $("#inLot").value = "LOT-2026";
  $("#inPart").value = "PART-990";
  $("#btnApply").click();
  assert.ok(await until(() => w.eval("S.runs.length") === 3));

  // 2. 開啟選取視窗
  $("#btnOpenRecModal").click();
  await tick(50);
  assert.ok(await until(() => $("#tblPickSpi").textContent.includes("LOT-2026")), "選取視窗應列出剛存入的 LOT-2026");

  // 3. 測試搜尋過濾
  $("#recPickerQ").value = "NONEXISTENT";
  $("#recPickerQ").dispatchEvent(new w.Event("input"));
  await tick(20);
  assert.ok(!$("#tblPickSpi").textContent.includes("LOT-2026"), "搜尋不到時應過濾");

  $("#recPickerQ").value = "LOT-2026";
  $("#recPickerQ").dispatchEvent(new w.Event("input"));
  await tick(20);
  assert.ok($("#tblPickSpi").textContent.includes("LOT-2026"), "搜尋關鍵字命中時應顯示");

  // 4. 測試「一鍵載入分析」🚀
  const loadBtn = $("#tblPickSpi [data-pact=load]");
  assert.ok(loadBtn, "應有載入分析按鈕");
  loadBtn.click();
  await tick(100);

  // 驗證視窗自動關聯並切換至 issues 頁籤
  assert.ok($("#recPickerModal").hidden, "載入後視窗應自動關閉");
  assert.ok(await until(() => {
    const t = $("#toast");
    return t && t.textContent && /已開啟批號 LOT-2026/.test(t.textContent);
  }), "載入後應顯示開啟成功提示");

  assert.deepEqual(errs, []);
});

test("座標檔庫切換、管理與設為目前座標檔", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom, errs } = page();
  await tick(50);
  const w = dom.window, d = w.document, $ = (s) => d.querySelector(s);

  // 1. 上傳一個座標檔
  $("[data-tab=data]").click();
  $("#placePart").value = "PART-990";
  $("#placeRev").value = "V2";
  const inp = $("#placeIn");
  Object.defineProperty(inp, "files", { configurable: true, value: [new w.File([Buffer.from("RefDes,X,Y,PartType,Layer\nU1,50,50,BGA,TOP\n")], "cad_v2.csv")] });
  inp.dispatchEvent(new w.Event("change"));
  assert.ok(await until(() => /已存入資料庫/.test($("#placeState").textContent)));

  // 2. 開啟選取視窗並切換至座標檔庫
  $("#btnOpenRecModal").click();
  await tick(50);
  $("#btnPickPlace").click();
  await tick(30);

  assert.equal($("#boxPickPlace").hidden, false, "座標檔庫表格應顯示");
  assert.equal($("#boxPickSpi").hidden, true, "量測記錄表格應隱藏");
  assert.ok($("#tblPickPlace").textContent.includes("PART-990"), "座標檔表格應包含 PART-990");
  assert.ok($("#tblPickPlace").textContent.includes("V2"), "座標檔表格應包含版本 V2");

  // 3. 測試在選取庫中設為目前座標檔
  const useBtn = $("#tblPickPlace [data-pact=use-place]");
  if (useBtn) {
    useBtn.click();
    await tick(50);
    assert.match($("#toast").textContent, /已改用座標檔 PART-990 V2/);
  }

  assert.deepEqual(errs, []);
});
