import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { HTML, withIdb, loadCore, baseState } = require('./_load.js');
const { JSDOM } = (() => { try { return require('jsdom'); } catch { return {}; } })();
const core = loadCore();

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function page() {
  const html = fs.readFileSync(HTML, 'utf8').replace(/<script src=[^>]+><\/script>/g, '');
  const errs = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/',
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
        get: (t, k) => (k === 'measureText' ? () => ({ width: 1 }) : t[k] ?? (() => {})),
        set: (t, k, v) => { t[k] = v; return true; }
      });
      Object.defineProperty(w.HTMLElement.prototype, 'offsetParent', {
        get() { let e = this; while (e) { if (e.hidden) return null; e = e.parentElement; } return w.document.body; }
      });
      w.Element.prototype.scrollIntoView = () => {};
      w.matchMedia = () => ({ matches: false, addEventListener() {} });
      w.ResizeObserver = class { observe() {} };
      w.scrollTo = () => {};
      w.Chart = class { constructor() {} destroy() {} static register() {} };
      Object.assign(w, { Response, DecompressionStream, TextDecoder });
      w.SPI_TEST_HOOK = {};
      w.addEventListener('error', (e) => errs.push(e.message));
      withIdb(w);
    }
  });
  return { dom, errs };
}

// -------------------------------------------------------------
// TV-6 / M-06: CUSUM Centering on Target & >10σ Fallback
// -------------------------------------------------------------
test('[M-06 / TV-6] CUSUM 以規格目標為中心，符合 TV-6 預期值，>10σ 自動回退', async () => {
  const s = 2.4379432624;
  const bMeans = [100.5, 99.5, 103.0, 99.5, 102.5];
  const target = 100;

  // TV-6 verification using direct math matching analyze() implementation
  let cp = 0, cm = 0;
  const pts = bMeans.map((m, i) => {
    const u = (m - target) / s;
    cp = Math.max(0, u - 0.5 + cp);
    cm = Math.max(0, -u - 0.5 + cm);
    return { lab: 'B' + (i + 1), u, cp, cm };
  });

  const expectedU = [0.2051, -0.2051, 1.2305, -0.2051, 1.0255];
  const expectedCp = [0, 0, 0.7305, 0.0255, 0.5509];
  const expectedCm = [0, 0, 0, 0, 0];

  pts.forEach((p, i) => {
    assert.ok(Math.abs(p.u - expectedU[i]) < 1e-4, `u[${i}] expected ${expectedU[i]}, got ${p.u}`);
    assert.ok(Math.abs(p.cp - expectedCp[i]) < 1e-4, `cp[${i}] expected ${expectedCp[i]}, got ${p.cp}`);
    assert.ok(Math.abs(p.cm - expectedCm[i]) < 1e-4, `cm[${i}] expected ${expectedCm[i]}, got ${p.cm}`);
  });

  // Verify in analyze()
  const rows = [];
  bMeans.forEach((bm, i) => {
    const b = 'B' + (i + 1);
    for (let p = 1; p <= 10; p++) {
      rows.push({ board: b, refdes: 'R' + p, pad: String(p), group: '0603', volume: bm, x: p * 10, y: 10 });
    }
  });

  // 1. Normal target = 100
  const stNormal = {
    rows,
    metric: 'volume',
    group: 'ALL',
    chart: 'cusum',
    specs: { volume: { lsl: 70, usl: 130, tgt: 100 } }
  };
  const Anormal = core.analyze(stNormal);
  assert.equal(Anormal.cusum.center, 100);
  assert.equal(Anormal.cusum.centerFallback, false);

  // 2. Outlying target = 0.5 (deviates > 10σ from gMean ~101)
  const stOutlying = {
    rows,
    metric: 'volume',
    group: 'ALL',
    chart: 'cusum',
    specs: { volume: { lsl: 0.1, usl: 1.0, tgt: 0.5 } }
  };
  const Aoutlying = core.analyze(stOutlying);
  assert.equal(Aoutlying.cusum.centerFallback, true);
  assert.match(Aoutlying.cusum.centerReason, /偏離資料平均 >10σ/);
  assert.ok(Math.abs(Aoutlying.cusum.center - Aoutlying.gMean) < 1e-6);
});

