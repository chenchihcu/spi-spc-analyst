// 規格一律由使用者定義：匯入必填鋼板厚度 → 未定義規格時分析鎖定 → 規格表驗證與草稿 → 存成料號規格（預設）解鎖
// → 同料號再匯入自動套用並帶入鋼板厚度 → 群組覆寫存 v2 → 版本清單套用／設預設 → 放棄草稿需確認；範例資料用示範規格
// 本機模式（IndexedDB），全部使用合成資料
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { JSDOM } = (() => { try { return require("jsdom"); } catch { return {}; } })();
const fs = require("fs");
const { HTML, withIdb, loadCore } = require("./_load.js");
import { createCloudHarness, installBrowserCloud } from './_cloud-harness.mjs';
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function page(cloud) {
  const html = fs.readFileSync(HTML, "utf8").replace(/<script src=[^>]+><\/script>/g, "");
  const errs = [];
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://example.test/", beforeParse(w) {
    w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === "measureText" ? () => ({ width: 1 }) : t[k] ?? (() => {})), set: (t, k, v) => ((t[k] = v), true) });
    Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { let e = this; while (e) { if (e.hidden) return null; e = e.parentElement; } return w.document.body; } });
    w.Element.prototype.scrollIntoView = () => {}; w.matchMedia = () => ({ matches: false, addEventListener() {} }); w.ResizeObserver = class { observe() {} }; w.scrollTo = () => {}; w.scrollBy = () => {};
    w.Chart = class { constructor() {} destroy() {} static register() {} };
    Object.assign(w, { Response, DecompressionStream });
    withIdb(w);
    if (cloud) installBrowserCloud(w, cloud);
    w.SPI_TEST_HOOK = {};
    w.addEventListener("error", (e) => errs.push(e.message));
  } });
  return { dom, errs };
}
// 兩個元件群組、10 片板；U2 的體積偏低（約 80%）
const CSV = "Board,Pad,Component,Volume,Height,Area\n" + Array.from({ length: 120 }, (_, i) => {
  const b = Math.floor(i / 12) + 1, p = i % 12, c = p < 6 ? "U1" : "U2", v = c === "U1" ? 100 + (i % 5) : 78 + (i % 5);
  return `B${b},P${p},${c},${v},${118 + (i % 4)},${100 + (i % 3)}`;
}).join("\n");
async function until(fn, n = 200) { for (let i = 0; i < n; i++) { if (fn()) return true; await tick(20); } return false; }
async function pickFile(dom, name, text) {
  const w = dom.window, inp = w.document.querySelector("#fileIn");
  Object.defineProperty(inp, "files", { configurable: true, value: [new w.File([Buffer.from(text)], name)] });
  inp.dispatchEvent(new w.Event("change"));
  await until(() => !w.document.querySelector("#mapBox").hidden || w.document.querySelector("#parseErr").textContent);
}
const J = (w, js) => JSON.parse(w.eval(`JSON.stringify(${js})`));
const change = (w, el, v) => { el.value = String(v); el.dispatchEvent(new w.Event("change")); };

test("核心：料號規格 → 分析狀態（高度 µm＝鋼板厚度 × 高度 %、群組補齊全板）與草稿 → 規格物件往返一致", () => {
  const c = loadCore();
  const spec = { schema: "spi-part-spec/1", part: "P", stencilRef: 100, note: "",
    specs: { volume: { lsl: 70, tgt: 100, usl: 130 }, hpct: { lsl: 80, tgt: 100, usl: 120 }, area: { lsl: 70, tgt: null, usl: 130 }, offx: { lsl: -50, tgt: 0, usl: 50 }, offy: { lsl: -50, tgt: 0, usl: 50 } },
    groups: { G: { hpct: { lsl: 90, tgt: 100, usl: 110 } } } };
  const st = JSON.parse(JSON.stringify(c.partSpecToState(spec, 150)));
  assert.deepEqual(st.specs.height, { lsl: 120, usl: 180, tgt: 150 }, "150 µm × 80%–120%");
  assert.deepEqual(st.htol, { lo: 80, hi: 120 });
  assert.equal(st.specs.area.tgt, 100, "標準值空白時以 LSL／USL 中點補上");
  assert.deepEqual(st.specsG.G.height, { lsl: 135, usl: 165, tgt: 150 }, "群組高度 % 推出群組高度 µm");
  assert.deepEqual(st.specsG.G.volume, st.specs.volume, "群組未覆寫的項目補全板值");
  const back = c.stateToPartSpec("P", { specs: st.specs, groups: st.groups }, 150, "n");
  const enc = c.partSpecEncode(back);
  assert.ok(!enc.error, enc.error);
  assert.equal(enc.spec.stencilRef, 150); assert.equal(enc.spec.groups.G.hpct.lsl, 90);
  assert.equal(c.specReady({ specSrc: "sample" }), true);
  assert.equal(c.specReady({ specSrc: "part", partSpec: { id: "x" } }), true);
  assert.equal(c.specReady({ specSrc: "part", partSpec: null }), false);
  assert.equal(c.specReady({ specSrc: "none" }), false);
});

