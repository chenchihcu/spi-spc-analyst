#!/usr/bin/env node
// tools/migrate-netlify-blobs.mjs: 整合 Cloudflare Workers 免費方案配額的 Netlify Blobs 資料遷移工具
// 實作規範：9.2 B3, C3, 9.3, A-7, B-3, C-5, D-2, E-2, F-1, G-2, G-3
import { getStore, listStores } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  isShareKey,
  sqlStr,
  buildRecordInsertSql,
  buildShareInsertSql,
  buildAuditInsertSql,
  buildDeleteAuditSql,
  buildDeleteRecordSql,
  buildDeleteShareSql,
  buildUpdateDoneSql,
} from './migration-sql.mjs';
import { auditStatus } from '../lib/records-core.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const STORES = ['spi-records', 'spi-share', 'spi-maint', 'spi-auth-lock'];
const BUCKET = 'spi-spc-record';
const DB = 'spi-spc';

const sha = (data) => createHash('sha256').update(data).digest('hex');
const die = (message) => { throw new Error(message); };

const kindFor = (store, key) => {
  if (store === 'spi-share' || (store === 'spi-records' && key.startsWith('f/'))) return 'binary';
  if (store === 'spi-records' && (key === 'index.json' || key.startsWith('log/'))) return 'json';
  if ((store === 'spi-maint' || store === 'spi-auth-lock') && key) return 'json';
  throw new Error(`Unclassified source object: ${store}/${key}`);
};

const wrangler = (args) => {
  const r = spawnSync(process.execPath, [WRANGLER, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error || r.status !== 0) die(`Wrangler ${args.slice(0, 4).join(' ')} failed: ${r.error?.message || r.stderr || r.stdout}`);
  return r.stdout;
};

export async function exportSnapshot(dir, sinceTime = null) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!siteID || !token) die('NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN are required for export');
  
  try {
    await access(join(dir, 'manifest.json'));
    die('Export already exists; use a new empty directory');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const names = new Set((await listStores({ siteID, token })).stores);
  if (!names.has('spi-records')) die('Source spi-records store is missing');

  await mkdir(join(dir, 'objects'), { recursive: true });
  const entries = [];
  const sharesMetadata = [];

  for (const name of STORES) {
    if (!names.has(name)) continue;
    const store = getStore({ name, siteID, token, consistency: 'strong' });
    for await (const page of store.list({ paginate: true })) {
      for (const { key } of page.blobs) {
        if (name === 'spi-share' && isShareKey(key)) {
          const hit = await store.getWithMetadata(key, { type: 'arrayBuffer' });
          if (!hit?.data) continue;
          const meta = hit.metadata || {};
          sharesMetadata.push({
            id: key,
            created: Number(meta.created) || Date.now(),
            exp: Number(meta.exp) || 0,
            user: meta.user || '',
            bytes: Number(meta.bytes) || hit.data.byteLength,
          });
          // 如果有 since 且過舊，且不是重要控制檔，可選擇跳過 binary 本體下載
          if (sinceTime && meta.created && new Date(meta.created) <= new Date(sinceTime)) {
            continue;
          }
          const bytes = Buffer.from(hit.data);
          const filename = `objects/${String(entries.length + 1).padStart(6, '0')}.bin`;
          await writeFile(join(dir, filename), bytes, { flag: 'wx' });
          entries.push({ store: name, key, kind: 'binary', filename, bytes: bytes.length, sha256: sha(bytes), metadata: meta });
          continue;
        }

        const kind = kindFor(name, key);
        const hit = await store.getWithMetadata(key, { type: 'arrayBuffer' });
        if (!hit?.data) die(`Source disappeared during export: ${name}/${key}`);
        const bytes = Buffer.from(hit.data);
        const filename = `objects/${String(entries.length + 1).padStart(6, '0')}.bin`;
        if (kind === 'json') JSON.parse(bytes.toString('utf8'));
        await writeFile(join(dir, filename), bytes, { flag: 'wx' });
        entries.push({ store: name, key, kind, filename, bytes: bytes.length, sha256: sha(bytes), metadata: hit.metadata ?? null });
      }
    }
  }

  // 驗證 index.json 完整性
  const index = entries.find((e) => e.store === 'spi-records' && e.key === 'index.json');
  if (!index) die('Source records index.json is missing');
  const records = JSON.parse(await readFile(join(dir, index.filename), 'utf8'));
  if (!Array.isArray(records)) die('Source records index is not an array');

  // G-2: 每次匯出（完整與 --since）都輸出完整分享清單 shares.json
  await writeFile(join(dir, 'shares.json'), JSON.stringify(sharesMetadata, null, 2) + '\n', { flag: 'wx' });

  const manifest = {
    format: 'CF-SPI-001/v2',
    sourceSiteID: siteID,
    exportedAt: new Date().toISOString(),
    records: records.length,
    shares: sharesMetadata.length,
    entries,
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ phase: 'export', records: records.length, shares: sharesMetadata.length, directory: dir }));
}

