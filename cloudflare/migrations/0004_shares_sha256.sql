-- 0004_shares_sha256.sql: Add sha256 column to shares table for verification (H-2)
ALTER TABLE shares ADD COLUMN sha256 TEXT NOT NULL DEFAULT '';
