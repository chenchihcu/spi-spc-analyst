// 資料庫記錄庫與開機載入中樞整合測試 (RFC-SPI-2026-002)
// 測試頂端按鈕、首頁提示列、選取載入視窗、雙視圖切換、一鍵載入分析與座標檔管理
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const { JSDOM } = (() => { try { return require("jsdom"); } catch { return {}; } })();
const fs = require("fs");
const { HTML, withIdb, seedPartSpec } = require("./_load.js");
import { createCloudHarness, installBrowserCloud } from './_cloud-harness.mjs';
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function page(saved = [], { fetch: fetchStub, cloud } = {}) {
  const html = fs.readFileSync(HTML, "utf8").replace(/<script src=[^>]+><\/script>/g, "");
  const errs = [];
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://example.test/", beforeParse(w) {
    w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === "measureText" ? () => ({ width: 1 }) : t[k] ?? (() => {})), set: (t, k, v) => ((t[k] = v), true) });
    Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { let e = this; while (e) { if (e.hidden) return null; e = e.parentElement; } return w.document.body; } });
    w.Element.prototype.scrollIntoView = () => {}; w.matchMedia = () => ({ matches: false, addEventListener() {} }); w.ResizeObserver = class { observe() {} }; w.scrollTo = () => {}; w.scrollBy = () => {};
    w.Chart = class { constructor() {} destroy() {} static register() {} };
    w.claude = { use: async (n) => (n === "downloads" ? { save: async (x) => { saved.push(x); return { status: "saved" }; } } : null) };
    Object.assign(w, { Response, DecompressionStream });
    if (fetchStub) w.fetch = fetchStub;
    withIdb(w);
    if (cloud) installBrowserCloud(w, cloud);
    w.SPI_TEST_HOOK = {};
    w.addEventListener("error", (e) => errs.push(e.message));
  } });
  return { dom, errs };
}

const CSV = "Board,Pad,Component,Volume,Height,Area\n" + Array.from({ length: 60 }, (_, i) => `B${Math.floor(i / 6) + 1},P${i % 6},U1,${100 + (i % 5)},120,100`).join("\n");
async function until(fn, n = 150) { for (let i = 0; i < n; i++) { if (fn()) return true; await tick(20); } return false; }

async function cloudPage() {
  const cloud = await createCloudHarness();
  const result = page([], { cloud });
  await result.dom.window.SPI_TEST_HOOK.RecDB.ready;
  await result.dom.window.SPI_TEST_HOOK.RecDB.list();
  return { ...result, cloud };
}

async function selectPlacement(dom, cloud, part, rev, side) {
  const d = dom.window.document;
  await cloud.upload({ kind: 'place', part, rev, side, unit: 'mm', name: `${part}-${rev}-${side}.csv` },
    `RefDes,X,Y,Layer\nU1,1,2,${side}\n`);
  d.querySelector('#btnSelectPlace').click();
  assert.ok(await until(() => [...d.querySelectorAll('#tblPickPlace tr')].some(tr =>
    tr.textContent.includes(part) && tr.textContent.includes(rev) && tr.textContent.includes(side) && tr.querySelector('[data-pact="use-place"]'))),
    `應可選取 ${part} ${rev} ${side} 的受控座標`);
  const row = [...d.querySelectorAll('#tblPickPlace tr')].find(tr =>
    tr.textContent.includes(part) && tr.textContent.includes(rev) && tr.textContent.includes(side));
  row.querySelector('[data-pact="use-place"]').click();
  assert.ok(await until(() => d.querySelector('#placePart').value === part && d.querySelector('#placeRev').value === rev));
  d.querySelector('#recPickerClose').click();
}

