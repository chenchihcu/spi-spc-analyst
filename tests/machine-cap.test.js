// 系統性能力判定：規格過窄時照常判嚴重（規格一律由使用者定義）；高度 % 匯入的鋼板厚度換算
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

test("rescaleHpct：階梯鋼板區域內的焊墊有效厚度不隨基礎厚度變，不換算", () => {
  const st = { stencil: 150, step: { on: true, zones: [{ id: 1, mode: "group", group: "BGA", t: 100 }] } };
  const rows = [{ group: "BGA", height: 100 }, { group: "C", height: 120 }];
  const hp0 = rows.map((r) => r.height / c.padThk(r, { ...st, stencil: 120 }));
  assert.equal(c.rescaleHpct(rows, 120, 150, st), 1);
  assert.deepEqual(rows.map((r) => r.height), [100, 150]);
  assert.deepEqual(rows.map((r) => r.height / c.padThk(r, st)), hp0, "高度 % 每列都不變");
});
