-- 0005_record_catalog_enhancement.sql: 建立料號與類型聚合索引，加速開機歷史記錄檢索與座標檔關聯
CREATE INDEX IF NOT EXISTS idx_records_part_kind ON records (part, kind, created DESC);
