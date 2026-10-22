// 機台模式：群組規格由該群組 PASS 讀值 min～max 推估時，不可再拿同一份資料判系統性能力不足（自我參照誤報）
// 全部使用合成資料（不含客戶資料）
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadCore, baseState } = require("./_load");

const c = loadCore();
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function gauss(r) { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
// 每個位號自成一個群組（無封裝欄時的推論），每位號 2 焊墊、20 片板、穩定製程、機台全判 PASS
function synth({ nb = 20, ncomp = 60, seed = 11 } = {}) {
  const r = rng(seed), rows = [];
  for (let b = 1; b <= nb; b++) for (let i = 0; i < ncomp; i++) for (let p = 1; p <= 2; p++) {
    const comp = "R" + (i + 1), h = 120 + gauss(r) * 4, a = 100 + gauss(r) * 4;
    rows.push({ board: "B" + String(b).padStart(2, "0"), pad: comp + "-" + p, comp, group: comp, x: 2 + (i % 10) * 4 + p, y: 2 + Math.floor(i / 10) * 4, w: 0.5, d: 0.5, shape: "rect",
      height: +h.toFixed(2), area: +a.toFixed(2), volume: +((h / 120) * a * (1 + gauss(r) * 0.02)).toFixed(2), result: "PASS", mNG: false });
  }
  return rows;
}

test("機台模式＋逐位號群組：推估規格不據以判系統性能力不足（修正前每群組×項目都出卡）", () => {
  const rows = synth(), st0 = baseState(c, { rows });
  const m = c.machineSpecs(rows, st0, c.DEF_SPECS);
  const S = baseState(c, { rows, specSrc: "machine", specs: m.specs, specsG: m.groups });
  const sys = c.detectIssues(S).filter((x) => x.sig && x.sig.t === "sys");
  assert.equal(sys.length, 0, `實得 ${sys.length} 張系統性能力卡`);
});

test("自訂規格模式不受影響：規格過窄時照常判系統性能力嚴重", () => {
  const rows = synth({ ncomp: 4 }), specs = JSON.parse(JSON.stringify(c.DEF_SPECS));
  specs.volume = { lsl: 97, tgt: 100, usl: 103 };
  const S = baseState(c, { rows, specs });
  const sys = c.detectIssues(S).filter((x) => x.sig && x.sig.t === "sys" && x.sig.k === "volume");
  assert.ok(sys.length >= 1 && sys.some((x) => x.lv === "ng"));
});

test("rescaleHpct：µm 高度依厚度比例換算，空值與相同厚度不動", () => {
  const rows = [{ height: 120 }, { height: null }, { height: 60 }];
  assert.equal(c.rescaleHpct(rows, 120, 88), 2);
  assert.deepEqual(rows.map((r) => r.height), [88, null, 44]);
  assert.equal(c.rescaleHpct(rows, 88, 88), 0);
  assert.equal(c.rescaleHpct(rows, 0, 88), 0);
});