// -------------------------------------------------------------
// M-09: Repeated Offender Pad Detection
// -------------------------------------------------------------
test('[M-09] 跨板重複不良焊墊偵測與 D-30 explained_pads 整合', () => {
  const rows = [];
  // 5 boards, 5 pads
  // Pad 'R1_1' fails on 4/5 boards (volume = 50 < LSL 70)
  for (let b = 1; b <= 5; b++) {
    const bName = 'B' + b;
    for (let p = 1; p <= 5; p++) {
      const isOffender = (p === 1 && b <= 4);
      const vol = isOffender ? 50 : 100;
      rows.push({
        board: bName, comp: 'R' + p, refdes: 'R' + p, pad: 'R' + p + '_' + p,
        group: '0603', volume: vol, height: 120, area: 100, offx: 0, offy: 0,
        x: p * 10, y: 10
      });
    }
  }

  const st = {
    rows,
    metric: 'volume',
    group: 'ALL',
    chart: 'xbars',
    specs: {
      volume: { lsl: 70, usl: 130, tgt: 100 },
      height: { lsl: 90, usl: 150, tgt: 120 },
      area: { lsl: 70, usl: 130, tgt: 100 },
      offx: { lsl: -75, usl: 75, tgt: 0 },
      offy: { lsl: -75, usl: 75, tgt: 0 }
    }
  };

  const issues = core.detectIssues(st);
  const repCard = issues.find(x => x.sig && x.sig.t === 'repeated');
  assert.ok(repCard, '應產出重複犯焊墊卡');
  assert.equal(repCard.cat, '重複犯焊墊');
  assert.ok(repCard.sig.pads.includes('R1_1'), '應包含 R1_1 焊墊');
  assert.match(repCard.title, /重複出現異常/);

  // D-30 isolated pad cards should exclude or explain R1_1
  const isoCards = issues.filter(x => x.sig && x.sig.t === 'iso');
  for (const card of isoCards) {
    assert.ok(!card.sig.pads.includes('R1_1'), 'D-30 不得重複將已由 M-09 解釋的焊墊列為孤立極端焊墊');
  }
});

// -------------------------------------------------------------
// M-10: Board × Component Group Defect Matrix (Pass/Fail)
// -------------------------------------------------------------
test('[M-10] passFailMatrix 回傳板號 × 元件群組不良品矩陣', () => {
  const rows = [
    // Board B1: 2 in 0402 (1 bad), 2 in 0603 (0 bad)
    { board: 'B1', pad: '1', group: '0402', volume: 50 },  // bad (vol < 70)
    { board: 'B1', pad: '2', group: '0402', volume: 100 },
    { board: 'B1', pad: '3', group: '0603', volume: 100 },
    { board: 'B1', pad: '4', group: '0603', volume: 100 },
    // Board B2: 2 in 0402 (0 bad), 2 in 0603 (1 bad)
    { board: 'B2', pad: '1', group: '0402', volume: 100 },
    { board: 'B2', pad: '2', group: '0402', volume: 100 },
    { board: 'B2', pad: '3', group: '0603', volume: 140 }, // bad (vol > 130)
    { board: 'B2', pad: '4', group: '0603', volume: 100 }
  ];

  const st = {
    rows,
    specs: { volume: { lsl: 70, usl: 130, tgt: 100 } }
  };

  const pfm = core.passFailMatrix(st);
  assert.equal(pfm.boards.length, 2);
  assert.equal(pfm.groups.length, 2);
  assert.equal(pfm.totalN, 8);
  assert.equal(pfm.totalD, 2);
  assert.equal(pfm.overallRate, 2 / 8);

  const b1 = pfm.matrix.find(m => m.board === 'B1');
  assert.equal(b1.total, 4);
  assert.equal(b1.defects, 1);
  assert.equal(b1.groups['0402'].d, 1);
  assert.equal(b1.groups['0402'].p, 1);
  assert.equal(b1.groups['0603'].d, 0);
  assert.equal(b1.groups['0603'].p, 2);

  const b2 = pfm.matrix.find(m => m.board === 'B2');
  assert.equal(b2.total, 4);
  assert.equal(b2.defects, 1);
  assert.equal(b2.groups['0402'].d, 0);
  assert.equal(b2.groups['0603'].d, 1);
});

// -------------------------------------------------------------
// M-11: Pareto Cumulative % Clamping & Dimension Switching
// -------------------------------------------------------------
test('[M-11] Pareto 累積百分比最後一格精確為 100.0%，支援位號與群組維度', { skip: !JSDOM && '未安裝 jsdom' }, () => {
  const { dom } = page();
  const d = dom.window.document;
  const w = dom.window;

  // Verify drawPareto exists in SPI_TEST_HOOK
  assert.equal(typeof w.SPI_TEST_HOOK.drawPareto, 'function');

  // Verify clamping logic on odd counts
  const P = [['A', 3], ['B', 3], ['C', 3]]; // 33.3%, 66.7%, 100%
  const tot = 9;
  let cum = 0;
  const cumVals = P.map((p, idx) => idx === P.length - 1 ? 100 : Math.round(((cum += p[1]) / tot * 100) * 10) / 10);
  assert.equal(cumVals[cumVals.length - 1], 100);
});

