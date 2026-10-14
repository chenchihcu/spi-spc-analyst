// v9.10 統計稽核修正：能力指標、P' 圖、判異規則範圍、機台規格、擦拭相位、量測一致性、失效模式交叉比對
// 全部使用合成資料（不含客戶資料）
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadCore, baseState } = require("./_load");

const c = loadCore();
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} 期望 ${b}，實得 ${a}`);
const clone = (o) => JSON.parse(JSON.stringify(o));
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function gauss(r) { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
// 焊墊配置取自範例資料第一片板，另加一組開孔很小（面積比低）的 FINE 群組
const LAYOUT = (() => {
  const L = c.sampleData().filter((r) => r.board === "B01").map((r) => ({ pad: r.pad, group: r.group, x: r.x, y: r.y, w: r.w, d: r.d, shape: r.shape }));
  for (let i = 0; i < 24; i++) L.push({ pad: "F1-" + (i + 1), group: "FINE", x: 8 + (i % 6) * 1.2, y: 34 + Math.floor(i / 6) * 1.2, w: 0.25, d: 0.25, shape: "rect" });
  return L;
})();
// fx(b, p, pos) 回傳該焊墊的調整量：{dh, da, dv, ox, oy}
function synth({ nb = 30, seed = 7, fx = () => ({}) } = {}) {
  const r = rng(seed), rows = [];
  for (let b = 1; b <= nb; b++) for (const p of LAYOUT) {
    const e = fx(b, p) || {};
    const h = 120 + (e.dh || 0) + gauss(r) * 5, a = 100 + (e.da || 0) + gauss(r) * 5;
    const v = (h / 120) * a * (1 + gauss(r) * 0.025) + (e.dv || 0);
    rows.push({ board: "B" + String(b).padStart(2, "0"), pad: p.pad, comp: p.pad, group: p.group, x: p.x, y: p.y, w: p.w, d: p.d, shape: p.shape,
      height: +h.toFixed(1), area: +a.toFixed(1), volume: +v.toFixed(1), offx: +((e.ox || 0) + gauss(r) * 12).toFixed(1), offy: +((e.oy || 0) + gauss(r) * 12).toFixed(1) });
  }
  return rows;
}
const st = (rows, extra = {}) => baseState(c, { rows, metrics: ["volume", "height", "hpct", "area", "offx", "offy"], metric: "volume", group: "ALL", chart: "xbars", ...extra });
const modes = (rows, extra) => { const F = c.detectIssues(st(rows, extra)); return { F, M: Object.fromEntries(F.meta.modes.map((m) => [m.name.split("（")[0], m])) }; };

test("能力：混合群組時以組內 σ 計算，整體取最差群組；Cpk 95% 信賴區間與 NIST 公式一致", () => {
  const r = rng(3), rows = [];
  for (let b = 1; b <= 20; b++) for (let i = 0; i < 40; i++) {
    const g = i < 20 ? "G1" : "G2", mu = g === "G1" ? 90 : 110;
    rows.push({ board: "B" + b, pad: g + "-" + i, group: g, volume: mu + gauss(r) * 5 });
  }
  const A = c.analyze(st(rows, { metrics: ["volume"] }));
  near(A.sigmaW, 5, 0.3, "組內 σ 不含群組平均差");
  assert.ok(A.overallSd > 9, "整體 σ 含群組差異");
  assert.equal(A.cap.mixed, true);
  assert.equal(A.cap.groups.length, 2);
  const w = A.cap.groups[0];
  assert.equal(A.cap.worst, w.g);
  near(A.cap.cpk, Math.min(...A.cap.groups.map((g) => g.cpk)), 1e-12, "整體 Cpk 取最差群組");
  assert.equal(w.nb, 20, "有效樣本數取板數");
  const se = Math.sqrt(1 / (9 * w.nb) + (w.cpk * w.cpk) / (2 * (w.nb - 1)));
  near(w.ci[0], w.cpk - 1.96 * se, 1e-9, "CI 下限");
  near(w.ci[1], w.cpk + 1.96 * se, 1e-9, "CI 上限");
  // 單一群組：Cp 用組內 σ、Pp 用整體 σ
  const one = c.analyze(st(rows.filter((x) => x.group === "G1"), { metrics: ["volume"] }));
  assert.equal(one.cap.mixed, false);
  near(one.cap.cp, (one.sp.usl - one.sp.lsl) / (6 * one.sigmaW), 1e-9);
  near(one.cap.pp, (one.sp.usl - one.sp.lsl) / (6 * one.overallSd), 1e-9);
});

test("S 圖：中心線 c4(n)·σ̂，界限 ±3σ̂√(1−c4²)", () => {
  const r = rng(11), rows = [];
  for (let b = 1; b <= 15; b++) for (let i = 0; i < 5; i++) rows.push({ board: "B" + b, pad: "P" + i, group: "G", volume: 100 + gauss(r) * 4 });
  const A = c.analyze(st(rows, { metrics: ["volume"] })), s = A.xs.s[0], c4 = c.c4(5);
  near(s.cl, c4 * A.sigmaW, 1e-9);
  near(s.ucl, s.cl + 3 * A.sigmaW * Math.sqrt(1 - c4 * c4), 1e-9);
});

test("P' 圖（Laney）：板間不良率過度離散時 σz > 1、界限放寬，誤報減少", () => {
  const r = rng(5), rows = [];
  for (let b = 1; b <= 25; b++) { const lvl = 0.03 + r() * 0.08; for (let i = 0; i < 400; i++) rows.push({ board: "B" + String(b).padStart(2, "0"), pad: "P" + i, group: "G", volume: r() < lvl ? 30 : 100 + gauss(r) * 3 }); }
  const A = c.analyze(st(rows, { metrics: ["volume"], chart: "p" }));
  assert.ok(A.pc.sigZ > 2, "σz = " + A.pc.sigZ);
  const pb = A.pc.cl, binom = A.pc.pts.filter((p) => Math.abs(p.v - pb) > 3 * Math.sqrt(pb * (1 - pb) / 400)).length, laney = A.pc.pts.filter((p) => p.v > p.ucl || p.v < p.lcl).length;
  assert.ok(laney < binom, `Laney 越界 ${laney} 應少於二項式 ${binom}`);
});

test("判異規則：P' 圖只用 1–4、EWMA／CUSUM 只用規則 1；管制狀態一律以 X̄ 圖判斷", () => {
  const rows = c.sampleData();
  const p = c.analyze(st(rows, { chart: "p" })), e = c.analyze(st(rows, { chart: "ewma" })), x = c.analyze(st(rows, { chart: "xbars" }));
  assert.deepEqual([...p.nel.rules.filter((r) => r.na).map((r) => r.id)], [5, 6, 7, 8]);
  assert.deepEqual([...e.nel.rules.filter((r) => r.na).map((r) => r.id)], [2, 3, 4, 5, 6, 7, 8]);
  assert.ok(p.nel.rules.filter((r) => r.na).every((r) => r.idx.length === 0), "不適用規則不得有觸發點");
  assert.equal(p.nelX.flag.size, x.nel.flag.size, "穩定性判斷與所選管制圖無關");
  assert.equal(p.stable, x.stable);
});

test("規格來源：與機台判定一致時好壞以機台為準，規格窗推估自 PASS 範圍", () => {
  const rows = synth({ nb: 8 }).map((r, i) => ({ ...r, result: i % 97 === 0 ? "FAIL" : "PASS", mNG: i % 97 === 0 }));
  const m = c.machineSpecs(rows, st(rows), c.DEF_SPECS);
  const pass = rows.filter((r) => !r.mNG).map((r) => r.volume);
  assert.ok(m.specs.volume.lsl <= Math.min(...pass) && m.specs.volume.usl >= Math.max(...pass));
  assert.equal(m.specs.volume.lsl, Math.min(...pass), "不向外取整：規格窗就是 PASS 實際範圍（能力為下限）");
  const S = st(rows, { specSrc: "machine", specs: m.specs });
  assert.ok(rows.every((r) => (c.classify(r, S.specs, S).length > 0) === r.mNG), "判定與機台完全一致");
  assert.deepEqual([...c.classify({ ...rows[0], mNG: true, volume: 100, area: 100, height: 120, offx: 0, offy: 0 }, S.specs, S)], ["MNG"]);
});

test("擦拭週期：未知第一次擦拭位置時，相位掃描找回擦拭後第 1 片並校正 p 值", () => {
  const N = 5, ph = 2, v = Array.from({ length: 30 }, (_, i) => 100 + (((i - ph) % N) + N) % N * 2 + Math.sin(i) * 0.3);
  const w = c.wipeScan(v, N);
  assert.equal(w.ph, ph);
  assert.ok(w.slope > 1.8 && w.slope < 2.2);
  assert.ok(w.p >= w.p0 * N - 1e-12 || w.p === 1, "p 值乘以相位數");
});

test("量測一致性：機台由面積×高度算出體積時判為不適用（鋼板厚度輸入不同也一樣）；獨立量測時以組內殘差判斷", () => {
  const rows = synth({ nb: 6 }), der = rows.map((r) => ({ ...r, volume: +(r.area * r.height / 120).toFixed(3) }));
  assert.equal(c.msaCheck(der, st(der, { stencil: 100 })).derived, true, "厚度輸入 100 µm 時比值為 1.2 但仍為衍生值");
  const d = c.msaCheck(der, st(der)), ind = c.msaCheck(rows, st(rows));
  assert.equal(d.derived, true);
  assert.equal(ind.derived, false);
  assert.ok(ind.rW > 0.8, "rW = " + ind.rW);
});

test("試產比較：不良率以每板為單位（Welch），Ppk 標準誤以板數計", () => {
  const a = synth({ seed: 1 }), b = synth({ seed: 2 });
  const out = c.compareRuns(st(a), st(b), "volume").find((x) => x.g === "整體");
  assert.ok(Array.isArray(out.a.br) && out.a.br.length === 30, "每板不良率");
  assert.ok(out.pD > 0.01, "同分布資料不應判不良率顯著不同");
});

test("問題偵測揭露檢定次數與預期誤報數", () => {
  const { F } = modes(synth({}));
  assert.ok(F.meta.tests > 100);
  near(F.meta.alpha, 2 * (1 - 0.99976737), 2e-6);
  near(F.meta.expFA, F.meta.tests * F.meta.alpha, 1e-9);
});

test("失效模式：純雜訊資料沒有任何模式判為「可能」", () => {
  for (const seed of [21, 22, 23, 24, 25, 26, 27, 28, 29, 30]) {
    const { M } = modes(synth({ seed }));
    const hit = [...Object.values(M).filter((m) => m.verdict === "可能").map((m) => m.name)];
    assert.deepEqual(hit, [], `seed ${seed}: ${hit.join("、")}`);
  }
});

test("失效模式：範例資料埋入的堵孔、錫膏漂移、刮刀問題判為「可能」，且單一面向只到「待確認」", () => {
  const { M } = modes(c.sampleData(), { stencil: 120 });
  for (const k of ["開孔堵塞", "錫膏老化／黏度漂移", "刮刀"]) assert.equal(M[k].verdict, "可能", k + "：" + JSON.stringify(M[k].sup.map((e) => e.txt)));
  assert.equal(M["對位平移"].verdict, "待確認", "只有對位一個面向");
  for (const m of Object.values(M)) if (m.verdict === "可能") assert.ok(m.dims.length >= 2 && m.con.length === 0 && (!m.key || m.dims.includes(m.key)));
});

test("失效模式：擦拭不足（含未知相位）與坍塌、堵孔可彼此區分", () => {
  // 擦拭不足：面積隨擦拭後片數上升，第一次擦拭在第 3 片
  const wipe = synth({ fx: (b) => { const pos = ((b - 1 - 2) % 5 + 5) % 5; return { da: pos * 4, dv: pos * 4 }; } });
  const W = modes(wipe);
  assert.equal(W.M["擦拭不足／鋼板底面污染"].verdict, "可能", JSON.stringify(W.M["擦拭不足／鋼板底面污染"]));
  const wf = W.F.find((x) => x.cat === "擦拭週期");
  assert.ok(wf && wf.sig.ph === 2, "推定擦拭後第 1 片為 B03");
  assert.notEqual(W.M["錫膏坍塌外擴"].verdict, "可能");
  // 坍塌：面積大、高度低、體積正常，且自 B16 起逐漸惡化
  const slump = synth({ fx: (b) => { const k = b >= 16 ? (b - 15) * 1.2 : 0; return { da: 14 + k, dh: -13 - k * 0.6 }; } });
  const SL = modes(slump);
  assert.equal(SL.M["錫膏坍塌外擴"].verdict, "可能", JSON.stringify(SL.M["錫膏坍塌外擴"]));
  assert.notEqual(SL.M["錫膏過多"].verdict, "可能");
  // 堵孔：面積比低的 FINE 群組，擦拭後體積逐片下降
  const clog = synth({ fx: (b, p) => p.group === "FINE" ? { dv: -(((b - 1) % 5)) * 6 } : {} });
  const CL = modes(clog);
  assert.equal(CL.M["開孔堵塞"].verdict, "可能", JSON.stringify(CL.M["開孔堵塞"]));
  assert.notEqual(CL.M["擦拭不足／鋼板底面污染"].verdict, "可能");
});

test("失效模式：對位平移、旋轉、伸縮分別被辨識", () => {
  const rows = synth({ fx: (b, p) => b === 5 ? { ox: 70, oy: -40 } : b === 12 ? { ox: -(p.y - 20) * 2.5, oy: (p.x - 30) * 2.5 } : b === 20 ? { ox: (p.x - 30) * 2.2, oy: (p.y - 20) * 2.2 } : {} });
  const { F, M } = modes(rows);
  const al = F.filter((x) => x.sig && x.sig.t === "align");
  assert.deepEqual([...al.map((x) => x.sig.ty)].sort(), ["ro", "sc", "tr"]);
  assert.deepEqual([...al.find((x) => x.sig.ty === "tr").sig.bs], ["B05"]);
  assert.notEqual(M["對位平移"].verdict, "未見跡象");
  assert.notEqual(M["旋轉／伸縮"].verdict, "未見跡象");
});

test("進階分析刮刀比較：資料有方向欄位時依欄位分組（與問題偵測一致）", () => {
  const rows = c.sampleData(), S = st(rows), A = c.analyze(S), V = c.advAnalyze(S, A);
  assert.equal(V.strokeFromField, true);
  assert.deepEqual([...V.strokeLabel], ["方向 前", "方向 後"]);
  const noField = rows.map(({ stroke, ...r }) => r), S2 = st(noField), V2 = c.advAnalyze(S2, c.analyze(S2));
  assert.equal(V2.strokeFromField, false);
});

test("機台規格：群組某量測項目有效值不足 20 筆時沿用全板推估；試產比較整體 Ppk 取最差群組", () => {
  const rows = synth({ nb: 8 }).map((r, i) => ({ ...r, result: "PASS", mNG: false, area: r.group === "FINE" && i % 50 ? null : r.area }));
  const m = c.machineSpecs(rows, st(rows), c.DEF_SPECS);
  assert.deepEqual({ ...m.groups.FINE.area }, { ...m.specs.area }, "FINE 面積有效值不足，沿用全板");
  assert.notDeepEqual({ ...m.groups.FINE.volume }, { ...m.specs.volume }, "FINE 體積有足夠資料，用群組推估");
  const S = st(rows, { specSrc: "machine", specs: m.specs, specsG: m.groups });
  const out = c.compareRuns(S, S, "volume"), all = out.find((x) => x.g === "整體");
  const worst = Math.min(...out.filter((x) => x.g !== "整體").map((x) => x.a.ppk));
  assert.equal(all.a.ppk, worst);
});
