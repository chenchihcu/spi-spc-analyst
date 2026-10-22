// 分析報告與 AI 分析送出的資料都要帶失效模式交叉比對、能力細節與管制狀態；規格一律來自使用者定義的料號規格（範例資料為示範規格）
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { validatePayload, LIMITS } from "../lib/analyze-core.mjs";

const require = createRequire(import.meta.url);
const { JSDOM } = (() => { try { return require("jsdom"); } catch { return {}; } })();
const fs = require("fs");
const { HTML, withIdb, loadCore } = require("./_load.js");
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function page() {
  const html = fs.readFileSync(HTML, "utf8").replace(/<script src=[^>]+><\/script>/g, "");
  const errs = [];
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://example.test/", beforeParse(w) {
    w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === "measureText" ? () => ({ width: 1 }) : t[k] ?? (() => {})), set: (t, k, v) => ((t[k] = v), true) });
    Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { let e = this; while (e) { if (e.hidden) return null; e = e.parentElement; } return w.document.body; } });
    w.Element.prototype.scrollIntoView = () => {}; w.matchMedia = () => ({ matches: false, addEventListener() {} }); w.ResizeObserver = class { observe() {} }; w.scrollTo = () => {};
    w.Chart = class { constructor() {} destroy() {} static register() {} };
    Object.assign(w, { Response, DecompressionStream });
    withIdb(w);
    w.SPI_TEST_HOOK = {};
    w.addEventListener("error", (e) => errs.push(e.message));
  } });
  return { dom, errs };
}
async function ready(w) { for (let i = 0; i < 200; i++) { if (w.eval("S.F&&S.F.meta&&S.F.meta.modes")) return; await tick(20); } throw new Error("頁面未完成分析"); }

test("AI 分析資料：含失效模式交叉比對、能力信賴區間、X̄ 管制狀態、多重比較，且通過伺服器驗證", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom, errs } = page(); const w = dom.window; await ready(w);
  const raw = w.eval("JSON.stringify({payload:SPI_TEST_HOOK.aiPayload()})");
  assert.ok(Buffer.byteLength(raw) < LIMITS.maxBytes, "大小在上限內：" + Buffer.byteLength(raw));
  const out = validatePayload(raw);
  assert.equal(out["失效模式交叉比對"].length, 12);
  const clog = out["失效模式交叉比對"].find((m) => m["模式"].startsWith("開孔堵塞"));
  assert.equal(clog["判讀"], "可能");
  assert.ok(clog["支持證據"].length >= 2 && typeof clog["支持證據"][0] === "string", "證據未被巢狀上限截掉");
  assert.match(out["能力"]["Cpk95信賴區間"], /–/);
  assert.ok(out["能力"]["逐群組"].length >= 2 && out["能力"]["逐群組"][0]["Cpk95信賴區間"]);
  assert.equal(typeof out["管制狀態"]["製程穩定"], "boolean");
  assert.ok(out["多重比較"]["單板異常檢定次數"] > 0);
  assert.match(out["規格來源"], /示範規格/);
  assert.deepEqual(errs, []);
});

test("分析報告：含規格來源、能力信賴區間、逐群組能力、X̄ 判異與失效模式交叉比對", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom } = page(); const w = dom.window; await ready(w);
  const md = w.eval("SPI_TEST_HOOK.reportMd()");
  for (const s of ["規格來源：示範規格", "Cpk 95% 信賴區間", "### 逐元件群組製程能力", "Nelson 規則（X̄ 圖", "## 失效模式交叉比對", "| 開孔堵塞（Clogging） | 可能 |"]) assert.ok(md.includes(s), "報告缺少：" + s);
});

