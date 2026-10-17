import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { generateStableData, rowsToCsv } from '../tools/gen-stable.mjs';

const require = createRequire(import.meta.url);
const { loadCore, baseState } = require('./_load.js');

const core = loadCore();

const CMP_FIELDS = ['board', 'pad', 'comp', 'group', 'x', 'y', 'w', 'd', 'stroke', 'height', 'area', 'volume', 'offx', 'offy'];

test('6.1 stable-25.csv 驗證：seed 1、25 板 CSV 往返一致且穩定製程整體判定為正常', () => {
  const csvPath = path.join(import.meta.dirname, 'fixtures', 'stable-25.csv');
  assert.ok(fs.existsSync(csvPath), 'stable-25.csv 應存在');
  const txt = fs.readFileSync(csvPath, 'utf8');
  const parsed = core.parseCSV(txt);
  const direct = generateStableData({ nb: 25, shift: 0, stroke: true, seed: 1 });
  assert.equal(parsed.rows.length, direct.length, '25 板 × 116 焊墊 = 2900 列');

  for (let i = 0; i < direct.length; i++) {
    for (const f of CMP_FIELDS) {
      assert.ok(parsed.rows[i][f] === direct[i][f], `row ${i} field ${f} 應完全一致（容差 0）: ${parsed.rows[i][f]} vs ${direct[i][f]}`);
    }
  }

  const st = baseState(core, {
    rows: parsed.rows,
    metrics: ['volume', 'hpct', 'area', 'offx', 'offy'],
    metric: 'volume',
    group: 'ALL',
    chart: 'xbars'
  });
  const iss = core.detectIssues(st);
  const vd = iss.meta.verdict;

  assert.equal(vd.level, 'ok', '整體判定等級應為 ok');
  assert.equal(vd.label, '正常', '整體判定標籤應為正常');
  assert.ok(iss.every(x => x.level === '資訊' || x.lv === 'info'), '穩定製程 seed 1 不得有嚴重或警示問題卡');
});

test('6.1 verdict-sim-expected.json 期望檔與附錄 C 稽核參考判定比對（一致率 ≥85%）', () => {
  const expPath = path.join(import.meta.dirname, 'fixtures', 'verdict-sim-expected.json');
  assert.ok(fs.existsSync(expPath), 'verdict-sim-expected.json 應存在');
  const expected = JSON.parse(fs.readFileSync(expPath, 'utf8'));
  const runs = expected.runs || expected;

  const configs = [
    { key: '25_shift0', data: runs['nb25_s0'] || runs['25_shift0'], refFile: 'perseed_25_1_200_0.txt', minOk: 0.77, maxOk: 1.0 },
    { key: '50_shift0', data: runs['nb50_s0'] || runs['50_shift0'], refFile: 'perseed_50_1_200_0.txt', minOk: 0.78, maxOk: 1.0 },
    { key: '25_shift3', data: runs['nb25_s3'] || runs['25_shift3'], refFile: 'perseed_25_1_200_3.txt', minOk: 0.0, maxOk: 0.05 },
    { key: '50_shift3', data: runs['nb50_s3'] || runs['50_shift3'], refFile: 'perseed_50_1_200_3.txt', minOk: 0.0, maxOk: 0.05 }
  ];

  for (const cfg of configs) {
    assert.ok(cfg.data, `應包含 ${cfg.key} 設定`);
    const seeds = Array.isArray(cfg.data) ? cfg.data : cfg.data.seeds;
    assert.equal(seeds.length, 200, `${cfg.key} 應有 200 個 seed`);
    const okCount = seeds.filter(x => x.level === 'ok').length;
    const okRate = okCount / 200;
    assert.ok(okRate >= cfg.minOk && okRate <= cfg.maxOk, `${cfg.key} 正常率 ${okRate} 應在 [${cfg.minOk}, ${cfg.maxOk}]`);

    const refPath = path.join(import.meta.dirname, 'fixtures', 'audit', 'r6merge', cfg.refFile);
    if (fs.existsSync(refPath)) {
      const refChars = [...fs.readFileSync(refPath, 'utf8').trim()];
      assert.equal(refChars.length, 200);
      let agree = 0;
      for (let i = 0; i < 200; i++) {
        const refOk = refChars[i] === '正';
        const ourOk = seeds[i].level === 'ok';
        if (refOk === ourOk) agree++;
      }
      assert.ok(agree / 200 >= 0.85, `${cfg.key} 與附錄 C 正常／非正常一致率 ${agree / 200} 應 >= 85%`);
    }
  }
});

const isSlow = process.env.RUN_SLOW === '1';

test('[slow] 6.1 整體判定模擬：seed 1–200 蒙地卡羅驗收（25/50 板、SHIFT 0/3）', () => {
  const expPath = path.join(import.meta.dirname, 'fixtures', 'verdict-sim-expected.json');
  const expected = JSON.parse(fs.readFileSync(expPath, 'utf8'));
  const runs = expected.runs || expected;
  const maxSeed = isSlow ? 200 : 2;

  const configs = [
    { nb: 25, shift: 0, key: '25_shift0', expKey: 'nb25_s0', minOkRate: 0.77, maxOkRate: 1.0 },
    { nb: 50, shift: 0, key: '50_shift0', expKey: 'nb50_s0', minOkRate: 0.78, maxOkRate: 1.0 },
    { nb: 25, shift: 3, key: '25_shift3', expKey: 'nb25_s3', minOkRate: 0.0, maxOkRate: 0.05 },
    { nb: 50, shift: 3, key: '50_shift3', expKey: 'nb50_s3', minOkRate: 0.0, maxOkRate: 0.05 }
  ];

  for (const cfg of configs) {
    let okCount = 0;
    const rawExp = runs[cfg.expKey] || runs[cfg.key];
    const expSeeds = Array.isArray(rawExp) ? rawExp : rawExp.seeds;
    for (let s = 1; s <= maxSeed; s++) {
      const directRows = generateStableData({ nb: cfg.nb, shift: cfg.shift, stroke: true, seed: s });
      const rows = s === 1 ? core.parseCSV(rowsToCsv(directRows)).rows : directRows;
      const st = baseState(core, {
        rows,
        metrics: ['volume', 'hpct', 'area', 'offx', 'offy'],
        metric: 'volume',
        group: 'ALL',
        chart: 'xbars'
      });
      const iss = core.detectIssues(st);
      const vd = iss.meta.verdict;
      if (vd.level === 'ok') okCount++;

      const expSeed = expSeeds[s - 1];
      assert.equal(vd.level, expSeed.level, `seed ${s} 在 ${cfg.key} 的判定等級應與期望檔完全一致`);
      const cats = [...new Set(iss.map(x => x.cat))].sort();
      assert.deepEqual(cats, expSeed.cats, `seed ${s} 在 ${cfg.key} 的卡片類別應與期望檔完全一致`);
    }

    if (isSlow) {
      const rate = okCount / 200;
      assert.ok(rate >= cfg.minOkRate, `${cfg.key} 正常率 ${rate} 應 >= ${cfg.minOkRate}`);
      assert.ok(rate <= cfg.maxOkRate, `${cfg.key} 正常率 ${rate} 應 <= ${cfg.maxOkRate}`);
    }
  }
});
