import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadCore } = require('./_load.js');

test('受控元件中心不生成焊墊位置；通用格式保留完整位號', () => {
  const core = loadCore();
  const table = core.csvTable('Board,Component ID,PAD ID,Volume(%)\n1,U1_1,1,101\n');
  const map = core.autoMap(table.head);
  const options = { ...core.guessOpts(table.head, map), side: 'TOP',
    place: { controlled: true, items: [{ side: 'TOP', ref: 'U1_1', x: 5, y: 8 }] } };
  const result = core.buildRows(table, map, options);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].comp, 'U1_1');
  assert.equal(result.rows[0].componentX, 5);
  assert.equal(result.rows[0].componentY, 8);
  assert.equal(result.rows[0].x, undefined);
  assert.equal(result.rows[0].y, undefined);
});
