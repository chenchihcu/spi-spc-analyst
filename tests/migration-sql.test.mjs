import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { sql, utf8Chunks, SQL_CHUNK_BYTES } from '../tools/migration-sql.mjs';

test('large Unicode record index is split into safe SQL commands without changing bytes', () => {
  const source = JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ id: i, name: `焊墊-${i}-測試` })));
  assert.ok(Buffer.byteLength(source) > 50_000);
  assert.ok(Buffer.byteLength(sql(source)) > 100_000);
  const chunks = [...utf8Chunks(source)];
  assert.equal(chunks.join(''), source);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk) <= SQL_CHUNK_BYTES);
    const command = `UPDATE objects SET body=body||${sql(chunk)} WHERE store=${sql('spi-records')} AND key=${sql('index.json')}`;
    assert.ok(Buffer.byteLength(command) < 32_000);
  }
});
