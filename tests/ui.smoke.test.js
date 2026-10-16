// 介面冒煙測試：在 jsdom 中開啟頁面，走過所有頁籤與主要流程，確認沒有執行錯誤
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { HTML, withIdb } = require("./_load");

let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require("jsdom")); } catch { /* 未安裝 jsdom 時略過 */ }

test("所有頁籤與主要流程無執行錯誤", { skip: !JSDOM && "未安裝 jsdom（npm install）" }, async () => {
  const html = fs.readFileSync(HTML, "utf8").replace(/<script src=[^>]+><\/script>/g, "");
  const errs = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errs.push(e.message));
  const dom = new JSDOM(html, {
    runScripts: "dangerously", virtualConsole: vc, url: "https://example.test/",
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === "measureText" ? () => ({ width: 1 }) : t[k] ?? (() => {})), set: (t, k, v) => ((t[k] = v), true) });
      Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { let e = this; while (e) { if (e.hidden) return null; e = e.parentElement; } return w.document.body; } });
      w.Element.prototype.scrollIntoView = () => {};
      w.matchMedia = () => ({ matches: false, addEventListener() {} });
      w.ResizeObserver = class { observe() {} };
      w.scrollTo = () => {};
      w.Chart = class { constructor(_c, cfg) { if (!cfg || !cfg.data) throw new Error("圖表設定錯誤"); } destroy() {} static register() {} };
      w.claude = { use: async (n) => (n === "downloads" ? { save: async () => {} } : null) };
      withIdb(w);
    },
  });
  const w = dom.window, d = w.document, $ = (s) => d.querySelector(s);
  const tab = (t) => $(`[data-tab=${t}]`).click();
  const change = (el, v) => { el.value = v; el.dispatchEvent(new w.Event("change")); };
  await new Promise((r) => setTimeout(r, 50));

  assert.match($("#appVer").textContent, /^v\d+\.\d+\.\d+$/, "主頁需顯示語意化版本");
  assert.match($("#appBuilt").textContent, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "主頁需顯示到秒的更新時間");
  assert.equal(d.compatMode, "CSS1Compat", "頁面需處於標準模式而非 Quirks 模式 (D-01)");
  assert.equal(d.doctype?.name, "html", "需有 <!DOCTYPE html> (D-01)");
  assert.equal(d.documentElement.lang, "zh-Hant-TW", "html 需指定 lang=zh-Hant-TW (D-01)");
  assert.equal(d.characterSet, "UTF-8", "文件字元編碼需為 UTF-8 (D-01)");
  const vp = d.querySelector('meta[name="viewport"]');
  assert.ok(vp && vp.content.includes("width=device-width") && vp.content.includes("viewport-fit=cover"), "需含正確的 viewport meta (D-01)");
  assert.ok(d.querySelectorAll(".iss-card").length > 0, "首頁應列出問題");

  // 以「抓出問題」為目的的介面要素：問題地圖、證據迷你圖、嚴重度分段、來源提示
  assert.ok(d.querySelectorAll("#pmap [data-ent]").length >= 25, "問題地圖應有每片板的格子");
  assert.ok(d.querySelectorAll(".iss-card svg.ev").length === d.querySelectorAll(".iss-card").length, "每個問題卡片都應有證據迷你圖");
  assert.ok(d.querySelectorAll("#issList .sevhead").length >= 2, "問題應依嚴重度分段");
  // 問題卡片預設收合成一行，可全部展開／收合
  assert.equal(d.querySelectorAll("#issList details.iss-card[open]").length, 0, "問題卡片預設收合");
  assert.ok(d.querySelectorAll("#issList details.iss-card > summary .iss-sum-t b").length === d.querySelectorAll(".iss-card").length, "每張卡片的摘要列有標題");
  $("#issExpand").click();
  assert.equal(d.querySelectorAll("#issList details.iss-card:not([open])").length, 0, "全部展開");
  $("#issCollapse").click();
  assert.equal(d.querySelectorAll("#issList details.iss-card[open]").length, 0, "全部收合");
  // 頂端不再重複規格輸入；資料與規格頁分為子分頁
  assert.equal(d.querySelector("#inLsl"), null, "規格輸入只保留在資料與規格頁");
  assert.equal(d.querySelectorAll("#p-data .subtab").length, 4);
  // 子分頁鍵盤：只有選取中的在 Tab 順序，左右鍵切換
  assert.deepEqual([...d.querySelectorAll("#p-data .subtab")].map((b) => b.tabIndex), [0, -1, -1, -1]);
  d.querySelector("#p-data .subtabs").dispatchEvent(new w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert.equal(d.querySelector('#p-data .subtab[data-sub="runs"]').getAttribute("aria-selected"), "true", "右鍵切到回合管理");
  d.querySelector("#p-data .subtabs").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  // 換回合後，先前展開的問題不會自動展開
  d.querySelector("#iss-1 > summary").click();
  assert.equal(d.querySelector("#iss-1").open, true);
  change($("#selRun"), "2"); tab("issues");
  assert.equal(d.querySelectorAll("#issList details.iss-card[open]").length, 0, "換回合後全部收合");
  change($("#selRun"), "1"); tab("issues");
  d.querySelector('#pmap [data-ent="b:B13"]').click();
  assert.ok(d.querySelectorAll(".iss-card").length >= 1 && d.querySelectorAll(".iss-card").length < 12, "點選板格應只顯示該板相關問題");
  d.querySelector("#pmapClear").click();
  d.querySelector("#issList [data-go]").click();
  assert.equal($("#ctxBar").hidden, false, "前往證據頁時應顯示來源提示");
  $("#ctxBack").click();
  assert.equal($("[data-tab=issues]").getAttribute("aria-selected"), "true", "返回鍵應回到問題清單");
  assert.equal($("#selMetric").closest(".field").hidden, true, "問題偵測頁不顯示不相干的量測項目選單");

  for (const t of ["issues", "overview", "compare", "dfm", "control", "capability", "sim3d", "cross", "adv", "lab", "ai", "data"]) tab(t);
  for (const v of ["xbars", "imr", "p", "ewma", "cusum"]) { change($("#selChart"), v); tab("control"); }
  tab("lab"); $("#btnAoiSample").click(); $("#btnGrrSample").click(); $("#btnDoeSample").click();
  tab("data"); $("#btnPhme").click(); $("#btnApply").click();
  tab("compare"); tab("dfm");
  $("#btnSample").click();

  assert.deepEqual(errs, []);
});

