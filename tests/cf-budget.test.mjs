import test from 'node:test';
import assert from 'node:assert/strict';

// 9.4 預算測試：模擬免費方案配額限制 (L-1 查詢數 <= 40, L-2, L-6, L-14)
class CountingD1 {
  constructor() {
    this.queryCount = 0;
    this.records = new Map();
    this.shares = new Map();
    this.audit = [];
    this.authAttempts = [];
  }

  prepare(sql) {
    const self = this;
    return {
      bind(...params) {
        return {
          async first() {
            self.queryCount++;
            if (sql.includes("FROM records WHERE id = ?")) {
              return self.records.get(params[0]) || null;
            }
            if (sql.includes("INSERT INTO auth_attempts")) {
              const row = { id: self.authAttempts.length + 1, key_hash: params[0], at: params[1] };
              self.authAttempts.push(row);
              return { id: row.id };
            }
            return null;
          },
          async all() {
            self.queryCount++;
            if (sql.includes("FROM records WHERE kind = ?")) {
              return { results: [...self.records.values()].slice(0, 50) };
            }
            if (sql.includes("FROM records WHERE (lot LIKE")) {
              return { results: [...self.records.values()].slice(0, 50) };
            }
            if (sql.includes("FROM audit_log")) {
              return { results: self.audit.slice(0, 100) };
            }
            if (sql.includes("FROM auth_attempts")) {
              return { results: self.authAttempts.slice(-10) };
            }
            return { results: [] };
          },
          async run() {
            self.queryCount++;
            return { success: true };
          }
        };
      }
    };
  }

  async batch(statements) {
    for (const stmt of statements) {
      this.queryCount++; // 依 R5-7: batch 內每一句分別計入預算
    }
    return [];
  }
}

class StubR2 {
  async put() { return {}; }
  async get() { return { body: new Uint8Array([0x1f, 0x8b, 0x08]) }; }
  async delete() { return {}; }
}

test('CF Free Plan 預算守衛：D1 查詢數每請求 <= 40', async () => {
  const { Repo } = await import('../lib/repo.mjs');
  const d1 = new CountingD1();
  const r2 = new StubR2();
  const repo = new Repo(d1, r2);

  // 1. 列表首頁查詢
  d1.queryCount = 0;
  await repo.listRecords({ kind: 'spi', limit: 50 });
  assert.ok(d1.queryCount <= 40, `列表首頁查詢數 ${d1.queryCount} 必須 <= 40`);

  // 2. 伺服器搜尋查詢
  d1.queryCount = 0;
  await repo.searchRecords('TEST', 50);
  assert.ok(d1.queryCount <= 40, `搜尋查詢數 ${d1.queryCount} 必須 <= 40`);

  // 3. 單筆 metadata 查詢
  d1.queryCount = 0;
  await repo.getRecord('aaaaaaaaaaaaaaaaaaaaaa');
  assert.ok(d1.queryCount <= 40, `單筆查詢數 ${d1.queryCount} 必須 <= 40`);

  // 4. 新增紀錄 (批次寫入)
  d1.queryCount = 0;
  await repo.createRecord({
    id: 'bbbbbbbbbbbbbbbbbbbbbb',
    kind: 'spi',
    part: 'P1',
    lot: 'L1',
    bytes: 100,
    sha256: 'abc'
  }, new Uint8Array([0x1f, 0x8b, 0x08]));
  assert.ok(d1.queryCount <= 40, `新增紀錄查詢數 ${d1.queryCount} 必須 <= 40`);

  // 5. 登入防禦流程 (9.5 定案設計)
  d1.queryCount = 0;
  await repo.getAuthAttempts('h1', 'ip1');
  await repo.insertAuthAttemptAtomic('h1', 'ip1');
  assert.ok(d1.queryCount <= 40, `登入防禦查詢數 ${d1.queryCount} 必須 <= 40`);
});