async function importMeasurement(dom, cloud, { part, rev = 'V1', side = 'TOP', lot, name, csv = CSV }) {
  const w = dom.window, d = w.document, $ = s => d.querySelector(s);
  await selectPlacement(dom, cloud, part, rev, side);
  $('[data-tab=data]').click();
  $('#selSide').value = side;
  $('#selSide').dispatchEvent(new w.Event('change'));
  await pickFile(dom, name, csv);
  $('#inLot').value = lot;
  $('#inPart').value = part;
  $('#inRev').value = rev;
  $('#inWorkOrder').value = `WO-${lot}`;
  $('#inImpStencil').value = '120';
  const specBytes = w.eval(`(()=>{const sp={schema:"spi-part-spec/1",part:${JSON.stringify(part)},stencilRef:120,specs:{},groups:{},note:"測試"};for(const k of PART_SPEC_METRICS)sp.specs[k]={...DEF_SPECS[k]};return partSpecEncode(sp).bytes})()`);
  await cloud.upload({ kind: 'spec', part, makeDefault: true }, specBytes);
  const before = w.eval('S.runs.length');
  $('#btnApply').click();
  assert.ok(await until(() => w.eval('S.runs.length') === before + 1), `應建立 ${lot} 正式分析回合：${$('#recNote').textContent}`);
}

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
  const { dom, errs, cloud } = await cloudPage();
  await tick(50);
  const w = dom.window, d = w.document, $ = (s) => d.querySelector(s);

  // 1. 匯入一筆量測檔案並填寫批號料號
  await importMeasurement(dom, cloud, { part: 'PART-990', lot: 'LOT-2026', name: 'TEST_REC.csv' });

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
  const { dom, errs } = await cloudPage();
  await tick(50);
  const w = dom.window, d = w.document, $ = (s) => d.querySelector(s);

  // 1. 上傳一個座標檔
  $("[data-tab=data]").click();
  $("#placePart").value = "PART-990";
  $("#placeRev").value = "V2";
  $("#placeSide").value = "TOP";
  $("#placeUnit").value = "mm";
  const inp = $("#placeIn");
  Object.defineProperty(inp, "files", { configurable: true, value: [new w.File([Buffer.from("RefDes,X,Y,PartType,Layer\nU1,50,50,BGA,TOP\n")], "cad_v2.csv")] });
  inp.dispatchEvent(new w.Event("change"));
  assert.ok(await until(() => /料號 PART-990 版次 V2/.test($("#placeState").textContent)), $("#placeState").textContent);

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

