// lib/repo.mjs: 專屬 Cloudflare D1 + R2 之資料存取層
// 嚴格依據規格書 D-59, 9.4 規範實作：
// - records: 每筆一列，走索引查詢，keyset 分頁，單列限制
// - audit_log: 永不刪除，原子記錄新增與刪除
// - shares: 儲存分享代碼與中繼資料，支援 keyset 分頁與撤銷
// - auth_attempts: 記錄登入失敗 HMAC 雜湊與時間，支援防暴破與節流
// - stats: 快照統計數據，避免管理頁與全表 COUNT(*) 查詢
import { clean, int, ID_RE, sameFile } from "./records-core.mjs";

export class Repo {
  /**
   * @param {D1Database} db D1 資料庫 binding
   * @param {R2Bucket} r2 R2 物件儲存 binding
   */
  constructor(db, r2) {
    this.db = db;
    this.r2 = r2;
  }

  // --- records 表操作 ---

  /** Keyset 分頁列表查詢 */
  async listRecords({ kind, cursorCreated, cursorId, limit = 50 }) {
    const lim = Math.min(Math.max(1, limit), 100);
    let sql, params;
    if (cursorCreated != null && cursorId != null) {
      sql = `SELECT * FROM records WHERE kind = ? AND (created, id) < (?, ?) ORDER BY created DESC, id DESC LIMIT ?`;
      params = [kind, cursorCreated, cursorId, lim + 1];
    } else {
      sql = `SELECT * FROM records WHERE kind = ? ORDER BY created DESC, id DESC LIMIT ?`;
      params = [kind, lim + 1];
    }
    const stmt = this.db.prepare(sql).bind(...params);
    const { results = [] } = await stmt.all();
    const hasMore = results.length > lim;
    const records = hasMore ? results.slice(0, lim) : results;
    let next = null;
    if (hasMore && records.length > 0) {
      const last = records[records.length - 1];
      next = `${last.created},${last.id}`;
    }
    return { records, next };
  }

  /** 全量取得（向後相容與測試用途），預設 100 筆 */
  async getAllRecords(kind) {
    let sql = `SELECT * FROM records`;
    const params = [];
    if (kind) {
      sql += ` WHERE kind = ?`;
      params.push(kind);
    }
    sql += ` ORDER BY created DESC, id DESC LIMIT 100`;
    const stmt = this.db.prepare(sql).bind(...params);
    const { results = [] } = await stmt.all();
    return results;
  }

  /** 伺服器端搜尋 (LOT, Part, Rev, Name, User) */
  async searchRecords(query, limit = 50) {
    const rawQ = String(query || "").trim();
    if (rawQ.length < 2) return [];
    // 依 D-59: D1 LIKE 樣式上限 50 bytes，中文約 16 字；跳脫 %, _, \
    const escaped = rawQ.slice(0, 16).replace(/[\\%_]/g, "\\$&");
    const pattern = `%${escaped}%`;
    const lim = Math.min(Math.max(1, limit), 50);
    const sql = `SELECT * FROM records WHERE (lot LIKE ? ESCAPE '\\' OR part LIKE ? ESCAPE '\\' OR rev LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR user LIKE ? ESCAPE '\\') ORDER BY created DESC, id DESC LIMIT ?`;
    const stmt = this.db.prepare(sql).bind(pattern, pattern, pattern, pattern, pattern, lim);
    const { results = [] } = await stmt.all();
    return results;
  }

  /** 單筆查詢 (metadata) */
  async getRecord(id) {
    if (!id || !ID_RE.test(id)) return null;
    const stmt = this.db.prepare(`SELECT * FROM records WHERE id = ? LIMIT 1`).bind(id);
    return await stmt.first();
  }

  /** 檢查重複檔 (sameFile 條件) */
  async findDuplicate(rec) {
    const sql = `SELECT id FROM records WHERE kind = ? AND part = ? AND rev = ? AND lot = ? AND side = ? AND vendor = ? AND place_id = ? AND sha256 = ? LIMIT 1`;
    const stmt = this.db.prepare(sql).bind(
      rec.kind || "",
      rec.part || "",
      rec.rev || "",
      rec.lot || "",
      rec.side || "",
      rec.vendor || "",
      rec.placeId || rec.place_id || "",
      rec.sha256 || ""
    );
    const row = await stmt.first();
    return row ? row.id : null;
  }

