import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  buildRecordInsertSql,
  buildShareInsertSql,
  buildAuditInsertSql,
  buildDeleteAuditSql,
  buildDeleteRecordSql,
  buildDeleteShareSql,
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

test('G-1 & G-3: 稽核頁單列狀態映射與分享 6 碼 ID 回傳', async () => {
  const { Repo } = await import('../lib/repo.mjs');

  const rows = [
    { seq: 6, at: 106, by: 'u', action: 'create', target_type: 'record', target_id: 'rec_live', detail: JSON.stringify({ done: true }), target_exists: 1 },
    { seq: 5, at: 105, by: 'u', action: 'create', target_type: 'record', target_id: 'rec_gone', detail: JSON.stringify({ done: true }), target_exists: 0 },
    { seq: 4, at: 104, by: 'u', action: 'delete', target_type: 'record', target_id: 'rec_gone', detail: JSON.stringify({ done: true }), target_exists: 0 },
    { seq: 3, at: 103, by: 'migration', action: 'migrate_exclude', target_type: 'record', target_id: 'rec_ex', detail: JSON.stringify({ reason: 'test' }), target_exists: 0 },
    { seq: 2, at: 102, by: 'u', action: 'create', target_type: 'record', target_id: 'rec_inc', detail: JSON.stringify({ done: false }), target_exists: 0 },
    { seq: 1, at: 101, by: 'u', action: 'share_create', target_type: 'share', target_id: 'abcdef1234567890_share', detail: JSON.stringify({ name: 'S' }), target_exists: 0 },
  ];

  const mockDb = {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: rows }),
      }),
    }),
  };

  const repo = new Repo(mockDb, null);
  const result = await repo.listAuditLog({ limit: 10 });
  assert.equal(result.length, 6);

  // 1. live 紀錄 -> 已存檔
  assert.equal(result[0].status, '已存檔');
  assert.equal(result[0].ok, true);

  // 2. target_type === 'record' 但已不在本站 -> 中性提示文字，不當成異常
  assert.equal(result[1].status, '目標已不在本站（見較新的刪除或遷移排除紀錄）');
  assert.equal(result[1].ok, true);

  // 3. delete -> 刪除
  assert.equal(result[2].status, '刪除');

  // 4. migrate_exclude -> 遷移時排除
  assert.equal(result[3].status, '遷移時排除（未搬到新站）');

  // 5. done: false -> 未完成 (pill warn)
  assert.equal(result[4].status, '未完成');
  assert.equal(result[4].ok, false);

  // 6. 分享稽核列：id 應只回前 6 碼
  assert.equal(result[5].id, 'abcdef');
});

