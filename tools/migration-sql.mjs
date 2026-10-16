// tools/migration-sql.mjs: D1 遷移 SQL 生成與分批工具
// 實作規範：D-59, 9.2 B3, 9.4 L-2, L-6
import { Buffer } from 'node:buffer';

export const ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const MAX_PARAMS_PER_STMT = 90;
export const MAX_BYTES_PER_STMT = 80 * 1024; // < 100 KB limit

export function sqlStr(val) {
  if (val == null) return "''";
  return `'${String(val).replace(/'/g, "''")}'`;
}

export function isShareKey(key) {
  return typeof key === 'string' && ID_RE.test(key);
}

export function buildRecordInsertSql(rows) {
  if (!rows || rows.length === 0) return [];
  const stmts = [];
  // records columns: id, kind, part, rev, lot, side, vendor, place_id, name, user, created, bytes, gz_bytes, sha256, meta (15 cols)
  // 6 rows * 15 cols = 90 params limit
  const batchSize = Math.floor(MAX_PARAMS_PER_STMT / 15);
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const valueClauses = chunk.map(r => `(${sqlStr(r.id)}, ${sqlStr(r.kind || '')}, ${sqlStr(r.part || '')}, ${sqlStr(r.rev || '')}, ${sqlStr(r.lot || '')}, ${sqlStr(r.side || '')}, ${sqlStr(r.vendor || '')}, ${sqlStr(r.place_id || r.placeId || '')}, ${sqlStr(r.name || '')}, ${sqlStr(r.user || '')}, ${Number(r.created) || 0}, ${Number(r.bytes) || 0}, ${Number(r.gz_bytes) || 0}, ${sqlStr(r.sha256 || '')}, ${sqlStr(typeof r.meta === 'string' ? r.meta : JSON.stringify(r.meta || {}))})`).join(', ');
    const stmt = `INSERT INTO records (id, kind, part, rev, lot, side, vendor, place_id, name, user, created, bytes, gz_bytes, sha256, meta) VALUES ${valueClauses} ON CONFLICT(id) DO NOTHING;`;
    stmts.push(stmt);
  }
  return stmts;
}

export function buildShareInsertSql(rows) {
  if (!rows || rows.length === 0) return [];
  const stmts = [];
  // shares columns: id, user, name, created, exp, bytes, sha256 (7 cols)
  const batchSize = Math.floor(MAX_PARAMS_PER_STMT / 7);
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const valueClauses = chunk.map(s => `(${sqlStr(s.id)}, ${sqlStr(s.user || '')}, ${sqlStr(s.name || '')}, ${Number(s.created) || 0}, ${Number(s.exp) || 0}, ${Number(s.bytes) || 0}, ${sqlStr(s.sha256 || '')})`).join(', ');
    const stmt = `INSERT INTO shares (id, user, name, created, exp, bytes, sha256) VALUES ${valueClauses} ON CONFLICT(id) DO NOTHING;`;
    stmts.push(stmt);
  }
  return stmts;
}

export function buildAuditInsertSql(rows) {
  if (!rows || rows.length === 0) return [];
  const stmts = [];
  // audit_log columns: at, by, action, target_type, target_id, detail, src_key (7 cols)
  const batchSize = Math.floor(MAX_PARAMS_PER_STMT / 7);
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const valueClauses = chunk.map(a => `(${Number(a.at) || 0}, ${sqlStr(a.by || '')}, ${sqlStr(a.action || '')}, ${sqlStr(a.target_type || '')}, ${sqlStr(a.target_id || '')}, ${sqlStr(typeof a.detail === 'string' ? a.detail : JSON.stringify(a.detail || {}))}, ${sqlStr(a.src_key || null)})`).join(', ');
    const stmt = `INSERT INTO audit_log (at, by, action, target_type, target_id, detail, src_key) VALUES ${valueClauses} ON CONFLICT(src_key) WHERE src_key IS NOT NULL DO NOTHING;`;
    stmts.push(stmt);
  }
  return stmts;
}

export function buildDeleteAuditSql(srcKeys) {
  if (!srcKeys || srcKeys.length === 0) return [];
  const stmts = [];
  const batchSize = MAX_PARAMS_PER_STMT;
  for (let i = 0; i < srcKeys.length; i += batchSize) {
    const chunk = srcKeys.slice(i, i + batchSize);
    const inClause = chunk.map(k => sqlStr(k)).join(', ');
    stmts.push(`DELETE FROM audit_log WHERE src_key IN (${inClause});`);
  }
  return stmts;
}

export function buildDeleteRecordSql(ids) {
  if (!ids || ids.length === 0) return [];
  const stmts = [];
  const batchSize = MAX_PARAMS_PER_STMT;
  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    const inClause = chunk.map(id => sqlStr(id)).join(', ');
    stmts.push(`DELETE FROM records WHERE id IN (${inClause});`);
  }
  return stmts;
}

export function buildDeleteShareSql(ids) {
  if (!ids || ids.length === 0) return [];
  const stmts = [];
  const batchSize = MAX_PARAMS_PER_STMT;
  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    const inClause = chunk.map(id => sqlStr(id)).join(', ');
    stmts.push(`DELETE FROM shares WHERE id IN (${inClause});`);
  }
  return stmts;
}
