// 加工廠 SPI 格式測試：立榮電子（每列一焊墊、各板量測橫排）轉成一列一筆，並以座標檔補位置與封裝
// 測試資料為自行組出的小檔，不含任何真實量測資料
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { JSDOM } = (() => { try { return require("jsdom"); } catch { return {}; } })();
const fs = require("fs");
const { HTML, withIdb, seedPartSpec } = require("./_load.js");
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
    withIdb(w);
    w.SPI_TEST_HOOK = {};
  } });
  return { dom, errs };
}
async function pick(dom, sel, name, bytes) {
  const w = dom.window, inp = w.document.querySelector(sel);
  Object.defineProperty(inp, "files", { configurable: true, value: [new w.File([bytes], name)] });
  inp.dispatchEvent(new w.Event("change"));
  for (let i = 0; i < 100; i++) { await tick(20); const d = w.document; if (sel === "#placeIn" ? /已存入資料庫|class="err"/.test(d.querySelector("#placeState").innerHTML) : (!d.querySelector("#mapBox").hidden || d.querySelector("#parseErr").textContent)) break; }
}
function setVendor(dom, v) { const s = dom.window.document.querySelector("#selVendor"); s.value = v; s.dispatchEvent(new dom.window.Event("change")); }

// 3 片板 × 5 列：C1、R2 各 2 個焊墊；G9 一列是「焊墊編號錯放在第 1 片板高度欄」的已知錯位
const head = ["Component ID"];
for (let b = 1; b <= 3; b++) head.push(`Height(%)${b}`, `Volume(%)${b}`, `Area(%)${b}`, ...(b === 1 ? ["PAD ID"] : []), `Result${b}`);
const row = (comp, pad, base) => [comp, ...[1, 2, 3].flatMap((b) => [base + b, base + 2 * b, 100 - b, ...(b === 1 ? [pad] : []), "PASS"])];
const WIDE = [head, row("C1_1", 1, 100), row("C1_1", 2, 102), row("R2_1", 1, 95), row("R2_1", 2, 97),
  ["G9_1", "1", "", "", "", "", 104, 106, 99, "PASS", 105, 107, 98, "FAIL"]].map((r) => r.join(",")).join("\n");
const PLACE = "PartType,RefDes,PartDecal,Pins,Layer,Orient.,X,Y\nC0402,C1,C0402,2,L1-TOP,0,1000,2000\nR0603,R2,R0603,2,L1-TOP,90,3000,500\nC0402,C5,C0402,2,L6-BOTTOM,0,100,100\n";

test("立榮格式：選加工廠後轉成一列一筆，座標檔補 mm 座標與封裝群組，錯位列取回焊墊編號", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom, errs } = page();
  await tick(60);
  const w = dom.window, d = w.document;
  setVendor(dom, "lirong");
  assert.equal(d.querySelector("#sideField").hidden, false, "選立榮後顯示面別");
  assert.equal(d.querySelector("#placeRow").hidden, false, "選立榮後顯示座標檔");
  d.querySelector("#placePart").value = "DEMO-01"; d.querySelector("#placeRev").value = "V5";
  await pick(dom, "#placeIn", "X3000_place.csv", Buffer.from(PLACE));
  assert.match(d.querySelector("#placeState").textContent, /料號 DEMO-01 版本 V5 · .*3 個元件（TOP 2、BOT 1），單位 mil（自動判斷） · 已存入資料庫/);
  await pick(dom, "#fileIn", "DEMO-01_TOP_spi.csv", Buffer.from(WIDE));
  assert.equal(d.querySelector("#parseErr").textContent, "");
  const prev = d.querySelector("#mapPrev").textContent;
  assert.match(prev, /立榮格式已轉換：3 片板 × 5 個焊墊（3 個元件），TOP 面/);
  assert.match(prev, /座標檔對應 2\/3 個元件/);
  assert.match(prev, /找不到 1 個位號：G9/);
  assert.match(prev, /1 列的焊墊編號錯放/);
  assert.match(prev, /14 筆、3 片板、5 個焊墊位置/, "G9 第 1 片板未量測，共 5×3−1 筆");
  assert.equal(d.querySelector("#inRunName").value, "DEMO-01_TOP_spi");
  assert.equal(d.querySelector("#inPart").value, "DEMO-01", "料號預填座標檔料號");
  d.querySelector("#inLot").value = "LOT-A";
  await seedPartSpec(w, "DEMO-01");
  d.querySelector("#btnApply").click();
  for (let i = 0; i < 100 && w.eval("S.rows.length") !== 14; i++) await tick(20);
  const rows = JSON.parse(w.eval("JSON.stringify(S.rows)"));
  assert.equal(rows.length, 14);
  assert.deepEqual([...new Set(rows.map((r) => r.board))], ["B01", "B02", "B03"]);
  const c1 = rows.find((r) => r.pad === "C1-1" && r.board === "B02");
  assert.equal(c1.group, "C0402", "群組＝座標檔封裝");
  assert.ok(Math.abs(c1.x - (1000 * 0.0254 - 0.25)) < 1e-6 && Math.abs(c1.y - 2000 * 0.0254) < 1e-6, `C1 焊墊 1 在中心左側 0.25 mm：${c1.x},${c1.y}`);
  assert.equal(c1.height, 122.4, "高度 102% × 鋼板 120 µm");
  assert.equal(c1.hpct, 102, "高度 % 換算回原值");
  assert.equal(c1.volume, 104);
  const r2 = rows.filter((r) => r.comp === "R2" && r.board === "B01").sort((a, b) => a.pad.localeCompare(b.pad));
  assert.ok(Math.abs(r2[0].x - r2[1].x) < 1e-6 && r2[1].y > r2[0].y, "旋轉 90° 的元件焊墊沿 Y 排列");
  const g9 = rows.filter((r) => r.comp === "G9");
  assert.deepEqual(g9.map((r) => r.board), ["B02", "B03"]);
  assert.equal(g9[0].pad, "G9-1");
  assert.equal(g9[0].group, "G", "座標檔沒有的位號依字首分群");
  assert.ok(!rows.some((r) => r.mNG != null || r.result != null), "機台判定欄（Result）讀入後忽略：好壞只依使用者定義的料號規格");
  assert.deepEqual(errs, []);
});