test("SMT 產線過濾工具列、品質快照狀態與手機端卡片流", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom, errs, cloud } = await cloudPage();
  await tick(50);
  const w = dom.window, d = w.document, $ = (s) => d.querySelector(s);

  // 1. 匯入一筆正常資料與一筆帶不良的資料
  await importMeasurement(dom, cloud, { part: 'PART-AAA', side: 'TOP', lot: 'LOT-OK', name: 'NORMAL_TOP.csv' });

  // 第二筆：不良資料（Volume < 50）
  const BAD_CSV = "Board,Pad,Component,Volume,Height,Area\n" + Array.from({ length: 60 }, (_, i) => `B${Math.floor(i / 6) + 1},P${i % 6},U1,${i === 5 ? 20 : 100},120,100`).join("\n");
  await importMeasurement(dom, cloud, { part: 'PART-BBB', side: 'BOT', lot: 'LOT-NG', name: 'DEFECT_BOT.csv', csv: BAD_CSV });

  // 2. 開啟選取視窗
  $("#btnOpenRecModal").click();
  assert.ok(await until(() => $("#tblPickSpi").textContent.includes("LOT-OK") && $("#tblPickSpi").textContent.includes("LOT-NG")), "表格應包含兩筆新匯入的量測");
  assert.ok($("#tblPickSpi").textContent.includes("LOT-NG"), "表格應包含 LOT-NG");
  assert.ok($("#tblPickSpi").textContent.includes("良品"), "LOT-OK 應標示為良品");
  assert.ok($("#tblPickSpi").textContent.includes("缺點"), "LOT-NG 應標示有缺點");

  // 3. 測試料號篩選下拉選單
  const partFilter = $("#pickPartFilter");
  assert.ok(partFilter, "應存在料號篩選選單");
  assert.ok([...partFilter.options].some(o => o.value === "PART-AAA"), "選單應包含 PART-AAA");
  assert.ok([...partFilter.options].some(o => o.value === "PART-BBB"), "選單應包含 PART-BBB");

  partFilter.value = "PART-AAA";
  partFilter.dispatchEvent(new w.Event("change"));
  await tick(30);
  assert.ok($("#tblPickSpi").textContent.includes("LOT-OK"), "篩選 PART-AAA 應保留 LOT-OK");
  assert.ok(!$("#tblPickSpi").textContent.includes("LOT-NG"), "篩選 PART-AAA 應隱藏 LOT-NG");

  partFilter.value = "";
  partFilter.dispatchEvent(new w.Event("change"));
  await tick(30);

  // 4. 測試面別篩選
  const botSideBtn = $("#pickSideSeg button[data-side=BOT]");
  assert.ok(botSideBtn, "應有 BOT 面別按鈕");
  botSideBtn.click();
  await tick(30);
  assert.ok(!$("#tblPickSpi").textContent.includes("LOT-OK"), "篩選 BOT 應隱藏 TOP 的 LOT-OK");
  assert.ok($("#tblPickSpi").textContent.includes("LOT-NG"), "篩選 BOT 應保留 LOT-NG");

  const allSideBtn = $("#pickSideSeg button[data-side='']");
  allSideBtn.click();
  await tick(30);

  // 5. 測試品質狀態篩選（僅異常 ⚠️）
  const ngBtn = $("#pickQualitySeg button[data-qfilter=ng]");
  assert.ok(ngBtn, "應有僅異常篩選按鈕");
  ngBtn.click();
  await tick(30);
  assert.ok(!$("#tblPickSpi").textContent.includes("LOT-OK"), "僅異常模式應過濾掉良品 LOT-OK");
  assert.ok($("#tblPickSpi").textContent.includes("LOT-NG"), "僅異常模式應保留 LOT-NG");

  const allQBtn = $("#pickQualitySeg button[data-qfilter=all]");
  allQBtn.click();
  await tick(30);

  // 6. 驗證手機端卡片流與觸控熱區
  const cardsSpi = $("#cardsPickSpi");
  assert.ok(cardsSpi, "手機端量測卡片容器應存在");
  assert.ok(cardsSpi.innerHTML.includes("LOT-OK"), "手機端卡片應渲染 LOT-OK");
  const cardLoadBtn = cardsSpi.querySelector("button[data-pact=load]");
  assert.ok(cardLoadBtn, "手機端卡片應有載入分析主按鈕");
  assert.ok(cardLoadBtn.style.minHeight.includes("44px"), "手機端主按鈕高度應符合 Apple HIG (>= 44px)");

  assert.deepEqual(errs, []);
});

