// 大檔效能（RFC：docs/spec-perf-large-dataset-rfc.md）：分析快取、延遲欄位、背景預算打包還原，結果必須與重新計算逐位元相同
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadCore, baseState } = require('./_load.js');

// Set／Map／NaN／±∞ 轉成可比較的字串（JSON 預設會把它們吃掉）
// 用 toString 判斷型別：核心在獨立的 vm 環境執行，其 Set／Map 不是本環境的 instanceof
const tag = (v) => Object.prototype.toString.call(v);
const rep = (k, v) => tag(v) === '[object Set]' ? { __set: [...v] } : tag(v) === '[object Map]' ? { __map: [...v] } : (typeof v === 'number' && !Number.isFinite(v)) ? String(v) : v;
const js = (o) => JSON.stringify(o, rep);

// 多板多焊墊的合成資料：以範例板為底，複製焊墊並加上確定性的擾動
function bigRows(c, nb, npad) {
  const base = c.sampleData(), L = [...new Set(base.map((r) => r.pad))], byPad = {}, rows = [];
  for (const r of base) (byPad[r.pad] = byPad[r.pad] || []).push(r);
  for (let b = 1; b <= nb; b++) for (let k = 0; k < npad; k++) {
    const src = byPad[L[k % L.length]][(b - 1) % 25], rp = Math.floor(k / L.length);
    rows.push({ ...src, board: 'B' + String(b).padStart(3, '0'), pad: src.pad + '#' + rp, x: src.x + (rp % 10) * 60, y: src.y + Math.floor(rp / 10) * 45, volume: src.volume + ((b * 7 + k) % 9) - 4 });
  }
  return rows;
}
// 每個情境各用一份全新的核心（沒有任何快取），當作「重新計算」的對照
const fresh = (rows, extra) => { const c = loadCore(); return { c, st: baseState(c, { rows: rows.map((r) => ({ ...r })), ...extra }) }; };

const CASES = [
  ['範例 A', (c) => c.sampleData(), {}],
  ['階梯鋼板', (c) => c.sampleData(), { step: { on: true, zones: [{ id: 1, name: 'z', mode: 'group', group: 'U2 BGA', t: 100 }] } }],
  ['40 板 × 300 焊墊', (c) => bigRows(c, 40, 300), {}],
];

test('analyze 快取：切換量測項目／群組／管制圖／焊墊／分布模型後，結果與無快取重算逐字相同', () => {
  for (const [name, gen, extra] of CASES) {
    const c = loadCore(), rows = gen(c), st = baseState(c, { rows, ...extra });
    const groups = [c.ALL_GRP, ...new Set(rows.map((r) => r.group))].slice(0, 2), pads = [...new Set(rows.map((r) => r.pad))];
    const seq = [];
    for (const m of ['volume', 'hpct']) for (const g of groups) for (const ch of ['xbars', 'imr', 'p', 'xbarr']) seq.push({ metric: m, group: g, chart: ch, pad: ch === 'imr' ? pads[5] : null });
    seq.push({ metric: 'volume', group: c.ALL_GRP, chart: 'xbars', pad: null, capDistMode: 'boxcox' }, { metric: 'volume', group: c.ALL_GRP, chart: 'ewma', pad: null, capDistMode: 'iso' });
    for (const v of seq) {
      Object.assign(st, v);
      const got = js(c.analyze(st));
      const f = fresh(rows, { ...extra, ...v });
      assert.equal(got, js(f.c.analyze(f.st)), `${name}：${JSON.stringify(v)}`);
    }
  }
});

