import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadCore, baseState } = require('../tests/_load.js');

export function mulberry32(a) {
  return function() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function makeNormal(u) {
  let spare = null;
  return function() {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let a, b;
    do { a = u(); } while (a === 0);
    b = u();
    const r = Math.sqrt(-2 * Math.log(a));
    spare = r * Math.sin(2 * Math.PI * b);
    return r * Math.cos(2 * Math.PI * b);
  };
}

let cachedPads = null;
export function getTemplatePads() {
  if (cachedPads) return cachedPads;
  const core = loadCore();
  const sample = core.sampleData({ variant: 'A' });
  cachedPads = sample
    .filter(r => r.board === 'B01')
    .map(({ board, stroke, height, area, volume, offx, offy, hpct, ...p }) => p);
  return cachedPads;
}

export function generateStableData({ nb = 25, shift = 0, stroke = true, seed = 1 } = {}) {
  const u = mulberry32(seed);
  const n = makeNormal(u);
  const pads = getTemplatePads();
  const rows = [];

  for (let b = 1; b <= nb; b++) {
    const eh = 1 * n();
    const ea = 1 * n();
    const ex = 2 * n();
    const ey = 2 * n();
    const shiftB = b > nb - 8 ? shift : 0;

    for (const p of pads) {
      const h = 120 + eh + 3.5 * n();
      const a = 100 + ea + shiftB + 4 * n();
      const v = (h / 120) * a * (1 + 0.025 * n());
      const offx = ex + 10 * n();
      const offy = ey + 10 * n();

      const r = {
        ...p,
        board: 'B' + String(b).padStart(2, '0'),
        height: +h.toFixed(1),
        area: +a.toFixed(1),
        volume: +v.toFixed(1),
        offx: +offx.toFixed(1),
        offy: +offy.toFixed(1)
      };
      if (stroke) {
        r.stroke = b % 2 ? '前' : '後';
      } else {
        delete r.stroke;
      }
      rows.push(r);
    }
  }
  return rows;
}

export function rowsToCsv(rows) {
  const headers = ['板號', '元件位號', '焊墊', '元件群組', 'x', 'y', 'padl', 'padw', '刮刀方向', '高度', '面積', '體積', 'offsetx', 'offsety'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    const line = [
      r.board,
      r.comp || '',
      r.pad,
      r.group,
      r.x,
      r.y,
      r.w,
      r.d,
      r.stroke || '',
      r.height,
      r.area,
      r.volume,
      r.offx,
      r.offy
    ].join(',');
    lines.push(line);
  }
  return lines.join('\n');
}

export function buildStableTable({ sampleCount = 1000 } = {}) {
  const core = loadCore();
  const boardCounts = [10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200];
  const MS = ['volume', 'hpct', 'area', 'offx', 'offy'];
  const specs = core.DEF_SPECS;
  const table = {};

  for (const nb of boardCounts) {
    let isoDatasetHits = 0;
    const nelsonDatasetHits = {};
    const nelsonChartHits = {};
    for (let r = 1; r <= 8; r++) {
      nelsonDatasetHits[r] = 0;
      nelsonChartHits[r] = 0;
    }
    let anyNelson28DatasetHits = 0;
    let anyNelson28ChartHits = 0;
    const totalCharts = sampleCount * MS.length;

    for (let s = 1; s <= sampleCount; s++) {
      const rows = generateStableData({ nb, shift: 0, stroke: true, seed: s });
      for (const r of rows) r.hpct = +(r.height / 120 * 100).toFixed(1);

      const byB = new Map();
      const byG = new Map();
      for (const r of rows) {
        let b = byB.get(r.board); if (!b) byB.set(r.board, b = []); b.push(r);
        let g = byG.get(r.group); if (!g) byG.set(r.group, g = []); g.push(r);
      }
      const boards = [...byB.keys()];

      let datasetHasIso = false;
      let datasetHasAny28 = false;
      const triggeredRulesInDataset = new Set();

      for (const k of MS) {
        const sp = specs[k];
        const span = sp.usl - sp.lsl;

        // D-30 candidate screen: at least one candidate relying ONLY on |z| >= 5 (not out-of-spec)
        if (!datasetHasIso) {
          for (const rs of byG.values()) {
            const n = rs.length;
            if (n < 10) continue;
            const v = new Float64Array(n);
            for (let i = 0; i < n; i++) v[i] = rs[i][k];
            v.sort();
            const med = n % 2 ? v[n >> 1] : (v[(n >> 1) - 1] + v[n >> 1]) / 2;
            const ad = new Float64Array(n);
            for (let i = 0; i < n; i++) ad[i] = Math.abs(v[i] - med);
            ad.sort();
            const mad = n % 2 ? ad[n >> 1] : (ad[(n >> 1) - 1] + ad[n >> 1]) / 2;
            let res = Infinity;
            for (let j = 1; j < n; j++) {
              const d = v[j] - v[j - 1];
              if (d > 1e-9 && d < res) res = d;
            }
            if (!isFinite(res)) res = 0;
            let sg = 1.4826 * mad;
            if (!(mad > 0)) {
              let sumAd = 0;
              for (let i = 0; i < n; i++) sumAd += ad[i];
              sg = 1.2533 * (sumAd / n);
            }
            sg = Math.max(sg, res / Math.sqrt(12));
            const eff = Math.max(0.1 * span, 3 * res);
            for (let i = 0; i < n; i++) {
              const x = v[i];
              const over = x < sp.lsl || x > sp.usl;
              if (!over && Math.abs(x - med) / sg >= 5 && Math.abs(x - med) >= eff) {
                datasetHasIso = true;
                break;
              }
            }
            if (datasetHasIso) break;
          }
        }

        // Nelson rules on X-bar chart (group = ALL)
        const bm = new Float64Array(boards.length);
        for (let bi = 0; bi < boards.length; bi++) {
          const rs = byB.get(boards[bi]);
          let sum = 0;
          for (let i = 0; i < rs.length; i++) sum += rs[i][k];
          bm[bi] = sum / rs.length;
        }
        let sumBm = 0;
        for (let bi = 0; bi < bm.length; bi++) sumBm += bm[bi];
        const mu = sumBm / bm.length;
        let mrSum = 0;
        for (let bi = 1; bi < bm.length; bi++) mrSum += Math.abs(bm[bi] - bm[bi - 1]);
        const sB = (mrSum / (bm.length - 1)) / 1.128;
        const z = Array.from(bm, x => (x - mu) / sB);
        const nel = core.nelson(z);

        let chartHasAny28 = false;
        for (const r of nel.rules) {
          if (r.idx.length && r.id !== 7) {
            triggeredRulesInDataset.add(r.id);
            nelsonChartHits[r.id]++;
            if (r.id >= 2 && r.id <= 8) {
              datasetHasAny28 = true;
              chartHasAny28 = true;
            }
          }
        }
        if (chartHasAny28) anyNelson28ChartHits++;
      }

      if (datasetHasIso) isoDatasetHits++;
      if (datasetHasAny28) anyNelson28DatasetHits++;
      for (const rId of triggeredRulesInDataset) {
        nelsonDatasetHits[rId]++;
      }
    }

    table[nb] = {
      nb,
      iso_z5_rate: +(isoDatasetHits / sampleCount).toFixed(4),
      nelson_rule_rates: Object.fromEntries(
        Object.entries(nelsonDatasetHits).map(([k, v]) => [k, +(v / sampleCount).toFixed(4)])
      ),
      nelson_rules_2_8_any_rate: +(anyNelson28DatasetHits / sampleCount).toFixed(4),
      nelson_single_rule_rates: Object.fromEntries(
        Object.entries(nelsonChartHits).map(([k, v]) => [k, +(v / totalCharts).toFixed(4)])
      ),
      nelson_single_2_8_any_rate: +(anyNelson28ChartHits / totalCharts).toFixed(4)
    };
  }
  return table;
}

if (process.argv[1] && process.argv[1].endsWith('gen-stable.mjs')) {
  const args = process.argv.slice(2);
  const getArg = (name, dflt) => {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : dflt;
  };

  if (args.includes('--table')) {
    const outPath = getArg('--output', path.join(import.meta.dirname, 'gen-stable-table.json'));
    const count = +getArg('--count', 1000);
    console.log(`Building stable table with ${count} iterations per board count...`);
    const table = buildStableTable({ sampleCount: count });
    fs.writeFileSync(outPath, JSON.stringify(table, null, 2) + '\n', 'utf8');
    console.log(`Saved table to ${outPath}`);
  } else {
    const nb = +getArg('--nb', 25);
    const shift = +getArg('--shift', 0);
    const seed = +getArg('--seed', 1);
    const outPath = getArg('--output', null);
    const rows = generateStableData({ nb, shift, stroke: true, seed });
    const csv = rowsToCsv(rows);
    if (outPath) {
      fs.writeFileSync(outPath, csv + '\n', 'utf8');
      console.log(`Saved ${rows.length} rows to ${outPath}`);
    } else {
      process.stdout.write(csv + '\n');
    }
  }
}
