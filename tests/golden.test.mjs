import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = (() => { try { return require('jsdom'); } catch { return {}; } })();
const fs = require('fs');
const path = require('path');
const { HTML, withIdb } = require('./_load.js');
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures', 'golden');

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
      w.addEventListener('error', (e) => errs.push(e.message));
      withIdb(w);
    }
  });
  return { dom, errs };
}

async function pick(dom, sel, name, bytes) {
  const w = dom.window, inp = w.document.querySelector(sel);
  Object.defineProperty(inp, 'files', { configurable: true, value: [new w.File([bytes], name)] });
  inp.dispatchEvent(new w.Event('change'));
  for (let i = 0; i < 100; i++) {
    await tick(20);
    const d = w.document;
    if (sel === '#placeIn' ? /已存入資料庫|class="err"/.test(d.querySelector('#placeState').innerHTML)
      : (!d.querySelector('#mapBox').hidden || d.querySelector('#parseErr').textContent)) break;
  }
}

function setVendor(dom, v) {
  const s = dom.window.document.querySelector('#selVendor');
  s.value = v;
  s.dispatchEvent(new dom.window.Event('change'));
}

async function loadPlacement(dom, filename) {
  const d = dom.window.document;
  setVendor(dom, 'lirong');
  d.querySelector('#placePart').value = 'GOLDEN';
  d.querySelector('#placeRev').value = 'V1';
  const placeBytes = fs.readFileSync(path.join(FIXTURES_DIR, filename));
  await pick(dom, '#placeIn', filename, placeBytes);
  setVendor(dom, 'generic');
}

async function applyImport(dom, expectedRows) {
  const d = dom.window.document, w = dom.window;
  d.querySelector('#inLot').value = 'LOT-GOLDEN';
  if (!d.querySelector('#inPart').value) d.querySelector('#inPart').value = 'PART-GOLDEN';
  d.querySelector('#btnApply').click();
  for (let i = 0; i < 100 && (!w.eval('S.A') || w.eval('S.rows.length') !== expectedRows); i++) await tick(20);
}

// 金標測試骨架 (M-04, TV-21)
test('[D-10] no_coords: 空間分布與問題地圖顯示不適用，無空間問題卡', { skip: !JSDOM && '未安裝 jsdom' }, async () => {
  const { dom } = page();
  await tick(60);
  const csvBytes = fs.readFileSync(path.join(FIXTURES_DIR, 'normal_baseline.csv'));
  await pick(dom, '#fileIn', 'normal_baseline.csv', csvBytes);
  await applyImport(dom, 10);
  const w = dom.window;
  const A = JSON.parse(w.eval('JSON.stringify(S.A)'));
  assert.equal(A.N, 10);
  const xv = A.xv.rows.find(x => x.k === '空間分布');
  assert.ok(xv, '應有空間分布項目');
  assert.equal(xv.st, 'na');
  assert.equal(xv.ev, '不適用（無座標）');
  const issues = JSON.parse(w.eval('JSON.stringify(detectIssues(S))'));
  const spatialIssues = issues.filter(iss => iss.cat === '空間分布');
  assert.equal(spatialIssues.length, 0, '無座標時不得出現空間相關的問題卡');
  const d = dom.window.document;
  d.querySelector('[data-tab="cross"]').click();
  await tick(40);
  const heatSub = d.querySelector('#heatSub');
  if (heatSub) {
    assert.match(heatSub.textContent, /不適用（無座標）/);
  }
});

