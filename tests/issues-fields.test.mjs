import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { loadCore, baseState, HTML } = require('./_load.js');

const core = loadCore();

const MANDATORY_FIELDS = [
  'no', 'level', 'category', 'title', 'rule_id', 'rule_name', 'metric',
  'boards', 'subboard', 'group', 'refdes', 'pads', 'observed', 'limit',
  'z', 'p', 'facts', 'inference', 'confidence', 'action',
  'corroborated_by', 'same_phenomenon', 'explained_pads'
];

test('R-ISSUE (8.0): 每張問題卡必備 23 個欄位，不為 undefined 或 null', () => {
  const samp = core.sampleData();
  const st = baseState(core, {
    rows: samp,
    metrics: ['volume', 'height', 'hpct', 'area', 'offx', 'offy'],
    metric: 'volume',
    group: 'ALL',
    chart: 'xbars'
  });
  const issues = core.detectIssues(st);
  assert.ok(issues.length > 0, '應偵測到問題卡');

  for (const x of issues) {
    for (const f of MANDATORY_FIELDS) {
      assert.ok(x[f] !== undefined && x[f] !== null, `卡片 #${x.no} 欄位 ${f} 不得為 undefined/null`);
    }
    assert.ok(Array.isArray(x.facts) && x.facts.length > 0, `卡片 #${x.no} facts 應為非空陣列`);
    assert.ok(Array.isArray(x.same_phenomenon), `卡片 #${x.no} same_phenomenon 應為陣列`);
    assert.ok(Array.isArray(x.explained_pads), `卡片 #${x.no} explained_pads 應為陣列`);
    assert.ok(['嚴重', '警示', '資訊'].includes(x.level), `卡片 #${x.no} level 應為 嚴重/警示/資訊，實得 ${x.level}`);
  }
});

test('R-ISSUE (8.0): issuesCsv 匯出格式包含 24 欄標準欄位（含規格來源）', () => {
  const samp = core.sampleData();
  const st = baseState(core, {
    rows: samp,
    metrics: ['volume', 'height', 'hpct', 'area', 'offx', 'offy'],
    metric: 'volume',
    group: 'ALL',
    chart: 'xbars'
  });
  const issues = core.detectIssues(st);
  const csv = core.issuesCsv(issues);
  const lines = csv.split('\n');
  const header = lines[0].replace(/\r/g, '').split(',');
  assert.deepEqual(header, [...core.ISS_CSV_COLS], 'CSV 標頭應與 ISS_CSV_COLS 完全一致');
  assert.equal(lines.length, issues.length + 1, 'CSV 行數應為 issues 數 + 1');
});

test('D-47: Nelson 規則卡獨立於畫面選擇、嚴重度依 8.0、誤報率來自常數表', () => {
  const samp = core.sampleData();
  const st = baseState(core, {
    rows: samp,
    metrics: ['volume', 'height', 'hpct', 'area', 'offx', 'offy'],
    metric: 'volume',
    group: 'ALL',
    chart: 'xbars'
  });
  const issues = core.detectIssues(st);
  const nelsonCards = issues.filter(x => x.category === '管制圖規則' && x.rule_id.startsWith('Nelson 規則'));
  assert.ok(nelsonCards.length >= 5, '應產生各判定項目的 Nelson 規則卡');

  const nel5 = nelsonCards.find(x => x.metric === '體積' && x.rule_id === 'Nelson 規則 5');
  const nel6 = nelsonCards.find(x => x.metric === '體積' && x.rule_id === 'Nelson 規則 6');
  assert.ok(nel5, '應有體積 Nelson 規則 5 卡片');
  assert.ok(nel6, '應有體積 Nelson 規則 6 卡片');

  assert.equal(nel5.level, '資訊', '規則 5 嚴重度應為資訊');
  assert.equal(nel6.level, '資訊', '規則 6 嚴重度應為資訊');
  assert.equal(nel5.boards, 'B22–B25', '規則 5 板號應為 B22–B25');
  assert.equal(nel6.boards, 'B21–B25', '規則 6 板號應為 B21–B25');

  assert.ok(nel5._sameTitles.some(t => t.includes('體積自 B20 起持續下降')), '規則 5 same_phenomenon 應含持續下降趨勢');
  assert.ok(nel6._sameTitles.some(t => t.includes('體積自 B20 起持續下降')), '規則 6 same_phenomenon 應含持續下降趨勢');

  for (const c of nelsonCards) {
    assert.ok(c.facts.some(t => t.includes('預期誤報')), `卡片 #${c.no} facts 應含預期誤報率揭露`);
  }
});