test("匯入資料中的 HTML 不會被執行（XSS）", { skip: !JSDOM && "未安裝 jsdom（npm install）" }, async () => {
  const html = fs.readFileSync(HTML, "utf8").replace(/<script src=[^>]+><\/script>/g, "");
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://example.test/", beforeParse(w) {
    w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === "measureText" ? () => ({ width: 1 }) : t[k] ?? (() => {})), set: (t, k, v) => ((t[k] = v), true) });
    Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { let e = this; while (e) { if (e.hidden) return null; e = e.parentElement; } return w.document.body; } });
    w.Element.prototype.scrollIntoView = () => {}; w.matchMedia = () => ({ matches: false, addEventListener() {} }); w.ResizeObserver = class { observe() {} }; w.scrollTo = () => {};
    w.Chart = class { constructor() {} destroy() {} static register() {} }; withIdb(w); } });
  const w = dom.window, d = w.document, $ = (s) => d.querySelector(s);
  await new Promise((r) => setTimeout(r, 50));
  const csv = "Board,Pad,Component,Result,Volume,Height,Area\n" + Array.from({ length: 60 }, (_, i) => `"B${Math.floor(i / 6) + 1}<img src=x onerror=1>",P${i % 6}<b>x</b>,U<svg onload=1>1,"NG<img src=y>",${i === 13 ? 40 : 100 + (i % 5)},120,${i === 13 ? 40 : 100}`).join("\n");
  $("[data-tab=data]").click(); $("#pasteIn").value = csv; $("#btnRead").click(); $("#inRunName").value = "<img src=z onerror=1>";
  $("#inLot").value = "L1<img src=q onerror=1>"; $("#inPart").value = "P<svg onload=1>"; $("#btnApply").click();
  for (let i = 0; i < 100 && w.eval("S.runs.length") < 3; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.eval("S.runs.length"), 3, "存入資料庫後建立回合");
  $("[data-tab=data]").click(); $('.subtab[data-sub="records"]').click(); $('.subtab[data-sub="runs"]').click(); $('.subtab[data-sub="records"]').click();
  await new Promise((r) => setTimeout(r, 200));
  assert.match($("#recSpi").textContent, /L1/);
  for (const t of ["issues", "overview", "compare", "dfm", "control", "capability", "sim3d", "cross", "adv", "lab", "data"]) $(`[data-tab=${t}]`).click();
  assert.equal(d.querySelectorAll("img[onerror],svg[onload]").length, 0, "不應出現注入的 img／svg");
  assert.equal([...d.querySelectorAll("b")].filter((b) => b.textContent === "x").length, 0, "不應出現注入的 <b>");
});
