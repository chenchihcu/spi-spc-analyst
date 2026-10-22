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

  /** Keyset 分頁列表查詢，支援 part 料號與 side 面別過濾 */
  async listRecords({ kind, part, side, cursorCreated, cursorId, limit = 50 }) {
    const lim = Math.min(Math.max(1, limit), 100);
    let sql, params;
    if (part && side) {
      if (cursorCreated != null && cursorId != null) {
        sql = `SELECT * FROM records WHERE kind = ? AND part = ? AND side = ? AND (created, id) < (?, ?) ORDER BY created DESC, id DESC LIMIT ?`;
        params = [kind, part, side, cursorCreated, cursorId, lim + 1];
      } else {
        sql = `SELECT * FROM records WHERE kind = ? AND part = ? AND side = ? ORDER BY created DESC, id DESC LIMIT ?`;
        params = [kind, part, side, lim + 1];
      }
    } else if (part) {
      if (cursorCreated != null && cursorId != null) {
        sql = `SELECT * FROM records WHERE kind = ? AND part = ? AND (created, id) < (?, ?) ORDER BY created DESC, id DESC LIMIT ?`;
        params = [kind, part, cursorCreated, cursorId, lim + 1];
      } else {
        sql = `SELECT * FROM records WHERE kind = ? AND part = ? ORDER BY created DESC, id DESC LIMIT ?`;
        params = [kind, part, lim + 1];
      }
    } else {
      if (cursorCreated != null && cursorId != null) {
        sql = `SELECT * FROM records WHERE kind = ? AND (created, id) < (?, ?) ORDER BY created DESC, id DESC LIMIT ?`;
        params = [kind, cursorCreated, cursorId, lim + 1];
      } else {
        sql = `SELECT * FROM records WHERE kind = ? ORDER BY created DESC, id DESC LIMIT ?`;
        params = [kind, lim + 1];
      }
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

  /** 依產品料號與面別查詢可用之座標檔列表 (新到舊，優先排序 isDefault) */
  async getPlacementsForPart(part, side) {
    if (!part) return [];
    let sql, params;
    if (side) {
      sql = `SELECT * FROM records WHERE kind = 'place' AND part = ? AND (side = ? OR side = '' OR side IS NULL) ORDER BY created DESC, id DESC LIMIT 20`;
      params = [part, side];
    } else {
      sql = `SELECT * FROM records WHERE kind = 'place' AND part = ? ORDER BY created DESC, id DESC LIMIT 20`;
      params = [part];
    }
    const stmt = this.db.prepare(sql).bind(...params);
    const { results = [] } = await stmt.all();
    results.sort((a, b) => {
      let aDef = false, bDef = false;
      try { aDef = !!JSON.parse(a.meta || "{}").isDefault; } catch {}
      try { bDef = !!JSON.parse(b.meta || "{}").isDefault; } catch {}
      if (aDef !== bDef) return bDef ? 1 : -1;
      return 0;
    });
    return results;
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
    const metaObj = { ...(rec.meta || {}) };
    if (rec.qualitySnapshot) metaObj.qualitySnapshot = rec.qualitySnapshot;
    if (rec.comps != null) metaObj.comps = rec.comps;
    if (rec.unit != null) metaObj.unit = rec.unit;
    if (rec.isDefault != null) metaObj.isDefault = rec.isDefault;
    if (rec.placeMatch != null) metaObj.placeMatch = rec.placeMatch;
    if (rec.note != null) metaObj.note = rec.note;
    const isSpec = rec.kind === "spec";
    if (isSpec) {
      if (rec.basedOn) metaObj.basedOn = rec.basedOn;
      metaObj.isDefault = !!rec.makeDefault;
    }
    const metaJson = JSON.stringify(metaObj);

    // 料號規格設為預設時，先記下目前的預設版（稽核 from）
    const prevDefault = isSpec && rec.makeDefault ? await this.specDefaults(rec.part) : [];

    // D1 寫入 records 與 audit_log；料號規格的版本號在同一句 INSERT 內依同料號遞增（不怕同時儲存取到同號以外的競態）
    const insertRec = this.db.prepare(`
      INSERT INTO records (id, kind, part, rev, lot, side, vendor, place_id, name, user, created, bytes, gz_bytes, sha256, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${isSpec ? "json_set(?, '$.ver', (SELECT COALESCE(MAX(json_extract(meta, '$.ver')), 0) + 1 FROM records WHERE kind = 'spec' AND part = ?))" : "?"})
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
      metaJson,
      ...(isSpec ? [rec.part || ""] : [])
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

    // 建立＋設為預設在同一個 batch（交易）內完成：清掉同料號其他版本的預設、寫入切換稽核
    const stmts = [insertRec, insertAudit];
    if (isSpec && rec.makeDefault) stmts.push(...this.specDefaultStmts(rec.id, rec.part, rec.user || "", now, prevDefault));

    try {
      await this.db.batch(stmts);
    } catch (e) {
      try { await this.r2.delete(`records/${rec.id}`); } catch {}
      throw e;
    }

    if (isSpec) {
      const row = await this.db.prepare(`SELECT meta FROM records WHERE id = ? LIMIT 1`).bind(rec.id).first();
      try { Object.assign(metaObj, JSON.parse(row?.meta || "{}")); } catch {}
      const { makeDefault, ...out } = rec;
      return { record: { ...out, ver: metaObj.ver, isDefault: !!metaObj.isDefault, meta: metaObj } };
    }
    return { record: { ...rec, meta: metaObj } };
  }

  // --- 料號規格（kind:"spec"）---

  /** 同料號目前標為預設的料號規格 id（正常只有 0 或 1 筆） */
  async specDefaults(part) {
    const { results = [] } = await this.db.prepare(
      `SELECT id FROM records WHERE kind = 'spec' AND part = ? AND json_extract(meta, '$.isDefault') = 1`
    ).bind(part).all();
    return results.map((r) => r.id);
  }

  /** 把 id 設為同料號唯一預設版的語句（清除其他、設定目標、寫稽核 from／to） */
  specDefaultStmts(id, part, user, now, prev) {
    return [
      this.db.prepare(
        `UPDATE records SET meta = json_set(meta, '$.isDefault', json('false')) WHERE kind = 'spec' AND part = ? AND id <> ? AND json_extract(meta, '$.isDefault') = 1`
      ).bind(part, id),
      this.db.prepare(
        `UPDATE records SET meta = json_set(meta, '$.isDefault', json('true')) WHERE id = ? AND kind = 'spec'`
      ).bind(id),
      this.db.prepare(
        `INSERT INTO audit_log (at, by, action, target_type, target_id, detail) VALUES (?, ?, 'set_default_spec', 'record', ?, ?)`
      ).bind(now, user, id, JSON.stringify({ action: "set_default_spec", kind: "spec", part, from: prev.filter((x) => x !== id), to: id })),
    ];
  }

  /** 依料號列出料號規格版本（新到舊），meta 攤平為 ver／isDefault／note／basedOn */
  async getSpecsForPart(part) {
    if (!part) return [];
    const { results = [] } = await this.db.prepare(
      `SELECT id, part, name, user, created, bytes, sha256, meta FROM records WHERE kind = 'spec' AND part = ? ORDER BY created DESC, id DESC LIMIT 200`
    ).bind(part).all();
    return results.map((r) => {
      let m = {};
      try { m = JSON.parse(r.meta || "{}"); } catch {}
      return { id: r.id, kind: "spec", part: r.part, name: r.name, user: r.user, created: r.created, bytes: r.bytes, sha256: r.sha256,
        ver: Number.isFinite(m.ver) ? m.ver : 0, isDefault: !!m.isDefault, note: m.note || "", basedOn: m.basedOn || "" };
    });
  }

  /** 設定料號規格預設版：任何登入者都可以（D5）；原子切換並記錄前後版本 */
  async setDefaultSpec(id, user) {
    if (!id || !ID_RE.test(id)) return { error: "料號規格代碼格式不正確", status: 400 };
    const target = await this.getRecord(id);
    if (!target || target.kind !== "spec") return { error: "找不到指定的料號規格", status: 404 };
    const prev = await this.specDefaults(target.part);
    if (prev.length === 1 && prev[0] === id) return { success: true, defaultId: id, part: target.part, unchanged: true };
    await this.db.batch(this.specDefaultStmts(id, target.part, user, Date.now(), prev));
    return { success: true, defaultId: id, part: target.part, from: prev.filter((x) => x !== id) };
  }

  /** 設定指定座標檔為預設版本 */
  async setDefaultPlacement(id, user) {
    if (!id || !ID_RE.test(id)) return { error: "座標檔代碼格式不正確", status: 400 };
    const target = await this.getRecord(id);
    if (!target || target.kind !== "place") return { error: "找不到指定的座標檔", status: 404 };
    const part = target.part, side = target.side || "";
    let sql, params;
    if (side) {
      sql = `SELECT id, meta FROM records WHERE kind = 'place' AND part = ? AND (side = ? OR side = '' OR side IS NULL)`;
      params = [part, side];
    } else {
      sql = `SELECT id, meta FROM records WHERE kind = 'place' AND part = ?`;
      params = [part];
    }
    const { results = [] } = await this.db.prepare(sql).bind(...params).all();
    const batchStmts = [];
    const now = Date.now();
    for (const r of results) {
      let m = {};
      try { m = JSON.parse(r.meta || "{}"); } catch {}
      const shouldBeDefault = r.id === id;
      if (m.isDefault !== shouldBeDefault) {
        m.isDefault = shouldBeDefault;
        batchStmts.push(
          this.db.prepare(`UPDATE records SET meta = ? WHERE id = ?`).bind(JSON.stringify(m), r.id)
        );
      }
    }
    const auditDetail = JSON.stringify({
      action: "set_default_place",
      target_id: id,
      part,
      rev: target.rev,
      side,
    });
    batchStmts.push(
      this.db.prepare(
        `INSERT INTO audit_log (at, by, action, target_type, target_id, detail) VALUES (?, ?, 'set_default_place', 'record', ?, ?)`
      ).bind(now, user, id, auditDetail)
    );
    if (batchStmts.length > 0) {
      await this.db.batch(batchStmts);
    }
    return { success: true, defaultId: id, part, side };
  }

  /** 更新紀錄中繼資料（工單號與備註），原子寫入 audit_log */
  async updateRecordMeta(id, patch, user) {
    if (!id || !ID_RE.test(id)) return { error: "紀錄代碼格式不正確", status: 400 };
    const target = await this.getRecord(id);
    if (!target) return { error: "找不到這筆紀錄", status: 404 };
    if (target.user !== user) return { error: `只有上傳者（${target.user}）可以修改中繼資料`, status: 403 };

    let m = {};
    try { m = JSON.parse(target.meta || "{}"); } catch {}
    const changes = {};

    let newSupplierWo = target.supplierWo || "";
    if (patch.supplierWo !== undefined) {
      changes.supplierWo = { from: target.supplierWo || "", to: patch.supplierWo };
      newSupplierWo = patch.supplierWo;
    }
    let newOutsourceWo = target.outsourceWo || "";
    if (patch.outsourceWo !== undefined) {
      changes.outsourceWo = { from: target.outsourceWo || "", to: patch.outsourceWo };
      newOutsourceWo = patch.outsourceWo;
    }
    if (patch.note !== undefined) {
      changes.note = { from: m.note || "", to: patch.note };
      m.note = patch.note;
    }
    m.lastModified = Date.now();
    m.modifiedBy = user;

    const metaJson = JSON.stringify(m);
    const updateStmt = this.db.prepare(
      `UPDATE records SET supplierWo = ?, outsourceWo = ?, meta = ? WHERE id = ?`
    ).bind(newSupplierWo, newOutsourceWo, metaJson, id);

    const now = Date.now();
    const auditDetail = JSON.stringify({
      action: "update_meta",
      target_id: id,
      changes,
    });
    const auditStmt = this.db.prepare(
      `INSERT INTO audit_log (at, by, action, target_type, target_id, detail) VALUES (?, ?, 'update_meta', 'record', ?, ?)`
    ).bind(now, user, id, auditDetail);

    await this.db.batch([updateStmt, auditStmt]);
    return { success: true, id, changes };
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

  async listAuditLog(_limit = 50, beforeSeq = null) {
    // H-4: 稽核頁 API 忽略 limit 參數，一律 LIMIT 51 (每頁 50 筆)
    const hasCursor = beforeSeq != null && Number.isFinite(Number(beforeSeq));
    // F-2, L-6: SELECT a.seq, a.at, a.by, a.action, a.target_type, a.target_id, a.detail, r.id AS live FROM audit_log a LEFT JOIN records r ON r.id = a.target_id [WHERE a.seq < ?] ORDER BY a.seq DESC LIMIT 51
    const sql = `
      SELECT a.seq, a.at, a.by, a.action, a.target_type, a.target_id, a.detail, r.id AS live
      FROM audit_log a
      LEFT JOIN records r ON a.target_id = r.id
      ${hasCursor ? "WHERE a.seq < ?" : ""}
      ORDER BY a.seq DESC
      LIMIT 51
    `;
    const params = hasCursor ? [Number(beforeSeq)] : [];
    const { results = [] } = await this.db.prepare(sql).bind(...params).all();
    const sliced = results.slice(0, 50);
    return sliced.map((row) => {
      let d = {};
      try { d = JSON.parse(row.detail || "{}"); } catch {}
      let status = "完成";
      if (d.done === false) {
        status = "未完成";
      } else if (row.action === "migrate_exclude") {
        status = "遷移時排除（未搬到新站）";
      } else if (row.action === "delete" || row.action === "share_revoke") {
        status = "刪除";
      } else if (row.target_type === "record") {
        status = (row.live != null || Boolean(row.target_exists))
          ? (row.action === "create" ? "已存檔" : "完成")
          : "目標已不在本站（見較新的刪除或遷移排除紀錄）";
      }
      return {
        seq: row.seq,
        action: row.action,
        at: row.at,
        by: row.by,
        target_type: row.target_type,
        id: (row.target_type === "share" && row.target_id) ? row.target_id.slice(0, 6) : row.target_id,
        status,
        ok: d.done !== false,
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

  // --- auth_attempts 表操作 (9.5 定案設計) ---

  /** 9.5 步驟 1: 取兩把鍵各自最新 5 筆 (以 UNION ALL 限制每把鍵 <= 5 列) */
  async getAuthAttempts(keyU, keyIp, now = Date.now()) {
    const sql = `
      SELECT 'u' AS k, at FROM (SELECT at FROM auth_attempts WHERE key_u = ?1 AND at > ?3 - 1800000 ORDER BY at DESC LIMIT 5)
      UNION ALL
      SELECT 'ip' AS k, at FROM (SELECT at FROM auth_attempts WHERE key_ip = ?2 AND at > ?3 - 1800000 ORDER BY at DESC LIMIT 5)
    `;
    const { results = [] } = await this.db.prepare(sql).bind(keyU, keyIp, now).all();
    return results;
  }

  /** 9.5 步驟 2: 原子條件式 INSERT (RETURNING id) */
  async insertAuthAttemptAtomic(keyU, keyIp, now = Date.now()) {
    const sql = `
      INSERT INTO auth_attempts (key_u, key_ip, at)
      SELECT ?1, ?2, ?3
      WHERE (SELECT COUNT(*) = 5 AND MAX(at) - MIN(at) < 900000 AND MAX(at) > ?3 - 900000
               FROM (SELECT at FROM auth_attempts WHERE key_u = ?1 AND at > ?3 - 1800000 ORDER BY at DESC LIMIT 5)) = 0
        AND (SELECT COUNT(*) = 5 AND MAX(at) - MIN(at) < 900000 AND MAX(at) > ?3 - 900000
               FROM (SELECT at FROM auth_attempts WHERE key_ip = ?2 AND at > ?3 - 1800000 ORDER BY at DESC LIMIT 5)) = 0
      RETURNING id;
    `;
    const row = await this.db.prepare(sql).bind(keyU, keyIp, now).first();
    return row ? row.id : null;
  }

  /** 9.5 步驟 4: 登入成功時清除該帳號所有失敗記錄 */
  async clearAuthAttemptsForUser(keyU) {
    await this.db.prepare(`DELETE FROM auth_attempts WHERE key_u = ?`).bind(keyU).run();
  }

  /** 定時清除 30 分鐘前登入嘗試 (cron) */
  async purgeOldAuthAttempts(now = Date.now()) {
    const thirtyMinsAgo = now - 30 * 60_000;
    return await this.db.prepare(`DELETE FROM auth_attempts WHERE at < ?`).bind(thirtyMinsAgo).run();
  }
}
