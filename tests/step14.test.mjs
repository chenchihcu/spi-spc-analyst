import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const { HTML, withIdb, loadCore, baseState } = require('./_load.js');
const { JSDOM } = (() => { try { return require('jsdom'); } catch { return {}; } })();
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

test('D-11 & TV-14: GR&R interaction pooling and exact values', () => {
  const { grrAnalyze } = core;

  // TV-14 GR&R: 3 pads x 2 ops x 2 trials
  // P1: A 10.1, 10.3 | B 10.4, 10.2
  // P2: A 12.0, 11.8 | B 12.3, 12.1
  // P3: A 9.0, 9.2   | B 9.3, 9.1
  const rows = [
    { part: 'P1', op: 'A', trial: 1, volume: 10.1 },
    { part: 'P1', op: 'A', trial: 2, volume: 10.3 },
    { part: 'P1', op: 'B', trial: 1, volume: 10.4 },
    { part: 'P1', op: 'B', trial: 2, volume: 10.2 },

    { part: 'P2', op: 'A', trial: 1, volume: 12.0 },
    { part: 'P2', op: 'A', trial: 2, volume: 11.8 },
    { part: 'P2', op: 'B', trial: 1, volume: 12.3 },
    { part: 'P2', op: 'B', trial: 2, volume: 12.1 },

    { part: 'P3', op: 'A', trial: 1, volume: 9.0 },
    { part: 'P3', op: 'A', trial: 2, volume: 9.2 },
    { part: 'P3', op: 'B', trial: 1, volume: 9.3 },
    { part: 'P3', op: 'B', trial: 2, volume: 9.1 },
  ];

  // 1. Pooled analysis (default alphaPool = 0.25, interaction p = 0.5477 > 0.25 -> pooled)
  const pooled = grrAnalyze(rows, 'volume', 50, { alphaPool: 0.25 });
  assert.equal(pooled.pooled, true, 'p > 0.25 應自動合併交互作用項');
  assert.ok(Math.abs(pooled.pInt - 0.5477084899) < 1e-4, `交互作用 p 值應約 0.5477，實測 ${pooled.pInt}`);
  assert.ok(Math.abs(pooled.pctTV - 11.5990416274) < 1e-4, `%GRR(合併)應為 11.5990416274，實測 ${pooled.pctTV}`);
  assert.equal(pooled.ndc, 12, 'ndc 應為 12');
  assert.match(pooled.model, /合併交互作用模型/);

  // 2. Unpooled analysis (force forceNoPool: true to keep interaction)
  const unpooled = grrAnalyze(rows, 'volume', 50, { forceNoPool: true });
  assert.equal(unpooled.pooled, false, 'forceNoPool 應保留交互作用項');
  assert.ok(Math.abs(unpooled.pctTV - 12.0754852735) < 1e-4, `%GRR(保留)應為 12.0754852735，實測 ${unpooled.pctTV}`);
  assert.equal(unpooled.ndc, 11, 'ndc 應為 11');
  assert.match(unpooled.model, /含交互作用模型/);
});

test('D-56: Unbalanced GR&R cell truncation disclosure', () => {
  const { grrAnalyze } = core;

  // Unbalanced dataset: P1-A has 3 measurements, P1-B has 2 measurements
  const rows = [
    { part: 'P1', op: 'A', trial: 1, volume: 10.1 },
    { part: 'P1', op: 'A', trial: 2, volume: 10.3 },
    { part: 'P1', op: 'A', trial: 3, volume: 10.2 }, // extra trial
    { part: 'P1', op: 'B', trial: 1, volume: 10.4 },
    { part: 'P1', op: 'B', trial: 2, volume: 10.2 },

    { part: 'P2', op: 'A', trial: 1, volume: 12.0 },
    { part: 'P2', op: 'A', trial: 2, volume: 11.8 },
    { part: 'P2', op: 'B', trial: 1, volume: 12.3 },
    { part: 'P2', op: 'B', trial: 2, volume: 12.1 },
  ];

  const res = grrAnalyze(rows, 'volume', 50);
  assert.equal(res.truncated, 1, '應記錄截斷筆數為 1');
  assert.equal(res.truncCells.length, 1, '應記錄截斷儲存格');
  assert.equal(res.truncCells[0].part, 'P1');
  assert.equal(res.truncCells[0].op, 'A');
  assert.equal(res.truncCells[0].dropped, 1);
});

