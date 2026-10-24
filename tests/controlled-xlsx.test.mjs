import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseXlsx } from '../lib/xlsx-table.mjs';

test('server parses the original XLSX and selects the measurement worksheet', () => {
  const bytes = readFileSync(new URL('./fixtures/spi-sample.xlsx', import.meta.url));
  const table = parseXlsx(bytes);
  assert.ok(table.head.some(name => /board/i.test(name)));
  assert.equal(table.data.length, 240);
  assert.ok(table.data.some(row => row.some(value => /^\d{4}-\d{2}-\d{2}/.test(value))));
});

test('server rejects a non-XLSX byte stream before creating a record', () => {
  assert.throws(() => parseXlsx(new TextEncoder().encode('not a ZIP')), /不是有效的 \.xlsx/);
});
