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

export function resolveNow(nowOpt) {
  if (typeof nowOpt === 'function') return Number(nowOpt());
  if (typeof nowOpt === 'number') return nowOpt;
  return Date.now();
}

// K-1 ⑥, LT-1, MT-1: 嚴格禁止任何略過或放寬時鐘檢查、或指向本機來源的模組參數與環境變數
export function assertNoForbiddenBypass(options = {}) {
  const forbiddenOpts = ['skipClockCheck', 'clockSkewLimitMs', 'maxClockSkew', 'sourceDir', 'localSource'];
  for (const k of forbiddenOpts) {
    if (options && k in options) {
      die(`禁止在模組介面傳入略過或放寬時鐘檢查的參數: ${k}`);
    }
  }
  const forbiddenEnvs = ['SKIP_CLOCK_CHECK', 'CLOCK_SKEW_LIMIT_MS', 'NETLIFY_SOURCE_DIR'];
  for (const envKey of forbiddenEnvs) {
    if (process.env[envKey]) {
      die(`禁止透過環境變數略過時鐘檢查或指定本機來源: ${envKey}`);
    }
  }
}

// K-1, MT-1: 時鐘檢查函式（只在 import 帶 --remote 時與每次 export 執行；預設封閉；測試只能注入 now() 與 fetch 來控制時鐘檢查）
export async function checkWorkerClock(workerUrl, options = {}) {
  assertNoForbiddenBypass(options);
  if (!workerUrl || typeof workerUrl !== 'string' || !workerUrl.startsWith('https://')) {
    die('時鐘檢查失敗：缺少或無效的 --worker-url（必須為 https:// 網址），請檢查 --worker-url 或校正電腦時鐘');
  }

  const fetchFn = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    die('時鐘檢查失敗：缺少可用的 fetch 實作');
  }

  const targetUrl = `${workerUrl.replace(/\/+$/, '')}/__login`;
  let res;
  try {
    res = await fetchFn(targetUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    die(`時鐘檢查失敗：HEAD ${targetUrl} 請求失敗 (${err?.message || err})，請檢查 --worker-url 或校正電腦時鐘`);
  }

  if (!res || !res.headers) {
    die('時鐘檢查失敗：Worker 回應缺少標頭，請檢查 --worker-url 或校正電腦時鐘');
  }

  const dateHdr = typeof res.headers.get === 'function'
    ? (res.headers.get('date') || res.headers.get('Date'))
    : (res.headers.date || res.headers.Date);

  if (!dateHdr) {
    die('時鐘檢查失敗：Worker 回應缺少 Date 標頭，請檢查 --worker-url 或校正電腦時鐘');
  }

  const workerTime = Date.parse(dateHdr);
  if (!Number.isFinite(workerTime)) {
    die(`時鐘檢查失敗：Worker Date 標頭無法解析 (${dateHdr})，請校正電腦時鐘`);
  }

  const localNow = resolveNow(options.now);
  const diffMs = Math.abs(workerTime - localNow);
  if (diffMs > 60_000) {
    die(`時鐘檢查失敗：本機時鐘與 Worker Date 相差 ${Math.round(diffMs / 1000)} 秒（超過 60 秒上限），請校正電腦時鐘`);
  }

  return { localNow, workerTime, diffMs };
}