test('D-17 & D-32: No duplicate bmr/sB and strict eradication of σ板間', () => {
  const html = fs.readFileSync(HTML, 'utf8');

  // D-32: σ板間 must not appear anywhere in code, UI or comments
  assert.ok(!html.includes('σ板間'), 'HTML 與程式碼中嚴禁出現「σ板間」字樣');

  // Subtitle uses 三向法 and σ̂(板平均)
  assert.ok(html.includes('σ̂(板平均)'), '管制圖應使用 σ̂(板平均)');
  assert.ok(html.includes('三向法'), '管制圖應標示三向法說明');
});

test('D-14: Laney P-prime chart discloses sigma_z < 1', () => {
  const html = fs.readFileSync(HTML, 'utf8');
  assert.ok(html.includes('σz < 1：板間變異小於二項式預期，界限已收窄'), 'P′ 圖副標應揭露 σz < 1 說明');
});

test('D-12: Capacity card inline notice when Cpk < Ppk', () => {
  const html = fs.readFileSync(HTML, 'utf8');
  assert.ok(html.includes('組內變異大於整體變異（Cpk < Ppk）：板間差異很小，或子群組內混了不同元件（請確認元件群組欄）'),
    'Cpk < Ppk 時應顯示組內變異大於整體變異之行內說明');
});

test('D-15: Anderson-Darling sampling disclosure for N > 4000', () => {
  const { analyze } = core;
  const largeData = [];
  for (let b = 1; b <= 50; b++) {
    for (let p = 1; p <= 100; p++) {
      largeData.push({ board: 'B' + b, pad: 'P' + p, volume: 100 + (b % 5) + (p % 3) });
    }
  }
  assert.equal(largeData.length, 5000, '總筆數為 5000 > 4000');

  const S = {
    ...baseState(core),
    rows: largeData,
    metric: 'volume',
    group: 'ALL',
    chart: 'xbars',
    specs: { volume: { lsl: 50, tgt: 100, usl: 150 } },
    specSrc: 'custom'
  };

  const A = analyze(S);
  assert.ok(A.ad.sampled != null, '大於 4000 筆時 ad.sampled 應有值');
  assert.ok(A.ad.sampled > 0 && A.ad.sampled <= 4000, `抽樣後筆數應 <= 4000，實測 ${A.ad.sampled}`);
});

test('D-20: Cloudflare AI gateway default model is claude-opus-5-5', () => {
  const aiCode = fs.readFileSync(path.join(process.cwd(), 'cloudflare', 'ai.mjs'), 'utf8');
  assert.ok(aiCode.includes("'claude-opus-5-5'"), 'AI gateway 預設模型應為 claude-opus-5-5');
  assert.ok(!aiCode.includes('claude-3-5-sonnet'), '不應再引用已停用的 claude-3-5-sonnet');
});

test('D-53: UTC+8 timestamp and Compare MD volume CV% column', () => {
  const { fmtNowUtc8, formatUtc8Date } = core;

  const fixedDate = new Date('2026-03-01T00:00:00Z');
  const utc8Str = formatUtc8Date(fixedDate, 'YYYY-MM-DD HH:mm:ss');
  assert.equal(utc8Str, '2026-03-01 08:00:00', 'UTC 00:00 應轉換為 UTC+8 08:00');

  const nowStr = fmtNowUtc8(fixedDate);
  assert.equal(nowStr, '2026-03-01 08:00:00 UTC+8', '應帶有 UTC+8 字樣');

  const html = fs.readFileSync(HTML, 'utf8');
  assert.ok(html.includes('錫量 CV %'), 'btnCmpMd 報告表格應包含「錫量 CV %」欄位');
});

test('D-54 & D-55: DOE and AOI spec window disclosure notes', () => {
  const html = fs.readFileSync(HTML, 'utf8');
  assert.ok(html.includes('註：各因子單獨檢定、未調整其他因子與交互作用。'), 'DOE 應標示單獨檢定未調整交互作用之揭露');
  assert.ok(html.includes('AOI 建議窗（'), 'specSrcText 應揭露 AOI 建議窗來源');
});

test('D-34: Inferred board disclosure across UI and reports', () => {
  const html = fs.readFileSync(HTML, 'utf8');
  assert.ok(html.includes('推定子群組，僅供參考'), '問題清單卡片應有「推定子群組，僅供參考」pill');
  assert.ok(html.includes('板號為推定（每 N 筆）') || html.includes('板號為推定（每'), '頂端狀態列與報告應揭露推定板號');
});

