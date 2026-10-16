import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { JSDOM } = (() => { try { return require('jsdom'); } catch { return {}; } })();
const { HTML, withIdb } = require('./_load.js');

function page() {
  const html = fs.readFileSync(HTML, 'utf8').replace(/<script src=[^>]+><\/script>/g, '');
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
      withIdb(w);
    }
  });
  return dom;
}

test('TV-10: 高精度 Φ 與 Φ⁻¹（相對誤差 < 1e-9）', { skip: !JSDOM && '未安裝 jsdom' }, () => {
  const dom = page();
  const w = dom.window;

  const tv10 = [
    [-3, 1.3498980316e-3],
    [-4, 3.1671241833e-5],
    [-4.5, 3.3976731247e-6],
    [-5, 2.8665157188e-7],
    [-6, 9.8658764504e-10]
  ];

  for (const [z, exp] of tv10) {
    const got = w.eval(`Phi(${z})`);
    const relErr = Math.abs(got - exp) / exp;
    assert.ok(relErr < 1e-9, `Phi(${z}) relative error should be < 1e-9, got ${relErr} (val=${got}, exp=${exp})`);
  }

  const gotInv1 = w.eval('invPhi(0.00135)');
  const expInv1 = -2.9999769927;
  const relErrInv1 = Math.abs(gotInv1 - expInv1) / Math.abs(expInv1);
  assert.ok(relErrInv1 < 1e-9, `invPhi(0.00135) relative error < 1e-9, got ${relErrInv1}`);

  const gotInv2 = w.eval('invPhi(0.975)');
  const expInv2 = 1.9599639845;
  const relErrInv2 = Math.abs(gotInv2 - expInv2) / Math.abs(expInv2);
  assert.ok(relErrInv2 < 1e-9, `invPhi(0.975) relative error < 1e-9, got ${relErrInv2}`);
});

test('TV-11: Minitab / Excel G1, G2 偏態與超額峰度（相對誤差 < 1e-9）', { skip: !JSDOM && '未安裝 jsdom' }, () => {
  const dom = page();
  const w = dom.window;

  const res = w.eval(`skewKurt([100.2, 98.7, 101.5, 99.9, 97.8, 102.3, 100.8, 99.1, 103.4, 98.2, 100.0, 101.1])`);
  const expG1 = 0.3250307672;
  const expG2 = -0.4144783595;

  const relErrG1 = Math.abs(res.skew - expG1) / Math.abs(expG1);
  const relErrG2 = Math.abs(res.kurt - expG2) / Math.abs(expG2);

  assert.ok(relErrG1 < 1e-9, `G1 relative error < 1e-9, got ${relErrG1}`);
  assert.ok(relErrG2 < 1e-9, `G2 relative error < 1e-9, got ${relErrG2}`);
});

test('TV-12: σ=0 全同值資料之 Fail-Closed 防護', { skip: !JSDOM && '未安裝 jsdom' }, () => {
  const dom = page();
  const w = dom.window;

  const st = {
    metric: 'volume',
    group: 'ALL',
    specs: { volume: { lsl: 70, usl: 130, tgt: 100 } },
    rows: Array.from({ length: 50 }, (_, i) => ({
      board: `B${Math.floor(i / 10) + 1}`,
      pad: `P${(i % 10) + 1}`,
      group: '0402',
      volume: 100.0
    }))
  };

  const A = w.eval(`analyze(${JSON.stringify(st)})`);
  assert.equal(A.overallSd, 0);
  assert.equal(A.cap.reason, '製程變異為零，Cp/Cpk 無法定義');
  assert.ok(Number.isNaN(A.cap.cp));
  assert.ok(Number.isNaN(A.cap.cpk));
  assert.ok(A.xs.rejected);
  assert.equal(A.xs.reason, '製程變異為零');
  assert.ok(A.xs.pts.every(p => Number.isNaN(p.ucl)));
  assert.ok(A.xs.pts.every(p => Number.isNaN(p.lcl)));

  const issues = w.eval(`detectIssues(${JSON.stringify(st)})`);
  assert.equal(issues.length, 0, 'TV-12 全同值資料不可產生誤報');
});

test('M-03: 單位／尺度不符偵測', { skip: !JSDOM && '未安裝 jsdom' }, () => {
  const dom = page();
  const w = dom.window;

  // 體積資料 100±5，規格 0.5–1.5（尺度差 100 倍）
  const st = {
    metric: 'volume',
    group: 'ALL',
    specs: { volume: { lsl: 0.5, usl: 1.5, tgt: 1.0 } },
    rows: [
      { board: 'B1', pad: 'P1', group: '0402', volume: 95 },
      { board: 'B1', pad: 'P2', group: '0402', volume: 105 },
      { board: 'B2', pad: 'P1', group: '0402', volume: 100 },
      { board: 'B2', pad: 'P2', group: '0402', volume: 102 }
    ]
  };

  const issues = w.eval(`detectIssues(${JSON.stringify(st)})`);
  assert.ok(issues.some(x => x.title.includes('疑似單位不符')), '應偵測到疑似單位不符警示');
});

test('D-46: 試產比較整體 Ppk 取最差群組（跨規格模式）', { skip: !JSDOM && '未安裝 jsdom' }, () => {
  const dom = page();
  const w = dom.window;

  const st = {
    metric: 'volume',
    specSrc: 'custom',
    specs: { volume: { lsl: 70, usl: 130, tgt: 100 } },
    rows: [
      // 群組 A: mean=100, sd=5 -> Ppk ~ 2.0
      ...Array.from({ length: 15 }, (_, i) => ({ board: `B${i % 5 + 1}`, pad: `PA${i}`, group: 'GA', volume: 100 + ((i % 3) - 1) * 5 })),
      // 群組 B: mean=125, sd=2 -> Ppk ~ (130-125)/(3*2) = 5/6 = 0.83
      ...Array.from({ length: 15 }, (_, i) => ({ board: `B${i % 5 + 1}`, pad: `PB${i}`, group: 'GB', volume: 125 + ((i % 3) - 1) * 2 }))
    ]
  };

  const out = w.eval(`runGroupStats(${JSON.stringify(st)}, "volume")`);
  assert.ok(out['整體'], '應有整體統計');
  assert.equal(out['整體'].ppkGroup, 'GB', '整體最差群組應為 GB');
  assert.ok(Math.abs(out['整體'].ppk - out['GB'].ppk) < 1e-6, '整體 Ppk 應取最差群組 GB 的 Ppk');
});

test('D-28: 不再單獨使用「實測 PPM」或「實測PPM」字樣，且 JSON 鍵名分離', () => {
  const html = fs.readFileSync(HTML, 'utf8');
  const matches = html.match(/實測 ?PPM/g);
  assert.equal(matches, null, 'grep -cE "實測 ?PPM" spi-spc.html 必須為 0');

  assert.ok(html.includes('不良PPM_全部判定項目'));
  assert.ok(html.includes('超規PPM_'));
});
