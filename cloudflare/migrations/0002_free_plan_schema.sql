-- 0002_free_plan_schema.sql: 符合 Cloudflare Workers 免費方案配額的 D1 資料表
-- 依照規格書 D-59, 9.4 規範

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT '',
  part TEXT NOT NULL DEFAULT '',
  rev TEXT NOT NULL DEFAULT '',
  lot TEXT NOT NULL DEFAULT '',
  side TEXT NOT NULL DEFAULT '',
  vendor TEXT NOT NULL DEFAULT '',
  place_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  user TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  gz_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}'
);

-- 唯一索引：比對 sameFile (相同內容、相同回溯欄位)
CREATE UNIQUE INDEX IF NOT EXISTS idx_records_same_file ON records (kind, part, rev, lot, side, vendor, place_id, sha256);

-- 列表查詢索引：依 kind 與時間遞減分頁
CREATE INDEX IF NOT EXISTS idx_records_list ON records (kind, created DESC, id DESC);

-- 指紋查詢索引
CREATE INDEX IF NOT EXISTS idx_records_sha256 ON records (sha256);


-- 稽核紀錄表：自動遞增 seq、永不刪除、不使用 AUTOINCREMENT 避免額外索引與寫入消耗
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  by TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log (target_id);


-- 分享連結表
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL DEFAULT 0,
  exp INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER NOT NULL DEFAULT 0,
  revoked_by TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_shares_user ON shares (user, created DESC);
CREATE INDEX IF NOT EXISTS idx_shares_exp ON shares (exp);


-- 登入嘗試紀錄表：記錄嘗試 HMAC 與時間，供暴力密碼防禦與速率限制
CREATE TABLE IF NOT EXISTS auth_attempts (
  id INTEGER PRIMARY KEY,
  key_hash TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_auth_key_at ON auth_attempts (key_hash, at);


-- 系統統計快照表：儲存每日計數快照，避免首頁或管理頁全表掃描
CREATE TABLE IF NOT EXISTS stats (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0
);
