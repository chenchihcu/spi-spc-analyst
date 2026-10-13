// 統計核心單元測試：已知答案比對 + 範例資料的偵測結果
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadCore, baseState } = require("./_load");

const c = loadCore();
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} 期望 ${b}，實得 ${a}`);

test("c4 常數與教科書值一致", () => {
  near(c.c4(5), 0.94, 0.0001, "c4(5)");
  near(c.c4(10), 0.9727, 0.0001, "c4(10)");
});

test("t 分布雙尾 p 值與教科書值一致", () => {
  near(c.tP(2.064, 24), 0.05, 0.001, "t=2.064, df=24");
  near(c.tP(2.228, 10), 0.05, 0.001, "t=2.228, df=10");
});

test("Welch t 檢定對明顯差異給出小 p 值", () => {
  const r = c.welch([10, 11, 12, 10, 11, 12], [20, 21, 19, 20, 22, 21]);
  assert.ok(r.p < 0.001);
});

test("Nelson 規則 1：超出 3σ 的點被標出", () => {
  const z = Array(20).fill(0.2);
  z[7] = 3.4;
  const n = c.nelson(z);
  assert.deepEqual([...n.rules.find((r) => r.id === 1).idx], [7]); // 轉成本環境陣列再比對（核心在獨立 vm 環境執行）
});

test("Anderson-Darling：常態資料 p 不應過小", () => {
  const xs = [];
  for (let i = 1; i <= 200; i++) xs.push(Math.sqrt(2) * erfinv((2 * i) / 201 - 1));
  assert.ok(c.andersonDarling(xs).p > 0.2);
});

test("對位分解還原已知的旋轉角度", () => {
  const rows = [];
  for (let x = 0; x <= 60; x += 10) for (let y = 0; y <= 40; y += 10)
    rows.push({ x, y, offx: 20 - 1.5 * (y - 20), offy: -5 + 1.5 * (x - 30) });
  const a = c.alignFit(rows);
  near(a.th, 1.5, 0.01, "θ (µm/mm)");
  near(a.tx, 20, 0.01, "平移 X");
});

test("面積比：IPC-7525 公式（矩形與圓形）", () => {
  const st = baseState(c);
  near(c.areaRatio({ w: 0.4, d: 1.5, shape: "rect", group: "g" }, st), 0.6 / (2 * 1.9 * 0.12), 1e-9, "矩形");
  near(c.areaRatio({ w: 0.55, d: 0.55, shape: "round", group: "g" }, st), 0.55 / (4 * 0.12), 1e-9, "圓形");
  near(c.maxThkForAR({ w: 0.2, d: 1.0, shape: "rect", group: "g" }, st), (0.2 / (2 * 1.2 * 0.66)) * 1000, 1e-6, "AR 0.66 最大厚度");
});

test("問題偵測：範例資料埋入的 8 種問題全部抓到", () => {
  const F = c.detectIssues(baseState(c, { rows: c.sampleData() }));
  const t = F.map((x) => x.title).join("\n");
  for (const re of [/B13 的 U2 BGA/, /U2 BGA 面積比合格但轉移效率偏低/, /持續下降/, /B09 整板平移/, /B21 旋轉/, /沿 X 方向有梯度/, /隨擦拭後片數上升/, /行程有差異/])
    assert.match(t, re);
});

test("問題偵測：純雜訊資料不誤報", () => {
  let a = 7;
  const rnd = () => ((a = (a * 16807) % 2147483647) / 2147483647);
  const g = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(6.283 * rnd());
  const rows = [];
  for (let b = 1; b <= 25; b++) for (let p = 0; p < 80; p++) {
    const h = 120 + g() * 5, ar = 100 + g() * 5;
    rows.push({ board: "B" + String(b).padStart(2, "0"), pad: "P" + p, group: p < 40 ? "A" : "B", x: (p % 10) * 5, y: Math.floor(p / 10) * 4, w: 0.6, d: 0.6, shape: "rect",
      height: h, area: ar, volume: (h / 120) * ar, offx: g() * 12, offy: g() * 12 });
  }
  assert.equal(c.detectIssues(baseState(c, { rows })).length, 0);
});

test("試產比較：改版 B 相對 A 判為改善", () => {
  const A = baseState(c, { rows: c.sampleData() });
  const B = baseState(c, { rows: c.sampleData({ variant: "B" }), aperture: { groups: { "U2 BGA": { red: -8 } } } });
  const R = c.compareRuns(A, B, "volume");
  assert.equal(R.find((x) => x.g === "整體").verdict, "改善");
  assert.equal(R.find((x) => x.g === "U2 BGA").verdict, "改善");
});

test("DFM：U2 BGA 為最高風險，建議圓形改圓角方形", () => {
  const D = c.dfmTable(baseState(c, { rows: c.sampleData() }));
  assert.equal(D[0].g, "U2 BGA");
  assert.ok(D[0].acts.some((a) => /圓角方形/.test(a.act)));
});

test("匯入：PHME 格式拼板子板與偏移 % 換算", () => {
  const P = c.parseCSV(c.samplePhmeCSV());
  assert.equal(P.info.panels, 8);
  assert.equal(P.info.figures, 4);
  assert.equal(P.rows[0].board, "PN001-1");
  const issues = c.detectIssues(baseState(c, { rows: P.rows }));
  assert.ok(issues.every((x) => x.cat === "子板位置"), "只應列出子板位置效應");
});

test("DOE：找出刮刀壓力與印刷速度為顯著因子", () => {
  const D = c.doeAnalyze(baseState(c, { rows: c.sampleData({ variant: "DOE" }) }), "vol");
  const p = Object.fromEntries(D.eff.map((e) => [e.k, e.p]));
  assert.ok(p.pressure < 0.01 && p.speed < 0.05);
});

test("GR&R：範例資料 %GRR 與 ndc 在合理範圍", () => {
  const st = baseState(c, { rows: c.sampleData() });
  const g = c.parseGRR(c.sampleGRR(st));
  const r = c.grrAnalyze(g.rows, "volume", 60);
  assert.ok(r.pctTV > 5 && r.pctTV < 20, `%GRR ${r.pctTV}`);
  assert.ok(r.ndc >= 5);
});

// 反誤差函數（Giles 近似），用來產生常態分位數
function erfinv(x) {
  let w = -Math.log((1 - x) * (1 + x)), p;
  if (w < 5) { w -= 2.5; p = 2.81022636e-8; for (const k of [3.43273939e-7, -3.5233877e-6, -4.39150654e-6, 0.00021858087, -0.00125372503, -0.00417768164, 0.246640727, 1.50140941]) p = k + p * w; }
  else { w = Math.sqrt(w) - 3; p = -0.000200214257; for (const k of [0.000100950558, 0.00134934322, -0.00367342844, 0.00573950773, -0.0076224613, 0.00943887047, 1.00167406, 2.83297682]) p = k + p * w; }
  return p * x;
}

test("誤報率與偵測力：60 組無異常資料警示以上 ≤ 6%；10 組種子埋入問題全部抓到", () => {
  const lay = c.sampleData().filter((x) => x.board === "B01");
  const gm = { "U1 QFP": [120, 100], "U2 BGA": [113, 91], "C 0402": [120, 100], "R 0603": [124, 103] };
  const clean = (seed) => { let a = seed; const u = () => ((a = (a * 16807) % 2147483647) / 2147483647), g = () => Math.sqrt(-2 * Math.log(u() || 1e-9)) * Math.cos(6.2832 * u()); const rows = [];
    for (let b = 1; b <= 25; b++) for (const p of lay) { const [hm, am] = gm[p.group]; const h = hm + g() * 5.2, ar = am + g() * 5.5; rows.push({ ...p, board: "B" + String(b).padStart(2, "0"), stroke: undefined, height: h, area: ar, volume: (h / 120) * ar * (1 + g() * 0.025), offx: g() * 13, offy: g() * 13 }); }
    return rows; };
  let warn = 0;
  for (let s = 1; s <= 60; s++) if (c.detectIssues(baseState(c, { rows: clean(1000 + s * 7919) })).some((x) => x.lv !== "info" && x.cat !== "設計 DFM" && x.cat !== "系統性能力")) warn++;
  assert.ok(warn <= 4, `警示以上誤報 ${warn}/60`);
  const keys = [/B13 的 U2 BGA/, /B09 整板平移/, /B21 旋轉/, /持續下降/, /沿 X 方向有梯度/, /隨擦拭後片數上升/, /行程有差異/, /U2 BGA 面積比合格但轉移效率偏低/];
  for (let s = 1; s <= 10; s++) { const t = c.detectIssues(baseState(c, { rows: c.sampleData({ seed: 20261013 + s * 104729 }) })).map((x) => x.title).join("\n"); for (const re of keys) assert.match(t, re, `種子 ${s}`); }
});

test("效能：5 萬筆資料的分析與問題偵測各在 3 秒內", () => {
  const base = c.sampleData().filter((x) => x.board === "B01"), rows = [];
  for (let b = 1; b <= 100; b++) for (let k = 0; k < 500; k++) { const p = base[k % base.length]; rows.push({ ...p, board: "B" + String(b).padStart(3, "0"), pad: p.pad + "#" + Math.floor(k / base.length), volume: p.volume + ((b * 7 + k) % 9) - 4 }); }
  const st = baseState(c, { rows }); let t = Date.now(); c.analyze(st); assert.ok(Date.now() - t < 3000, "analyze"); t = Date.now(); c.detectIssues(st); assert.ok(Date.now() - t < 3000, "detectIssues");
});
