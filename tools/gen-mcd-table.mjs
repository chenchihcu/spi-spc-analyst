// M-18 FastMCD 2D 小樣本門檻校準表：χ²₀.₉₉₉₉(2)=18.42 只在 n 很大時成立，
// 小樣本（焊墊群組常只有 30–100 個焊墊）的穩健 d² 尾部較重，固定 18.42 會讓每點誤報達名目的 25–50 倍。
// 本工具以 i.i.d. 雙變量常態模擬，求 fastMcd2D 回傳之 d² 的 1−10⁻⁴ 分位數，產出內嵌於 spi-spc.html 的 MCD_THR 表；
// 另以獨立 seed 的 holdout 自檢每點誤報 ≈ 10⁻⁴。
// 用法：node tools/gen-mcd-table.mjs [--points 1200000] [--output tools/mcd-threshold-table.json]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mulberry32, makeNormal } from './gen-stable.mjs';

const require = createRequire(import.meta.url);
const { loadCore } = require('../tests/_load.js');

export const MCD_TABLE_N = [30, 32, 35, 40, 45, 50, 60, 70, 80, 100, 125, 150, 200, 300, 400, 600];
const ALPHA = 1e-4;
const CHI2_09999 = 18.42068;

function d2Pool(core, n, points, seed) {
  const u = mulberry32(seed), N = makeNormal(u);
  const runs = Math.ceil(points / n), out = new Float64Array(runs * n);
  let j = 0;
  for (let k = 0; k < runs; k++) {
    const r = core.fastMcd2D(Array.from({ length: n }, () => [N(), N()]));
    for (const v of r.d2) out[j++] = v;
  }
  return out;
}

export function buildMcdTable({ points = 1200000 } = {}) {
  const core = loadCore();
  const rows = [];
  for (const n of MCD_TABLE_N) {
    const cal = d2Pool(core, n, points, 1000 + n);
    cal.sort();
    const thr = cal[Math.floor(cal.length * (1 - ALPHA))];
    const hold = d2Pool(core, n, points / 2, 7000 + n);
    let fp = 0;
    for (const v of hold) if (v > thr) fp++;
    rows.push({ n, thr, holdoutFp: fp / hold.length });
    console.log(`n=${String(n).padStart(3)} thr=${thr.toFixed(2)} holdout 每點誤報=${(fp / hold.length).toExponential(2)}（名目 1e-4）`);
  }
  // 蒙地卡羅雜訊可能讓相鄰格點不單調；門檻隨 n 增加只會下降且不低於 χ² 漸近值
  for (let i = rows.length - 2; i >= 0; i--) rows[i].thr = Math.max(rows[i].thr, rows[i + 1].thr);
  for (const r of rows) r.thr = +Math.max(r.thr, CHI2_09999).toFixed(2);
  return { alpha: ALPHA, chi2: CHI2_09999, points, rows };
}

if (process.argv[1] && process.argv[1].endsWith('gen-mcd-table.mjs')) {
  const args = process.argv.slice(2);
  const getArg = (name, dflt) => {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : dflt;
  };
  const outPath = getArg('--output', path.join(import.meta.dirname, 'mcd-threshold-table.json'));
  const table = buildMcdTable({ points: +getArg('--points', 1200000) });
  fs.writeFileSync(outPath, JSON.stringify(table, null, 2) + '\n', 'utf8');
  console.log(`Saved table to ${outPath}`);
  console.log(`const MCD_THR_N=[${table.rows.map(r => r.n).join(',')}];`);
  console.log(`const MCD_THR=[${table.rows.map(r => r.thr).join(',')}];`);
}