export async function exportSnapshot(dir, sinceOrOptions = null) {
  const opts = (sinceOrOptions && typeof sinceOrOptions === 'object')
    ? sinceOrOptions
    : { sinceTime: sinceOrOptions };

  assertNoForbiddenBypass(opts);

  // K-1 ①, LT-1, MT-1: 每次 export 開始時，在讀寫任何資料之前執行時鐘檢查（fetch 與 now() 只控制時鐘檢查）
  await checkWorkerClock(opts.workerUrl, { now: opts.now, fetch: opts.fetch });

  const hasInjectedStore = Boolean(opts.storeFactory || opts.stores || opts.store);
  const sinceTime = opts.since || opts.sinceTime || null;
  const siteID = opts.siteID || process.env.NETLIFY_SITE_ID;
  const token = opts.token || process.env.NETLIFY_AUTH_TOKEN;
  if (!hasInjectedStore && (!siteID || !token)) {
    die('NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN are required for export');
  }

  try {
    await access(join(dir, 'manifest.json'));
    die('Export already exists; use a new empty directory');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const getStoreFn = opts.storeFactory
    || (opts.stores ? ({ name }) => opts.stores[name] : null)
    || (opts.store ? ({ name }) => (name === 'spi-records' ? opts.store : null) : null)
    || ((cfg) => getStore(cfg));

  const listStoresFn = opts.listStores
    || (opts.stores ? async () => ({ stores: Object.keys(opts.stores) }) : null)
    || (opts.store ? async () => ({ stores: ['spi-records'] }) : null)
    || (opts.storeFactory ? async () => ({ stores: ['spi-records', 'spi-share'] }) : null)
    || listStores;

  const names = new Set((await listStoresFn({ siteID, token })).stores);
  if (!names.has('spi-records')) die('Source spi-records store is missing');

  await mkdir(join(dir, 'objects'), { recursive: true });
  const entries = [];
  const sharesMetadata = [];
  const exportNow = resolveNow(opts.now);

  for (const name of STORES) {
    if (!names.has(name)) continue;
    const store = getStoreFn({ name, siteID, token, consistency: 'strong' });
    if (!store) continue;
    for await (const page of store.list({ paginate: true })) {
      for (const { key } of page.blobs) {
        if (name === 'spi-share' && isShareKey(key)) {
          const hit = await store.getWithMetadata(key, { type: 'arrayBuffer' });
          if (!hit?.data) continue;
          const meta = hit.metadata || {};
          sharesMetadata.push({
            id: key,
            created: Number(meta.created) || exportNow,
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
    sourceSiteID: siteID || 'mock-site',
    exportedAt: new Date(exportNow).toISOString(),
    records: records.length,
    shares: sharesMetadata.length,
    entries,
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ phase: 'export', records: records.length, shares: sharesMetadata.length, directory: dir }));
  return manifest;
}

// I-2, J-2 ③: 每次 import（C3 必做）在本次的全部 log/* 都已在 D1 之後重算 done:false 的遷移列（只用 K 中的鍵）
export function calculateDoneUpdates(auditLogs, indexRecords, allowedKeys = null) {
  const kSet = allowedKeys
    ? new Set([...allowedKeys].map((k) => (k.startsWith('log/') ? k : `log/${k}`)))
    : null;
  const candidates = [];
  const logsByTargetId = new Map();

  for (const row of auditLogs) {
    if (!row.src_key || !row.src_key.startsWith('log/')) continue;
    // J-2 ③: 要重算的列與同 target_id 的全部 log/* 列都限於 K；來源端已撤回的列不重算、不參與推定
    if (kSet && !kSet.has(row.src_key)) continue;
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

// J-2 ①②: C3 ① 子集合核對與「來源端已撤回」分類
export function verifyC3AuditLogs(d1AuditRows, manifestLogKeys) {
  const kSet = new Set(
    (manifestLogKeys || []).map((k) => (k.startsWith('log/') ? k : `log/${k}`))
  );
  const d1Logs = (d1AuditRows || []).filter((r) => r.src_key && r.src_key.startsWith('log/'));
  const d1KeyMap = new Map(d1Logs.map((r) => [r.src_key, r]));

  const missingKeys = [];
  for (const k of kSet) {
    if (!d1KeyMap.has(k)) {
      missingKeys.push(k);
    }
  }

  // K 中含有 delete 動作的 target_id 集合（供同時刪除例外判定）
  const kDeleteTargetIds = new Set();
  for (const r of d1Logs) {
    if (kSet.has(r.src_key) && r.action === 'delete') {
      kDeleteTargetIds.add(r.target_id);
    }
  }

  const retractedOnSource = [];
  const retractedConcurrentDeletes = [];
  const unexpectedDoneRetracted = [];

  for (const r of d1Logs) {
    if (kSet.has(r.src_key)) continue;
    const detail = typeof r.detail === 'string' ? JSON.parse(r.detail) : (r.detail || {});
    const isDone = r.done != null ? Boolean(r.done) : (detail.done === true || detail.done === 1);
    const item = {
      src_key: r.src_key,
      action: r.action || '',
      target_id: r.target_id || '',
      at: r.at || 0,
    };

    if (!isDone) {
      retractedOnSource.push({ ...item, label: '來源端已撤回' });
    } else if (r.action === 'delete' && kDeleteTargetIds.has(r.target_id)) {
      // 唯一例外：action='delete' 且 K 中有同一 target_id 的另一筆 delete
      retractedConcurrentDeletes.push({ ...item, label: '來源端已撤回（同時刪除）' });
    } else {
      unexpectedDoneRetracted.push(item);
    }
  }

  return {
    ok: missingKeys.length === 0 && unexpectedDoneRetracted.length === 0,
    missingKeys,
    retractedOnSource,
    retractedConcurrentDeletes,
    unexpectedDoneRetracted,
  };
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
  assertNoForbiddenBypass(options);
  if (options.remote && !options._clockChecked) {
    await checkWorkerClock(options.workerUrl, { now: options.now, fetch: options.fetch });
  }

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
      // J-3 ②: D_app 的查詢加 target_type='record'
      if (a.src_key == null && a.action === 'delete' && a.target_type === 'record' && a.at > appliedAt) {
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
  const now = resolveNow(options.now);

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
    const srcKey = l.key.startsWith('log/') ? l.key : `log/${l.key}`;
    rawLogs.push({ ...raw, filename: l.filename, key: l.key, src_key: srcKey });
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
      target_id: r.target_id || r.id || '',
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
    .map((e) => (e.key.startsWith('log/') ? e.key : `log/${e.key}`));

  const normalizeSrcKey = (k) => {
    if (!k) return k;
    return k.startsWith('log/log/') ? k.slice(4) : k;
  };

  const existingLogKeySet = new Set(
    (options.existingAuditLogs || [])
      .filter((a) => a.src_key && a.src_key.startsWith('log/'))
      .map((a) => normalizeSrcKey(a.src_key))
  );
  for (const a of auditLogs) {
    existingLogKeySet.add(normalizeSrcKey(a.src_key));
  }

  let allLogsInD1 = true;
  if (manifestLogKeys.length > 0) {
    allLogsInD1 = manifestLogKeys.every((k) => existingLogKeySet.has(k));
  }

  // 建立代表 D1 INSERT ON CONFLICT DO NOTHING 後現況的 combinedAuditLogs（既有 D1 列優先）
  const seenSrcKeys = new Set();
  const combinedAuditLogs = [];
  for (const a of (options.existingAuditLogs || [])) {
    const nk = normalizeSrcKey(a.src_key);
    if (nk) seenSrcKeys.add(nk);
    combinedAuditLogs.push(nk ? { ...a, src_key: nk } : a);
  }
  for (const a of auditLogs) {
    const nk = normalizeSrcKey(a.src_key);
    if (nk && seenSrcKeys.has(nk)) continue;
    if (nk) seenSrcKeys.add(nk);
    combinedAuditLogs.push(nk ? { ...a, src_key: nk } : a);
  }

  // I-2, J-2 ③: done:false 重算 UPDATE（只用 K 中的鍵）
  let pendingDoneUpdates = [];
  if (allLogsInD1) {
    pendingDoneUpdates = calculateDoneUpdates(combinedAuditLogs, records, manifestLogKeys);
  }

  // J-2 ①②: C3 ① 子集合核對
  const c3AuditCheck = verifyC3AuditLogs(combinedAuditLogs, manifestLogKeys);

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
    c3AuditCheck,
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
  const now = resolveNow(options.now);
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
  assertNoForbiddenBypass(options);
  // K-1 ①④: 只在 import 帶 --remote 時執行時鐘檢查；本機模式（不帶 --remote）不發 HEAD、不需要 --worker-url
  if (options.remote) {
    await checkWorkerClock(options.workerUrl, { now: options.now, fetch: options.fetch });
  }

  const plan = await parseImportPlan(dir, { ...options, _clockChecked: true });

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

  // D-2, 9.2 B3: 任何 records / shares 列都只在對應的 R2 物件上傳並核對 SHA-256 之後寫入（若提供 R2 執行器）
  if (options.r2 && typeof options.r2.put === 'function' && typeof options.r2.get === 'function') {
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    const existingRecordIds = new Set(options.existingRecordIds || []);
    const existingShareIds = new Set(options.existingShareIds || []);

    for (const rec of plan.plannedRecords) {
      if (existingRecordIds.has(rec.id)) continue;
      const entry = manifest.entries.find((e) => e.store === 'spi-records' && e.key === `f/${rec.id}`);
      if (!entry) continue;
      const bytes = await readFile(join(dir, entry.filename));
      await options.r2.put(`f/${rec.id}`, bytes);
      const r2Obj = await options.r2.get(`f/${rec.id}`);
      if (!r2Obj) die(`R2 寫入後讀回失敗: f/${rec.id}`);
      const readBuf = Buffer.from(await r2Obj.arrayBuffer());
      const expectedSha = entry.sha256 || sha(bytes);
      if (sha(readBuf) !== expectedSha) {
        die(`R2 物件 SHA-256 核對失敗: f/${rec.id}`);
      }
    }

    for (const s of plan.plannedShares) {
      if (existingShareIds.has(s.id)) continue;
      const entry = manifest.entries.find((e) => e.store === 'spi-share' && e.key === s.id);
      if (!entry) continue;
      const bytes = await readFile(join(dir, entry.filename));
      await options.r2.put(`shares/${s.id}`, bytes);
      const r2Obj = await options.r2.get(`shares/${s.id}`);
      if (!r2Obj) die(`R2 寫入後讀回失敗: shares/${s.id}`);
      const readBuf = Buffer.from(await r2Obj.arrayBuffer());
      const expectedSha = entry.sha256 || sha(bytes);
      if (sha(readBuf) !== expectedSha) {
        die(`R2 物件 SHA-256 核對失敗: shares/${s.id}`);
      }
    }
  }

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
    if (typeof options.d1Exec === 'function') {
      await options.d1Exec(s);
    } else {
      wrangler(['d1', 'execute', DB, targetFlag, '--command', s]);
    }
  }

  // H-4 ②: 刪除 R2 物件（含撤回分享與來源端刪除紀錄），失敗殘留 key 逐筆列出
  const failedR2Keys = [];
  if (!plan.postponedBookkeeping && options.r2 && typeof options.r2.delete === 'function') {
    for (const recId of plan.syncDelRecords) {
      try {
        await options.r2.delete(`f/${recId}`);
      } catch (err) {
        failedR2Keys.push(`f/${recId}`);
      }
    }
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

  // H-3 ③, I-1 ③, J-3 ①: --apply 成功後寫入 import-options.json
  // applied_at 只在該匯出目錄第一次成功 --apply 時寫入，已有則不覆寫
  let existingAppliedAt = null;
  try {
    const existingOpts = JSON.parse(await readFile(join(dir, 'import-options.json'), 'utf8'));
    if (existingOpts && existingOpts.applied_at != null) {
      existingAppliedAt = existingOpts.applied_at;
    }
  } catch {}
  const appliedAt = existingAppliedAt != null
    ? existingAppliedAt
    : (plan.appliedAt != null ? plan.appliedAt : resolveNow(options.now));
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

// K-1 ⑥: 嚴格命令列旗標解析，未知或禁止旗標（如 --skip-clock-check、--source-dir）一律報錯中止
export function parseMigrationArgs(args) {
  const cmd = args[0];
  if (!cmd) die('Subcommand required (export | import)');

  if (cmd === 'export') {
    const dir = args[1];
    if (!dir || dir.startsWith('--')) die('Export directory required');
    let since = null;
    let workerUrl = null;
    for (let i = 2; i < args.length; i++) {
      const a = args[i];
      if (a === '--since') {
        if (!args[i + 1] || args[i + 1].startsWith('--')) die('--since requires a value');
        since = args[++i];
      } else if (a === '--worker-url') {
        if (!args[i + 1] || args[i + 1].startsWith('--')) die('--worker-url requires a value');
        workerUrl = args[++i];
      } else {
        die(`未知或不允許的旗標: ${a}`);
      }
    }
    return { cmd, dir, since, workerUrl };
  }

  if (cmd === 'import') {
    const dir = args[1];
    if (!dir || dir.startsWith('--')) die('Import directory required');
    let remote = false;
    let local = false;
    let apply = false;
    let sameOptions = false;
    let workerUrl = null;
    const excludeLots = [];
    const excludeLotPrefixes = [];
    const excludeIds = [];
    const excludeShares = [];

    for (let i = 2; i < args.length; i++) {
      const a = args[i];
      if (a === '--remote') remote = true;
      else if (a === '--local') local = true;
      else if (a === '--apply') apply = true;
      else if (a === '--same-options') sameOptions = true;
      else if (a === '--worker-url') {
        if (!args[i + 1] || args[i + 1].startsWith('--')) die('--worker-url requires a value');
        workerUrl = args[++i];
      } else if (a === '--exclude-lot') {
        if (!args[i + 1] || args[i + 1].startsWith('--')) die('--exclude-lot requires a value');
        excludeLots.push(args[++i]);
      } else if (a === '--exclude-lot-prefix') {
        if (!args[i + 1] || args[i + 1].startsWith('--')) die('--exclude-lot-prefix requires a value');
        excludeLotPrefixes.push(args[++i]);
      } else if (a === '--exclude-id') {
        if (!args[i + 1] || args[i + 1].startsWith('--')) die('--exclude-id requires a value');
        excludeIds.push(args[++i]);
      } else if (a === '--exclude-share') {
        if (!args[i + 1] || args[i + 1].startsWith('--')) die('--exclude-share requires a value');
        excludeShares.push(args[++i]);
      } else {
        die(`未知或不允許的旗標: ${a}`);
      }
    }
    return {
      cmd,
      dir,
      remote,
      local,
      apply,
      sameOptions,
      workerUrl,
      excludeLots,
      excludeLotPrefixes,
      excludeIds,
      excludeShares,
    };
  }

  // LT-2 ①②: export-cloudflare 一律讀正式 D1（指令列不帶 --remote、不需要 --worker-url、不做時鐘檢查）
  if (cmd === 'export-cloudflare') {
    let dir = null;
    let since = null;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '--since') {
        if (!args[i + 1] || args[i + 1].startsWith('--')) die('--since requires a value');
        since = args[++i];
      } else if (!a.startsWith('--') && !dir) {
        dir = a;
      } else {
        die(`未知或不允許的旗標: ${a}`);
      }
    }
    if (!since) die('export-cloudflare requires --since <ISO time>');
    return { cmd, dir: dir || '.', since };
  }

  // LT-2 ②: netlify-sync-deletions 不做時鐘檢查、不需要 --worker-url
  if (cmd === 'netlify-sync-deletions') {
    const dir = args[1];
    if (!dir || dir.startsWith('--')) die('export-cloudflare output directory/file required');
    let site = null;
    let apply = false;
    for (let i = 2; i < args.length; i++) {
      const a = args[i];
      if (a === '--site') {
        if (!args[i + 1] || args[i + 1].startsWith('--')) die('--site requires a value');
        site = args[++i];
      } else if (a === '--apply') {
        apply = true;
      } else {
        die(`未知或不允許的旗標: ${a}`);
      }
    }
    if (!site) die('netlify-sync-deletions requires --site <SITE_ID>');
    return { cmd, dir, site, apply };
  }

  die(`未知的子命令: ${cmd}`);
}

// LT-2 ①②: export-cloudflare 一律讀正式 D1（工具內部固定以 wrangler --remote 讀取，不做時鐘檢查）
export async function exportCloudflareSnapshot(dir, options = {}) {
  assertNoForbiddenBypass(options);
  const sinceStr = options.since;
  if (!sinceStr) die('export-cloudflare requires since ISO time');
  const sinceMs = Date.parse(sinceStr);
  if (!Number.isFinite(sinceMs)) die(`Invalid --since ISO time: ${sinceStr}`);

  // 預設執行器固定加 --remote；測試可透過 options.d1Query 注入替身（並可驗證內部預設目標為 remote）
  const queryRemoteD1 = async (sql) => {
    if (typeof options.d1Query === 'function') {
      return await options.d1Query(sql, { target: 'remote', args: ['d1', 'execute', DB, '--remote', '--json', '--command', sql] });
    }
    const out = wrangler(['d1', 'execute', DB, '--remote', '--json', '--command', sql]);
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? (parsed[0]?.results || []) : (parsed?.results || []);
  };

  // ① 新增紀錄
  const createdRecords = await queryRemoteD1(
    `SELECT * FROM records WHERE created > ${Number(sinceMs)} ORDER BY created ASC;`
  );
  // ② 刪除的紀錄（audit_log 的 delete）
  const deletedAuditRows = await queryRemoteD1(
    `SELECT target_id, at, by, detail FROM audit_log WHERE action = 'delete' AND target_type = 'record' AND at > ${Number(sinceMs)} ORDER BY seq ASC;`
  );
  // ③ 撤銷的分享（audit_log 的 share_revoke 與 shares.revoked_at > 該時間）
  const revokedShareAuditRows = await queryRemoteD1(
    `SELECT target_id, at, by FROM audit_log WHERE action = 'share_revoke' AND at > ${Number(sinceMs)} ORDER BY seq ASC;`
  );
  const revokedShareRows = await queryRemoteD1(
    `SELECT id, revoked_at FROM shares WHERE revoked_at IS NOT NULL AND revoked_at > ${Number(sinceMs)};`
  );
  // ④ 新建的分享（shares.created > 該時間，與 audit_log 的 share_create 交叉核對）
  const createdShareRows = await queryRemoteD1(
    `SELECT id, created, exp, user, bytes FROM shares WHERE created > ${Number(sinceMs)} ORDER BY created ASC;`
  );
  const createdShareAuditRows = await queryRemoteD1(
    `SELECT target_id, at, by FROM audit_log WHERE action = 'share_create' AND at > ${Number(sinceMs)} ORDER BY seq ASC;`
  );

  const revokedShareIds = new Set([
    ...revokedShareAuditRows.map((r) => r.target_id),
    ...revokedShareRows.map((r) => r.id),
  ]);
  const deletedRecordIds = [...new Set(deletedAuditRows.map((r) => r.target_id))];

  const delta = {
    phase: 'export-cloudflare',
    target: 'remote',
    since: new Date(sinceMs).toISOString(),
    sinceMs,
    createdRecords,
    deletedRecords: deletedRecordIds,
    revokedShares: [...revokedShareIds],
    createdShares: createdShareRows,
    createdShareAudits: createdShareAuditRows,
  };

  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'cloudflare-delta.json'), JSON.stringify(delta, null, 2) + '\n', 'utf8');
  }

  return delta;
}

// LT-2 ②, MT-1: netlify-sync-deletions 不做時鐘檢查、不需要 --worker-url，支援經模組介面注入 storeFactory / stores 替身
export async function netlifySyncDeletions(deltaDirOrFile, options = {}) {
  assertNoForbiddenBypass(options);
  const hasInjectedStore = Boolean(options.storeFactory || options.stores || options.store);
  const siteID = options.site || options.siteID || process.env.NETLIFY_SITE_ID;
  const token = options.token || process.env.NETLIFY_AUTH_TOKEN;
  if (!hasInjectedStore && (!siteID || !token)) {
    die('NETLIFY_SITE_ID (--site) and NETLIFY_AUTH_TOKEN are required for netlify-sync-deletions');
  }

  let deltaPath = deltaDirOrFile;
  try {
    await readFile(join(deltaDirOrFile, 'cloudflare-delta.json'), 'utf8');
    deltaPath = join(deltaDirOrFile, 'cloudflare-delta.json');
  } catch {}

  const delta = JSON.parse(await readFile(deltaPath, 'utf8'));
  const deletedRecords = delta.deletedRecords || [];
  const revokedShares = delta.revokedShares || [];

  if (!options.apply) {
    return {
      phase: 'dry-run',
      deletedRecords,
      revokedShares,
    };
  }

  const getStoreFn = options.storeFactory
    || (options.stores ? ({ name }) => options.stores[name] : null)
    || (options.store ? ({ name }) => (name === 'spi-records' ? options.store : null) : null)
    || ((cfg) => getStore(cfg));

  const recStore = getStoreFn({ name: 'spi-records', siteID, token, consistency: 'strong' });
  const shareStore = getStoreFn({ name: 'spi-share', siteID, token, consistency: 'strong' });

  const syncedDeletedRecords = [];
  for (const recId of deletedRecords) {
    if (recStore && typeof recStore.delete === 'function') {
      await recStore.delete(`f/${recId}`);
    }
    // 以 etag 條件寫入從 index.json 移除該筆
    if (recStore && typeof recStore.getWithMetadata === 'function') {
      const idxHit = await recStore.getWithMetadata('index.json', { type: 'text' });
      if (idxHit && idxHit.data != null) {
        const list = JSON.parse(typeof idxHit.data === 'string' ? idxHit.data : Buffer.from(idxHit.data).toString('utf8'));
        const nextList = list.filter((item) => item.id !== recId);
        if (typeof recStore.setJSON === 'function') {
          await recStore.setJSON('index.json', nextList, idxHit.etag ? { onlyIfMatch: idxHit.etag } : undefined);
        } else if (typeof recStore.set === 'function') {
          await recStore.set('index.json', JSON.stringify(nextList), idxHit.etag ? { onlyIfMatch: idxHit.etag } : undefined);
        }
      }
    }
    syncedDeletedRecords.push(recId);
  }

  const syncedRevokedShares = [];
  for (const sId of revokedShares) {
    if (shareStore && typeof shareStore.delete === 'function') {
      await shareStore.delete(sId);
    }
    syncedRevokedShares.push(sId);
  }

  return {
    phase: 'apply',
    syncedDeletedRecords,
    syncedRevokedShares,
  };
}

// CLI entry point
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const parsed = parseMigrationArgs(process.argv.slice(2));
    if (parsed.cmd === 'export') {
      exportSnapshot(parsed.dir, { since: parsed.since, workerUrl: parsed.workerUrl })
        .catch((err) => { console.error(err); process.exit(1); });
    } else if (parsed.cmd === 'import') {
      importSnapshot(parsed.dir, parsed)
        .catch((err) => { console.error(err); process.exit(1); });
    } else if (parsed.cmd === 'export-cloudflare') {
      exportCloudflareSnapshot(parsed.dir, parsed)
        .catch((err) => { console.error(err); process.exit(1); });
    } else if (parsed.cmd === 'netlify-sync-deletions') {
      netlifySyncDeletions(parsed.dir, parsed)
        .catch((err) => { console.error(err); process.exit(1); });
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}