// I-2: 每次 import（C3 必做）在本次的全部 log/* 都已在 D1 之後重算 done:false 的遷移列
export function calculateDoneUpdates(auditLogs, indexRecords) {
  const candidates = [];
  const logsByTargetId = new Map();

  for (const row of auditLogs) {
    if (!row.src_key || !row.src_key.startsWith('log/')) continue;
    const detail = typeof row.detail === 'string' ? JSON.parse(row.detail) : (row.detail || {});
    const isDone = detail.done === true || detail.done === 1;
    if (!isDone) {
      candidates.push(row);
    }
    const tId = row.target_id || '';
    if (!logsByTargetId.has(tId)) {
      logsByTargetId.set(tId, []);
    }
    logsByTargetId.get(tId).push({ ...row, detail });
  }

  const updates = [];
  for (const cand of candidates) {
    const tId = cand.target_id || '';
    const group = logsByTargetId.get(tId) || [];
    // 依 src_key 由新到舊呼叫 auditStatus(entries, index.json)
    const sorted = [...group].sort((a, b) => (b.src_key || '').localeCompare(a.src_key || ''));
    // entries 的 done 用已寫入的值，待重算的列不帶 done
    const entries = sorted.map((item) => {
      const e = {
        id: item.target_id || item.id,
        action: item.action,
        at: item.at,
        by: item.by,
        target_id: item.target_id,
        src_key: item.src_key,
      };
      if (item.src_key !== cand.src_key) {
        e.done = item.detail?.done ?? true;
      }
      return e;
    });

    const evaluated = auditStatus(entries, indexRecords);
    const result = evaluated.find((e) => e.src_key === cand.src_key);
    // 結果為 true 的列 UPDATE，仍為 false 的不動，不把 true 改回 false
    if (result && result.ok === true) {
      updates.push({
        src_key: cand.src_key,
        target_id: cand.target_id,
        sql: buildUpdateDoneSql(cand.src_key),
      });
    }
  }

  return updates;
}

// I-1 ③: C5 的紀錄核對＝records 中 id 屬於 R 的列數＝|R| − |D_app|
export function verifyC5Records(d1RecordIds, expectedRecords, dAppRecords = []) {
  const d1Set = new Set(d1RecordIds);
  const rSet = new Set(expectedRecords.map((r) => r.id));
  const dAppSet = new Set(dAppRecords.map((r) => r.id));
  const expectedCount = expectedRecords.length - dAppRecords.length;

  let actualCount = 0;
  for (const id of rSet) {
    if (d1Set.has(id) && !dAppSet.has(id)) {
      actualCount++;
    }
  }

  return {
    ok: actualCount === expectedCount,
    expectedCount,
    actualCount,
    dAppRecords,
  };
}