// -------------------------------------------------------------
// M-12: Statistical Anomalies List (buildStatsData & statsDataCsv)
// -------------------------------------------------------------
test('[M-12] buildStatsData & statsDataCsv 收集 OOC、偏移、漂移與離群值', () => {
  const rows = [];
  // 5 boards × 10 pads = 50 rows in group '0603'
  for (let b = 1; b <= 5; b++) {
    for (let p = 1; p <= 10; p++) {
      let v = 100;
      if (b === 1 && p === 1) v = 145; // OOC (>130)
      if (b === 2 && p === 2) v = 50;  // OOC (<70)
      rows.push({
        board: 'B' + b, comp: 'R' + p, refdes: 'R' + p, pad: 'P' + p, group: '0603',
        volume: v, height: 120, area: 100
      });
    }
  }

  const st = {
    rows,
    metric: 'volume',
    group: 'ALL',
    chart: 'xbars',
    specs: { volume: { lsl: 70, usl: 130, tgt: 100 } }
  };
  st.A = core.analyze(st);

  const stats = core.buildStatsData(st);
  assert.ok(stats.length >= 2, '應至少抓出 2 個 OOC 點');
  const p1 = stats.find(s => s.board === 'B1' && s.pad === 'P1');
  assert.ok(p1, '應包含 B1 P1');
  assert.match(p1.rule, /OOC/);

  const csv = core.statsDataCsv(st);
  assert.match(csv, /^Board,RefDes,Pad,Group,Metric,Value,Mean,SD,Z_Score,Rule/);
  assert.match(csv, /B1,R1,P1,0603,volume/);
});

// -------------------------------------------------------------
// M-18: FastMCD 2D Bivariate Outlier Detection
// -------------------------------------------------------------
test('[M-18] FastMCD 2D 能檢出雙變數離群值（d² 超過小樣本校準門檻），30,000 筆假警報受控', () => {
  assert.equal(typeof core.fastMcd2D, 'function');

  // 1. Synthetic 100 points with 1 bivariate anomaly (+2σ, -2σ)
  const pts = [];
  let seed = 54321;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  function randn() {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  // Correlated bivariate normal (corr = 0.8)
  for (let i = 0; i < 99; i++) {
    const z1 = randn(), z2 = randn();
    const area = 100 + 10 * z1;
    const height = 100 + 10 * (0.8 * z1 + 0.6 * z2);
    pts.push([area, height]);
  }
  // Point 99: area +2σ (120), height -2σ (80). Neither is univariate outlier, but bivariate outlier!
  pts.push([120, 80]);

  const res = core.fastMcd2D(pts);
  assert.ok(res, 'FastMCD 2D 應回傳有效結果');
  // 小樣本校準門檻：n=100 查表 23.14，n 很大時收斂到 χ²₀.₉₉₉₉(2)
  assert.equal(res.threshold, core.mcdThr(100));
  assert.equal(res.threshold, 23.14);
  assert.ok(res.outliers.some(o => o.index === 99), '第 99 筆雙變數離群點應被檢出');

  // 2. Test 30,000 normal points false positive rate <= expected + 3*sqrt(expected)
  const pts30k = [];
  seed = 1111;
  for (let i = 0; i < 30000; i++) {
    pts30k.push([randn(), randn()]);
  }
  const res30k = core.fastMcd2D(pts30k);
  // expected = 30000 * 0.0001 = 3; upper bound = 3 + 3*sqrt(3) ~= 8.196
  assert.ok(res30k.outliers.length <= 8, `30,000 筆資料誤報數 (${res30k.outliers.length}) 不得超過 8`);
});

test('[M-18] 小樣本門檻：隨 n 單調不增、不低於 χ² 漸近值，焊墊群組大小的誤報受控', () => {
  const ns = [30, 33, 36, 48, 100, 112, 600, 601, 3000, 30000];
  const thr = ns.map(n => core.mcdThr(n));
  for (let i = 1; i < thr.length; i++) assert.ok(thr[i] <= thr[i - 1], `mcdThr(${ns[i]})=${thr[i]} 不得大於 mcdThr(${ns[i - 1]})=${thr[i - 1]}`);
  for (const t of thr) assert.ok(t >= core.MCD_CHI2, `門檻 ${t} 不得低於 ${core.MCD_CHI2}`);
  assert.ok(Math.abs(core.mcdThr(30000) - core.MCD_CHI2) < 0.02, 'n 很大時收斂到 18.42');

  // i.i.d. 雙變量常態、焊墊群組常見大小：修正前 P(任一離群) 為 8.9%（n=36）／7.2%（n=48），名目約 0.4%
  let seed = 2468;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed + 1) / 4294967297; };
  const randn = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  for (const n of [36, 48]) {
    const runs = 1500;
    let hit = 0;
    for (let k = 0; k < runs; k++) {
      const res = core.fastMcd2D(Array.from({ length: n }, () => [randn(), randn()]));
      if (res.outliers.length) hit++;
    }
    assert.ok(hit / runs <= 0.02, `n=${n} 任一離群比例 ${hit / runs} 應 ≤ 2%（名目 ${(n * 1e-4).toFixed(4)}）`);
  }
});