test('D-4 / L-6: 查詢索引走查與 EXPLAIN QUERY PLAN 例外豁免', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  
  // 建立完整 D1 schema
  db.exec(`
    CREATE TABLE records (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      part TEXT NOT NULL,
      rev TEXT NOT NULL DEFAULT '',
      lot TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT '',
      vendor TEXT NOT NULL DEFAULT '',
      place_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      user TEXT NOT NULL,
      created INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      gz_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}'
    );
    CREATE UNIQUE INDEX r_u ON records(kind, part, rev, lot, side, vendor, place_id, sha256);
    CREATE INDEX r_k ON records(kind, created DESC, id DESC);
    CREATE INDEX r_sha ON records(sha256);

    CREATE TABLE shares (
      id TEXT PRIMARY KEY,
      user TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL DEFAULT 0,
      exp INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      revoked_at INTEGER,
      revoked_by TEXT
    );
    CREATE INDEX idx_shares_user ON shares(user, created DESC);
    CREATE INDEX idx_shares_exp ON shares(exp);

    CREATE TABLE audit_log (
      seq INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      by TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      target_type TEXT NOT NULL DEFAULT '',
      target_id TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      src_key TEXT
    );
    CREATE INDEX idx_audit_at ON audit_log(at DESC, seq DESC);
    CREATE UNIQUE INDEX audit_log_src ON audit_log(src_key) WHERE src_key IS NOT NULL;

    CREATE TABLE auth_attempts (
      id INTEGER PRIMARY KEY,
      key_u TEXT NOT NULL,
      key_ip TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX idx_auth_u ON auth_attempts(key_u, at);
    CREATE INDEX idx_auth_ip ON auth_attempts(key_ip, at);
  `);

  // 常規查詢必須走索引 (不含 SCAN TABLE)
  const appQueries = [
    { name: 'records list', sql: "SELECT id FROM records WHERE kind = 'meas' ORDER BY created DESC, id DESC LIMIT 51" },
    { name: 'records single', sql: "SELECT * FROM records WHERE id = 'rec1'" },
    { name: 'records dedupe', sql: "SELECT id FROM records WHERE kind = 'meas' AND part = 'p' AND rev = 'r' AND lot = 'l' AND side = 's' AND vendor = 'v' AND place_id = 'pl' AND sha256 = 'h'" },
    { name: 'auth_attempts u', sql: "SELECT at FROM auth_attempts WHERE key_u = 'u1' AND at > 1000 ORDER BY at DESC LIMIT 5" },
    { name: 'auth_attempts ip', sql: "SELECT at FROM auth_attempts WHERE key_ip = 'ip1' AND at > 1000 ORDER BY at DESC LIMIT 5" },
    { name: 'shares get', sql: "SELECT * FROM shares WHERE id = 's1' LIMIT 1" },
    { name: 'shares mine', sql: "SELECT * FROM shares WHERE user = 'u1' ORDER BY created DESC LIMIT 50" },
    { name: 'audit list', sql: "SELECT * FROM audit_log ORDER BY at DESC, seq DESC LIMIT 100" },
  ];

  for (const q of appQueries) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all();
    const details = plan.map(p => p.detail).join('; ');
    assert.ok(
      !details.includes('SCAN TABLE') || details.includes('USING INDEX') || details.includes('USING COVERING INDEX'),
      `常規查詢 [${q.name}] 必須走索引，實際執行計畫: ${details}`
    );
  }

  // D-4 規格豁免的兩類查詢：
  // 1. ?q= 關鍵字搜尋 (允許 SCAN)
  const searchPlan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM records WHERE (lot LIKE '%X%' OR name LIKE '%X%') ORDER BY created DESC LIMIT 50").all();
  assert.ok(searchPlan.length > 0, '搜尋查詢成功生成執行計畫');

  // 2. cron 固定掃描 (允許 SCAN)
  const cronAttemptsPlan = db.prepare("EXPLAIN QUERY PLAN DELETE FROM auth_attempts WHERE at < 1000").all();
  assert.ok(cronAttemptsPlan.length > 0, 'auth_attempts 清除查詢成功生成執行計畫');
  const cronStatsPlan = db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*), SUM(gz_bytes) FROM records").all();
  assert.ok(cronStatsPlan.length > 0, 'stats 每日統計查詢成功生成執行計畫');
});