test('延遲欄位：非常態能力、停機衰減、印刷機補償、空間自相關讀取時才算，值與一次算完相同；可被覆寫', () => {
  const c = loadCore(), st = baseState(c, { rows: c.sampleData() });
  const A = c.analyze(st);
  const d = Object.getOwnPropertyDescriptor(A, 'nonNormal');
  assert.equal(typeof d.get, 'function', '未讀取前是延遲欄位');
  assert.ok(Object.keys(A).includes('spatialAutocorr'), '延遲欄位可列舉（JSON／展開會帶到）');
  const nn = A.nonNormal;
  assert.equal(Object.getOwnPropertyDescriptor(A, 'nonNormal').value, nn, '讀取後存成一般欄位');
  assert.equal(A.cap.nonNormal, nn, 'cap.nonNormal 與 A.nonNormal 為同一份結果');
  A.pauseDecay = 'x'; assert.equal(A.pauseDecay, 'x');
});

test('快取不互相污染：規格改變後分類與能力重算；資料陣列不同不共用', () => {
  const c = loadCore(), rows = c.sampleData(), st = baseState(c, { rows });
  const before = js(c.analyze(st));
  st.specs = JSON.parse(JSON.stringify(st.specs)); st.specs.volume.lsl += 15;
  const changed = js(c.analyze(st));
  assert.notEqual(changed, before);
  const f = fresh(rows, { specs: st.specs });
  assert.equal(changed, js(f.c.analyze(f.st)));
  st.specs.volume.lsl -= 15; assert.equal(js(c.analyze(st)), before, '改回原設定沿用原結果');
});

test('buildStatsData／passFailMatrix／dfmTable 快取結果與重新計算相同，規格改變會失效', () => {
  const c = loadCore(), rows = bigRows(c, 20, 200), st = baseState(c, { rows });
  st.A = c.analyze(st);
  const f = fresh(rows); f.st.A = f.c.analyze(f.st);
  for (let k = 0; k < 2; k++) {
    assert.equal(js(c.buildStatsData(st)), js(f.c.buildStatsData(f.st)));
    assert.equal(js(c.passFailMatrix(st)), js(f.c.passFailMatrix(f.st)));
    assert.equal(js(c.dfmTable(st)), js(f.c.dfmTable(f.st)));
  }
  st.aperture = { groups: { 'U2 BGA': { red: -8 } } };
  const g = fresh(rows, { aperture: st.aperture });
  assert.equal(js(c.dfmTable(st)), js(g.c.dfmTable(g.st)), '開孔設定改變後 DFM 表重算');
});

test('背景預算：打包 → 結構化複製 → 還原後，analyze 結果與同步計算逐字相同', () => {
  for (const [name, gen, extra] of CASES) {
    const c = loadCore(), rows = gen(c), st = baseState(c, { rows, ...extra });
    for (const m of ['area', 'hpct']) for (const ch of ['xbars', 'imr']) {
      // 背景端：拿到的是複製過的資料（與 postMessage 相同）
      const wst = structuredClone({ ...st, metric: m, A: null, F: null });
      const P = structuredClone(c.anWork(wst));
      const view = { ...st, metric: m, chart: ch, pad: null };
      c.anPutKey(rows, c.anKey(view), c.anUnpack(P, view));
      assert.ok(c.anHas(view), `${name} ${m}：已放進快取`);
      Object.assign(st, { metric: m, chart: ch });
      const got = js(c.analyze(st));
      const f = fresh(rows, { ...extra, metric: m, chart: ch });
      assert.equal(got, js(f.c.analyze(f.st)), `${name} ${m} ${ch}`);
      for (const mode of ['johnson', 'iso']) { st.capDistMode = mode; f.st.capDistMode = mode; assert.equal(js(c.analyze(st).nonNormal), js(f.c.analyze(f.st).nonNormal), `${name} ${m} ${mode}`); }
      st.capDistMode = undefined;
    }
  }
});

