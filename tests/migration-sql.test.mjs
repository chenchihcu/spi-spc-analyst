import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  buildRecordInsertSql,
  buildShareInsertSql,
  buildAuditInsertSql,
  buildDeleteAuditSql,
  buildDeleteRecordSql,
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
  const deleteStmts = buildDeleteAuditSql(['exclude:record:rec1', 'exclude:share:share1']);
  assert.equal(deleteStmts.length, 1);
  assert.match(deleteStmts[0], /DELETE FROM audit_log WHERE src_key IN \('exclude:record:rec1', 'exclude:share:share1'\);/);
});

test('D-2: 排除清單減少時的 parseImportPlan 行為', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { parseImportPlan } = await import('../tools/migrate-netlify-blobs.mjs');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'd2-test-'));
  try {
    await fs.mkdir(path.join(tmpDir, 'objects'), { recursive: true });
    const manifest = {
      exportTime: 1700000000000,
      entries: [
        { store: 'spi-records', key: 'index.json', filename: 'objects/index.json' },
        { store: 'spi-records', key: 'f/rec_cancel', filename: 'objects/rec_cancel.bin' },
        { store: 'spi-records', key: 'f/rec_kept', filename: 'objects/rec_kept.bin' },
      ],
    };
    const indexRecords = [
      { id: 'rec_cancel', lot: 'LOT_CANCEL', part: 'P1' },
      { id: 'rec_kept', lot: 'LOT_KEPT', part: 'P2' },
    ];
    await fs.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(tmpDir, 'objects', 'index.json'), JSON.stringify(indexRecords));
    await fs.writeFile(path.join(tmpDir, 'objects', 'rec_cancel.bin'), Buffer.from('data1'));
    await fs.writeFile(path.join(tmpDir, 'objects', 'rec_kept.bin'), Buffer.from('data2'));

    // 既有 exclude 為 rec_cancel 與 rec_kept；本次排除清單只剩 rec_kept（rec_cancel 取消排除）
    const plan = await parseImportPlan(tmpDir, {
      excludeLots: ['LOT_KEPT'],
      existingExcludes: ['exclude:record:rec_cancel', 'exclude:record:rec_kept'],
    });

    assert.equal(plan.plannedRecords.length, 1, 'rec_cancel 應被排入 plannedRecords');
    assert.equal(plan.plannedRecords[0].id, 'rec_cancel');
    assert.equal(plan.excludedRecords.length, 1, 'rec_kept 應維持排除');
    assert.deepEqual(plan.deletedExcludeKeys, ['exclude:record:rec_cancel'], 'rec_cancel 簿記列應被刪除');

    // 若取消排除但原始檔缺失（模擬 --since 遺失 raw 物件），dry-run 應拋出明確錯誤
    const manifestMissing = {
      exportTime: 1700000000000,
      entries: [
        { store: 'spi-records', key: 'index.json', filename: 'objects/index.json' },
        { store: 'spi-records', key: 'f/rec_kept', filename: 'objects/rec_kept.bin' },
      ],
    };
    await fs.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifestMissing));
    await assert.rejects(
      async () => {
        await parseImportPlan(tmpDir, {
          excludeLots: [],
          existingExcludes: ['exclude:record:rec_cancel'],
        });
      },
      /缺少原始檔 f\/rec_cancel，無法取消排除，請改用完整匯出/
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('E-2: Netlify 端刪除比對與 D1 清空後行為', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { parseImportPlan } = await import('../tools/migrate-netlify-blobs.mjs');

  const deleteRecordStmts = buildDeleteRecordSql(['rec_del1', 'rec_del2']);
  assert.equal(deleteRecordStmts.length, 1);
  assert.match(deleteRecordStmts[0], /DELETE FROM records WHERE id IN \('rec_del1', 'rec_del2'\);/);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2-test-'));
  try {
    await fs.mkdir(path.join(tmpDir, 'objects'), { recursive: true });
    // 前次匯出有 rec1 與 rec2
    const previousManifest = {
      exportTime: 1690000000000,
      entries: [
        { store: 'spi-records', key: 'f/rec1' },
        { store: 'spi-records', key: 'f/rec2' },
      ],
    };

    // 本次匯出只有 rec1 (rec2 已在 Netlify 刪除)
    const manifest = {
      exportTime: 1700000000000,
      entries: [
        { store: 'spi-records', key: 'index.json', filename: 'objects/index.json' },
        { store: 'spi-records', key: 'f/rec1', filename: 'objects/rec1.bin' },
      ],
    };
    const indexRecords = [{ id: 'rec1', lot: 'L1', part: 'P1' }];
    await fs.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(tmpDir, 'objects', 'index.json'), JSON.stringify(indexRecords));
    await fs.writeFile(path.join(tmpDir, 'objects', 'rec1.bin'), Buffer.from('data1'));

    // 情境 1: D1 中仍有 rec2 -> 工具應計畫刪除 rec2 並寫 sync-del:rec2
    const planWithD1 = await parseImportPlan(tmpDir, {
      previousManifest,
      existingRecordIds: ['rec1', 'rec2'],
    });
    assert.deepEqual(planWithD1.syncDelRecords, ['rec2']);
    assert.equal(planWithD1.syncDelAudits.length, 1);
    assert.equal(planWithD1.syncDelAudits[0].src_key, 'sync-del:rec2');

    // 情境 2 (D-59 / E-2 驗收): D1 清空後 (existingRecordIds 為空) -> 不會誤產生 sync-del，也不會失敗
    const planEmptyD1 = await parseImportPlan(tmpDir, {
      previousManifest,
      existingRecordIds: [],
    });
    assert.deepEqual(planEmptyD1.syncDelRecords, [], 'D1 沒有該紀錄時應略過，不寫 sync-del');
    assert.equal(planEmptyD1.syncDelAudits.length, 0);

    // 情境 3: plannedRecord 缺原始檔時，dry-run 必須拋出錯誤
    const badManifest = {
      exportTime: 1700000000000,
      entries: [
        { store: 'spi-records', key: 'index.json', filename: 'objects/index.json' },
      ],
    };
    await fs.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(badManifest));
    await assert.rejects(
      async () => {
        await parseImportPlan(tmpDir, {
          existingRecordIds: [], // D1 尚未有此紀錄，需要匯入
        });
      },
      /缺少原始檔 f\/rec1，無法匯入，請改用完整匯出/
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
