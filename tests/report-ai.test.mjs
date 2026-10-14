// v9.10.1：分析報告與 AI 分析送出的資料都要帶失效模式交叉比對、能力細節與管制狀態；機台規格依元件群組推估
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
  assert.match(out["規格來源"], /自訂規格/);
  assert.deepEqual(errs, []);
});

test("分析報告：含規格來源、能力信賴區間、逐群組能力、X̄ 判異與失效模式交叉比對", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom } = page(); const w = dom.window; await ready(w);
  const md = w.eval("SPI_TEST_HOOK.reportMd()");
  for (const s of ["規格來源：自訂規格", "Cpk 95% 信賴區間", "### 逐元件群組製程能力", "Nelson 規則（X̄ 圖", "## 失效模式交叉比對", "| 開孔堵塞（Clogging） | 可能 |"]) assert.ok(md.includes(s), "報告缺少：" + s);
});

test("規格來源：機台模式各元件群組各自推估規格窗；之後匯入無判定碼的資料回到自訂規格", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom } = page(); const w = dom.window; await ready(w);
  w.eval(`S.rows.forEach((r,i)=>{r.result=i%53===0?"FAIL":"PASS";r.mNG=i%53===0});SPI_TEST_HOOK.setSpecSrc("machine")`);
  assert.equal(w.eval("S.specSrc"), "machine");
  const G = JSON.parse(w.eval("JSON.stringify(S.specsG)"));
  assert.ok(Object.keys(G).length >= 3, "各群組推估");
  assert.notDeepEqual(G["U2 BGA"].volume, G["U1 QFP"].volume, "不同群組規格窗不同");
  const cap = JSON.parse(w.eval("JSON.stringify(S.A.cap)"));
  assert.ok(cap.perGroupSpec && cap.groups.some((g) => g.lsl === G[g.g].volume.lsl), "能力以群組規格計算");
  assert.equal(cap.lowerBound, true, "機台推估規格算出的能力標為下限");
  assert.match(w.eval("SPI_TEST_HOOK.reportMd()"), /Cp\/Cpk 為下限/);
  const cfg = JSON.parse(w.eval(`JSON.stringify(SPI_TEST_HOOK.importCfg([{board:"B1",pad:"P",group:"G",volume:100}]))`));
  assert.equal(cfg.specSrc, "custom"); assert.equal(cfg.specsG, null);
});

test("核心：specOfGroup 只在機台模式且有該群組規格時使用群組規格", () => {
  const c = loadCore(), base = JSON.parse(JSON.stringify(c.DEF_SPECS)), g = { A: { volume: { lsl: 80, usl: 120, tgt: 100 } } };
  assert.equal(c.specOfGroup({ specSrc: "machine", specsG: g, specs: base }, "A", "volume").lsl, 80);
  assert.equal(c.specOfGroup({ specSrc: "machine", specsG: g, specs: base }, "B", "volume").lsl, base.volume.lsl);
  assert.equal(c.specOfGroup({ specSrc: "custom", specsG: g, specs: base }, "A", "volume").lsl, base.volume.lsl);
});

test("claude.ai 內的 AI 提示詞與伺服器端使用相同的證據規則", async () => {
  const { SYSTEM_PROMPT } = await import("../lib/analyze-core.mjs");
  const html = fs.readFileSync(HTML, "utf8"), m = html.match(/const AI_EVIDENCE_RULE="([^"]+)"/);
  assert.ok(m, "頁面定義了證據規則");
  assert.ok(SYSTEM_PROMPT.includes(m[1]), "伺服器提示詞含相同文字");
  assert.match(html, /\$\{AI_EVIDENCE_RULE\}/, "頁面內提示詞有使用");
});

test("還原 v9.10.0 存下的機台模式回合：自動依原始資料重建群組規格", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom } = page(); const w = dom.window; await ready(w);
  w.eval(`S.rows.forEach((r,i)=>{r.result=i%53===0?"FAIL":"PASS";r.mNG=i%53===0});const c=S.runs.find(r=>r.id===S.runId);c.cfg={...c.cfg,specSrc:"machine",specsCustom:JSON.parse(JSON.stringify(S.specs))};delete c.cfg.specsG;S.runId=-1;SPI_TEST_HOOK.switchRun(c.id)`);
  assert.equal(w.eval("S.specSrc"), "machine");
  assert.ok(Object.keys(JSON.parse(w.eval("JSON.stringify(S.specsG)"))).length >= 3, "群組規格已重建");
});
