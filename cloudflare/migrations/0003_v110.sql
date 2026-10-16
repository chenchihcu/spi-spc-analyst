-- 0003_v110.sql: 9.5 定案登入鎖定結構與 audit_log 冪等索引
-- 實作規範：9.5, C-1, C-5

DROP TABLE IF EXISTS auth_attempts;
CREATE TABLE auth_attempts (
  id     INTEGER PRIMARY KEY,
  key_u  TEXT    NOT NULL,
  key_ip TEXT    NOT NULL,
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_u  ON auth_attempts(key_u,  at);
CREATE INDEX IF NOT EXISTS idx_auth_ip ON auth_attempts(key_ip, at);

-- audit_log 增加 src_key 欄位與部分唯一索引 (遷移冪等)
ALTER TABLE audit_log ADD COLUMN src_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_src ON audit_log(src_key) WHERE src_key IS NOT NULL;

-- 清理 stats 舊節流鍵
DELETE FROM stats WHERE key = 'auth_mode' OR key LIKE 'auth\_del\_%' ESCAPE '\';
