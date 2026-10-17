import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { HTML, withIdb, loadCore, baseState } = require('./_load.js');
const { JSDOM } = (() => { try { return require('jsdom'); } catch { return {}; } })();
const recordsCore = require('../lib/records-core.mjs');
const core = loadCore();

function createPage() {
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

test('M-07: Xbar-R Control Chart & AIAG Constants (TV-1)', () => {
  const { computeXbarR, AIAG_CONSTANTS } = core;

  // 1. Check AIAG constants table for n=2..10
  assert.equal(AIAG_CONSTANTS[2].A2, 1.880);
  assert.equal(AIAG_CONSTANTS[2].D3, 0);
  assert.equal(AIAG_CONSTANTS[2].D4, 3.267);
  assert.equal(AIAG_CONSTANTS[2].d2, 1.128);

  assert.equal(AIAG_CONSTANTS[4].A2, 0.729);
  assert.equal(AIAG_CONSTANTS[4].D3, 0);
  assert.equal(AIAG_CONSTANTS[4].D4, 2.282);
  assert.equal(AIAG_CONSTANTS[4].d2, 2.059);

  assert.equal(AIAG_CONSTANTS[10].A2, 0.308);
  assert.equal(AIAG_CONSTANTS[10].D3, 0.223);
  assert.equal(AIAG_CONSTANTS[10].D4, 1.777);
  assert.equal(AIAG_CONSTANTS[10].d2, 3.078);

  // 2. Numerical fixture TV-1: 5 boards, 4 pads per board (n=4, k=5)
  // Board 1: [100, 102, 98, 104] (mean=101, R=6)
  // Board 2: [99, 101, 100, 102] (mean=100.5, R=3)
  // Board 3: [102, 100, 101, 103] (mean=101.5, R=3)
  // Board 4: [98, 102, 99, 101] (mean=100, R=4)
  // Board 5: [101, 99, 102, 103] (mean=101.25, R=4)
  const rows = [
    { board: 'B01', pad: 'P1', volume: 100 }, { board: 'B01', pad: 'P2', volume: 102 }, { board: 'B01', pad: 'P3', volume: 98 }, { board: 'B01', pad: 'P4', volume: 104 },
    { board: 'B02', pad: 'P1', volume: 99 }, { board: 'B02', pad: 'P2', volume: 101 }, { board: 'B02', pad: 'P3', volume: 100 }, { board: 'B02', pad: 'P4', volume: 102 },
    { board: 'B03', pad: 'P1', volume: 102 }, { board: 'B03', pad: 'P2', volume: 100 }, { board: 'B03', pad: 'P3', volume: 101 }, { board: 'B03', pad: 'P4', volume: 103 },
    { board: 'B04', pad: 'P1', volume: 98 }, { board: 'B04', pad: 'P2', volume: 102 }, { board: 'B04', pad: 'P3', volume: 99 }, { board: 'B04', pad: 'P4', volume: 101 },
    { board: 'B05', pad: 'P1', volume: 101 }, { board: 'B05', pad: 'P2', volume: 99 }, { board: 'B05', pad: 'P3', volume: 102 }, { board: 'B05', pad: 'P4', volume: 103 }
  ];

  const st = { xrSize: 4, xrMode: 'board' };
  const res = computeXbarR(st, rows, 'volume', false, 1.8);

  assert.equal(res.rejected, false);
  assert.equal(res.n, 4);
  assert.equal(res.k, 5);
  assert.equal(res.rbar, 4.0);
  assert.equal(res.cl, 100.85);

  // UCL_X = 100.85 + 0.729 * 4.0 = 103.766
  assert.ok(Math.abs(res.uclX - 103.766) < 1e-4, `Expected UCL_X ~ 103.766, got ${res.uclX}`);
  // LCL_X = 100.85 - 0.729 * 4.0 = 97.934
  assert.ok(Math.abs(res.lclX - 97.934) < 1e-4, `Expected LCL_X ~ 97.934, got ${res.lclX}`);
  // UCL_R = 2.282 * 4.0 = 9.128
  assert.ok(Math.abs(res.uclR - 9.128) < 1e-4, `Expected UCL_R ~ 9.128, got ${res.uclR}`);
  assert.equal(res.lclR, 0);
  // sigmaHat = Rbar / d2 = 4.0 / 2.059 = 1.9426906...
  assert.ok(Math.abs(res.sigmaHat - 1.9426906) < 1e-4, `Expected sigmaHat ~ 1.9426906, got ${res.sigmaHat}`);

  // 3. Fail-closed on out-of-range n
  const resOver = computeXbarR({ xrSize: 11, xrMode: 'board' }, rows, 'volume', false, 1.8);
  assert.equal(resOver.rejected, true);
  assert.match(resOver.reason, /n=2~10/);

  const resUnder = computeXbarR({ xrSize: 1, xrMode: 'board' }, rows, 'volume', false, 1.8);
  assert.equal(resUnder.rejected, true);

  // 4. Subgroup mode "pad"
  const resPad = computeXbarR({ xrSize: 5, xrMode: 'pad' }, rows, 'volume', false, 1.8);
  assert.equal(resPad.n, 5);
});

test('M-08: Hotelling T2 Multivariate Control Chart (TV-16)', () => {
  const { hotellingT2 } = core;

  // 1. Numerical fixture TV-16: p=1, m=5, X=[99, 102, 104, 100, 100]
  const boardsData = [
    { board: 'B01', area: 99 },
    { board: 'B02', area: 102 },
    { board: 'B03', area: 104 },
    { board: 'B04', area: 100 },
    { board: 'B05', area: 100 }
  ];

  const res = hotellingT2(boardsData, { dims: ['area'], alpha: 0.0027, skipGate: true });
  assert.equal(res.rejected, false);
  assert.equal(res.p, 1);
  assert.equal(res.m, 5);

  // Phase I UCL: (m-1)^2/m * Beta_0.9973(0.5, 1.5) = (16/5) * 0.96590306 = 3.0908898
  assert.ok(Math.abs(res.uclPhase1 - 3.0908898) < 1e-4, `Expected Phase I UCL ~ 3.0908898, got ${res.uclPhase1}`);

  // Phase II UCL: 1*(6)*(4)/(5*4) * F_0.9973(1, 4) = 1.2 * 43.825347 = 52.5904168
  assert.ok(Math.abs(res.uclPhase2 - 52.5904168) < 1e-4, `Expected Phase II UCL ~ 52.5904168, got ${res.uclPhase2}`);

  // Check T2 values
  assert.equal(res.pts.length, 5);
  for (const pt of res.pts) {
    assert.ok(pt.T2 >= 0);
    assert.ok(pt.T2 <= res.uclPhase1);
    assert.equal(pt.ooc, false);
  }

  // 2. Minimum board count gate m < max(p+2, 11)
  const resGate = hotellingT2(boardsData, { dims: ['area'], alpha: 0.0027 });
  assert.equal(resGate.rejected, true);
  assert.match(resGate.reason, /板數不足/);

  // 3. Collinear dimension rejection
  const m12Data = Array.from({ length: 15 }, (_, i) => ({
    board: `B${i + 1}`,
    area: 100 + i,
    height: 120 + (i % 3),
    volume: 2 * (100 + i) + 3 * (120 + (i % 3)) // exact linear combination
  }));
  const resSingular = hotellingT2(m12Data, { dims: ['area', 'height', 'volume'] });
  assert.equal(resSingular.rejected, true);
  assert.match(resSingular.reason, /共變異矩陣接近奇異|條件數/);
});

test('M-16: Shapiro-Wilk Normality Second Opinion (TV-11)', () => {
  const { shapiroWilk } = core;

  // TV-11 fixture: 12 values
  const vals = [100.2, 98.7, 101.5, 99.9, 97.8, 102.3, 100.8, 99.1, 103.4, 98.2, 100.0, 101.1];
  const res = shapiroWilk(vals);

  assert.equal(res.valid, true);
  // Expected: W = 0.97864757..., p = 0.97769214...
  assert.ok(Math.abs(res.w - 0.97864757) < 1e-4, `Expected W ~ 0.97864757, got ${res.w}`);
  assert.ok(Math.abs(res.p - 0.97769214) < 1e-4, `Expected p ~ 0.97769214, got ${res.p}`);

  // Sample size bounds
  const resSmall = shapiroWilk([10, 20]);
  assert.equal(resSmall.valid, false);
  assert.match(resSmall.reason, /樣本數需 ≥ 3/);

  const resLarge = shapiroWilk(Array.from({ length: 5001 }, (_, i) => i));
  assert.equal(resLarge.valid, false);
  assert.match(resLarge.reason, /超過 5000/);

  const resZeroSd = shapiroWilk([5, 5, 5, 5]);
  assert.equal(resZeroSd.valid, false);
  assert.match(resZeroSd.reason, /變異為零/);
});

test('M-13: SPI Process Knowledge Base R001-R030 & Failure Modes', () => {
  const { SPI_PROCESS_KB_RULES, failureModes } = core;

  assert.equal(SPI_PROCESS_KB_RULES.length, 30);
  for (let i = 1; i <= 30; i++) {
    const id = `R${String(i).padStart(3, '0')}`;
    const rule = SPI_PROCESS_KB_RULES.find((r) => r.id === id);
    assert.ok(rule, `Rule ${id} missing from SPI_PROCESS_KB_RULES`);
    assert.ok(rule.desc, `Rule ${id} missing desc`);
    assert.ok(Array.isArray(rule.causes) && rule.causes.length > 0, `Rule ${id} missing causes`);
    assert.ok(rule.action, `Rule ${id} missing action`);
  }

  // Check that failure modes are 12 and include kbRules
  const modes = failureModes();
  assert.equal(modes.length, 12);
  for (const m of modes) {
    assert.ok(Array.isArray(m.kbRules), `Failure mode ${m.name} missing kbRules array`);
    assert.ok(m.kbRules.length > 0, `Failure mode ${m.name} has no kbRules assigned`);
    // Each mode requires >= 2 independent dimensions to judge as "可能"
    assert.ok(['未見跡象', '待確認', '可能', '資料不足', '證據矛盾'].includes(m.verdict), `Unexpected verdict: ${m.verdict}`);
  }
});

test('M-15: Dual Work Order Fields (supplierWo & outsourceWo)', () => {
  const cleanStr = recordsCore.clean(' SWO-9981 ', 64);
  assert.equal(cleanStr, 'SWO-9981');

  const { meta: cleaned } = recordsCore.checkMeta({
    kind: 'spi',
    lot: 'L2410-01',
    part: '301-000100124',
    supplierWo: 'SWO-9981 ',
    outsourceWo: 'OWO-7712 '
  });
  assert.equal(cleaned.supplierWo, 'SWO-9981');
  assert.equal(cleaned.outsourceWo, 'OWO-7712');

  const same = recordsCore.sameFile(
    { kind: 'spi', sha256: 'abc', part: 'P1', lot: 'L1', supplierWo: 'S1', outsourceWo: 'O1' },
    { kind: 'spi', sha256: 'abc', part: 'P1', lot: 'L1', supplierWo: 'S1', outsourceWo: 'O1' }
  );
  assert.equal(same, true);

  const diffWo = recordsCore.sameFile(
    { kind: 'spi', sha256: 'abc', part: 'P1', lot: 'L1', supplierWo: 'S1', outsourceWo: 'O1' },
    { kind: 'spi', sha256: 'abc', part: 'P1', lot: 'L1', supplierWo: 'S2', outsourceWo: 'O1' }
  );
  assert.equal(diffWo, false);

  const ent = recordsCore.entC({ id: 'rec-1', kind: 'spi', lot: 'L1', part: 'P1', supplierWo: 'S1', outsourceWo: 'O1', name: 'test.csv', sha256: 'hash' }, 'user1');
  assert.equal(ent.supplierWo, 'S1');
  assert.equal(ent.outsourceWo, 'O1');
});

test('UI & Hook Export Verification', () => {
  const { dom, errs } = createPage();
  const doc = dom.window.document;
  const hook = dom.window.SPI_TEST_HOOK;

  assert.equal(errs.length, 0, `Page errors: ${errs.join(', ')}`);
  assert.ok(hook, 'SPI_TEST_HOOK missing');

  // Verify all new functions are exported to SPI_TEST_HOOK
  assert.equal(typeof hook.hotellingT2, 'function');
  assert.equal(typeof hook.shapiroWilk, 'function');
  assert.equal(typeof hook.computeXbarR, 'function');
  assert.ok(hook.AIAG_CONSTANTS);
  assert.ok(Array.isArray(hook.SPI_PROCESS_KB_RULES));

  // Verify DOM elements
  assert.ok(doc.getElementById('inSupplierWo'), 'inSupplierWo input missing');
  assert.ok(doc.getElementById('inOutsourceWo'), 'inOutsourceWo input missing');
  assert.ok(doc.getElementById('selXrSize'), 'selXrSize select missing');
  assert.ok(doc.getElementById('selXrMode'), 'selXrMode select missing');
  assert.ok(doc.getElementById('cHotellingT2'), 'cHotellingT2 canvas missing');
  assert.ok(doc.getElementById('selT2Dims'), 'selT2Dims select missing');
  assert.ok(doc.getElementById('btnT2Freeze'), 'btnT2Freeze button missing');

  // Verify chart options
  const selChart = doc.getElementById('selChart');
  const chartOpts = [...selChart.options].map((o) => o.value);
  assert.ok(chartOpts.includes('xbarr'), 'xbarr missing from selChart options');
});
