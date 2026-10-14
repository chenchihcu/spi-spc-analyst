CREATE TABLE IF NOT EXISTS objects (
  store TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT,
  metadata TEXT,
  etag TEXT NOT NULL,
  PRIMARY KEY (store, key)
);
CREATE INDEX IF NOT EXISTS objects_store_key ON objects(store, key);