test('D-30 & TV-17: 合成資料 synthetic_test01.csv 孤立極端焊墊與 (a) 板級排除', () => {
  const p = path.join(import.meta.dirname, 'fixtures', 'audit', 'audit1', 'testdata', 'synthetic_test01.csv');
  const txt = fs.readFileSync(p, 'utf8');
  const parsed = core.parseCSV(txt);
  const st = baseState(core, {
    rows: parsed.rows,
    metrics: parsed.metrics,
    metric: 'volume',
    group: 'ALL',
    chart: 'xbars'
  });
  const issues = core.detectIssues(st);

  const iso = issues.find(x => x.rule_id.includes('孤立極端焊墊') && x.pads.includes('U2-05'));
  assert.ok(iso, 'TV-17 應有 U2-05 孤立極端焊墊卡');
  assert.equal(iso.boards, 'B03');
  assert.equal(iso.pads, 'U2-05');
  assert.equal(iso.observed, '62.0');
  assert.equal(iso.limit, 'LSL 70');
  assert.equal(iso.z, '-9.88');

  const b03Single = issues.find(x => x.category === '單板異常' && x.boards.includes('B03'));
  assert.equal(b03Single, undefined, 'TV-17 移除 U2-05 後不得有單獨的 B03 單板卡');
});

test('D-30 & TV-20 ①, ②, ③: TEST-第三輪-02_lone_extreme.csv 孤立極端焊墊驗收', () => {
  const p = path.join(import.meta.dirname, 'fixtures', 'audit', 'audit3', 'testdata', 'TEST-第三輪-02_lone_extreme.csv');
  const txt = fs.readFileSync(p, 'utf8');

  // TV-20 ①
  const p1 = core.parseCSV(txt);
  const st1 = baseState(core, {
    rows: p1.rows,
    metrics: p1.metrics,
    metric: 'volume',
    group: 'ALL',
    chart: 'xbars'
  });
  const iss1 = core.detectIssues(st1);
  const iso1 = iss1.find(x => x.rule_id.includes('孤立極端焊墊') && x.pads.includes('U1-2'));
  assert.ok(iso1, 'TV-20 ① 應有 U1-2 孤立極端焊墊卡');
  assert.equal(iso1.boards, 'B07');
  assert.equal(iso1.pads, 'U1-2');
  assert.equal(iso1.observed, '55.0');
  assert.equal(iso1.limit, 'LSL 70');

  // TV-20 ②: sampleData volume has 6 isolated extreme pads
  const samp = core.sampleData();
  const stSamp = baseState(core, {
    rows: samp,
    metrics: ['volume', 'height', 'hpct', 'area', 'offx', 'offy'],
    metric: 'volume',
    group: 'ALL',
    chart: 'xbars'
  });
  const issSamp = core.detectIssues(stSamp);
  const isoVolSamp = issSamp.find(x => x.rule_id.includes('孤立極端焊墊') && x.metric === '體積');
  assert.ok(isoVolSamp, '範例資料應有體積孤立極端焊墊卡');
  assert.equal(isoVolSamp.pads.split('; ').length, 6, 'TV-20 ② 體積孤立極端焊墊卡應包含 6 處焊墊');

  // TV-20 ③: two extreme pads U1-2 and U1-3 on B07 set to 55.0
  const p3 = core.parseCSV(txt);
  for (const r of p3.rows) {
    if (r.board === 'B07' && (r.pad === 'U1-2' || r.pad === 'U1-3')) r.volume = 55.0;
  }
  const st3 = baseState(core, {
    rows: p3.rows,
    metrics: p3.metrics,
    metric: 'volume',
    group: 'ALL',
    chart: 'xbars'
  });
  const iss3 = core.detectIssues(st3);
  const isoVol3 = iss3.find(x => x.rule_id.includes('孤立極端焊墊') && x.metric === '體積');
  assert.ok(isoVol3, 'TV-20 ③ 應有體積孤立極端焊墊卡');
  assert.equal(isoVol3.pads, 'U1-2; U1-3');
  assert.equal(isoVol3.observed, '55.0; 55.0');
  assert.equal(isoVol3.limit, 'LSL 70; LSL 70');
  assert.equal(isoVol3.z, '-18.60; -18.60');
});

test('D-30: MAD=0 備援估計（meanAbsDev * 1.2533）與解析度下限', () => {
  // 建立 28 筆 120, 2 筆 121 (MAD = 0)
  const v = [...Array(28).fill(120), 121, 121];
  const stat = core.isoStat(v, 1.0);
  assert.equal(stat.mad, 0, 'MAD 應為 0');
  assert.ok(stat.sg > 0, 'σ̂ 應藉由 meanAbsDev * 1.2533 大於 0');
  const expectedSg = Math.max((2 / 30) * 1.2533, 1.0 / Math.sqrt(12));
  assert.ok(Math.abs(stat.sg - expectedSg) < 1e-9, `σ̂ 應為 ${expectedSg}，實測 ${stat.sg}`);
});