test('[D-10] partial_spec: area 無規格時顯示無規格，不為 0 或 NaN', { skip: !JSDOM && '未安裝 jsdom' }, async () => {
  const { dom } = page();
  await tick(60);
  const rows = [
    'Board,RefDes,Pad,Volume,Height,Area,PartType',
    'B1,R1,1,102,120,100,0603',
    'B1,R2,1,102,120,100,0603',
    'B2,R1,1,99,119,101,0603',
    'B2,R2,1,99,119,101,0603',
    'B3,R1,1,99,121,99,0603',
    'B3,R2,1,100,121,99,0603',
    'B4,R1,1,100,120,100,0603',
    'B4,R2,1,100,120,100,0603',
    'B5,R1,1,100,120,100,0603',
    'B5,R2,1,100,120,100,0603'
  ].join('\n');
  await pick(dom, '#fileIn', 'partial_spec.csv', Buffer.from(rows));
  await applyImport(dom, 10);
  const w = dom.window;
  const d = dom.window.document;
  d.querySelector('[data-tab="capability"]').click();
  await tick(40);
  w.eval("S.specs.area = { lsl: NaN, usl: NaN, tgt: NaN };");
  const sel = d.querySelector('#selMetric');
  sel.value = 'area';
  if (sel.onchange) sel.onchange({ target: sel });
  await tick(60);
  const A = JSON.parse(w.eval('JSON.stringify(S.A)'));
  assert.equal(A.hasSpec, false);
  assert.equal(A.cap.reason, '無規格');
  assert.ok(A.cap.cp === null || Number.isNaN(A.cap.cp));
  assert.ok(A.cap.cpk === null || Number.isNaN(A.cap.cpk));
  const kpisText = d.querySelector('#capKpis').textContent;
  assert.ok(!kpisText.includes('NaN'), '不得顯示 NaN');
  assert.ok(!kpisText.includes(' 0.00'), '不得顯示 0');
  assert.match(kpisText, /無規格/);

  // Volume 正常
  sel.value = 'volume';
  if (sel.onchange) sel.onchange({ target: sel });
  await tick(60);
  const Av = JSON.parse(w.eval('JSON.stringify(S.A)'));
  assert.equal(Av.hasSpec, true);
  assert.ok(Av.cap.cp !== null && !Number.isNaN(Av.cap.cp));
});
test('[M-02] sigma_zero_constant: 能力與管制圖拒算並顯示原因', { skip: !JSDOM && '未安裝 jsdom' }, async () => {
  const { dom } = page();
  await tick(60);
  const rows = [
    'Board,RefDes,Pad,Volume,PartType',
    'B1,R1,1,100,0402',
    'B1,R2,1,100,0603',
    'B2,R1,1,100,0402',
    'B2,R2,1,100,0603',
    'B3,R1,1,100,0402',
    'B3,R2,1,100,0603',
    'B4,R1,1,100,0402',
    'B4,R2,1,100,0603',
    'B5,R1,1,100,0603',
    'B5,R2,1,100,0603'
  ].join('\n');
  await pick(dom, '#fileIn', 'sigma_zero.csv', Buffer.from(rows));
  await applyImport(dom, 10);
  const w = dom.window;
  const A = JSON.parse(w.eval('JSON.stringify(S.A)'));
  assert.equal(A.overallSd, 0, '整體變異應為 0');
  assert.equal(A.cap.reason, '製程變異為零，Cp/Cpk 無法定義');
  assert.ok(A.xs.rejected, 'X̄ 圖應拒絕繪製零寬界限');
  assert.equal(A.xs.reason, '製程變異為零');
  assert.ok(A.xs.pts.every(p => p.ucl === null || Number.isNaN(p.ucl)), 'UCL 不得為數值');
  assert.ok(A.xs.pts.every(p => p.lcl === null || Number.isNaN(p.lcl)), 'LCL 不得為數值');
  const issues = JSON.parse(w.eval('JSON.stringify(detectIssues(S))'));
  assert.equal(issues.length, 0, 'TV-12: 全同值資料問題偵測不得產生誤報');
});

test('[M-02] sample_lt_10: 樣本數不足 10 顯示原因不輸出數值', { skip: !JSDOM && '未安裝 jsdom' }, async () => {
  const { dom } = page();
  await tick(60);
  await loadPlacement(dom, 'placement.csv');
  const csvBytes = fs.readFileSync(path.join(FIXTURES_DIR, 'normal_baseline.csv'));
  await pick(dom, '#fileIn', 'normal_baseline.csv', csvBytes);
  await applyImport(dom, 10);
  const w = dom.window;
  const A = JSON.parse(w.eval('JSON.stringify(S.A)'));
  assert.equal(A.N, 10);
  assert.ok(A.cap.groups.every(g => g.reason && g.reason.startsWith('樣本數不足（需 ≥10')));
  assert.ok(A.cap.groups.every(g => g.cp === null || Number.isNaN(g.cp)));
  assert.ok(A.cap.groups.every(g => g.cpk === null || Number.isNaN(g.cpk)));
  assert.ok(A.cap.reason.includes('樣本數不足'));
  assert.equal(A.xs.rejected, false, '5 板應可計算 X̄ 圖');
  assert.equal(A.xs.subgroupWarning, '子群組少於 20，界限僅供參考');
});