export async function parseImportPlan(dir, options = {}) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const exportTime = new Date(manifest.exportedAt).getTime();
  const indexEntry = manifest.entries.find((e) => e.store === 'spi-records' && e.key === 'index.json');
  const records = JSON.parse(await readFile(join(dir, indexEntry.filename), 'utf8'));

  let sharesList = [];
  try {
    sharesList = JSON.parse(await readFile(join(dir, 'shares.json'), 'utf8'));
  } catch {}

  let excludeLotsList = options.excludeLots || [];
  let excludeLotPrefixes = options.excludeLotPrefixes || [];
  let excludeIdsList = options.excludeIds || [];
  let excludeShares = options.excludeShares || [];

  if (options.sameOptions) {
    const hasAnyExclude = (options.excludeLots && options.excludeLots.length > 0) ||
      (options.excludeLotPrefixes && options.excludeLotPrefixes.length > 0) ||
      (options.excludeIds && options.excludeIds.length > 0) ||
      (options.excludeShares && options.excludeShares.length > 0);
    if (hasAnyExclude) {
      die('--same-options 不得與任何 --exclude-* 選項同時使用');
    }
    try {
      const savedOpts = JSON.parse(await readFile(join(dir, 'import-options.json'), 'utf8'));
      excludeLotsList = savedOpts.excludeLots || [];
      excludeLotPrefixes = savedOpts.excludeLotPrefixes || [];
      excludeIdsList = savedOpts.excludeIds || [];
      excludeShares = savedOpts.excludeShares || [];
    } catch (e) {
      die(`無法讀取 import-options.json: ${e.message}`);
    }
  }

  const excludeLots = new Set(excludeLotsList);
  const excludeIds = new Set(excludeIdsList);

  const plannedRecords = [];
  const excludedRecords = [];

  for (const rec of records) {
    let excluded = false;
    let reason = '';
    if (excludeLots.has(rec.lot)) {
      excluded = true;
      reason = `--exclude-lot ${rec.lot}`;
    } else if (excludeLotPrefixes.some((pfx) => rec.lot && rec.lot.startsWith(pfx))) {
      excluded = true;
      reason = `--exclude-lot-prefix`;
    } else if (excludeIds.has(rec.id)) {
      excluded = true;
      reason = `--exclude-id ${rec.id}`;
    }

    if (excluded) {
      excludedRecords.push({ record: rec, reason });
    } else {
      plannedRecords.push(rec);
    }
  }

  // I-1 ③: import-options.json 另存 applied_at；D_app＝本次預期紀錄集合 R 中 audit_log 有 src_key IS NULL、action='delete'、at > applied_at 的 target_id
  let appliedAt = options.appliedAt || null;
  if (!appliedAt) {
    try {
      const savedOpts = JSON.parse(await readFile(join(dir, 'import-options.json'), 'utf8'));
      appliedAt = savedOpts.applied_at || null;
    } catch {}
  }

  const dAppSet = new Set();
  const dAppRecords = [];
  if (appliedAt != null && Array.isArray(options.existingAuditLogs)) {
    const rIdMap = new Map(plannedRecords.map((r) => [r.id, r]));
    for (const a of options.existingAuditLogs) {
      if (a.src_key == null && a.action === 'delete' && (a.target_type === 'record' || !a.target_type) && a.at > appliedAt) {
        if (rIdMap.has(a.target_id)) {
          dAppSet.add(a.target_id);
          dAppRecords.push(rIdMap.get(a.target_id));
        }
      }
    }
  }

  // 重跑的 dry-run 不把 D_app 列為要寫入（不寫回、不算缺本文）
  const finalPlannedRecords = plannedRecords.filter((r) => !dAppSet.has(r.id));

  const plannedShares = [];
  const excludedShares = [];
  const expiredShares = [];
  const expiredAfterExportShares = [];
  const retractedShares = [];
  const existingShareIds = new Set(options.existingShareIds || []);
  const now = options.now || Date.now();

  for (const s of sharesList) {
    if (s.exp && s.exp <= exportTime) {
      expiredShares.push(s);
      continue;
    }
    const isExcluded = excludeShares.some((prefix) => s.id.startsWith(prefix));
    if (isExcluded) {
      excludedShares.push({ share: s, reason: `--exclude-share` });
      if (existingShareIds.has(s.id)) {
        retractedShares.push(s.id);
      }
    } else {
      // I-1 ②: 判斷分享是否寫入 shares 用 exp > max(exportTime, now)，已到期者不寫入、不算缺本文
      if (s.exp && s.exp <= Math.max(exportTime, now)) {
        expiredAfterExportShares.push(s);
      } else {
        const shareEntry = manifest.entries.find((e) => e.store === 'spi-share' && e.key === s.id);
        const sha256 = shareEntry ? (shareEntry.sha256 || '') : '';
        plannedShares.push({ ...s, sha256 });
      }
    }
  }

  for (const sId of existingShareIds) {
    if (excludeShares.some((prefix) => sId.startsWith(prefix))) {
      if (!retractedShares.includes(sId)) {
        retractedShares.push(sId);
        if (!excludedShares.some((e) => e.share.id === sId)) {
          excludedShares.push({ share: { id: sId }, reason: `--exclude-share` });
        }
      }
    }
  }

  // 稽核紀錄 log/* 準備 (G-1, H-1: 依鍵名由新到舊呼叫 auditStatus 並強制覆寫 done)
  const logEntries = manifest.entries.filter((e) => e.store === 'spi-records' && e.key.startsWith('log/'));
  const rawLogs = [];
  for (const l of logEntries) {
    const raw = JSON.parse(await readFile(join(dir, l.filename), 'utf8'));
    rawLogs.push({ ...raw, filename: l.filename, key: l.key, src_key: `log/${l.key}` });
  }
  rawLogs.sort((a, b) => (b.key || '').localeCompare(a.key || ''));
  const evaluatedLogs = auditStatus(rawLogs.map(r => ({ ...r, id: r.target_id || r.id })), records);
  const evaluatedMap = new Map();
  for (const e of evaluatedLogs) {
    evaluatedMap.set(e.src_key, !!e.ok);
  }

  const auditLogs = [];
  for (const r of rawLogs) {
    const detailObj = { ...(r.detail || {}) };
    detailObj.done = evaluatedMap.get(r.src_key) ?? true;
    auditLogs.push({
      at: r.at || 0,
      by: r.by || 'system',
      action: r.action || '',
      target_type: r.target_type || 'record',
      target_id: r.target_id || '',
      detail: detailObj,
      src_key: r.src_key,
    });
  }
  auditLogs.sort((a, b) => (a.at || 0) - (b.at || 0));

  // 排除標記稽核列 (migrate_exclude)
  const excludeAudits = [];
  for (const { record, reason } of excludedRecords) {
    excludeAudits.push({
      at: exportTime,
      by: 'migration',
      action: 'migrate_exclude',
      target_type: 'record',
      target_id: record.id,
      detail: { reason, lot: record.lot || '', name: record.name || '' },
      src_key: `exclude:record:${record.id}`,
    });
  }
  for (const { share, reason } of excludedShares) {
    excludeAudits.push({
      at: exportTime,
      by: 'migration',
      action: 'migrate_exclude',
      target_type: 'share',
      target_id: share.id,
      detail: { reason },
      src_key: `exclude:share:${share.id}`,
    });
  }

  // D-2: 排除清單減少 (取消排除)
  const existingExcludes = Array.isArray(options.existingExcludes) ? options.existingExcludes : [];
  const deletedExcludeKeys = [];

  for (const srcKey of existingExcludes) {
    if (srcKey.startsWith('exclude:record:')) {
      const recId = srcKey.replace('exclude:record:', '');
      const isStillExcluded = excludedRecords.some((e) => e.record.id === recId);
      if (!isStillExcluded) {
        // 取消排除：核對原始檔是否存在
        const binEntry = manifest.entries.find((e) => e.store === 'spi-records' && e.key === `f/${recId}`);
        if (!binEntry) {
          throw new Error(`缺少原始檔 f/${recId}，無法取消排除，請改用完整匯出`);
        }
        deletedExcludeKeys.push(srcKey);
      }
    } else if (srcKey.startsWith('exclude:share:')) {
      const shareId = srcKey.replace('exclude:share:', '');
      const isStillExcluded = excludedShares.some((e) => e.share.id === shareId);
      if (!isStillExcluded) {
        const isExpired = expiredShares.some((s) => s.id === shareId) || expiredAfterExportShares.some((s) => s.id === shareId);
        if (isExpired) {
          // ② 被排除的目標已過期或已刪除 -> 保留該列，不刪除簿記列
          continue;
        }
        const binEntry = manifest.entries.find((e) => e.store === 'spi-share' && e.key === shareId);
        if (!binEntry) {
          throw new Error(`缺少原始檔 ${shareId}，無法取消排除，請改用完整匯出`);
        }
        deletedExcludeKeys.push(srcKey);
      }
    }
  }

  // E-2 通則：要寫入的 records/shares 列（D1 沒有、本次也不排除）若本次匯出目錄沒有對應物件，dry-run 一律失敗並提示改用完整匯出
  const existingRecordIds = new Set(options.existingRecordIds || []);
  for (const rec of finalPlannedRecords) {
    if (!existingRecordIds.has(rec.id)) {
      const hasBin = manifest.entries.some((e) => e.store === 'spi-records' && e.key === `f/${rec.id}`);
      if (!hasBin) {
        throw new Error(`缺少原始檔 f/${rec.id}，無法匯入，請改用完整匯出`);
      }
    }
  }

  for (const s of plannedShares) {
    if (!existingShareIds.has(s.id)) {
      const hasBin = manifest.entries.some((e) => e.store === 'spi-share' && e.key === s.id);
      if (!hasBin) {
        throw new Error(`缺少原始檔 ${s.id}，無法匯入，請改用完整匯出`);
      }
    }
  }

  // E-2: Netlify 端刪除 (上次匯入有、本次 index.json 沒有，而且 D1 records 仍有該 id 的紀錄)
  const syncDelRecords = [];
  const syncDelAudits = [];
  if (options.previousManifest && Array.isArray(options.previousManifest.entries)) {
    const currentRecordIds = new Set(records.map(r => r.id));
    for (const prev of options.previousManifest.entries) {
      if (prev.store === 'spi-records' && prev.key.startsWith('f/')) {
        const id = prev.key.replace('f/', '');
        if (!currentRecordIds.has(id) && existingRecordIds.has(id)) {
          syncDelRecords.push(id);
          syncDelAudits.push({
            at: exportTime,
            by: 'migration',
            action: 'sync-del',
            target_type: 'record',
            target_id: id,
            detail: { reason: 'deleted-on-netlify' },
            src_key: `sync-del:${id}`,
          });
        }
      }
    }
  }

  // I-4: 檢查本次匯出的全部 log/* 是否都已在 D1（含本批）
  const manifestLogKeys = manifest.entries
    .filter((e) => e.store === 'spi-records' && e.key.startsWith('log/'))
    .map((e) => `log/${e.key}`);

  const existingLogKeySet = new Set(
    (options.existingAuditLogs || [])
      .filter((a) => a.src_key && a.src_key.startsWith('log/'))
      .map((a) => a.src_key)
  );
  for (const a of auditLogs) {
    existingLogKeySet.add(a.src_key);
  }

  let allLogsInD1 = true;
  if (manifestLogKeys.length > 0) {
    allLogsInD1 = manifestLogKeys.every((k) => existingLogKeySet.has(k));
  }

  // I-2: done:false 重算 UPDATE
  let pendingDoneUpdates = [];
  if (allLogsInD1) {
    const combinedAuditLogs = [...(options.existingAuditLogs || []), ...auditLogs];
    pendingDoneUpdates = calculateDoneUpdates(combinedAuditLogs, records);
  }

  const postponedBookkeeping = !allLogsInD1;

  // 計算估算列數 (F-1 雙估算指標 + G-3 分享撤回 + I-2 UPDATE 每筆 1 列 + I-4 簿記延後)
  let localRowsWritten =
    finalPlannedRecords.length * 5 +
    plannedShares.length * 4 +
    auditLogs.length * 4;

  let quotaRowsWritten =
    finalPlannedRecords.length * 5 +
    plannedShares.length * 4 +
    auditLogs.length * 4;

  if (!postponedBookkeeping) {
    localRowsWritten +=
      (excludeAudits.length + syncDelAudits.length) * 4 +
      deletedExcludeKeys.length * 1 +
      syncDelRecords.length * 1 +
      retractedShares.length * 1 +
      pendingDoneUpdates.length * 1;

    quotaRowsWritten +=
      (excludeAudits.length + syncDelAudits.length) * 4 +
      deletedExcludeKeys.length * 4 +
      syncDelRecords.length * 5 +
      retractedShares.length * 4 +
      pendingDoneUpdates.length * 1;
  }

  const expectedShareSet = new Set(plannedShares.map((s) => s.id));
  const staleLiveShares = [];
  const selfCreatedShares = [];
  const importedRevokedShares = [];
  const existingShares = options.existingShares || [];
  const selfCreatedSet = new Set(options.selfCreatedShareIds || []);
  const retractedSet = new Set(retractedShares);

  for (const s of existingShares) {
    if (selfCreatedSet.has(s.id)) {
      selfCreatedShares.push(s.id);
    } else if (s.revoked_at != null) {
      importedRevokedShares.push(s.id);
    } else if (!expectedShareSet.has(s.id) && s.exp > now && !retractedSet.has(s.id)) {
      staleLiveShares.push(s.id);
    }
  }

  return {
    plannedRecords: finalPlannedRecords,
    allExpectedRecords: plannedRecords,
    excludedRecords,
    dAppRecords,
    appliedAt,
    plannedShares,
    excludedShares,
    expiredShares,
    expiredAfterExportShares,
    retractedShares,
    auditLogs,
    excludeAudits,
    deletedExcludeKeys,
    syncDelRecords,
    syncDelAudits,
    allLogsInD1,
    postponedBookkeeping,
    pendingDoneUpdates,
    expectedShareSet: [...expectedShareSet],
    staleLiveShares,
    selfCreatedShares,
    importedRevokedShares,
    localRowsWritten,
    quotaRowsWritten,
  };
}