  /** 儲存量測紀錄與 R2 實體檔案 */
  async createRecord(rec, gzBuffer) {
    const dupId = await this.findDuplicate(rec);
    if (dupId) return { error: "這個檔案已經存過（相同內容與相同回溯欄位）", status: 409, existing: dupId };

    // 寫入 R2
    await this.r2.put(`records/${rec.id}`, gzBuffer, {
      httpMetadata: { contentType: "application/gzip" },
      customMetadata: { sha256: rec.sha256 },
    });

    const now = rec.created || Date.now();
    const metaJson = JSON.stringify(rec.meta || {});

    // D1 寫入 records 與 audit_log
    const insertRec = this.db.prepare(`
      INSERT INTO records (id, kind, part, rev, lot, side, vendor, place_id, name, user, created, bytes, gz_bytes, sha256, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      rec.id,
      rec.kind || "",
      rec.part || "",
      rec.rev || "",
      rec.lot || "",
      rec.side || "",
      rec.vendor || "",
      rec.placeId || rec.place_id || "",
      rec.name || "",
      rec.user || "",
      now,
      rec.bytes || 0,
      rec.gz_bytes || gzBuffer.length,
      rec.sha256 || "",
      metaJson
    );

    const detailJson = JSON.stringify({
      kind: rec.kind,
      lot: rec.lot || "",
      part: rec.part,
      rev: rec.rev || "",
      name: rec.name,
      sha256: rec.sha256,
      bytes: rec.bytes,
    });

    const insertAudit = this.db.prepare(`
      INSERT INTO audit_log (at, by, action, target_type, target_id, detail)
      VALUES (?, ?, 'create', 'record', ?, ?)
    `).bind(now, rec.user || "", rec.id, detailJson);

    try {
      await this.db.batch([insertRec, insertAudit]);
    } catch (e) {
      try { await this.r2.delete(`records/${rec.id}`); } catch {}
      throw e;
    }

    return { record: rec };
  }

  /** 取得檔案原始串流 */
  async getRecordFile(id) {
    if (!id || !ID_RE.test(id)) return null;
    return await this.r2.get(`records/${id}`);
  }

  /** 刪除量測紀錄與寫入稽核 */
  async deleteRecord(id, user, now = Date.now()) {
    const rec = await this.getRecord(id);
    if (!rec) return { error: "找不到這筆紀錄（可能已被刪除）", status: 404 };
    if (rec.user !== user) return { error: `只有上傳者（${rec.user}）可以刪除這筆紀錄`, status: 403 };

    const detailJson = JSON.stringify({
      kind: rec.kind,
      lot: rec.lot,
      part: rec.part,
      rev: rec.rev,
      name: rec.name,
      sha256: rec.sha256,
      bytes: rec.bytes,
      uploaded: rec.created,
    });

    const delRec = this.db.prepare(`DELETE FROM records WHERE id = ?`).bind(id);
    const insAudit = this.db.prepare(`
      INSERT INTO audit_log (at, by, action, target_type, target_id, detail)
      VALUES (?, ?, 'delete', 'record', ?, ?)
    `).bind(now, user, id, detailJson);

    await this.db.batch([delRec, insAudit]);
    try { await this.r2.delete(`records/${id}`); } catch {}
    return { ok: true };
  }

  // --- audit_log 表操作 ---

  async listAuditLog(limit = 100) {
    const lim = Math.min(Math.max(1, limit), 500);
    // LEFT JOIN records 確認目標是否存在
    const sql = `
      SELECT a.*, (r.id IS NOT NULL) AS target_exists
      FROM audit_log a
      LEFT JOIN records r ON a.target_id = r.id AND a.target_type = 'record'
      ORDER BY a.at DESC, a.seq DESC
      LIMIT ?
    `;
    const { results = [] } = await this.db.prepare(sql).bind(lim).all();
    return results.map((row) => {
      let d = {};
      try { d = JSON.parse(row.detail || "{}"); } catch {}
      return {
        seq: row.seq,
        action: row.action,
        at: row.at,
        by: row.by,
        target_type: row.target_type,
        id: row.target_id,
        status: row.target_type === "record" ? (row.action === "create" ? (row.target_exists ? "已存檔" : "已刪除") : "已刪除") : "完成",
        ...d,
      };
    });
  }

  // --- shares 表操作 ---

  async createShare(id, name, user, gzBuffer, exp, now = Date.now()) {
    await this.r2.put(`shares/${id}`, gzBuffer, {
      httpMetadata: { contentType: "application/gzip" },
    });

    const cleanName = clean(name, 200);
    const insShare = this.db.prepare(`
      INSERT INTO shares (id, user, name, created, exp, bytes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, user, cleanName, now, exp, gzBuffer.length);

    const insAudit = this.db.prepare(`
      INSERT INTO audit_log (at, by, action, target_type, target_id, detail)
      VALUES (?, ?, 'share_create', 'share', ?, ?)
    `).bind(now, user, id, JSON.stringify({ name: cleanName, exp, bytes: gzBuffer.length }));

    await this.db.batch([insShare, insAudit]);
    return { id, expires: exp };
  }

  async getShare(id) {
    if (!id || !ID_RE.test(id)) return null;
    return await this.db.prepare(`SELECT * FROM shares WHERE id = ? LIMIT 1`).bind(id).first();
  }

  async getShareFile(id) {
    if (!id || !ID_RE.test(id)) return null;
    return await this.r2.get(`shares/${id}`);
  }

  async listShares({ user, all = false, limit = 50 }) {
    const lim = Math.min(Math.max(1, limit), 100);
    let sql, params;
    if (all) {
      sql = `SELECT * FROM shares ORDER BY created DESC, id DESC LIMIT ?`;
      params = [lim];
    } else {
      sql = `SELECT * FROM shares WHERE user = ? ORDER BY created DESC, id DESC LIMIT ?`;
      params = [user || "", lim];
    }
    const { results = [] } = await this.db.prepare(sql).bind(...params).all();
    return results;
  }

  async revokeShare(id, user, isAdmin = false, now = Date.now()) {
    const share = await this.getShare(id);
    if (!share) return { error: "找不到分享連結", status: 404 };
    if (!isAdmin && share.user !== user) return { error: "無權限撤銷此分享連結", status: 403 };

    const updateShare = this.db.prepare(`
      UPDATE shares SET revoked_at = ?, revoked_by = ? WHERE id = ?
    `).bind(now, user, id);

    const insAudit = this.db.prepare(`
      INSERT INTO audit_log (at, by, action, target_type, target_id, detail)
      VALUES (?, ?, 'share_revoke', 'share', ?, ?)
    `).bind(now, user, id, JSON.stringify({ name: share.name, created: share.created }));

    await this.db.batch([updateShare, insAudit]);
    try { await this.r2.delete(`shares/${id}`); } catch {}
    return { ok: true };
  }

  // --- auth_attempts 表與節流操作 ---

  /** 檢查當前是否處於登入節流模式 */
  async isAuthThrottled() {
    const row = await this.db.prepare(`SELECT value FROM stats WHERE key = 'auth_mode' LIMIT 1`).first();
    return row ? row.value === 1 : false;
  }

  /** 查詢 30 分鐘內兩把 hash key 的登入嘗試紀錄 */
  async getRecentAuthAttempts(keyHashes, now = Date.now()) {
    if (!keyHashes || keyHashes.length === 0) return [];
    const since = now - 30 * 60_000;
    const placeholders = keyHashes.map(() => "?").join(",");
    const sql = `SELECT id, key_hash, at FROM auth_attempts WHERE key_hash IN (${placeholders}) AND at > ? ORDER BY at DESC LIMIT 20`;
    const { results = [] } = await this.db.prepare(sql).bind(...keyHashes, since).all();
    return results;
  }

  /** 插入登入失敗嘗試 */
  async insertAuthAttempt(keyHash, now = Date.now()) {
    const stmt = this.db.prepare(`INSERT INTO auth_attempts (key_hash, at) VALUES (?, ?) RETURNING id`).bind(keyHash, now);
    const row = await stmt.first();
    return row ? row.id : null;
  }

  /** 刪除指定的嘗試紀錄 */
  async deleteAuthAttemptsByIds(ids) {
    if (!ids || ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    await this.db.prepare(`DELETE FROM auth_attempts WHERE id IN (${placeholders})`).bind(...ids).run();
  }

  /** 登入成功時清除該帳號所有登入失敗記數 */
  async clearAuthAttemptsByKey(keyHash) {
    await this.db.prepare(`DELETE FROM auth_attempts WHERE key_hash = ?`).bind(keyHash).run();
  }
}