test('normal_baseline: 5 板 × 2 焊墊，Volume 敘述統計與座標 join 10/0', { skip: !JSDOM && '未安裝 jsdom' }, async () => {
  const { dom } = page();
  await tick(60);
  await loadPlacement(dom, 'placement.csv');

  const csvBytes = fs.readFileSync(path.join(FIXTURES_DIR, 'normal_baseline.csv'));
  await pick(dom, '#fileIn', 'normal_baseline.csv', csvBytes);

  const d = dom.window.document;
  assert.equal(d.querySelector('#parseErr').textContent, '');
  const prev = d.querySelector('#mapPrev').textContent;
  assert.match(prev, /10 筆、5 片板、2 個焊墊位置/);
  assert.match(prev, /對應 2 個位號/);

  await applyImport(dom, 10);

  const w = dom.window;
  const A = JSON.parse(w.eval('JSON.stringify(S.A)'));
  assert.equal(A.N, 10, '樣本數應為 10');
  assert.equal(A.boards.length, 5, '板數應為 5');
  assert.ok(Math.abs(A.gMean - 100.1) < 1e-6, `平均應為 100.1，實測 ${A.gMean}`);
  assert.ok(Math.abs(A.overallSd - 1.1005049346) < 1e-6, `整體標準差應為 1.1005049346，實測 ${A.overallSd}`);
  assert.equal(A.xs.subgroupWarning, '子群組少於 20，界限僅供參考');
  assert.ok(A.cap.reason.includes('樣本數不足'));
});

test('[D-42] duplicate_refdes_coords: 座標重複時取第一筆並列出忽略座標', { skip: !JSDOM && '未安裝 jsdom' }, async () => {
  const { dom } = page();
  await tick(60);
  await loadPlacement(dom, 'duplicate_refdes_coords.placement.csv');

  const csvBytes = fs.readFileSync(path.join(FIXTURES_DIR, 'normal_baseline.csv'));
  await pick(dom, '#fileIn', 'normal_baseline.csv', csvBytes);

  const d = dom.window.document;
  assert.equal(d.querySelector('#parseErr').textContent, '');
  const prev = d.querySelector('#mapPrev').textContent;
  assert.match(prev, /對應 2 個位號/);
  assert.match(prev, /忽略.*R1\(999,888\)/);

  await applyImport(dom, 10);
  const w = dom.window;
  const rows = JSON.parse(w.eval('JSON.stringify(S.rows)'));
  const r1 = rows.find(r => r.comp === 'R1');
  assert.equal(r1.x, 10, 'R1 的 X 座標應取第一筆 (10)');
  assert.equal(r1.y, 20, 'R1 的 Y 座標應取第一筆 (20)');
});

test('[D-42] refdes_suffix_strip_join: 位號 _N 後綴剝除後比對 join', { skip: !JSDOM && '未安裝 jsdom' }, async () => {
  const { dom } = page();
  await tick(60);
  await loadPlacement(dom, 'placement.csv');

  const csvBytes = fs.readFileSync(path.join(FIXTURES_DIR, 'refdes_suffix_strip_join.csv'));
  await pick(dom, '#fileIn', 'refdes_suffix_strip_join.csv', csvBytes);

  const d = dom.window.document;
  assert.equal(d.querySelector('#parseErr').textContent, '');
  const prev = d.querySelector('#mapPrev').textContent;
  assert.match(prev, /對應 2 個位號/);

  await applyImport(dom, 10);
  const w = dom.window;
  const rows = JSON.parse(w.eval('JSON.stringify(S.rows)'));
  assert.equal(rows.length, 10);
  assert.ok(rows.every(r => r.x != null && r.y != null), '剝除 _N 後綴應成功 join 到座標');
});

test('[D-25] partial_coord_match: 依多欄重複鍵去重，對不上列出位號', { skip: !JSDOM && '未安裝 jsdom' }, async () => {
  const { dom } = page();
  await tick(60);
  await loadPlacement(dom, 'placement.csv');

  const csvBytes = fs.readFileSync(path.join(FIXTURES_DIR, 'partial_coord_match.csv'));
  await pick(dom, '#fileIn', 'partial_coord_match.csv', csvBytes);

  const d = dom.window.document;
  assert.equal(d.querySelector('#parseErr').textContent, '');
  const prev = d.querySelector('#mapPrev').textContent;
  assert.match(prev, /對應 2 個位號.*未對應 1 個位號.*R99/);

  await applyImport(dom, 12);
  const w = dom.window;
  const A = JSON.parse(w.eval('JSON.stringify(S.A)'));
  assert.equal(A.N, 12, 'B6 兩筆 R99 封裝不同，不視為重複，總筆數應為 12');
  assert.ok(Math.abs(A.gMean - 100.0833333) < 1e-5, `平均應為 100.0833333，實測 ${A.gMean}`);
  assert.ok(Math.abs(A.overallSd - 2.3532698) < 1e-5, `整體標準差應為 2.3532698，實測 ${A.overallSd}`);
});