export async function checkShares(r2, db, sharesJson, options = {}) {
  const failures = [];
  const now = options.now || Date.now();
  const expiredAfterExport = [];
  const activeShares = [];

  for (const s of sharesJson) {
    // I-1 ①: E_now＝E 中 exp > 核對當下的 id 計算；其餘列為「匯出後已到期」
    if (s.exp && s.exp <= now) {
      expiredAfterExport.push({ id: s.id, exp: s.exp });
    } else {
      activeShares.push(s);
    }
  }

  for (const s of activeShares) {
    const row = await db.prepare('SELECT sha256 FROM shares WHERE id = ?').bind(s.id).first();
    if (!row || !row.sha256) {
      failures.push({ id: s.id, reason: 'missing-or-empty-sha256-in-d1' });
      continue;
    }
    const r2Obj = await r2.get(`shares/${s.id}`);
    if (!r2Obj) {
      failures.push({ id: s.id, reason: 'missing-in-r2' });
      continue;
    }
    const buf = Buffer.from(await r2Obj.arrayBuffer());
    if (buf.length !== s.bytes) {
      failures.push({ id: s.id, reason: 'size-mismatch', expected: s.bytes, actual: buf.length });
      continue;
    }
    const hash = createHash('sha256').update(buf).digest('hex');
    if (hash !== row.sha256) {
      failures.push({ id: s.id, reason: 'sha256-mismatch', expected: row.sha256, actual: hash });
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    expiredAfterExport,
    checkedCount: activeShares.length,
  };
}

export async function importSnapshot(dir, options = {}) {
  const plan = await parseImportPlan(dir, options);

  console.log(JSON.stringify({
    phase: options.apply ? 'apply' : 'dry-run',
    target: options.remote ? 'remote' : 'local',
    plannedRecords: plan.plannedRecords.length,
    dAppRecords: plan.dAppRecords.length,
    excludedRecords: plan.excludedRecords.length,
    plannedShares: plan.plannedShares.length,
    expiredAfterExportShares: plan.expiredAfterExportShares.length,
    excludedShares: plan.excludedShares.length,
    retractedShares: plan.retractedShares.length,
    staleLiveShares: plan.staleLiveShares.length,
    auditLogs: plan.auditLogs.length + (plan.postponedBookkeeping ? 0 : plan.excludeAudits.length + plan.syncDelAudits.length),
    deletedExcludeKeys: plan.postponedBookkeeping ? 0 : plan.deletedExcludeKeys.length,
    syncDelRecords: plan.postponedBookkeeping ? 0 : plan.syncDelRecords.length,
    pendingDoneUpdates: plan.pendingDoneUpdates.length,
    postponedBookkeeping: plan.postponedBookkeeping,
    localRowsWritten: plan.localRowsWritten,
    quotaRowsWritten: plan.quotaRowsWritten,
  }, null, 2));

  if (plan.postponedBookkeeping) {
    console.log('[NOTE] 簿記列延後到 log/* 全部寫入之後');
  }
  if (plan.pendingDoneUpdates.length > 0) {
    console.log(`[I-2] 將更新為已完成的遷移列 (${plan.pendingDoneUpdates.length}):`);
    for (const u of plan.pendingDoneUpdates) {
      console.log(`  src_key=${u.src_key} target_id=${u.target_id}`);
    }
  }
  if (plan.dAppRecords.length > 0) {
    console.log(`[I-1] C3 之後已在本站刪除 (${plan.dAppRecords.length}): ${plan.dAppRecords.map(r => r.id).join(', ')}`);
  }
  if (plan.expiredAfterExportShares.length > 0) {
    console.log(`[I-1] 匯出後已到期 (${plan.expiredAfterExportShares.length}): ${plan.expiredAfterExportShares.map(s => s.id).join(', ')}`);
  }

  if (plan.quotaRowsWritten > 80000) {
    console.warn(`[WARNING] Quota rows written estimate (${plan.quotaRowsWritten}) exceeds 80,000 limit. Batching required across UTC days.`);
  }

  if (plan.staleLiveShares.length > 0) {
    console.warn(`[C5 GATE WARNING] 發現 ${plan.staleLiveShares.length} 筆過時未撤銷分享: ${plan.staleLiveShares.join(', ')}`);
  }

  if (!options.apply) return plan;

  // 執行 --apply: 生成 SQL 語句並分批執行
  // H-1 ②, I-4: 先寫完全部 log/*；全部 log/* 在 D1 後才寫簿記列與 done 更新
  const recordSqls = buildRecordInsertSql(plan.plannedRecords);
  const shareSqls = buildShareInsertSql(plan.plannedShares);
  const logAuditSqls = buildAuditInsertSql(plan.auditLogs);

  let allSqls = [];
  if (plan.postponedBookkeeping) {
    allSqls = [...recordSqls, ...shareSqls, ...logAuditSqls];
  } else {
    const deleteExcludeSqls = buildDeleteAuditSql(plan.deletedExcludeKeys);
    const deleteRecordSqls = buildDeleteRecordSql(plan.syncDelRecords);
    const deleteShareSqls = buildDeleteShareSql(plan.retractedShares);
    const bookkeepingAuditSqls = buildAuditInsertSql([...plan.excludeAudits, ...plan.syncDelAudits]);
    const doneUpdateSqls = plan.pendingDoneUpdates.map(u => u.sql);

    allSqls = [
      ...recordSqls,
      ...shareSqls,
      ...logAuditSqls,
      ...bookkeepingAuditSqls,
      ...deleteExcludeSqls,
      ...deleteRecordSqls,
      ...deleteShareSqls,
      ...doneUpdateSqls,
    ];
  }

  const targetFlag = options.remote ? '--remote' : '--local';

  for (let i = 0; i < allSqls.length; i++) {
    const s = allSqls[i];
    wrangler(['d1', 'execute', DB, targetFlag, '--command', s]);
  }

  // H-4 ②: 刪除 R2 物件，失敗殘留 key 逐筆列出
  const failedR2Keys = [];
  if (!plan.postponedBookkeeping && options.r2) {
    for (const sId of plan.retractedShares) {
      try {
        await options.r2.delete(`shares/${sId}`);
      } catch (err) {
        failedR2Keys.push(`shares/${sId}`);
      }
    }
  }
  if (failedR2Keys.length > 0) {
    console.warn(`[WARNING] R2 刪除失敗殘留 keys (${failedR2Keys.length}):`);
    for (const k of failedR2Keys) {
      console.warn(`  npx wrangler r2 object delete <bucket>/${k} --remote`);
    }
  }

  // H-3 ③, I-1 ③, J-3: --apply 成功後寫入 import-options.json
  // applied_at 只在該匯出目錄第一次成功 --apply 時寫入，已有則不覆寫
  let appliedAt = plan.appliedAt;
  if (!appliedAt) {
    try {
      const existingOpts = JSON.parse(await readFile(join(dir, 'import-options.json'), 'utf8'));
      appliedAt = existingOpts.applied_at || null;
    } catch {}
  }
  if (!appliedAt) {
    appliedAt = options.now || Date.now();
  }
  const savedOptions = {
    excludeLots: options.excludeLots || [],
    excludeLotPrefixes: options.excludeLotPrefixes || [],
    excludeIds: options.excludeIds || [],
    excludeShares: options.excludeShares || [],
    applied_at: appliedAt,
  };
  try {
    await writeFile(join(dir, 'import-options.json'), JSON.stringify(savedOptions, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.warn(`[WARNING] 無法儲存 import-options.json: ${e.message}`);
  }

  console.log(JSON.stringify({ phase: 'apply-complete', statementsExecuted: allSqls.length }));
  return plan;
}

// CLI entry point
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'export') {
    const dir = args[1] || die('Directory required');
    exportSnapshot(dir).catch((err) => { console.error(err); process.exit(1); });
  } else if (cmd === 'import') {
    const dir = args[1] || die('Directory required');
    const remote = args.includes('--remote');
    const apply = args.includes('--apply');
    const sameOptions = args.includes('--same-options');
    const excludeLots = [];
    const excludeLotPrefixes = [];
    const excludeIds = [];
    const excludeShares = [];

    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--exclude-lot' && args[i + 1]) excludeLots.push(args[++i]);
      else if (args[i] === '--exclude-lot-prefix' && args[i + 1]) excludeLotPrefixes.push(args[++i]);
      else if (args[i] === '--exclude-id' && args[i + 1]) excludeIds.push(args[++i]);
      else if (args[i] === '--exclude-share' && args[i + 1]) excludeShares.push(args[++i]);
    }

    importSnapshot(dir, { remote, apply, sameOptions, excludeLots, excludeLotPrefixes, excludeIds, excludeShares })
      .catch((err) => { console.error(err); process.exit(1); });
  }
}