test('M-19: Work order spec parser and application', () => {
  const { parseWorkorderSpec, applyWorkorderSpec, S } = core;

  const jsonSpec = JSON.stringify({
    part: 'TEST-PART-01',
    specs: {
      volume: { lsl: 60, target: 100, usl: 140 },
      height: { lsl: 70, target: 110, usl: 150 }
    }
  });

  const parsed = parseWorkorderSpec(jsonSpec, 'mes_spec.json');
  assert.equal(parsed.part, 'TEST-PART-01');
  assert.equal(parsed.fileName, 'mes_spec.json');
  assert.equal(parsed.specs.volume.lsl, 60);
  assert.equal(parsed.specs.volume.usl, 140);
  assert.equal(parsed.specs.height.tgt, 110);

  applyWorkorderSpec(parsed);
  assert.equal(S.specSrc, 'workorder');
  assert.equal(S.woSpecFile, 'mes_spec.json');
  assert.equal(S.specs.volume.lsl, 60);
  assert.equal(S.specs.volume.usl, 140);
});

test('M-20: issuesXlsx OpenXML export and xlsxTable roundtrip', async () => {
  const { issuesXlsx, createZipStored, csvTable } = core;

  const mockIssues = [
    {
      no: 1,
      level: '嚴重',
      category: '單板突發',
      rule_id: 'R001',
      rule_name: '單板均值偏移',
      metric: 'volume',
      boards: 'B01',
      subboard: 'F01',
      group: 'BGA',
      refdes: 'U1',
      pads: 'P1-P4',
      observed: '125.40%',
      limit: '100.00%',
      z: '+3.82',
      p: '0.0001',
      facts: ['體積超標 25.4%'],
      inference: '可能為印刷機壓力不均',
      action: '調整刮刀平衡',
      corroborated_by: [2],
      same_phenomenon: [],
      explained_pads: ['P1', 'P2']
    }
  ];

  const xlsxBuf = issuesXlsx(mockIssues);
  assert.ok(xlsxBuf instanceof Uint8Array, 'issuesXlsx 應回傳 Uint8Array');
  assert.ok(xlsxBuf.length > 500, '檔案應具有合法 OpenXML 結構大小');

  // Verify stored zip signature (PK\x03\x04 = 0x04034b50)
  assert.equal(xlsxBuf[0], 0x50);
  assert.equal(xlsxBuf[1], 0x4b);
  assert.equal(xlsxBuf[2], 0x03);
  assert.equal(xlsxBuf[3], 0x04);
});

test('M-21: applyTimeFilter sequence R5-18 and partial board detection', () => {
  const { parseCSV, applyTimeFilter, S } = core;

  // 5 boards x 2 pads = 10 rows (without board column -> inferred 5 boards of 2 pads each)
  const csv = [
    'Time,RefDes,Pad,Volume',
    '2026-03-01 08:00:01,R1,1,102',
    '2026-03-01 08:00:03,R2,1,102',
    '2026-03-01 08:00:05,R1,1,99',
    '2026-03-01 08:00:07,R2,1,99',
    '2026-03-01 08:00:09,R1,1,99',
    '2026-03-01 08:00:11,R2,1,100',
    '2026-03-01 08:00:13,R1,1,100',
    '2026-03-01 08:00:15,R2,1,100',
    '2026-03-01 08:00:17,R1,1,100',
    '2026-03-01 08:00:19,R2,1,100'
  ].join('\n');

  const { rows, metrics } = parseCSV(csv);
  assert.equal(rows.length, 10);
  const inferredBoards = [...new Set(rows.map(r => r.board))];
  assert.equal(inferredBoards.length, 5, '先用完整檔案推定 5 片板');

  S.rows = rows;
  S._rawRows = rows;
  S.metric = 'volume';
  S.group = 'ALL';

  // Apply time filter 08:00:06 ~ 08:00:14
  // Filtered rows:
  // 08:00:07 (B02, pad 2 only -> 1 of 2 pads -> partial!)
  // 08:00:09 (B03, pad 1)
  // 08:00:11 (B03, pad 2 -> 2 of 2 pads -> full!)
  // 08:00:13 (B04, pad 1 only -> 1 of 2 pads -> partial!)
  applyTimeFilter('08:00:06', '08:00:14');

  assert.equal(S.rows.length, 4, '篩選後筆數應為 4');
  const remainingBoards = [...new Set(S.rows.map(r => r.board))];
  assert.equal(remainingBoards.length, 3, '篩選後板數應為 3（推定板 2、3、4）');
  assert.equal(S.partialBoards.length, 2, '應有 2 片板標示部分');
  assert.ok(S.partialBoards.includes('B02（推定）'));
  assert.ok(S.partialBoards.includes('B04（推定）'));
  assert.ok(!S.partialBoards.includes('B03（推定）'));

  // Clear time filter
  applyTimeFilter('', '');
  assert.equal(S.rows.length, 10, '清除後還原為 10 筆');
  assert.equal(S.partialBoards, null, '清除後 partialBoards 為 null');
});
