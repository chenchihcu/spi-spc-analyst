// 嚴重度顯示一致性：問題地圖依各板實際命中的子項上色、總覽「優先處理」標明卡片等級、同名回合的舊版警示可區分
// 測試資料為範例資料或自行組出的合成資料，不含任何真實量測資料
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { JSDOM } = (() => { try { return require("jsdom"); } catch { return {}; } })();
const fs = require("fs");
const { HTML, withIdb, seedPartSpec, loadCore, baseState } = require("./_load.js");
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const H = "SPI_TEST_HOOK";

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

test("問題地圖：跨板彙總卡只依該板命中的子項上色，點格篩選仍列出彙總卡", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom, errs } = page();
  await tick(100);
  const w = dom.window, d = w.document;
  for (let i = 0; i < 100 && !w.eval(`(S.F||[]).some(x=>x.cat==="孤立極端焊墊"&&x.lv==="ng")`); i++) await tick(20);
  // 範例資料的嚴重孤立極端焊墊卡：把其中一片板的子項改成警示，其餘子項仍為嚴重，地圖只留這張卡
  const pick = JSON.parse(w.eval(`(()=>{const x=S.F.find(x=>x.cat==="孤立極端焊墊"&&x.lv==="ng"&&new Set(x.sig.rows.map(c=>c.r.board)).size>=3);
    const bs=[...new Set(x.sig.rows.map(c=>c.r.board))],wb=bs[1];x.sig.rows.forEach(c=>{if(c.r.board===wb)c.lv="warn"});x.corrob=[];x.same_phenomenon=[];S.F=[x];
    return JSON.stringify({id:x.id,ng:bs[0],wb,none:[...new Set(S.rows.map(r=>r.board))].find(b=>!bs.includes(b))})})()`));
  w.eval(`${H}.setTab("issues")`);
  await tick(60);
  const cell = (b) => d.querySelector(`#pmap [data-ent="b:${b}"]`);
  assert.equal(cell(pick.ng).className, "ng", "有嚴重子項的板為嚴重");
  assert.equal(cell(pick.wb).className, "warn", "只命中警示子項的板不被彙總卡染成嚴重");
  assert.equal(cell(pick.none).className, "", "彙總卡沒碰到的板無色");
  assert.match(cell(pick.wb).title, /1 項相關問題，本板最高：警示（其中 1 張為跨板彙總卡，依本板命中的焊墊判定等級）/);
  assert.match(cell(pick.ng).title, /本板最高：嚴重/);
  cell(pick.wb).click();
  await tick(30);
  assert.equal(w.eval("S.issEnt"), "b:" + pick.wb);
  assert.deepEqual(JSON.parse(w.eval(`JSON.stringify(${H}.issueList().map(x=>x.id))`)), [pick.id], "點警示板仍篩出該彙總卡");
  assert.deepEqual(errs, []);
});

test("孤立極端焊墊卡：嚴重子項排在警示子項前面（即使警示子項 |z| 較大）", () => {
  const core = loadCore();
  let s = 12345;
  const noise = () => { s = (s * 1103515245 + 12345) % 2147483648; return (s / 2147483648 - 0.5) * 2; };
  const rows = [];
  for (let b = 1; b <= 20; b++) {
    const board = "B" + String(b).padStart(2, "0");
    for (const [g, sd] of Object.entries({ C1: 0.1, C2: 1, C3: 1, C4: 1 })) for (let p = 1; p <= 10; p++) {
      let v = 100 + noise() * sd;
      if (board === "B03" && g === "C2" && p === 4) v = 135; // 超出 USL 130 → 嚴重
      if (board === "B07" && g === "C1" && p === 6) v = 112; // 規格內，但 C1 群組很集中，|z| 遠大於上面那筆 → 警示
      rows.push({ board, comp: g, pad: `${g}-${p}`, group: g, volume: v });
    }
  }
  const F = core.detectIssues(baseState(core, { rows, metrics: ["volume"], metric: "volume", group: "ALL" }));
  const iso = F.find((x) => x.cat === "孤立極端焊墊");
  assert.ok(iso, "應有孤立極端焊墊卡");
  assert.equal(iso.lv, "ng");
  assert.deepEqual(JSON.parse(JSON.stringify(iso.sig.rows.map((c) => [c.lv, c.r.board]))), [["ng", "B03"], ["warn", "B07"]]);
  assert.ok(Math.abs(iso.sig.rows[1].z) > Math.abs(iso.sig.rows[0].z), "前提：警示子項 |z| 較大");
  assert.match(iso.facts[0], /B03.*（嚴重）$/, "第一筆事實是嚴重子項");
  assert.match(iso.title, /（B03\/C2-4、B07\/C1-6）/);
});

