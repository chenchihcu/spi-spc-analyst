import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  buildRecordInsertSql,
  buildShareInsertSql,
  buildAuditInsertSql,
  isShareKey,
  MAX_BYTES_PER_STMT,
} from '../tools/migration-sql.mjs';

test('新匯入工具分批生成 SQL：每句 < 100 KB 且參數 (欄位值) < 100', () => {
  const mockRecords = Array.from({ length: 100 }, (_, i) => ({
    id: `rec_${String(i).padStart(18, '0')}`,
    kind: 'csv',
    part: `PART-${i}`,
    rev: 'A',
    lot: `LOT-${i}`,
    side: 'TOP',
    vendor: 'LIRONG',
    place_id: '',
    name: `測試紀錄-${i}`,
    user: 'tester@example.com',
    created: 1700000000000 + i * 1000,
    bytes: 50000 + i,
    gz_bytes: 12000,
    sha256: 'a'.repeat(64),
    meta: { notes: `測試內容備註 ${i}` },
  }));

  const stmts = buildRecordInsertSql(mockRecords);
  assert.ok(stmts.length > 1, '應分批生成多個 SQL 語句');
  for (const s of stmts) {
    assert.ok(Buffer.byteLength(s, 'utf8') < 100 * 1024, '每句 SQL 長度需 < 100 KB');
    // records 一列 15 欄位，檢查 VALUES 後每句包含的列數 <= 6 (90 個值)
    const valuesPart = (s.split('VALUES ')[1] || '').split(' ON CONFLICT')[0];
    const rowCount = (valuesPart.match(/\([^\)]+\)/g) || []).length;
    assert.ok(rowCount <= 6 && rowCount > 0, '每句最多 6 列，保證參數值 < 100');
    assert.match(s, /INSERT INTO records/);
    assert.match(s, /ON CONFLICT\(id\) DO NOTHING/);
  }

  const mockShares = Array.from({ length: 50 }, (_, i) => ({
    id: `share_${String(i).padStart(16, '0')}`,
    user: 'user@example.com',
    name: `分享回合-${i}`,
    created: 1700000000000,
    exp: 1702592000000,
    bytes: 2048,
  }));
  const shareStmts = buildShareInsertSql(mockShares);
  for (const s of shareStmts) {
    assert.ok(Buffer.byteLength(s, 'utf8') < 100 * 1024);
    assert.match(s, /INSERT INTO shares/);
    assert.match(s, /ON CONFLICT\(id\) DO NOTHING/);
  }

  const mockAudits = Array.from({ length: 50 }, (_, i) => ({
    at: 1700000000000 + i,
    by: 'migration',
    action: 'migrate_exclude',
    target_type: 'record',
    target_id: `rec_${i}`,
    detail: { reason: 'exclude-lot' },
    src_key: `exclude:record:rec_${i}`,
  }));
  const auditStmts = buildAuditInsertSql(mockAudits);
  for (const s of auditStmts) {
    assert.ok(Buffer.byteLength(s, 'utf8') < 100 * 1024);
    assert.match(s, /INSERT INTO audit_log/);
    assert.match(s, /ON CONFLICT\(src_key\)/);
  }
});

test('非分享鍵不匯入：嚴格檢查 22 字元 base64url 格式 ID_RE', () => {
  // 規格 ID_RE: /^[A-Za-z0-9_-]{22}$/
  assert.equal(isShareKey('abcABC1234567890_-xyzQ'), true);
  assert.equal(isShareKey('share-cleanup'), false);
  assert.equal(isShareKey('maint-lock'), false);
  assert.equal(isShareKey('shortKey'), false);
  assert.equal(isShareKey('tooLongKey123456789012345'), false);
  assert.equal(isShareKey('invalid!char$in#key1234'), false);
});
