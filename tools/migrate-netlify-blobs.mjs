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
  buildRecordInsertSql,
  buildShareInsertSql,
  buildAuditInsertSql,
  buildDeleteAuditSql,
  buildDeleteRecordSql,
  buildDeleteShareSql,
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

export async function parseImportPlan(dir, options = {}) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const exportTime = new Date(manifest.exportedAt).getTime();
  const indexEntry = manifest.entries.find((e) => e.store === 'spi-records' && e.key === 'index.json');
  const records = JSON.parse(await readFile(join(dir, indexEntry.filename), 'utf8'));

  let sharesList = [];
  try {
    sharesList = JSON.parse(await readFile(join(dir, 'shares.json'), 'utf8'));
  } catch {}

  const excludeLots = new Set(options.excludeLots || []);
  const excludeLotPrefixes = options.excludeLotPrefixes || [];
  const excludeIds = new Set(options.excludeIds || []);
  const excludeShares = options.excludeShares || [];

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

  const plannedShares = [];
  const excludedShares = [];
  const expiredShares = [];
  const retractedShares = [];
  const existingShareIds = new Set(options.existingShareIds || []);

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
      plannedShares.push(s);
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

  // 稽核紀錄 log/* 準備 (G-1: 依來源站 auditStatus 計算每筆 log/* 的 done 布林值)
  const logEntries = manifest.entries.filter((e) => e.store === 'spi-records' && e.key.startsWith('log/'));
  const rawLogs = [];
  for (const l of logEntries) {
    const raw = JSON.parse(await readFile(join(dir, l.filename), 'utf8'));
    rawLogs.push({ ...raw, filename: l.filename, src_key: `log/${l.key}` });
  }
  rawLogs.sort((a, b) => (b.at || 0) - (a.at || 0));
  const evaluatedLogs = auditStatus(rawLogs.map(r => ({ ...r, id: r.target_id || r.id })), records);
  const evaluatedMap = new Map();
  for (const e of evaluatedLogs) {
    evaluatedMap.set(e.src_key, !!e.ok);
  }

  const auditLogs = [];
  for (const r of rawLogs) {
    const detailObj = { ...(r.detail || {}) };
    if (detailObj.done === undefined) {
      detailObj.done = evaluatedMap.get(r.src_key) ?? true;
    }
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
  auditLogs.sort((a, b) => a.at - b.at);

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
        const isExpired = expiredShares.some((s) => s.id === shareId);
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
  for (const rec of plannedRecords) {
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

  // 計算估算列數 (F-1 雙估算指標 + G-3 分享撤回)
  // 本機計法估算：records 5, shares 4, audit_log 4, delete 1 (E-1, D-2, E-2, G-3)
  const localRowsWritten =
    plannedRecords.length * 5 +
    plannedShares.length * 4 +
    (auditLogs.length + excludeAudits.length + syncDelAudits.length) * 4 +
    deletedExcludeKeys.length * 1 +
    syncDelRecords.length * 1 +
    retractedShares.length * 1;

  // 額度估算 (F-1: DELETE 以該表 INSERT 的每筆列數計：records 5、shares 4、audit_log 4)
  const quotaRowsWritten =
    plannedRecords.length * 5 +
    plannedShares.length * 4 +
    (auditLogs.length + excludeAudits.length + syncDelAudits.length) * 4 +
    deletedExcludeKeys.length * 4 +
    syncDelRecords.length * 5 +
    retractedShares.length * 4;

  const expectedShareSet = new Set(plannedShares.map((s) => s.id));
  const staleLiveShares = [];
  const selfCreatedShares = [];
  const now = options.now || Date.now();
  const existingShares = options.existingShares || [];
  const selfCreatedSet = new Set(options.selfCreatedShareIds || []);

  for (const s of existingShares) {
    if (selfCreatedSet.has(s.id)) {
      selfCreatedShares.push(s.id);
    } else if (!expectedShareSet.has(s.id) && !s.revoked_at && s.exp > now) {
      staleLiveShares.push(s.id);
    }
  }

  return {
    plannedRecords,
    excludedRecords,
    plannedShares,
    excludedShares,
    expiredShares,
    retractedShares,
    auditLogs,
    excludeAudits,
    deletedExcludeKeys,
    syncDelRecords,
    syncDelAudits,
    expectedShareSet: [...expectedShareSet],
    staleLiveShares,
    selfCreatedShares,
    localRowsWritten,
    quotaRowsWritten,
  };
}

export async function importSnapshot(dir, options = {}) {
  const plan = await parseImportPlan(dir, options);

  console.log(JSON.stringify({
    phase: options.apply ? 'apply' : 'dry-run',
    target: options.remote ? 'remote' : 'local',
    plannedRecords: plan.plannedRecords.length,
    excludedRecords: plan.excludedRecords.length,
    plannedShares: plan.plannedShares.length,
    excludedShares: plan.excludedShares.length,
    retractedShares: plan.retractedShares.length,
    staleLiveShares: plan.staleLiveShares.length,
    auditLogs: plan.auditLogs.length + plan.excludeAudits.length + plan.syncDelAudits.length,
    deletedExcludeKeys: plan.deletedExcludeKeys.length,
    syncDelRecords: plan.syncDelRecords.length,
    localRowsWritten: plan.localRowsWritten,
    quotaRowsWritten: plan.quotaRowsWritten,
  }, null, 2));

  if (plan.quotaRowsWritten > 80000) {
    console.warn(`[WARNING] Quota rows written estimate (${plan.quotaRowsWritten}) exceeds 80,000 limit. Batching required across UTC days.`);
  }

  if (plan.staleLiveShares.length > 0) {
    console.warn(`[C5 GATE WARNING] 發現 ${plan.staleLiveShares.length} 筆過時未撤銷分享: ${plan.staleLiveShares.join(', ')}`);
  }

  if (!options.apply) return plan;

  // 執行 --apply: 生成 SQL 語句並分批執行
  const deleteExcludeSqls = buildDeleteAuditSql(plan.deletedExcludeKeys);
  const deleteRecordSqls = buildDeleteRecordSql(plan.syncDelRecords);
  const deleteShareSqls = buildDeleteShareSql(plan.retractedShares);
  const allAudits = [...plan.auditLogs, ...plan.excludeAudits, ...plan.syncDelAudits];
  const recordSqls = buildRecordInsertSql(plan.plannedRecords);
  const shareSqls = buildShareInsertSql(plan.plannedShares);
  const auditSqls = buildAuditInsertSql(allAudits);

  const allSqls = [...deleteExcludeSqls, ...deleteRecordSqls, ...deleteShareSqls, ...recordSqls, ...shareSqls, ...auditSqls];
  const targetFlag = options.remote ? '--remote' : '--local';

  for (let i = 0; i < allSqls.length; i++) {
    const s = allSqls[i];
    wrangler(['d1', 'execute', DB, targetFlag, '--command', s]);
  }

  if (options.r2) {
    for (const sId of plan.retractedShares) {
      try { await options.r2.delete(`shares/${sId}`); } catch {}
    }
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

    importSnapshot(dir, { remote, apply, excludeLots, excludeLotPrefixes, excludeIds, excludeShares })
      .catch((err) => { console.error(err); process.exit(1); });
  }
}