test("總覽優先處理：每列以文字標出卡片等級，彙總卡的事實標成子項", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom, errs } = page();
  await tick(100);
  const w = dom.window, d = w.document;
  for (let i = 0; i < 100 && !w.eval("(S.F||[]).length"); i++) await tick(20);
  w.eval(`${H}.setTab("overview")`);
  await tick(60);
  const cards = JSON.parse(w.eval(`JSON.stringify(S.F.filter(x=>x.lv!=="info").slice(0,4).map(x=>({lv:x.lv,agg:!!(x.sig&&x.sig.rows&&x.sig.rows.length&&x.sig.rows[0].lv)})))`));
  const lis = [...d.querySelectorAll("#acts li")];
  assert.equal(lis.length, cards.length);
  assert.ok(cards.some((c) => c.agg), "前提：範例資料前 4 項含跨板彙總卡");
  lis.forEach((li, i) => {
    const pill = li.querySelector("b .pill");
    assert.ok(pill, `第 ${i + 1} 列有等級文字`);
    assert.equal(pill.textContent, cards[i].lv === "ng" ? "嚴重" : "警示");
    assert.ok(pill.classList.contains(cards[i].lv));
    assert.equal(/^子項（共 \d+ 筆，最嚴重者在前）：/.test(li.querySelector(".note").textContent), cards[i].agg, `第 ${i + 1} 列子項標示`);
  });
  assert.deepEqual(errs, []);
});

// 3 片板 × 4 列的高度 % 橫排（立榮格式），同 vendor.test.mjs
const head = ["Component ID"];
for (let b = 1; b <= 3; b++) head.push(`Height(%)${b}`, `Volume(%)${b}`, `Area(%)${b}`, ...(b === 1 ? ["PAD ID"] : []), `Result${b}`);
const row = (comp, pad, base) => [comp, ...[1, 2, 3].flatMap((b) => [base + b, base + 2 * b, 100 - b, ...(b === 1 ? [pad] : []), "PASS"])];
const WIDE = [head, row("C1_1", 1, 100), row("C1_1", 2, 102), row("R2_1", 1, 95), row("R2_1", 2, 97)].map((r) => r.join(",")).join("\n");

test("同名回合：舊版高度 % 警示與重新匯入按鈕附上列序，試產比較標明 A／B", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom, errs } = page();
  await tick(60);
  const w = dom.window, d = w.document;
  const s = d.querySelector("#selVendor"); s.value = "lirong"; s.dispatchEvent(new w.Event("change"));
  const inp = d.querySelector("#fileIn");
  Object.defineProperty(inp, "files", { configurable: true, value: [new w.File([Buffer.from(WIDE)], "DEMO-05_TOP_spi.csv")] });
  inp.dispatchEvent(new w.Event("change"));
  for (let i = 0; i < 100 && d.querySelector("#mapBox").hidden; i++) await tick(20);
  d.querySelector("#inLot").value = "LOT-E"; d.querySelector("#inPart").value = "DEMO-05";
  d.querySelector("#inRunName").value = "同名回合";
  await seedPartSpec(w, "DEMO-05");
  d.querySelector("#btnApply").click();
  for (let i = 0; i < 100 && w.eval("S.rows.length") !== 12; i++) await tick(20);
  const oldId = w.eval("S.runId");
  // 同一份原始檔再匯入一次的新版回合（記有換算厚度）；舊版回合拿掉換算厚度紀錄
  const newId = w.eval(`(()=>{const r=S.runs.find(r=>r.id===S.runId);return ${H}.addRun(r.name,r.rows,r.metrics,r.cfg,{...r.info,hPctThk:120})})()`);
  w.eval(`delete S.runs.find((r) => r.id === ${oldId}).info.hPctThk`);
  assert.equal(w.eval(`S.runs.find(r=>r.id===${oldId}).name===S.runs.find(r=>r.id===${newId}).name`), true, "前提：兩個回合同名");
  const pos = w.eval(`S.runs.findIndex(r=>r.id===${oldId})`) + 1;
  const runsTab = () => d.querySelector('#p-data .subtab[data-sub="runs"]');
  const waitFor = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await tick(20); return fn(); };

  w.eval(`${H}.setTab("data")`); runsTab().click();
  assert.ok(await waitFor(() => !d.querySelector("#runLegacy").hidden), "回合管理顯示警示");
  const name = w.eval(`S.runs.find(r=>r.id===${oldId}).name`);
  assert.match(d.querySelector("#runLegacy p").textContent, new RegExp(`「${name}」（回合表第 ${pos} 列）是舊版匯入`));
  const btn = d.querySelector("#runLegacy [data-reimp]");
  assert.equal(+btn.dataset.reimp, oldId);
  assert.equal(btn.textContent, `重新匯入「${name}」（回合表第 ${pos} 列）`);

  // 試產比較：舊版回合當 A 或 B，都標明是哪一邊
  w.eval(`S.cmpA = ${oldId}; S.cmpB = ${newId}; ${H}.setTab("compare")`);
  await tick(100);
  assert.match(d.querySelector("#cmpLegacy p").textContent, new RegExp(`A 回合「${name}」是舊版匯入`));
  assert.equal(d.querySelector("#cmpLegacy [data-reimp]").textContent, `重新匯入 A 回合「${name}」`);
  w.eval(`S.cmpA = ${newId}; S.cmpB = ${oldId}; ${H}.setTab("compare")`);
  await tick(100);
  assert.match(d.querySelector("#cmpLegacy p").textContent, new RegExp(`B 回合「${name}」是舊版匯入`));

  // 名稱不重複時維持原本的寫法
  w.eval(`S.runs.find(r=>r.id===${newId}).name="另一個名稱"; ${H}.setTab("data")`); runsTab().click();
  await tick(60);
  assert.match(d.querySelector("#runLegacy p").textContent, new RegExp(`「${name}」是舊版匯入`));
  assert.equal(d.querySelector("#runLegacy [data-reimp]").textContent, "重新匯入");
  assert.deepEqual(errs, []);
});