test("料號規格：群組覆寫只套用到該群組、能力以群組規格計算，報告標示料號與版本（不再有推估下限）", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom } = page(); const w = dom.window; await ready(w);
  w.eval(`const sp={schema:"spi-part-spec/1",part:"T-1",stencilRef:120,specs:{},groups:{"U2 BGA":{volume:{lsl:85,tgt:100,usl:115}}},note:"測試"};
    for(const k of PART_SPEC_METRICS)sp.specs[k]={...DEF_SPECS[k]};
    S.runs.find(r=>r.id===S.runId).sample=false;
    SPI_TEST_HOOK.useSpec({id:"x".repeat(22),part:"T-1",ver:1,sha256:"ab".repeat(32),isDefault:true,user:"a",created:1},sp)`);
  assert.equal(w.eval("S.specSrc"), "part");
  const G = JSON.parse(w.eval("JSON.stringify(S.specsG)"));
  assert.deepEqual(Object.keys(G), ["U2 BGA"], "只有覆寫的群組有群組規格");
  assert.equal(G["U2 BGA"].volume.lsl, 85); assert.equal(G["U2 BGA"].area.lsl, 70, "未覆寫項目補全板值");
  const cap = JSON.parse(w.eval("JSON.stringify(S.A.cap)"));
  assert.ok(cap.perGroupSpec && cap.groups.some((g) => g.g === "U2 BGA" && g.lsl === 85) && cap.groups.some((g) => g.g !== "U2 BGA" && g.lsl === 70), "能力以各群組適用的規格計算");
  assert.equal(cap.lowerBound, undefined, "不再有推估規格的「下限」");
  const md = w.eval("SPI_TEST_HOOK.reportMd()");
  assert.match(md, /規格來源：料號規格 T-1 v1（SHA-256 abababababab）/);
  assert.doesNotMatch(md, /下限|機台/);
});

test("核心：specOfGroup／stepHpct 有群組覆寫就用群組規格，否則全板", () => {
  const c = loadCore(), base = JSON.parse(JSON.stringify(c.DEF_SPECS)), g = { A: { ...base, volume: { lsl: 80, usl: 120, tgt: 100 }, hpct: { lsl: 85, usl: 115, tgt: 100 } } };
  assert.equal(c.specOfGroup({ specSrc: "part", specsG: g, specs: base }, "A", "volume").lsl, 80);
  assert.equal(c.specOfGroup({ specSrc: "part", specsG: g, specs: base }, "B", "volume").lsl, base.volume.lsl);
  assert.equal(c.specOfGroup({ specSrc: "sample", specsG: null, specs: base }, "A", "volume").lsl, base.volume.lsl);
  assert.deepEqual({ ...c.stepHpct({ specsG: g, htol: { lo: 75, hi: 125 } }, "A") }, { lo: 85, hi: 115 });
  assert.deepEqual({ ...c.stepHpct({ specsG: g, htol: { lo: 75, hi: 125 } }, "B") }, { lo: 75, hi: 125 });
});

test("claude.ai 內的 AI 提示詞與伺服器端使用相同的證據規則", async () => {
  const { SYSTEM_PROMPT } = await import("../lib/analyze-core.mjs");
  const html = fs.readFileSync(HTML, "utf8"), m = html.match(/const AI_EVIDENCE_RULE="([^"]+)"/);
  assert.ok(m, "頁面定義了證據規則");
  assert.ok(SYSTEM_PROMPT.includes(m[1]), "伺服器提示詞含相同文字");
  assert.match(html, /\$\{AI_EVIDENCE_RULE\}/, "頁面內提示詞有使用");
});

test("舊版回合（機台推估／自訂／工單／AOI 規格）還原後鎖定，直到套用料號規格；範例資料不受影響", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom } = page(); const w = dom.window, d = w.document; await ready(w);
  for (const src of ["machine", "custom", "workorder", "aoi"]) {
    w.eval(`const c=S.runs.find(r=>r.id===S.runId);c.sample=false;c.cfg={...c.cfg,specSrc:${JSON.stringify(src)},specsCustom:JSON.parse(JSON.stringify(S.specs)),specsG:{X:{}}};S.runId=-1;SPI_TEST_HOOK.switchRun(c.id)`);
    assert.equal(w.eval("S.specSrc"), "none", src + " → 未定義");
    assert.equal(w.eval("S.specsG"), null); assert.equal(w.eval("S.A"), null, "不計算任何分析");
    assert.equal(w.eval("'specsCustom' in S"), false);
    w.eval('SPI_TEST_HOOK.setTab("issues")');
    assert.equal(d.querySelector("#p-gate").hidden, false, "分析頁顯示鎖定畫面"); assert.equal(d.querySelector("#p-issues").hidden, true);
    w.eval('SPI_TEST_HOOK.setTab("data")');
    assert.equal(d.querySelector("#p-data").hidden, false, "資料與規格頁可用"); assert.equal(d.querySelector("#p-gate").hidden, true);
  }
  w.eval('const c=S.runs.find(r=>r.id===S.runId);c.sample=true;S.runId=-1;SPI_TEST_HOOK.switchRun(c.id)');
  assert.equal(w.eval("S.specSrc"), "sample"); assert.ok(w.eval("!!S.A"), "範例資料照常分析");
});