test("流程：鋼板厚度必填 → 未定義規格時鎖定 → 驗證與草稿 → 存 v1 預設解鎖 → 同料號自動套用 → 群組覆寫 v2 → 版本清單 → 放棄草稿需確認", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const cloud = await createCloudHarness();
  await cloud.upload({ kind: 'place', part: 'NEW-1', rev: 'V1', side: 'TOP', unit: 'mm', name: 'NEW-1-V1-TOP.csv' },
    'RefDes,X,Y,Layer\nU1,1,2,TOP\nU2,3,4,TOP\n');
  const { dom, errs } = page(cloud);
  await tick(60);
  const w = dom.window, d = w.document, $ = (s) => d.querySelector(s);
  assert.equal(w.eval("S.specSrc"), "sample", "開機的範例資料用示範規格");
  assert.match($("#partSpecBar").textContent, /示範規格/);
  assert.ok(w.eval("!!S.A"), "範例資料可直接分析");

  // 1. 鋼板厚度未填：不能套用
  $("[data-tab=data]").click();
  $("#btnSelectPlace").click();
  assert.ok(await until(() => $("#tblPickPlace [data-pact=use-place]")));
  $("#tblPickPlace [data-pact=use-place]").click();
  assert.ok(await until(() => $("#placePart").value === 'NEW-1'));
  $("#recPickerClose").click();
  $("#selSide").value = 'TOP';
  await pickFile(dom, "NEW-1_TOP.csv", CSV);
  $("#inLot").value = "L1"; $("#inPart").value = "NEW-1"; $("#inRev").value = "V1"; $("#inWorkOrder").value = "WO-L1"; $("#inImpStencil").value = "";
  await $("#btnApply").onclick();
  assert.match($("#recNote").textContent, /請填寫鋼板厚度/);
  assert.equal($("#inImpStencil").getAttribute("aria-invalid"), "true");
  assert.equal(w.eval("S.runs.length"), 2, "未填厚度不建立回合");

  // 2. 填厚度後套用：料號沒有規格 → 回合鎖定、導向規格設定
  $("#inImpStencil").value = "120";
  await $("#btnApply").onclick();
  assert.ok(await until(() => w.eval("S.runs.length") === 3));
  assert.equal(w.eval("S.specSrc"), "none"); assert.equal(w.eval("S.A"), null, "未定義規格不計算");
  assert.equal(w.eval("S.tab"), "data", "導向資料與規格");
  assert.equal(w.eval("S.stencil"), 120);
  assert.match($("#partSpecBar").textContent, /料號 NEW-1.*尚未定義規格，分析已鎖定/);
  assert.match($("#specSrcNote").textContent, /內建起始值，尚未存檔、不會用於判定/);
  $("[data-tab=issues]").click();
  assert.equal($("#p-gate").hidden, false, "分析頁顯示鎖定畫面"); assert.equal($("#p-issues").hidden, true);
  assert.match($("#gateMsg").textContent, /NEW-1.*儲存為新版本/);
  $("#btnGateSpec").click();
  assert.equal(w.eval("S.tab"), "data");

  // 3. 欄位驗證：LSL ≥ USL 不寫入，並以紅框＋行內說明提示
  change(w, $("#sp-volume-lsl"), 140);
  assert.equal($("#sp-volume-lsl").getAttribute("aria-invalid"), "true");
  assert.match($("#specTblErr").textContent, /體積：LSL 必須小於 USL/);
  assert.equal(w.eval("S.specDraft&&S.specDraft.dirty"), false, "不合格的值不寫入草稿");
  // 高度用 µm 輸入 → 換成鋼板厚度 %
  change(w, $("#sp-height-lsl"), 96);
  assert.equal(w.eval("S.specDraft.specs.hpct.lsl"), 80, "96 µm ÷ 120 µm = 80%");
  change(w, $("#sp-volume-lsl"), 75);
  assert.equal(w.eval("S.specDraft.dirty"), true);
  assert.match($("#partSpecBar").textContent, /已修改，尚未存成新版本/);
  assert.equal(w.eval("S.A"), null, "存檔前仍鎖定");

  // 4. 儲存為新版本（預設）→ 解鎖並套用
  $("#btnSpecSave").click();
  assert.equal($("#specSaveModal").hidden, false);
  assert.equal($("#specSaveDefault").checked, true, "第一版預設勾選設為預設");
  assert.match($("#specSaveTarget").textContent, /料號 NEW-1 · 鋼板厚度 120 µm/);
  $("#specSaveNote").value = "依加工廠規格";
  await $("#specSaveOk").onclick();
  assert.equal($("#specSaveModal").hidden, true);
  assert.equal(w.eval("S.specSrc"), "part");
  assert.deepEqual(J(w, "{ver:S.partSpec.ver,isDefault:S.partSpec.isDefault,part:S.partSpec.part,note:S.partSpec.note}"), { ver: 1, isDefault: true, part: "NEW-1", note: "依加工廠規格" });
  assert.equal(w.eval("S.specs.volume.lsl"), 75); assert.equal(w.eval("S.specs.height.lsl"), 96);
  assert.equal(w.eval("S.specDraft"), null);
  assert.ok(await until(() => w.eval("!!S.A")), "解鎖後開始分析");
  assert.match($("#partSpecBar").textContent, /料號 NEW-1 · v1（預設）/);
  assert.match(w.eval("SPI_TEST_HOOK.reportMd()"), /規格來源：料號規格 NEW-1 v1（SHA-256 [0-9a-f]{12}）/);

  // 5. 同料號再匯入：厚度空白也會自動套用預設版並帶入存檔時的鋼板厚度
  await pickFile(dom, "NEW-1_TOP_2.csv", CSV.replace("B1,P0,U1,100", "B1,P0,U1,101"));
  $("#inLot").value = "L2"; $("#inPart").value = "NEW-1"; $("#inRev").value = "V1"; $("#inWorkOrder").value = "WO-L2"; $("#inImpStencil").value = "";
  await $("#btnApply").onclick();
  assert.ok(await until(() => w.eval("S.runs.length") === 4));
  assert.equal(w.eval("S.specSrc"), "part"); assert.equal(w.eval("S.partSpec.ver"), 1);
  assert.equal(w.eval("S.stencil"), 120, "沿用規格存檔時的鋼板厚度");
  assert.equal(w.eval("S.tab"), "issues", "有規格時直接進入分析");

  // 6. 群組覆寫 → 存 v2（不設預設）
  $("[data-tab=data]").click();
  $("#selSpecGrp").value = "U2"; $("#selSpecGrpM").value = "volume"; $("#btnSpecGrpAdd").click();
  assert.equal(d.querySelectorAll("#specGrpTbl input").length, 3);
  change(w, d.querySelector('#specGrpTbl input[data-q="lsl"]'), 70);
  assert.equal(w.eval("S.specDraft.groups.U2.volume.lsl"), 70);
  $("#btnSpecSave").click();
  assert.equal($("#specSaveDefault").checked, true); $("#specSaveDefault").checked = false;
  await $("#specSaveOk").onclick();
  assert.equal(w.eval("S.partSpec.ver"), 2); assert.equal(w.eval("S.partSpec.isDefault"), false);
  assert.equal(w.eval("S.specsG.U2.volume.lsl"), 70); assert.equal(w.eval("S.specsG.U2.area.lsl"), 70, "群組未覆寫項目補全板值");
  assert.equal(w.eval("'U1' in S.specsG"), false, "沒覆寫的群組沿用全板");

  // 7. 版本清單：套用 v1、把 v2 設為預設
  $("#btnSpecVers").click();
  assert.ok(await until(() => d.querySelectorAll("#specVerTbl tbody tr").length === 2));
  assert.match($("#specVerState").textContent, /共 2 個版本/);
  d.querySelector("#specVerTbl [data-vuse]").click();
  assert.ok(await until(() => w.eval("S.partSpec.ver") === 1));
  assert.equal(w.eval("S.specsG"), null, "v1 沒有群組覆寫");
  $("#btnSpecVers").click();
  assert.ok(await until(() => !!d.querySelector("#specVerTbl [data-vdef]")));
  d.querySelector("#specVerTbl [data-vdef]").click();
  assert.ok(await until(() => /v2 <span class="pill ok">預設/.test(d.querySelector("#specVerTbl").innerHTML)));
  assert.equal(w.eval("S.partSpec.isDefault"), false, "目前套用的 v1 已不是預設");
  d.querySelector("#specVerModal [data-close]").click();

  // 8. 放棄草稿需確認；取消後草稿不變
  change(w, $("#sp-area-usl"), 125);
  assert.equal(w.eval("S.specDraft.dirty"), true);
  $("#btnSpecDiscard").click();
  assert.equal($("#specConfirmModal").hidden, false);
  d.querySelector("#specConfirmModal [data-close]").click();
  await tick(10);
  assert.equal(w.eval("S.specDraft.dirty"), true, "取消後草稿保留");
  $("#btnSpecDiscard").click();
  $("#specConfirmOk").click();
  await tick(10);
  assert.equal(w.eval("S.specDraft"), null, "確認後回到套用的版本");

  // 9. 資料庫頁列出料號規格版本；在這裡設為預設 → 稽核頁顯示「設為預設」與前後版本；列印表頭與匯出帶規格來源
  $("[data-tab=data]").click(); $('.subtab[data-sub="records"]').click(); $("#recReload").click();
  assert.ok(await until(() => d.querySelectorAll("#recSpec tbody tr").length === 2 && /v2/.test($("#recSpec").textContent)));
  const specRows = () => [...d.querySelectorAll("#recSpec tbody tr")].map((tr) => tr.textContent);
  assert.equal(specRows().length, 2);
  assert.match($("#recSpecSub").textContent, /2 個版本/);
  assert.match(specRows()[0], /NEW-1v2 預設/); assert.match(specRows()[1], /依加工廠規格/);
  assert.equal(d.querySelectorAll('#recSpec [data-ract="suse"]').length, 1, "只有非目前套用的 v2 可套用");
  assert.match(specRows()[1], /目前套用/);
  d.querySelector('#recSpec [data-ract="sdef"]').click();
  assert.ok(await until(() => /v1 預設/.test(specRows()[1] || "")), "v1 改為預設");
  assert.equal(w.eval("S.partSpec.isDefault"), true, "目前套用的 v1 同步標成預設");
  $("#recAuditBox").open = true; $("#recAuditBox").dispatchEvent(new w.Event("toggle"));
  assert.ok(await until(() => /設為預設/.test($("#recAudit").textContent)));
  const auditTxt = [...d.querySelectorAll("#recAudit tbody tr")].map((tr) => tr.textContent);
  assert.match(auditTxt[0], /設為預設前一版：v2 → 新版：v1料號規格.*NEW-1v1/);
  assert.ok(auditTxt.some((t) => /設為預設前一版：v1 → 新版：v2/.test(t)), "版本清單的切換也有記錄");
  assert.ok(auditTxt.some((t) => /設為預設前一版：無 → 新版：v1/.test(t)), "第一版存檔即設為預設");
  w.SPI_TEST_HOOK.beforePrint(); w.SPI_TEST_HOOK.afterPrint();
  assert.match($("#printHead").textContent, /規格來源：料號規格 NEW-1 v1（SHA-256 [0-9a-f]{12}）/);
  const csv = w.eval("SPI_TEST_HOOK.issuesCsv(S.F)").split("\n");
  assert.ok(csv[0].endsWith(",spec_source")); assert.match(csv[1], /料號規格 NEW-1 v1/);

  // 10. 範例回合仍可直接分析
  w.eval("SPI_TEST_HOOK.switchRun(S.runs[0].id)");
  assert.equal(w.eval("S.specSrc"), "sample"); assert.ok(w.eval("!!S.A"));
  assert.deepEqual(errs, []);
});