test("座標庫明確版次選取與備註修改對話框", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom, errs } = await cloudPage();
  await tick(50);
  const w = dom.window, d = w.document, $ = (s) => d.querySelector(s);

  // 1. 上傳兩個不同版本的座標檔
  $("[data-tab=data]").click();
  $("#placePart").value = "PART-777";
  $("#placeRev").value = "V1";
  $("#placeSide").value = "TOP";
  $("#placeUnit").value = "mm";
  const inp1 = $("#placeIn");
  Object.defineProperty(inp1, "files", { configurable: true, value: [new w.File([Buffer.from("RefDes,X,Y,PartType,Layer\nU1,10,10,BGA,TOP\n")], "cad_v1.csv")] });
  inp1.dispatchEvent(new w.Event("change"));
  assert.ok(await until(() => /料號 PART-777 版次 V1/.test($("#placeState").textContent)), $("#placeState").textContent);

  $("#placePart").value = "PART-777";
  $("#placeRev").value = "V2";
  const inp2 = $("#placeIn");
  Object.defineProperty(inp2, "files", { configurable: true, value: [new w.File([Buffer.from("RefDes,X,Y,PartType,Layer\nU1,20,20,BGA,TOP\n")], "cad_v2.csv")] });
  inp2.dispatchEvent(new w.Event("change"));
  assert.ok(await until(() => /料號 PART-777 版次 V2/.test($("#placeState").textContent)), $("#placeState").textContent);

  // 2. 開啟選取視窗並切換至座標庫
  $("#btnOpenRecModal").click();
  await tick(50);
  $("#btnPickPlace").click();
  await tick(30);

  assert.ok($("#tblPickPlace").textContent.includes("V1"), "應保留 V1 版次紀錄");
  assert.ok($("#tblPickPlace").textContent.includes("V2"), "應保留 V2 版次紀錄");
  const v1Row = [...$("#tblPickPlace").querySelectorAll('tr')].find(tr => tr.textContent.includes('PART-777') && tr.textContent.includes('V1'));
  assert.ok(v1Row?.querySelector('[data-pact="use-place"]'), "V1 應可明確選取");
  v1Row.querySelector('[data-pact="use-place"]').click();
  assert.ok(await until(() => $("#placeRev").value === "V1"), "選取 V1 後匯入表單應顯示 V1");
  const v2Row = [...$("#tblPickPlace").querySelectorAll('tr')].find(tr => tr.textContent.includes('PART-777') && tr.textContent.includes('V2'));
  assert.ok(v2Row?.querySelector('[data-pact="use-place"]'), "V2 應可明確選取");
  v2Row.querySelector('[data-pact="use-place"]').click();
  assert.ok(await until(() => $("#placeRev").value === "V2"), "選取 V2 後匯入表單應顯示 V2");

  // 3. 測試工單與備註修改彈窗
  const editBtn = $("#tblPickPlace [data-pact=edit-meta]");
  assert.ok(editBtn, "原上傳者應有 ✏️ 備註按鈕");
  editBtn.click();
  await tick(50);

  const editModal = $("#recEditModal");
  assert.ok(editModal && !editModal.hidden, "工單與備註彈窗應顯示");

  $("#recEditNote").value = "產線工程測試樣品";
  $("#recEditSave").click();
  assert.ok(await until(() => editModal.hidden), "儲存後修改彈窗應關閉");
  assert.ok(await until(() => {
    const t = $("#toast");
    return t && t.textContent && /已更新量測鑑別資料與備註/.test(t.textContent);
  }), "應提示成功更新");
  assert.ok(await until(() => $("#cardsPickPlace").textContent.includes("產線工程測試樣品")), "座標備註應寫回資料庫並顯示在卡片");

  assert.deepEqual(errs, []);
});


test("雲端模式開機：最近記錄只請求一次、先佔位再填入，且解除開機隱藏", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const calls = [];
  const fetchStub = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u === "/__me") return new Response(JSON.stringify({ user: "tester" }), { status: 200 });
    if (u.startsWith("/api/records?limit=3")) {
      await tick(40);
      return new Response(JSON.stringify({ records: [{ id: "r1", kind: "spi", lot: "LOT-A", part: "P1", side: "TOP" }] }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  const { dom, errs } = page([], { fetch: fetchStub });
  const w = dom.window, d = w.document, $ = (s) => d.querySelector(s);

  assert.equal(d.getElementById("bootHide"), null, "主程式跑完後應移除開機隱藏樣式");
  const box = $("#bannerRecentRuns");
  assert.ok(!box.hidden && /讀取最近記錄/.test(box.textContent), "有後端時應先顯示讀取中佔位，避免之後撐開版面");

  assert.ok(await until(() => box.querySelector(".banner-run-chip")), "應填入最近記錄晶片");
  assert.match(box.textContent, /LOT-A/);
  await tick(100);
  assert.equal(calls.filter((u) => u.startsWith("/api/records?limit=3")).length, 1, "開機時最近記錄只應請求一次");
  assert.deepEqual(errs, []);
});

test("雲端模式開機：資料庫無記錄時保留一列說明而非收合", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const fetchStub = async (url) => {
    const u = String(url);
    if (u === "/__me") return new Response(JSON.stringify({ user: "tester" }), { status: 200 });
    if (u.startsWith("/api/records?limit=3")) return new Response(JSON.stringify({ records: [] }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  const { dom, errs } = page([], { fetch: fetchStub });
  const box = dom.window.document.querySelector("#bannerRecentRuns");
  assert.ok(await until(() => /尚無量測記錄/.test(box.textContent)), "空資料庫應顯示說明");
  assert.ok(!box.hidden);
  assert.deepEqual(errs, []);
});