test("立榮格式：面別依檔名判斷，座標檔面別不符時提醒；改選面別會重新轉換", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom } = page();
  await tick(60);
  const d = dom.window.document;
  setVendor(dom, "lirong");
  d.querySelector("#placePart").value = "DEMO"; d.querySelector("#placeRev").value = "V1";
  await pick(dom, "#placeIn", "place.csv", Buffer.from(PLACE));
  await pick(dom, "#fileIn", "DEMO_BOT.csv", Buffer.from(WIDE));
  assert.match(d.querySelector("#mapPrev").textContent, /BOT 面/);
  assert.match(d.querySelector("#mapPrev").textContent, /2 個位號在座標檔屬於另一面（C1、R2）/);
  const side = d.querySelector("#selSide"); side.value = "TOP"; side.dispatchEvent(new dom.window.Event("change"));
  assert.match(d.querySelector("#mapPrev").textContent, /TOP 面/);
  assert.doesNotMatch(d.querySelector("#mapPrev").textContent, /屬於另一面/);
  assert.equal(d.querySelector("#inRunName").value, "DEMO_BOT TOP", "名稱補上指定的面別");
});

test("通用格式下讀到立榮橫排檔會自動切換；選立榮卻上傳一般檔會清楚說明", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom } = page();
  await tick(60);
  const d = dom.window.document;
  setVendor(dom, "generic");
  await pick(dom, "#fileIn", "x.csv", Buffer.from(WIDE));
  assert.equal(d.querySelector("#selVendor").value, "lirong");
  assert.match(d.querySelector("#mapPrev").textContent, /偵測到立榮（各板橫排）格式，已自動切換/);
  assert.match(d.querySelector("#mapPrev").textContent, /面別未知/);
  d.querySelector("#mapBox").hidden = true;
  await pick(dom, "#fileIn", "long.csv", Buffer.from("Board,Pad,Volume\nB1,P1,100\nB1,P2,98\n"));
  assert.match(d.querySelector("#parseErr").textContent, /不是立榮格式/);
});

test("座標檔為 Big5 編碼（台灣廠商常見）也能讀", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom } = page();
  await tick(60);
  const d = dom.window.document;
  setVendor(dom, "lirong");
  // 標題「位號,X,Y,封裝」以 Big5 編碼
  const bytes = Buffer.concat([Buffer.from("a6ecb8b9", "hex"), Buffer.from(",X,Y,"), Buffer.from("abcab8cb", "hex"), Buffer.from("\nC1,10.5,20,C0402\nR2,30,5,R0603\n")]);
  d.querySelector("#placePart").value = "B5"; d.querySelector("#placeRev").value = "A";
  await pick(dom, "#placeIn", "big5.csv", bytes);
  assert.match(d.querySelector("#placeState").textContent, /2 個元件.*單位 mm/);
});

test("立榮格式高度 % 匯入後改鋼板厚度：µm 高度依比例換算、高度 % 不變（不同裝置預設厚度不同也一致）", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom, errs } = page();
  await tick(60);
  const w = dom.window, d = w.document;
  setVendor(dom, "lirong");
  await pick(dom, "#fileIn", "DEMO-02_TOP_spi.csv", Buffer.from(WIDE));
  d.querySelector("#inLot").value = "LOT-B"; d.querySelector("#inPart").value = "DEMO-02";
  await seedPartSpec(w, "DEMO-02");
  d.querySelector("#btnApply").click();
  for (let i = 0; i < 100 && w.eval("S.rows.length") !== 14; i++) await tick(20);
  const pick1 = () => JSON.parse(w.eval("JSON.stringify(S.rows.find((r) => r.pad === 'C1-1' && r.board === 'B02'))"));
  assert.equal(pick1().height, 122.4, "匯入時以 120 µm 換算");
  assert.equal(w.eval("S.runs.find((r) => r.id === S.runId).info.hPctThk"), 120, "回合記下換算用的厚度");
  const inp = d.querySelector("#inStencil2");
  inp.value = "88"; inp.dispatchEvent(new w.Event("change"));
  await tick(60);
  assert.ok(Math.abs(pick1().height - 89.76) < 1e-9, `102% × 88 µm = 89.76，實得 ${pick1().height}`);
  assert.equal(pick1().hpct, 102, "高度 % 不變");
  assert.equal(w.eval("S.runs.find((r) => r.id === S.runId).info.hPctThk"), 88);
  inp.value = "120"; inp.dispatchEvent(new w.Event("change"));
  await tick(60);
  assert.ok(Math.abs(pick1().height - 122.4) < 1e-9, "改回 120 µm 換回原值");
  assert.deepEqual(errs, []);
});