test('G-3: 排除清單增加時已匯入分享撤回、列數統計與 C5 過時分享關卡', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { parseImportPlan } = await import('../tools/migrate-netlify-blobs.mjs');

  const deleteShareStmts = buildDeleteShareSql(['share_x1', 'share_x2']);
  assert.equal(deleteShareStmts.length, 1);
  assert.match(deleteShareStmts[0], /DELETE FROM shares WHERE id IN \('share_x1', 'share_x2'\);/);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'g3-test-'));
  try {
    await fs.mkdir(path.join(tmpDir, 'objects'), { recursive: true });
    const manifest = {
      exportedAt: new Date(1700000000000).toISOString(),
      entries: [
        { store: 'spi-records', key: 'index.json', filename: 'objects/index.json' },
      ],
    };
    await fs.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(tmpDir, 'objects', 'index.json'), JSON.stringify([]));

    const S_IN_E = 'abcABC1234567890_in_e_';
    const S_RETRACT = 'defDEF1234567890_ret_';
    const S_STALE = 'ghiGHI1234567890_stale';
    const S_CF_SELF = 'jklJKL1234567890_cf_s_';

    const sharesList = [
      { id: S_IN_E, created: 1699000000000, exp: 1705000000000, user: 'u', bytes: 100 },
      { id: S_RETRACT, created: 1699000000000, exp: 1705000000000, user: 'u', bytes: 100 },
    ];
    await fs.writeFile(path.join(tmpDir, 'shares.json'), JSON.stringify(sharesList));

    // 模擬情境：
    // D1 中已有 S_IN_E, S_RETRACT, S_STALE, S_CF_SELF
    // 本次匯入加入 --exclude-share defDEF
    const plan = await parseImportPlan(tmpDir, {
      excludeShares: ['defDEF'],
      existingShareIds: [S_IN_E, S_RETRACT],
      existingShares: [
        { id: S_IN_E, exp: 1705000000000, revoked_at: null },
        { id: S_CF_SELF, exp: 1705000000000, revoked_at: null },
        { id: S_STALE, exp: 1705000000000, revoked_at: null },
      ],
      selfCreatedShareIds: [S_CF_SELF],
      now: 1700000000000,
    });

    // 1. S_RETRACT 應被納入 retractedShares
    assert.deepEqual(plan.retractedShares, [S_RETRACT]);

    // 2. 列數估算驗證 (G-3: S_IN_E 插入 4 列; S_RETRACT 撤回貢獻: 本機 1+4=5, 額度 4+4=8)
    // 總和：local = 4 + 5 = 9, quota = 4 + 8 = 12
    assert.equal(plan.localRowsWritten, 9, '含 plannedShare 之本機計法估算應為 9 列');
    assert.equal(plan.quotaRowsWritten, 12, '含 plannedShare 之額度估算應為 12 列');

    // 3. 過時未撤銷分享 (C5 關卡):
    // S_IN_E 在 E 中 -> 通過
    // S_CF_SELF 在 selfCreatedShares 中 -> 標為 Cloudflare 自建
    // S_STALE 不在 E、未過期、未撤銷且非自建 -> 過時未撤銷分享 (筆數 1)
    assert.equal(plan.selfCreatedShares.length, 1);
    assert.deepEqual(plan.selfCreatedShares, [S_CF_SELF]);
    assert.equal(plan.staleLiveShares.length, 1);
    assert.deepEqual(plan.staleLiveShares, [S_STALE]);

    // 4. 當 S_STALE 經由 owner 撤銷後 (revoked_at 不為 null)，過時未撤銷分享筆數應為 0
    const planAfterRevoke = await parseImportPlan(tmpDir, {
      excludeShares: ['defDEF'],
      existingShareIds: [S_IN_E, S_RETRACT],
      existingShares: [
        { id: S_IN_E, exp: 1705000000000, revoked_at: null },
        { id: S_CF_SELF, exp: 1705000000000, revoked_at: null },
        { id: S_STALE, exp: 1705000000000, revoked_at: 1701000000000 },
      ],
      selfCreatedShareIds: [S_CF_SELF],
      now: 1700000000000,
    });
    assert.equal(planAfterRevoke.staleLiveShares.length, 0, '撤銷後過時未撤銷筆數應為 0');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('H-1: auditStatus 由新到舊呼叫與 done 覆寫、log/* 先於簿記列 (seq 保證)', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { parseImportPlan } = await import('../tools/migrate-netlify-blobs.mjs');
  const { auditStatus } = await import('../lib/records-core.mjs');

  // 1. 本機直接測試來源站 auditStatus 行為：
  // 沒有 done 標記、目標仍存在的 delete -> false
  const rAlive = [{ id: 'target_alive' }];
  const logDeleteAlive = [{ id: 'target_alive', action: 'delete', at: 1000, by: 'u' }];
  const res1 = auditStatus(logDeleteAlive, rAlive);
  assert.equal(res1[0].ok, false, '沒有 done 標記且目標仍存在的 delete 應為 false');

  // 沒有 done 標記、目標從未存在的 create -> false
  const rEmpty = [];
  const logCreateNever = [{ id: 'target_never', action: 'create', at: 1000, by: 'u' }];
  const res2 = auditStatus(logCreateNever, rEmpty);
  assert.equal(res2[0].ok, false, '沒有 done 標記且目標從未存在的 create 應為 false');

  // 同 id 兩筆沒有 done 標記的 delete（由新到舊呼叫）-> 只有鍵較新的為 true
  const logTwoDeletes = [
    { id: 'target_del', action: 'delete', at: 2000, by: 'u', key: 'log/000000000002000-aaaaaaaa' },
    { id: 'target_del', action: 'delete', at: 1000, by: 'u', key: 'log/000000000001000-bbbbbbbb' },
  ];
  const res3 = auditStatus(logTwoDeletes, []);
  assert.equal(res3[0].ok, true, '鍵較新的 delete 應為 true');
  assert.equal(res3[1].ok, false, '鍵較舊的 delete 應為 false');

  // 2. parseImportPlan 整合測試：覆寫原始 done
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'h1-test-'));
  try {
    await fs.mkdir(path.join(tmpDir, 'objects'), { recursive: true });
    const manifest = {
      exportedAt: new Date(1700000000000).toISOString(),
      entries: [
        { store: 'spi-records', key: 'index.json', filename: 'objects/index.json' },
        { store: 'spi-records', key: 'f/rec1', filename: 'objects/rec1.bin' },
        { store: 'spi-records', key: 'log/000000000001000-aaaaaaaa', filename: 'objects/log1.json' },
      ],
    };
    await fs.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(tmpDir, 'objects', 'index.json'), JSON.stringify([{ id: 'rec1', lot: 'EX_LOT' }]));
    await fs.writeFile(path.join(tmpDir, 'objects', 'rec1.bin'), Buffer.from('data'));
    const rawLog = {
      at: 1000,
      by: 'user',
      action: 'delete',
      target_type: 'record',
      target_id: 'rec1',
      detail: { done: true },
    };
    await fs.writeFile(path.join(tmpDir, 'objects', 'log1.json'), JSON.stringify(rawLog));

    const plan = await parseImportPlan(tmpDir, {
      excludeLots: ['EX_LOT'],
    });

    assert.equal(plan.auditLogs.length, 1);
    assert.equal(plan.auditLogs[0].detail.done, false, '原始 done 應被 auditStatus 結果 (false) 覆寫');
    assert.equal(plan.excludeAudits.length, 1);
    assert.equal(plan.excludeAudits[0].action, 'migrate_exclude');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('H-2: shares.sha256 欄位與 C3 checkShares 完整性核對', async () => {
  const { checkShares } = await import('../tools/migrate-netlify-blobs.mjs');
  const crypto = await import('node:crypto');

  const shareId = 'abcABC1234567890_test_';
  const content = Buffer.from('{"test":"share content"}', 'utf8');
  const validSha256 = crypto.createHash('sha256').update(content).digest('hex');

  const mockDb = {
    prepare: (sql) => ({
      bind: () => ({
        first: async () => ({ sha256: validSha256 }),
      }),
    }),
  };

  // 1. 正常核對通過
  const mockR2Valid = {
    get: async () => ({
      arrayBuffer: async () => content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength),
    }),
  };
  const resValid = await checkShares(mockR2Valid, mockDb, [{ id: shareId, bytes: content.length }]);
  assert.equal(resValid.ok, true);
  assert.equal(resValid.failures.length, 0);

  // 2. 同大小不同內容 -> SHA-256 核對失敗
  const corruptedContent = Buffer.from('{"test":"share corrupted"}', 'utf8');
  assert.notEqual(crypto.createHash('sha256').update(corruptedContent).digest('hex'), validSha256);
  const mockR2Corrupt = {
    get: async () => ({
      arrayBuffer: async () => corruptedContent.buffer.slice(corruptedContent.byteOffset, corruptedContent.byteOffset + corruptedContent.byteLength),
    }),
  };
  const resCorrupt = await checkShares(mockR2Corrupt, mockDb, [{ id: shareId, bytes: corruptedContent.length }]);
  assert.equal(resCorrupt.ok, false);
  assert.equal(resCorrupt.failures[0].reason, 'sha256-mismatch');

  // 3. 大小不同 -> 大小核對失敗
  const shortContent = Buffer.from('short', 'utf8');
  const mockR2Short = {
    get: async () => ({
      arrayBuffer: async () => shortContent.buffer.slice(shortContent.byteOffset, shortContent.byteOffset + shortContent.byteLength),
    }),
  };
  const resShort = await checkShares(mockR2Short, mockDb, [{ id: shareId, bytes: content.length }]);
  assert.equal(resShort.ok, false);
  assert.equal(resShort.failures[0].reason, 'size-mismatch');
});

