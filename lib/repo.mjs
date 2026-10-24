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

  async bootstrapAdmin(initialUser, accountExists, now = Date.now()) {
    const user = String(initialUser || '').trim().toLowerCase();
    if (!user || !accountExists) return;
    await this.db.batch([
      this.db.prepare(`INSERT INTO admin_roles(user,granted_at,granted_by)
        SELECT ?, ?, 'bootstrap' WHERE NOT EXISTS (SELECT 1 FROM system_settings WHERE key = 'admin_bootstrap')`).bind(user, now),
      this.db.prepare(`INSERT OR IGNORE INTO system_settings(key,value) VALUES ('admin_bootstrap', ?)`).bind(user),
    ]);
  }

  async isAdmin(user) {
    if (!user) return false;
    return !!(await this.db.prepare(`SELECT 1 FROM admin_roles WHERE user = ? LIMIT 1`).bind(user).first());
  }

  async listAdminRoles() {
    const { results = [] } = await this.db.prepare(`SELECT user,granted_at,granted_by FROM admin_roles ORDER BY user`).all();
    return results;
  }

  async setAdminRole(target, grant, by, loginUsers, now = Date.now()) {
    const user = String(target || '').trim().toLowerCase();
    if (grant) {
      await this.db.batch([
        this.db.prepare(`INSERT OR IGNORE INTO admin_roles(user,granted_at,granted_by) VALUES (?,?,?)`).bind(user, now, by),
        this.db.prepare(`INSERT INTO audit_log(at,by,action,target_type,target_id,detail)
          SELECT ?,?,'admin_grant','user',?,? FROM admin_roles WHERE user=? AND granted_at=? AND granted_by=?`)
          .bind(now, by, user, '{}', user, now, by),
      ]);
      return { ok: true };
    }
    const accounts = [...new Set(loginUsers || [])];
    if (!accounts.length) return { error: '無法確認可登入的管理者', status: 409 };
    const slots = accounts.map(() => '?').join(',');
    const eligibility = `user=? AND (SELECT COUNT(*) FROM admin_roles WHERE user IN (${slots})) > 1`;
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO audit_log(at,by,action,target_type,target_id,detail)
        SELECT ?,?,'admin_revoke','user',?,? FROM admin_roles WHERE ${eligibility}`)
        .bind(now, by, user, '{}', user, ...accounts),
      this.db.prepare(`DELETE FROM admin_roles WHERE ${eligibility}`).bind(user, ...accounts),
    ]);
    if (!results[1]?.meta?.changes) return { error: '無法撤銷最後一位可登入的管理者或該帳號不是管理者', status: 409 };
    return { ok: true };
  }

  async coordinateScope(part, rev, side) {
    return await this.db.prepare(`SELECT r.* FROM coordinate_scopes c JOIN records r ON r.id = c.record_id
      WHERE c.part = ? AND c.rev = ? AND c.side = ? LIMIT 1`).bind(part, rev, side).first();
  }

  async measurementFingerprint(part, rev, side, sha256) {
    return await this.db.prepare(`SELECT * FROM records WHERE kind='spi' AND part=? AND rev=? AND side=? AND sha256=?
      AND validation_source='server_verified' LIMIT 1`).bind(part, rev, side, sha256).first();
  }

  async relatedMeasurements(part, rev, side, workOrder, measuredDate) {
    if (!workOrder && !measuredDate) return [];
    const { results = [] } = await this.db.prepare(`SELECT id,work_order,measured_date,lifecycle FROM records
      WHERE kind='spi' AND part=? AND rev=? AND side=? AND lifecycle IN ('active','pending_review')
        AND ((? <> '' AND work_order=?) OR (? <> '' AND measured_date=?)) LIMIT 100`).bind(
      part, rev, side, workOrder, workOrder, measuredDate, measuredDate).all();
    return results;
  }

  // --- records 表操作 ---

  /** Keyset 分頁列表查詢；不以固定第一頁推定資料不存在。 */
  async listRecords({ kind, part, rev, side, workOrder, measuredDate, lifecycle, cursorCreated, cursorId, limit = 50 }) {
    const lim = Math.min(Math.max(1, limit), 100);
    const where = ['kind = ?'], params = [kind];
    for (const [column, value] of [['part', part], ['rev', rev], ['side', side], ['work_order', workOrder],
      ['measured_date', measuredDate], ['lifecycle', lifecycle]]) {
      if (value) { where.push(`${column} = ?`); params.push(value); }
    }
    if (cursorCreated != null && cursorId != null) { where.push('(created, id) < (?, ?)'); params.push(cursorCreated, cursorId); }
    const sql = `SELECT * FROM records WHERE ${where.join(' AND ')} ORDER BY created DESC, id DESC LIMIT ?`;
    params.push(lim + 1);
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
  async getPlacementsForPart(part, side, rev, cursorCreated = null, cursorId = null, limit = 100) {
    if (!part) return { placements: [], next: null };
    const lim = Math.min(Math.max(1, limit), 100);
    const sql = `SELECT DISTINCT r.* FROM coordinate_scopes c JOIN records r ON r.id = c.record_id
      WHERE c.part = ? AND (? = '' OR c.rev = ?) AND (? = '' OR c.side = ?) AND r.lifecycle = 'active'
      ${cursorCreated != null && cursorId != null ? 'AND (r.created, r.id) < (?, ?)' : ''}
      ORDER BY r.created DESC, r.id DESC LIMIT ?`;
    const params = [part, rev || '', rev || '', side || '', side || '',
      ...(cursorCreated != null && cursorId != null ? [cursorCreated, cursorId] : []), lim + 1];
    const stmt = this.db.prepare(sql).bind(...params);
    const { results = [] } = await stmt.all();
    const hasMore = results.length > lim, placements = hasMore ? results.slice(0, lim) : results;
    const last = placements[placements.length - 1];
    return { placements, next: hasMore && last ? `${last.created},${last.id}` : null };
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
  async searchRecords(query, limit = 50, cursorCreated = null, cursorId = null) {
    const rawQ = String(query || "").trim();
    if (rawQ.length < 2) return [];
    // 依 D-59: D1 LIKE 樣式上限 50 bytes，中文約 16 字；跳脫 %, _, \
    const escaped = rawQ.slice(0, 16).replace(/[\\%_]/g, "\\$&");
    const pattern = `%${escaped}%`;
    const lim = Math.min(Math.max(1, limit), 100);
    const sql = `SELECT * FROM records WHERE (lot LIKE ? ESCAPE '\\' OR part LIKE ? ESCAPE '\\' OR rev LIKE ? ESCAPE '\\'
      OR work_order LIKE ? ESCAPE '\\' OR measured_date LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR user LIKE ? ESCAPE '\\')
      ${cursorCreated != null && cursorId != null ? 'AND (created, id) < (?, ?)' : ''}
      ORDER BY created DESC, id DESC LIMIT ?`;
    const stmt = this.db.prepare(sql).bind(pattern, pattern, pattern, pattern, pattern, pattern, pattern,
      ...(cursorCreated != null && cursorId != null ? [cursorCreated, cursorId] : []), lim);
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
    if (rec.kind === 'place' && rec.validationSource === 'server_verified') {
      const sides = rec.sides || (rec.side === 'BOTH' ? ['TOP', 'BOT'] : [rec.side]);
      const occupied = (await Promise.all(sides.map(side => this.coordinateScope(rec.part, rec.rev, side)))).filter(Boolean);
      if (occupied.length) {
        const same = occupied.length === sides.length && occupied.every(x => {
          let m = {}; try { m = JSON.parse(x.meta || '{}'); } catch {}
          return x.id === occupied[0].id && x.sha256 === rec.sha256 && x.side === rec.side && m.unit === rec.unit;
        });
        return same ? { record: occupied[0], existing: occupied[0].id, status: 200 }
          : { error: '同料號、版次與面別已有受控座標檔', code: 'version_conflict', existing: occupied[0].id, status: 409 };
      }
    }
    const dupId = rec.validationSource === 'server_verified' && rec.kind === 'spi'
      ? (await this.measurementFingerprint(rec.part, rec.rev, rec.side, rec.sha256))?.id
      : rec.validationSource === 'server_verified' && rec.kind === 'place' ? null : await this.findDuplicate(rec);
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
    if (rec.factor != null) metaObj.factor = rec.factor;
    if (rec.formatVersion != null) metaObj.formatVersion = rec.formatVersion;
    if (rec.unmatchedRefs != null) metaObj.unmatchedRefs = rec.unmatchedRefs;
    if (rec.unmatchedConfirmed != null) metaObj.unmatchedConfirmed = rec.unmatchedConfirmed;
    if (rec.supplierWo != null) metaObj.supplierWo = rec.supplierWo;
    if (rec.outsourceWo != null) metaObj.outsourceWo = rec.outsourceWo;
    if (rec.boards != null) metaObj.boards = rec.boards;
    if (rec.pads != null) metaObj.pads = rec.pads;
    if (rec.rows != null) metaObj.rows = rec.rows;
    if (rec.isDefault != null) metaObj.isDefault = rec.validationSource === 'server_verified' && rec.kind === 'place' ? false : rec.isDefault;
    if (rec.placeMatch != null) metaObj.placeMatch = rec.placeMatch;
    if (rec.note != null) metaObj.note = rec.note;
    if (rec.stencil) metaObj.stencil = rec.stencil;
    const isSpec = rec.kind === "spec";
    if (isSpec) {
      if (rec.basedOn) metaObj.basedOn = rec.basedOn;
      metaObj.isDefault = !!rec.makeDefault;
    }
    const metaJson = JSON.stringify(metaObj);

    // D1 寫入 records 與 audit_log；料號規格的版本號在同一句 INSERT 內依同料號遞增（不怕同時儲存取到同號以外的競態）
    const reviewOnInsert = rec.kind === 'spi' && rec.validationSource === 'server_verified';
    const lifecycleSql = reviewOnInsert ? `CASE WHEN EXISTS (SELECT 1 FROM records prior
      WHERE prior.kind='spi' AND prior.part=? AND prior.rev=? AND prior.side=?
        AND prior.lifecycle IN ('active','pending_review')
        AND ((? <> '' AND prior.work_order=?) OR (? <> '' AND prior.measured_date=?)))
      THEN 'pending_review' ELSE ? END` : '?';
    const insertRec = this.db.prepare(`
      INSERT INTO records (id, kind, part, rev, lot, side, vendor, place_id, name, user, created, bytes, gz_bytes, sha256, meta,
        work_order, measured_date, lifecycle, validation_source, unmatched_refs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${isSpec ? "json_set(?, '$.ver', (SELECT COALESCE(MAX(json_extract(meta, '$.ver')), 0) + 1 FROM records WHERE kind = 'spec' AND part = ?))" : "?"}, ?, ?, ${lifecycleSql}, ?, ?)
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
      ...(isSpec ? [rec.part || ""] : []),
      rec.workOrder || '', rec.measuredDate || '',
      ...(reviewOnInsert ? [rec.part, rec.rev, rec.side, rec.workOrder || '', rec.workOrder || '', rec.measuredDate || '', rec.measuredDate || ''] : []),
      rec.lifecycle || 'legacy', rec.validationSource || 'legacy',
      JSON.stringify(rec.unmatchedRefs || [])
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
    if (rec.kind === 'place' && rec.validationSource === 'server_verified') {
      for (const side of rec.sides || [rec.side]) stmts.push(this.db.prepare(
        `INSERT INTO coordinate_scopes(part,rev,side,record_id) VALUES (?,?,?,?)`
      ).bind(rec.part, rec.rev, side, rec.id));
    }
    if (isSpec && rec.makeDefault) stmts.push(...this.specDefaultStmts(rec.id, rec.part, rec.user || "", now));
    // 座標檔上傳時勾選「設為預設」：同一個交易內清除同範圍其他預設並記錄切換，避免留下多個預設
    if (rec.kind === "place" && rec.isDefault && rec.validationSource !== 'server_verified') stmts.push(...this.placeDefaultStmts(rec, rec.user || "", now));

    try {
      await this.db.batch(stmts);
    } catch (e) {
      try { await this.r2.delete(`records/${rec.id}`); } catch {}
      if (rec.kind === 'place' && rec.validationSource === 'server_verified') {
        const checked = await Promise.all((rec.sides || [rec.side]).map(side => this.coordinateScope(rec.part, rec.rev, side)));
        const conflict = checked.find(Boolean);
        if (conflict) return { error: '同料號、版次與面別已有受控座標檔', code: 'version_conflict', existing: conflict.id, status: 409 };
      }
      if (rec.kind === 'spi' && rec.validationSource === 'server_verified') {
        const dup = await this.measurementFingerprint(rec.part, rec.rev, rec.side, rec.sha256);
        if (dup) return { error: '這個量測檔已匯入', code: 'duplicate_file', existing: dup.id, status: 409 };
      }
      throw e;
    }

    if (isSpec) {
      const row = await this.db.prepare(`SELECT meta FROM records WHERE id = ? LIMIT 1`).bind(rec.id).first();
      try { Object.assign(metaObj, JSON.parse(row?.meta || "{}")); } catch {}
      const { makeDefault, ...out } = rec;
      return { record: { ...out, ver: metaObj.ver, isDefault: !!metaObj.isDefault, meta: metaObj } };
    }
    if (reviewOnInsert) {
      const inserted = await this.getRecord(rec.id);
      return { record: { ...rec, lifecycle: inserted.lifecycle, meta: metaObj } };
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

  /** 把 id 設為同料號唯一預設版的語句。全部在 batch 執行當下選取資料列：
   *  先寫稽核（from＝此刻同料號其他預設版），再清除其他預設、設定目標；同時發生的請求依序執行，from 記錄的是實際被取代的版本 */
  specDefaultStmts(id, part, user, now) {
    return [
      this.db.prepare(
        `INSERT INTO audit_log (at, by, action, target_type, target_id, detail) VALUES (?, ?, 'set_default_spec', 'record', ?,
          json_set(?, '$.from', json((SELECT json_group_array(id) FROM records WHERE kind = 'spec' AND part = ? AND id <> ? AND json_extract(meta, '$.isDefault') = 1))))`
      ).bind(now, user, id, JSON.stringify({ action: "set_default_spec", kind: "spec", part, to: id }), part, id),
      this.db.prepare(
        `UPDATE records SET meta = json_set(meta, '$.isDefault', json('false')) WHERE kind = 'spec' AND part = ? AND id <> ? AND json_extract(meta, '$.isDefault') = 1`
      ).bind(part, id),
      this.db.prepare(
        `UPDATE records SET meta = json_set(meta, '$.isDefault', json('true')) WHERE id = ? AND kind = 'spec'`
      ).bind(id),
    ];
  }

  /** 依料號列出料號規格版本（版本號由新到舊；建立時間、id 只作同號時的備援排序），meta 攤平為 ver／isDefault／note／basedOn */
  async getSpecsForPart(part) {
    if (!part) return [];
    const { results = [] } = await this.db.prepare(
      `SELECT id, part, name, user, created, bytes, sha256, meta FROM records WHERE kind = 'spec' AND part = ? ORDER BY json_extract(meta, '$.ver') DESC, created DESC, id DESC LIMIT 200`
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
    await this.db.batch(this.specDefaultStmts(id, target.part, user, Date.now()));
    // 回傳稽核實際記錄的 from（batch 執行當下的前一預設版）
    const row = await this.db.prepare(
      `SELECT detail FROM audit_log WHERE action = 'set_default_spec' AND target_id = ? ORDER BY seq DESC LIMIT 1`
    ).bind(id).first();
    let from = [];
    try { from = JSON.parse(row?.detail || "{}").from || []; } catch {}
    return { success: true, defaultId: id, part: target.part, from };
  }

  /** 把座標檔 id 設為同料號（同面別；無面別者視為兩面通用）唯一預設版的語句。與 specDefaultStmts 相同，
   *  全部在 batch 執行當下選取資料列：先寫稽核（from＝此刻同範圍其他預設版），再清除其他預設、設定目標 */
  placeDefaultStmts(target, user, now) {
    const id = target.id, part = target.part || "", side = target.side || "";
    const scope = `kind = 'place' AND part = ? AND id <> ? AND (? = '' OR side = ? OR side = '' OR side IS NULL)`;
    const detail = { action: "set_default_place", kind: "place", target_id: id, to: id, part, rev: target.rev || "", side,
      name: target.name || "", sha256: target.sha256 || "" };
    return [
      this.db.prepare(
        `INSERT INTO audit_log (at, by, action, target_type, target_id, detail) VALUES (?, ?, 'set_default_place', 'record', ?,
          json_set(?, '$.from', json((SELECT json_group_array(id) FROM records WHERE ${scope} AND json_extract(meta, '$.isDefault') = 1))))`
      ).bind(now, user, id, JSON.stringify(detail), part, id, side, side),
      this.db.prepare(
        `UPDATE records SET meta = json_set(meta, '$.isDefault', json('false')) WHERE ${scope} AND json_extract(meta, '$.isDefault') = 1`
      ).bind(part, id, side, side),
      this.db.prepare(
        `UPDATE records SET meta = json_set(meta, '$.isDefault', json('true')) WHERE id = ? AND kind = 'place'`
      ).bind(id),
    ];
  }

  /** 設定指定座標檔為預設版本：原子切換並記錄前後版本；已是唯一預設時不重複寫稽核 */
  async setDefaultPlacement(id, user) {
    if (!id || !ID_RE.test(id)) return { error: "座標檔代碼格式不正確", status: 400 };
    const target = await this.getRecord(id);
    if (!target || target.kind !== "place") return { error: "找不到指定的座標檔", status: 404 };
    const part = target.part, side = target.side || "";
    const { results: prev = [] } = await this.db.prepare(
      `SELECT id FROM records WHERE kind = 'place' AND part = ? AND (? = '' OR side = ? OR side = '' OR side IS NULL) AND json_extract(meta, '$.isDefault') = 1`
    ).bind(part, side, side).all();
    if (prev.length === 1 && prev[0].id === id) return { success: true, defaultId: id, part, side, unchanged: true };
    await this.db.batch(this.placeDefaultStmts(target, user, Date.now()));
    const row = await this.db.prepare(
      `SELECT detail FROM audit_log WHERE action = 'set_default_place' AND target_id = ? ORDER BY seq DESC LIMIT 1`
    ).bind(id).first();
    let from = [];
    try { from = JSON.parse(row?.detail || "{}").from || []; } catch {}
    return { success: true, defaultId: id, part, side, from };
  }

  /** 更新紀錄中繼資料（工單號與備註），原子寫入 audit_log */
  async updateRecordMeta(id, patch, user, isAdmin = false) {
    if (!id || !ID_RE.test(id)) return { error: "紀錄代碼格式不正確", status: 400 };
    const target = await this.getRecord(id);
    if (!target) return { error: "找不到這筆紀錄", status: 404 };
    if (target.kind === "spec") return { error: "料號規格版本不能修改；備註記錄在規格檔內，請另存新版本", status: 400 };
    if (!isAdmin) return { error: '只有管理者可以修改量測中繼資料', status: 403 };
    if (target.kind === 'place' && ['workOrder', 'measuredDate', 'lot'].some(key => patch[key] !== undefined))
      return { error: '座標檔不能修改量測鑑別欄位', status: 422 };

    let m = {};
    try { m = JSON.parse(target.meta || "{}"); } catch {}
    const changes = {};

    let newSupplierWo = m.supplierWo || "";
    if (patch.supplierWo !== undefined) {
      changes.supplierWo = { from: m.supplierWo || "", to: patch.supplierWo };
      newSupplierWo = patch.supplierWo;
    }
    let newOutsourceWo = m.outsourceWo || "";
    if (patch.outsourceWo !== undefined) {
      changes.outsourceWo = { from: m.outsourceWo || "", to: patch.outsourceWo };
      newOutsourceWo = patch.outsourceWo;
    }
    m.supplierWo = newSupplierWo; m.outsourceWo = newOutsourceWo;
    const newWorkOrder = patch.workOrder !== undefined ? patch.workOrder : target.work_order || '';
    const newMeasuredDate = patch.measuredDate !== undefined ? patch.measuredDate : target.measured_date || '';
    const newLot = patch.lot !== undefined ? patch.lot : target.lot || '';
    if (patch.workOrder !== undefined) changes.workOrder = { from: target.work_order || '', to: newWorkOrder };
    if (patch.measuredDate !== undefined) changes.measuredDate = { from: target.measured_date || '', to: newMeasuredDate };
    if (patch.lot !== undefined) changes.lot = { from: target.lot || '', to: newLot };
    if (target.kind === 'spi' && target.validation_source === 'server_verified' && !newWorkOrder && !newMeasuredDate)
      return { error: '製令工單與量測日期至少填一項', status: 422 };
    if (patch.note !== undefined) {
      changes.note = { from: m.note || "", to: patch.note };
      m.note = patch.note;
    }
    m.lastModified = Date.now();
    m.modifiedBy = user;

    const metaJson = JSON.stringify(m);
    const updateStmt = this.db.prepare(
      `UPDATE records SET work_order = ?, measured_date = ?, lot = ?, meta = ? WHERE id = ?`
    ).bind(newWorkOrder, newMeasuredDate, newLot, metaJson, id);

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

  async archivePlacement(id, user, now = Date.now()) {
    const rec = await this.getRecord(id);
    if (!rec || rec.kind !== 'place') return { error: '找不到座標檔', status: 404 };
    if (rec.lifecycle === 'archived') return { ok: true, unchanged: true };
    if (rec.lifecycle !== 'active') return { error: '歷史座標檔不可直接封存', status: 409 };
    await this.db.batch([
      this.db.prepare(`UPDATE records SET lifecycle='archived' WHERE id=? AND lifecycle='active'`).bind(id),
      this.db.prepare(`INSERT INTO audit_log(at,by,action,target_type,target_id,detail) VALUES (?,?,'archive_place','record',?,?)`).bind(now,user,id,'{}'),
    ]);
    return { ok: true };
  }

  async judgeMeasurement(id, action, targetId, user, now = Date.now()) {
    const rec = await this.getRecord(id);
    if (!rec || rec.kind !== 'spi') return { error: '找不到量測紀錄', status: 404 };
    if (rec.lifecycle !== 'pending_review') return { error: '此紀錄已被判定', status: 409 };
    if (action === 'new_batch') {
      const results = await this.db.batch([
        this.db.prepare(`UPDATE records SET lifecycle='active' WHERE id=? AND lifecycle='pending_review'`).bind(id),
        this.db.prepare(`INSERT INTO audit_log(at,by,action,target_type,target_id,detail)
          SELECT ?,?,'new_batch','record',?,? WHERE EXISTS(SELECT 1 FROM records WHERE id=? AND lifecycle='active')`).bind(now,user,id,'{}',id),
      ]);
      return results[0]?.meta?.changes ? { ok: true } : { error: '紀錄已由其他管理者判定', status: 409 };
    }
    if (action !== 'correct' || !ID_RE.test(targetId || '')) return { error: '請選擇要修正的紀錄', status: 400 };
    const target = await this.getRecord(targetId);
    if (!target || target.kind !== 'spi' || target.lifecycle !== 'active' || target.part !== rec.part || target.rev !== rec.rev || target.side !== rec.side)
      return { error: '被修正紀錄必須是相同料號、版次、面別的有效量測', status: 409 };
    const results = await this.db.batch([
      this.db.prepare(`UPDATE records SET lifecycle='active',supersedes_id=? WHERE id=? AND lifecycle='pending_review'
        AND EXISTS(SELECT 1 FROM records WHERE id=? AND lifecycle='active')`).bind(targetId,id,targetId),
      this.db.prepare(`UPDATE records SET lifecycle='superseded' WHERE id=? AND lifecycle='active'
        AND EXISTS(SELECT 1 FROM records WHERE id=? AND lifecycle='active' AND supersedes_id=?)`).bind(targetId,id,targetId),
      this.db.prepare(`INSERT INTO audit_log(at,by,action,target_type,target_id,detail)
        SELECT ?,?,'correct','record',?,? WHERE EXISTS(SELECT 1 FROM records WHERE id=? AND lifecycle='active' AND supersedes_id=?)`).bind(now,user,id,JSON.stringify({supersedes:targetId}),id,targetId),
    ]);
    return results[0]?.meta?.changes ? { ok: true, supersedes: targetId } : { error: '此紀錄已由其他管理者判定', status: 409 };
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
    if (rec.kind === 'place' || rec.kind === 'spi') return { error: '量測與座標原始檔須保留，請使用封存或修正流程', status: 409 };
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
