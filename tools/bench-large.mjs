// 大檔效能基準（docs/spec-perf-large-dataset-rfc.md P0）：node tools/bench-large.mjs
// 以範例板為底合成三種約 4.7 萬筆的資料形狀，列出 analyze／detectIssues／統計清單等核心計算的耗時（Node，不含畫面繪製）
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadCore, baseState } = require('../tests/_load.js');

function bigRows(c, nb, npad) {
  const base = c.sampleData(), L = [...new Set(base.map((r) => r.pad))], byPad = {}, rows = [];
  for (const r of base) (byPad[r.pad] = byPad[r.pad] || []).push(r);
  for (let b = 1; b <= nb; b++) for (let k = 0; k < npad; k++) {
    const src = byPad[L[k % L.length]][(b - 1) % 25], rp = Math.floor(k / L.length);
    rows.push({ ...src, board: 'B' + String(b).padStart(4, '0'), pad: src.pad + '#' + rp, x: src.x + (rp % 10) * 60, y: src.y + Math.floor(rp / 10) * 45, volume: src.volume + ((b * 7 + k) % 9) - 4 });
  }
  return rows;
}
const T = (fn) => { const t = performance.now(); fn(); return +(performance.now() - t).toFixed(1); };

const out = [];
for (const [nb, np] of [[24, 1986], [100, 477], [410, 116]]) {
  const c = loadCore(), st = baseState(c, { rows: bigRows(c, nb, np) });
  const r = { 形狀: `${nb} 板 × ${np} 焊墊`, 筆數: st.rows.length };
  r['analyze 首次'] = T(() => c.analyze(st));
  r['analyze 相同設定'] = T(() => c.analyze(st));
  st.chart = 'imr'; r['切換管制圖'] = T(() => c.analyze(st));
  st.metric = 'area'; r['切換量測項目（首次）'] = T(() => c.analyze(st));
  st.metric = 'volume'; r['切回看過的量測項目'] = T(() => c.analyze(st));
  const A = c.analyze(st); st.A = A;
  r['讀非常態能力'] = T(() => A.nonNormal);
  r['統計清單 首次'] = T(() => c.buildStatsData(st));
  r['統計清單 再次'] = T(() => c.buildStatsData(st));
  r['detectIssues'] = T(() => c.detectIssues(st));
  out.push(r);
}
console.table(out);