test('detectIssues 進度回呼：依序回報 11 個階段，且不影響結果', () => {
  const c = loadCore(), rows = c.sampleData();
  const seen = [];
  const a = js(c.detectIssues(baseState(c, { rows: rows.map((r) => ({ ...r })) }), (i, n, t) => seen.push([i, n, t])));
  const b = js(c.detectIssues(baseState(c, { rows: rows.map((r) => ({ ...r })) })));
  assert.equal(a, b);
  assert.deepEqual(seen.map((x) => x[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.ok(seen.every((x) => x[1] === 11 && typeof x[2] === 'string' && x[2]));
  assert.doesNotThrow(() => c.detectIssues(baseState(c, { rows }), () => { throw new Error('回呼錯誤不得中斷偵測'); }));
});

test('效能：4.7 萬筆時切換管制圖／焊墊與回到看過的量測項目都在 80 ms 內，統計清單第二次 ≤ 20 ms', () => {
  const c = loadCore(), st = baseState(c, { rows: bigRows(c, 24, 1986) });
  c.analyze(st);
  const T = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
  st.chart = 'imr'; const tChart = T(() => c.analyze(st));
  st.pad = st.rows[10].pad; const tPad = T(() => c.analyze(st));
  st.metric = 'area'; c.analyze(st); st.metric = 'volume'; const tBack = T(() => c.analyze(st));
  st.A = c.analyze(st); c.buildStatsData(st); const tStats = T(() => c.buildStatsData(st));
  assert.ok(tChart < 80, `切換管制圖 ${tChart.toFixed(0)} ms`);
  assert.ok(tPad < 80, `切換焊墊 ${tPad.toFixed(0)} ms`);
  assert.ok(tBack < 80, `回到看過的量測項目 ${tBack.toFixed(0)} ms`);
  assert.ok(tStats < 20, `統計清單第二次 ${tStats.toFixed(0)} ms`);
});

test('資料指紋（偵測結果快取 key）：同內容相同、忽略衍生的 hpct；任一欄位值或順序改變就不同', () => {
  const c = loadCore(), rows = c.sampleData(), fp = c.rowsFingerprint(rows);
  assert.equal(c.rowsFingerprint(rows.map((r) => ({ ...r }))), fp);
  assert.equal(c.rowsFingerprint(rows.map((r) => ({ ...r, hpct: 1 }))), fp, 'hpct 隨鋼板設定重算，不影響指紋');
  const mut = (fn) => { const x = rows.map((r) => ({ ...r })); fn(x); return c.rowsFingerprint(x); };
  assert.notEqual(mut((x) => { x[5].volume += 0.1; }), fp, '數值改變');
  assert.notEqual(mut((x) => { x[7].pad = 'Z9'; }), fp, '文字改變');
  assert.notEqual(mut((x) => { [x[0], x[1]] = [x[1], x[0]]; }), fp, '列順序改變');
  assert.notEqual(mut((x) => { x.pop(); }), fp, '筆數改變');
  assert.notEqual(mut((x) => { x[3].volume = null; }), fp, '空值');
});

test('效能：群組很多（無封裝欄以位號為群組，200 群組、5.8 萬筆）時問題偵測在 8 秒內（v9.12.0 同資料約 20 秒）', () => {
  const c = loadCore(), base = c.sampleData(), L = [...new Set(base.map((r) => r.pad))], byPad = {}, rows = [];
  for (const r of base) (byPad[r.pad] = byPad[r.pad] || []).push(r);
  for (let b = 1; b <= 10; b++) for (let rp = 0; rp < 50; rp++) for (const pk of L) {
    const src = byPad[pk][(b - 1) % 25];
    rows.push({ ...src, board: 'B' + String(b).padStart(3, '0'), comp: src.comp + '_' + rp, group: src.group + ' #' + rp, pad: src.pad + '#' + rp, x: src.x + (rp % 10) * 60, y: src.y + Math.floor(rp / 10) * 45, volume: src.volume + ((b * 7 + rp) % 9) - 4 });
  }
  const st = baseState(c, { rows });
  assert.equal(new Set(rows.map((r) => r.group)).size, 200);
  const t = performance.now(); const F = c.detectIssues(st); const ms = performance.now() - t;
  assert.ok(F.length > 0);
  assert.ok(ms < 8000, `問題偵測 ${(ms / 1000).toFixed(1)} s（${rows.length} 筆）`);
});