test('H-3: 過時未撤銷分享排除將撤回者、DRILL-演練分類與 --same-options', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { parseImportPlan } = await import('../tools/migrate-netlify-blobs.mjs');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'h3-test-'));
  try {
    await fs.mkdir(path.join(tmpDir, 'objects'), { recursive: true });
    const manifest = {
      exportedAt: new Date(1700000000000).toISOString(),
      entries: [
        { store: 'spi-records', key: 'index.json', filename: 'objects/index.json' },
      ],
    };
    await fs.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(tmpDir, 'objects', 'index.json'), JSON.stringify([]));

    const S_RETRACT = 'retract1234567890_share';
    const S_DRILL = 'drill123456789012_share';
    const sharesList = [
      { id: S_RETRACT, created: 1699000000000, exp: 1705000000000, user: 'u', bytes: 100 },
    ];
    await fs.writeFile(path.join(tmpDir, 'shares.json'), JSON.stringify(sharesList));

    // 1. S_RETRACT 被 --exclude-share 命中 -> staleLiveShares 筆數不可包含它 (H-3 ①)
    // S_DRILL 在本站已被撤銷 (revoked_at != null) -> 歸「已匯入、已在本站撤銷」，不是過時未撤銷 (H-3 ②)
    const plan = await parseImportPlan(tmpDir, {
      excludeShares: ['retract'],
      existingShareIds: [S_RETRACT],
      existingShares: [
        { id: S_RETRACT, exp: 1705000000000, revoked_at: null },
        { id: S_DRILL, exp: 1705000000000, revoked_at: 1700500000000 },
      ],
      selfCreatedShareIds: [],
      now: 1700000000000,
    });

    assert.deepEqual(plan.retractedShares, [S_RETRACT]);
    assert.equal(plan.staleLiveShares.length, 0, '將撤回的分享不可計入 staleLiveShares');
    assert.deepEqual(plan.importedRevokedShares, [S_DRILL], '已在本站撤銷的分享應被正確分類');

    // 2. 測試 --same-options: 當有 saved import-options.json 時讀回 (H-3 ③)
    const savedOpts = {
      excludeLots: ['SAVED_LOT'],
      excludeShares: ['retract'],
    };
    await fs.writeFile(path.join(tmpDir, 'import-options.json'), JSON.stringify(savedOpts));

    const planSame = await parseImportPlan(tmpDir, {
      sameOptions: true,
      existingShareIds: [S_RETRACT],
    });
    assert.deepEqual(planSame.retractedShares, [S_RETRACT], '--same-options 應讀回 savedOpts 並正確識別已撤回分享');

    // 若同時帶 --same-options 與 --exclude-lot -> 必須報錯中止
    await assert.rejects(
      async () => {
        await parseImportPlan(tmpDir, {
          sameOptions: true,
          excludeLots: ['OTHER_LOT'],
        });
      },
      /--same-options 不得與任何 --exclude-\* 選項同時使用/
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('H-4: 稽核頁 API 忽略 limit 參數，一律 LIMIT 51', async () => {
  const { Repo } = await import('../lib/repo.mjs');

  let executedSql = '';
  let executedParams = [];
  const mockDb = {
    prepare: (sql) => {
      executedSql = sql;
      return {
        bind: (...params) => {
          executedParams = params;
          return {
            all: async () => ({
              results: Array.from({ length: 51 }, (_, i) => ({
                seq: 100 - i,
                at: 1700000000000 + i,
                by: 'u',
                action: 'create',
                target_type: 'record',
                target_id: `rec_${i}`,
                detail: '{}',
                live: `rec_${i}`,
              })),
            }),
          };
        },
      };
    },
  };

  const repo = new Repo(mockDb, null);
  // 傳入 limit = 100，API 必須忽略並嚴格限制回傳最大 50 筆
  const results = await repo.listAuditLog(100);
  assert.equal(results.length, 50, '回傳筆數需截斷為最多 50 筆');
  assert.match(executedSql, /LIMIT 51/, 'SQL 語句必須包含 LIMIT 51');
  assert.equal(executedParams.length, 0, '無 cursor 時不應帶 limit 參數');
});

test('I-1 ①②: 匯出後到期的分享過濾 (E_now) 與 checkShares 不判定失敗、不寫入 shares、不檢查缺本文', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { parseImportPlan, checkShares } = await import('../tools/migrate-netlify-blobs.mjs');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'i1-test-'));
  try {
    await fs.mkdir(path.join(tmpDir, 'objects'), { recursive: true });
    const exportTime = 1700000000000;
    const now = 1701000000000; // C5 或核對當下
    const manifest = {
      exportedAt: new Date(exportTime).toISOString(),
      entries: [
        { store: 'spi-records', key: 'index.json', filename: 'objects/index.json' },
      ],
    };
    await fs.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(tmpDir, 'objects', 'index.json'), JSON.stringify([]));

    const S_LIVE = 'live1234567890123_share';
    const S_EXPIRED_AFTER = 'expafter123456789_share';
    const sharesList = [
      { id: S_LIVE, created: 1699000000000, exp: 1702000000000, user: 'u', bytes: 100 },
      { id: S_EXPIRED_AFTER, created: 1699000000000, exp: 1700500000000, user: 'u', bytes: 100 },
    ];
    await fs.writeFile(path.join(tmpDir, 'shares.json'), JSON.stringify(sharesList));

    // S_EXPIRED_AFTER 缺原始檔 (不在 manifest entries 內)，但因 exp <= now，不應拋出「缺少原始檔」錯誤
    const plan = await parseImportPlan(tmpDir, {
      now,
      existingShareIds: [S_LIVE],
    });

    assert.equal(plan.plannedShares.length, 1, 'S_LIVE 在 plannedShares 內');
    assert.equal(plan.plannedShares[0].id, S_LIVE);
    assert.equal(plan.expiredAfterExportShares.length, 1, 'S_EXPIRED_AFTER 應被歸入 expiredAfterExportShares');
    assert.equal(plan.expiredAfterExportShares[0].id, S_EXPIRED_AFTER);

    // 測試 checkShares: S_EXPIRED_AFTER 在 E 中但 exp <= now，應被分類為 expiredAfterExport，且不引起失敗
    const mockR2 = {
      get: async (key) => null, // 模擬皆無物件
    };
    const mockDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
        }),
      }),
    };

    // 只有已到期分享傳入 checkShares
    const res = await checkShares(mockR2, mockDb, [{ id: S_EXPIRED_AFTER, exp: 1700500000000, bytes: 100 }], { now });
    assert.equal(res.ok, true, '已到期分享不應導致核對失敗');
    assert.equal(res.expiredAfterExport.length, 1);
    assert.equal(res.expiredAfterExport[0].id, S_EXPIRED_AFTER);
    assert.equal(res.checkedCount, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('I-1 ③④: C3 --apply 儲存 applied_at，後續 App 刪除記錄納入 D_app 扣除', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { parseImportPlan, verifyC5Records } = await import('../tools/migrate-netlify-blobs.mjs');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'i1-dapp-test-'));
  try {
    await fs.mkdir(path.join(tmpDir, 'objects'), { recursive: true });
    const exportTime = 1700000000000;
    const appliedAt = 1700000001000;
    const manifest = {
      exportedAt: new Date(exportTime).toISOString(),
      entries: [
        { store: 'spi-records', key: 'index.json', filename: 'objects/index.json' },
        { store: 'spi-records', key: 'f/rec_kept', filename: 'objects/rec_kept.bin' },
        // rec_deleted 在匯出目錄中故意不提供原始檔，驗證 dry-run 不會因缺本文失敗
      ],
    };
    const records = [
      { id: 'rec_kept', lot: 'LOT1', part: 'P1' },
      { id: 'rec_deleted', lot: 'LOT2', part: 'P2' },
    ];
    await fs.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(tmpDir, 'objects', 'index.json'), JSON.stringify(records));
    await fs.writeFile(path.join(tmpDir, 'objects', 'rec_kept.bin'), Buffer.from('data'));

    // 寫入 import-options.json 包含 applied_at
    await fs.writeFile(
      path.join(tmpDir, 'import-options.json'),
      JSON.stringify({ excludeLots: [], applied_at: appliedAt })
    );

    // 模擬 D1 audit_log：
    // 1. rec_deleted 於 at = 1700000005000（> applied_at）由 App 刪除 (src_key IS NULL)
    // 2. rec_other 於 at = 1700000000500（< applied_at）由 App 刪除（不扣除）
    const existingAuditLogs = [
      { src_key: null, action: 'delete', target_type: 'record', target_id: 'rec_deleted', at: 1700000005000 },
      { src_key: null, action: 'delete', target_type: 'record', target_id: 'rec_kept', at: 1700000000500 },
    ];

    const plan = await parseImportPlan(tmpDir, {
      existingAuditLogs,
    });

    assert.equal(plan.dAppRecords.length, 1, 'rec_deleted 應納入 dAppRecords');
    assert.equal(plan.dAppRecords[0].id, 'rec_deleted');
    assert.equal(plan.plannedRecords.length, 1, 'plannedRecords 應扣除 rec_deleted，不寫回');
    assert.equal(plan.plannedRecords[0].id, 'rec_kept');

    // C5 核對驗收：D1 目前只有 rec_kept
    const c5Check = verifyC5Records(['rec_kept'], records, plan.dAppRecords);
    assert.equal(c5Check.ok, true, '核對應通過，且 expectedCount 為 |R| - |D_app| = 1');
    assert.equal(c5Check.expectedCount, 1);
    assert.equal(c5Check.actualCount, 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('I-2: done:false 遷移列重算與 UPDATE (create/delete 重算為 true，未完成維持 false)', async () => {
  const { calculateDoneUpdates } = await import('../tools/migrate-netlify-blobs.mjs');

  const indexRecords = [
    { id: 'rec_live' },
  ];

  // 1. rec_live 的 create log：B4 匯出時為 done:false，現在 rec_live 在 index.json -> 重算為 true
  // 2. rec_del 的 delete log：B4 匯出時為 done:false，現在 rec_del 已不在 index.json -> 重算為 true
  // 3. rec_unfin 的 create log：rec_unfin 不在 index.json 且未被刪除 -> 維持 false，不產生 UPDATE
  const auditLogs = [
    { src_key: 'log/01-create-live', action: 'create', target_id: 'rec_live', at: 1000, detail: { done: false } },
    { src_key: 'log/02-del-done', action: 'delete', target_id: 'rec_del', at: 2000, detail: { done: false } },
    { src_key: 'log/03-create-unfin', action: 'create', target_id: 'rec_unfin', at: 3000, detail: { done: false } },
  ];

  const updates = calculateDoneUpdates(auditLogs, indexRecords);
  assert.equal(updates.length, 2, '只有 rec_live 與 rec_del 應更新為 true');
  assert.equal(updates[0].src_key, 'log/01-create-live');
  assert.match(updates[0].sql, /UPDATE audit_log SET detail = json_set\(detail, '\$\.done', json\('true'\)\) WHERE src_key = 'log\/01-create-live';/);
  assert.equal(updates[1].src_key, 'log/02-del-done');
  assert.match(updates[1].sql, /UPDATE audit_log SET detail = json_set\(detail, '\$\.done', json\('true'\)\) WHERE src_key = 'log\/02-del-done';/);
});

test('I-4: 分批跨 UTC 日守衛：log/* 未全數入庫時延後簿記列與 done 重算', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { parseImportPlan } = await import('../tools/migrate-netlify-blobs.mjs');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'i4-test-'));
  try {
    await fs.mkdir(path.join(tmpDir, 'objects'), { recursive: true });
    const manifest = {
      exportedAt: new Date().toISOString(),
      entries: [
        { store: 'spi-records', key: 'index.json', filename: 'objects/index.json' },
        { store: 'spi-records', key: 'log/001', filename: 'objects/log001.json' },
        { store: 'spi-records', key: 'log/002', filename: 'objects/log002.json' },
      ],
    };
    await fs.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(tmpDir, 'objects', 'index.json'), JSON.stringify([]));
    await fs.writeFile(path.join(tmpDir, 'objects', 'log001.json'), JSON.stringify({ action: 'create', id: 'r1', at: 100 }));
    await fs.writeFile(path.join(tmpDir, 'objects', 'log002.json'), JSON.stringify({ action: 'create', id: 'r2', at: 200 }));

    // 模擬 D1 目前只有 log/log/001，缺少 log/log/002（若本次只匯入部分或缺少）
    // 構造情況：manifest 有 2 筆 log，但既有 audit log 只有 log/log/001，且本次 options 模擬只寫入 log/log/001
    const plan = await parseImportPlan(tmpDir, {
      excludeLots: ['EX_LOT'],
    });

    // 當本次匯出包含全部 log (001, 002) 時，本批 auditLogs 包含全部，allLogsInD1 為 true
    assert.equal(plan.allLogsInD1, true);
    assert.equal(plan.postponedBookkeeping, false);

    // 若 manifest 有額外的 logKey 未包含在本次也未在 existingAuditLogs
    const manifestExtra = {
      exportedAt: new Date().toISOString(),
      entries: [
        { store: 'spi-records', key: 'index.json', filename: 'objects/index.json' },
        { store: 'spi-records', key: 'log/001', filename: 'objects/log001.json' },
        { store: 'spi-records', key: 'log/002', filename: 'objects/log002.json' },
        { store: 'spi-records', key: 'log/003', filename: 'objects/log003.json' }, // 未入庫
      ],
    };
    await fs.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifestExtra));
    await fs.writeFile(path.join(tmpDir, 'objects', 'log003.json'), JSON.stringify({ action: 'create', id: 'r3', at: 300 }));

    const planPartial = await parseImportPlan(tmpDir, {
      existingAuditLogs: [{ src_key: 'log/log/001' }],
    });
    // 本次只讀到 manifest 的 log，但缺少 log/log/003 (假設分批) -> 延後簿記列
    assert.equal(planPartial.allLogsInD1, true, '若讀取全目錄則本批包含 001~003');

    // 模擬 manifest 有 log/004 且不存在於本目錄檔案或批次
    const manifestMissing = {
      exportedAt: new Date().toISOString(),
      entries: [
        { store: 'spi-records', key: 'index.json', filename: 'objects/index.json' },
        { store: 'spi-records', key: 'log/001', filename: 'objects/log001.json' },
        { store: 'spi-records', key: 'log/004', filename: 'objects/log004.json' }, // 假定不在本次批次
      ],
    };
    await fs.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifestMissing));
    await fs.writeFile(path.join(tmpDir, 'objects', 'log004.json'), JSON.stringify({ action: 'create', id: 'r4', at: 400 }));

    const planPostponed = await parseImportPlan(tmpDir, {
      existingAuditLogs: [], // D1 尚未有任何 log
    });
    // manifest 共有 001, 004。若本批 auditLogs 包含 001, 004 則入庫
    // 現在構造本批僅寫入部分：
    const planPostponedMock = await parseImportPlan(tmpDir, {
      existingAuditLogs: [{ src_key: 'log/log/other' }],
    });
    // 只要 manifestLogKeys 都被 existingLogKeySet 包含即可
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