test('D-29: 佐證僅限非衍生、不同證據族', () => {
  const samp = core.sampleData();
  const st = baseState(core, {
    rows: samp,
    metrics: ['volume', 'height', 'hpct', 'area', 'offx', 'offy'],
    metric: 'volume',
    group: 'ALL',
    chart: 'xbars'
  });
  const issues = core.detectIssues(st);
  for (const x of issues) {
    if (x.corrob && x.corrob.length > 0) {
      for (const refNo of x.corrob) {
        const ref = issues.find(i => i.no === refNo);
        assert.ok(ref, `佐證項目 #${refNo} 應存在`);
        assert.notEqual(x.category, ref.category, `卡片 #${x.no} 與佐證 #${refNo} 不得來自同面向（${x.category}）`);
      }
    }
  }
});

test('D-61: 刮刀方向卡於推定方向（奇偶板序）時降為資訊並附註（方向為推定）', () => {
  const p = path.join(import.meta.dirname, 'fixtures', 'audit', 'audit4', 'testdata', 'TEST-第四輪-phone-lone.csv');
  const txt = fs.readFileSync(p, 'utf8');
  const parsed = core.parseCSV(txt);
  const st = baseState(core, {
    rows: parsed.rows,
    metrics: parsed.metrics,
    metric: 'volume',
    group: 'ALL',
    chart: 'xbars'
  });
  const issues = core.detectIssues(st);
  const str = issues.find(x => x.category === '刮刀方向');
  assert.ok(str, '應有刮刀方向卡片');
  assert.equal(str.level, '資訊', '推定方向時嚴重度上限為資訊');
  assert.ok(str.title.includes('（方向為推定）'), '標題應附註（方向為推定）');
});

test('D-62: 焊墊位置穩健 Cpk 標籤與 0 次「穩健 Cpk 中位」稽核', () => {
  const html = fs.readFileSync(HTML, 'utf8');
  const count = (html.match(/穩健 Cpk 中位/g) || []).length;
  assert.equal(count, 0, '全檔中「穩健 Cpk 中位」出現次數必須為 0');

  const samp = core.sampleData();
  const st = baseState(core, {
    rows: samp,
    metrics: ['volume', 'height', 'hpct', 'area', 'offx', 'offy'],
    metric: 'volume',
    group: 'ALL',
    chart: 'xbars'
  });
  const issues = core.detectIssues(st);
  const sys = issues.find(x => x.category === '系統性能力');
  assert.ok(sys, '應有系統性能力卡片');
  assert.match(sys.title, /焊墊位置穩健 Cpk（中位數）/);
  assert.ok(sys.facts.some(t => t.includes('定義：每個焊墊位置跨')), 'facts 應說明公式定義');
});

test('D-64: 刮刀方向與擦拭週期 p 值校準與呈現', () => {
  const samp = core.sampleData();
  const st = baseState(core, {
    rows: samp,
    metrics: ['volume', 'height', 'hpct', 'area', 'offx', 'offy'],
    metric: 'volume',
    group: 'ALL',
    chart: 'xbars'
  });
  const issues = core.detectIssues(st);
  const str = issues.find(x => x.category === '刮刀方向');
  if (str) {
    assert.match(str.p, /名目 p = .*；?校正後 p = /, '刮刀卡 p 值應顯示名目與校正後 p 值');
  }
  const wipe = issues.find(x => x.category === '擦拭週期');
  if (wipe) {
    assert.match(wipe.p, /名目 p = .*；?校正後 p = /, '擦拭卡 p 值應顯示名目與校正後 p 值');
  }
});

test('N7-5: TEST-第三輪-PHME_small.csv 焊墊與界限清楚呈現在卡片事實', () => {
  const p = path.join(import.meta.dirname, 'fixtures', 'audit', 'audit3', 'testdata', 'TEST-第三輪-PHME_small.csv');
  const txt = fs.readFileSync(p, 'utf8');
  const parsed = core.parseCSV(txt);
  const st = baseState(core, {
    rows: parsed.rows,
    metrics: parsed.metrics,
    metric: 'volume',
    group: 'ALL',
    chart: 'xbars'
  });
  const issues = core.detectIssues(st);
  for (const x of issues) {
    assert.ok(x.pads && x.pads !== '', `卡片 #${x.no} pads 應非空`);
    assert.ok(x.observed && x.observed !== '', `卡片 #${x.no} observed 應非空`);
    assert.ok(x.limit && x.limit !== '', `卡片 #${x.no} limit 應非空`);
  }
});