test('[D-43] panel_id_instead_of_board: PanelId 自動對應為板號', { skip: !JSDOM && '未安裝 jsdom' }, async () => {
  const { dom } = page();
  await tick(60);

  const csvBytes = fs.readFileSync(path.join(FIXTURES_DIR, 'panel_id_instead_of_board.csv'));
  await pick(dom, '#fileIn', 'panel_id_instead_of_board.csv', csvBytes);

  const d = dom.window.document;
  assert.equal(d.querySelector('#parseErr').textContent, '');
  const prev = d.querySelector('#mapPrev').textContent;
  assert.match(prev, /10 筆、5 片板、2 個焊墊位置/);

  await applyImport(dom, 10);
  const w = dom.window;
  const A = JSON.parse(w.eval('JSON.stringify(S.A)'));
  assert.equal(A.boards.length, 5, '板數應為 5');
  assert.equal(A.N, 10, '筆數應為 10');
  assert.ok(Math.abs(A.gMean - 100.1) < 1e-6);
  assert.ok(Math.abs(A.overallSd - 1.1005049346) < 1e-6);
});

test('[D-43] time_only_measurements: 純時間序推定板號', { skip: !JSDOM && '未安裝 jsdom' }, async () => {
  const { dom } = page();
  await tick(60);

  const csvBytes = fs.readFileSync(path.join(FIXTURES_DIR, 'time_only_measurements.csv'));
  await pick(dom, '#fileIn', 'time_only_measurements.csv', csvBytes);

  const d = dom.window.document;
  assert.equal(d.querySelector('#parseErr').textContent, '');
  const prev = d.querySelector('#mapPrev').textContent;
  assert.match(prev, /（推定）/);
  assert.match(prev, /沒有板號欄/);

  await applyImport(dom, 10);
  const w = dom.window;
  const A = JSON.parse(w.eval('JSON.stringify(S.A)'));
  assert.equal(A.boards.length, 5, '推定板數應為 5');
  assert.equal(A.N, 10, '筆數應為 10');
  assert.ok(Math.abs(A.gMean - 100.1) < 1e-6);
});

test('[D-43] timestamp_alias_measurements: Timestamp 欄位別名', { skip: !JSDOM && '未安裝 jsdom' }, async () => {
  const { dom } = page();
  await tick(60);

  const csvBytes = fs.readFileSync(path.join(FIXTURES_DIR, 'timestamp_alias_measurements.csv'));
  await pick(dom, '#fileIn', 'timestamp_alias_measurements.csv', csvBytes);

  const d = dom.window.document;
  assert.equal(d.querySelector('#parseErr').textContent, '');
  const prev = d.querySelector('#mapPrev').textContent;
  assert.match(prev, /（推定）/);

  await applyImport(dom, 10);
  const w = dom.window;
  const A = JSON.parse(w.eval('JSON.stringify(S.A)'));
  assert.equal(A.boards.length, 5);
});

test('[D-43] timestamp_lowercase_measurements: timestamp 小寫別名', { skip: !JSDOM && '未安裝 jsdom' }, async () => {
  const { dom } = page();
  await tick(60);

  const csvBytes = fs.readFileSync(path.join(FIXTURES_DIR, 'timestamp_lowercase_measurements.csv'));
  await pick(dom, '#fileIn', 'timestamp_lowercase_measurements.csv', csvBytes);

  const d = dom.window.document;
  assert.equal(d.querySelector('#parseErr').textContent, '');
  const prev = d.querySelector('#mapPrev').textContent;
  assert.match(prev, /（推定）/);

  await applyImport(dom, 10);
  const w = dom.window;
  const A = JSON.parse(w.eval('JSON.stringify(S.A)'));
  assert.equal(A.boards.length, 5);
});

test('[D-43] datetime_alias_measurements: DateTime 欄位別名', { skip: !JSDOM && '未安裝 jsdom' }, async () => {
  const { dom } = page();
  await tick(60);

  const csvBytes = fs.readFileSync(path.join(FIXTURES_DIR, 'datetime_alias_measurements.csv'));
  await pick(dom, '#fileIn', 'datetime_alias_measurements.csv', csvBytes);

  const d = dom.window.document;
  assert.equal(d.querySelector('#parseErr').textContent, '');
  const prev = d.querySelector('#mapPrev').textContent;
  assert.match(prev, /（推定）/);

  await applyImport(dom, 10);
  const w = dom.window;
  const A = JSON.parse(w.eval('JSON.stringify(S.A)'));
  assert.equal(A.boards.length, 5);
});
