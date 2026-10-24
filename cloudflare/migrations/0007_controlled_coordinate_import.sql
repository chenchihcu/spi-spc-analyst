-- RFC-SPI-COORD-20261023. Legacy rows remain readable and unverified.
ALTER TABLE records ADD COLUMN work_order TEXT NOT NULL DEFAULT '';
ALTER TABLE records ADD COLUMN measured_date TEXT NOT NULL DEFAULT '';
ALTER TABLE records ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE records ADD COLUMN validation_source TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE records ADD COLUMN unmatched_refs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE records ADD COLUMN supersedes_id TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS coordinate_scopes (
  part TEXT NOT NULL,
  rev TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('TOP','BOT')),
  record_id TEXT NOT NULL REFERENCES records(id),
  PRIMARY KEY (part, rev, side)
);
CREATE INDEX IF NOT EXISTS idx_coordinate_scopes_record ON coordinate_scopes(record_id);

CREATE TABLE IF NOT EXISTS admin_roles (
  user TEXT PRIMARY KEY,
  granted_at INTEGER NOT NULL,
  granted_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_records_work_order ON records(part, rev, side, work_order) WHERE kind = 'spi';
CREATE INDEX IF NOT EXISTS idx_records_measured_date ON records(part, rev, side, measured_date) WHERE kind = 'spi';
CREATE INDEX IF NOT EXISTS idx_records_lifecycle ON records(kind, lifecycle, created DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_records_supersedes ON records(supersedes_id) WHERE supersedes_id <> '' AND lifecycle = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_records_spi_fingerprint ON records(part, rev, side, sha256)
  WHERE kind = 'spi' AND validation_source = 'server_verified';
