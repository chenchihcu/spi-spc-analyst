-- 0006_placement_and_snapshot.sql: 支援料號 + 面別三維座標關聯索引與快照
CREATE INDEX IF NOT EXISTS idx_records_part_side_kind ON records (part, side, kind, created DESC);
