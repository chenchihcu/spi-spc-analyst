import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { generateStableData } from '../tools/gen-stable.mjs';

const require = createRequire(import.meta.url);
const { loadCore, baseState } = require('./_load.js');

const core = loadCore();

test('6.1 stable-25.csv 驗證：seed 1、25 板穩定製程整體判定為正常', () => {
  const csvPath = path.join(import.meta.dirname, 'fixtures', 'stable-25.csv');
  assert.ok(fs.existsSync(csvPath), 'stable-25.csv 應存在');
  const txt = fs.readFileSync(csvPath, 'utf8');
  const parsed = core.parseCSV(txt);
  assert.equal(parsed.rows.length, 25 * 116, '25 板 × 116 焊墊 = 2900 列');

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

test('6.1 verdict-sim-expected.json 期望檔存在且結構合法', () => {
  const expPath = path.join(import.meta.dirname, 'fixtures', 'verdict-sim-expected.json');
  assert.ok(fs.existsSync(expPath), 'verdict-sim-expected.json 應存在');
  const expected = JSON.parse(fs.readFileSync(expPath, 'utf8'));
  const runs = expected.runs || expected;

  const keyMap = {
    '25_shift0': runs['nb25_s0'] || runs['25_shift0'],
    '50_shift0': runs['nb50_s0'] || runs['50_shift0'],
    '25_shift3': runs['nb25_s3'] || runs['25_shift3'],
    '50_shift3': runs['nb50_s3'] || runs['50_shift3']
  };

  for (const [key, data] of Object.entries(keyMap)) {
    assert.ok(data, `應包含 ${key} 設定`);
    const seeds = Array.isArray(data) ? data : data.seeds;
    assert.equal(seeds.length, 200, `${key} 應有 200 個 seed`);
    const okCount = seeds.filter(x => x.level === 'ok').length;
    const okRate = okCount / 200;
    if (key === '25_shift0') assert.ok(okRate >= 0.77, `25_shift0 正常率應 >= 77%，實測 ${okRate}`);
    if (key === '50_shift0') assert.ok(okRate >= 0.78, `50_shift0 正常率應 >= 78%，實測 ${okRate}`);
    if (key === '25_shift3') assert.ok(okRate <= 0.05, `25_shift3 正常率應 <= 5%，實測 ${okRate}`);
    if (key === '50_shift3') assert.ok(okRate <= 0.05, `50_shift3 正常率應 <= 5%，實測 ${okRate}`);
  }
});

const isSlow = process.env.RUN_SLOW === '1';

test('[slow] 6.1 整體判定模擬：seed 1–200 蒙地卡羅驗收（25/50 板、SHIFT 0/3）', { skip: !isSlow && '整體判定模擬標記為 slow，執行 npm run test:slow 進行驗收' }, () => {
  const expPath = path.join(import.meta.dirname, 'fixtures', 'verdict-sim-expected.json');
  const expected = JSON.parse(fs.readFileSync(expPath, 'utf8'));
  const runs = expected.runs || expected;

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
    for (let s = 1; s <= 200; s++) {
      const rows = generateStableData({ nb: cfg.nb, shift: cfg.shift, stroke: true, seed: s });
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
    }

    const rate = okCount / 200;
    assert.ok(rate >= cfg.minOkRate, `${cfg.key} 正常率 ${rate} 應 >= ${cfg.minOkRate}`);
    assert.ok(rate <= cfg.maxOkRate, `${cfg.key} 正常率 ${rate} 應 <= ${cfg.maxOkRate}`);
  }
});
