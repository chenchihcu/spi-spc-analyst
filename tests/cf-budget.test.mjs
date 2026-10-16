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

  // 3. E-4 規格豁免之查詢：
  // shares all=1 (全表掃描 + 暫存排序)
  const sharesAllPlan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM shares ORDER BY created DESC, id DESC LIMIT 51").all();
  assert.ok(sharesAllPlan.length > 0, 'shares all=1 執行計畫');

  // shares mine=1 (暫存排序)
  const sharesMinePlan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM shares WHERE user = 'u' AND (created, id) < (1, 's') ORDER BY created DESC, id DESC LIMIT 51").all();
  assert.ok(sharesMinePlan.length > 0, 'shares mine=1 執行計畫');

  // 保存期限清除逐 kind 查詢 (走 r_k 索引)
  const retentionPerKindPlan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM records WHERE kind = 'meas' AND created < 1000 ORDER BY created LIMIT 40").all();
  const retentionDetails = retentionPerKindPlan.map(p => p.detail).join('; ');
  assert.ok(retentionDetails.includes('INDEX r_k'), `逐 kind 保存期限查詢應使用 r_k 索引: ${retentionDetails}`);
});

test('E-3: 分頁查詢讀取列數守衛 (首頁與第 2 頁 rows_read <= 52)', async () => {
  const { getPlatformProxy } = await import('wrangler');
  const proxy = await getPlatformProxy();
  try {
    const db = proxy.env.DB;
    await db.exec('CREATE TABLE IF NOT EXISTS records_e3 (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT \'\', created INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL DEFAULT \'\', name TEXT NOT NULL DEFAULT \'\');');
    await db.exec('CREATE INDEX IF NOT EXISTS r_k_e3 ON records_e3(kind, created DESC, id DESC);');

    // 寫入 120 筆測試紀錄
    const stmts = [];
    for (let i = 0; i < 120; i++) {
      stmts.push(
        db.prepare('INSERT OR IGNORE INTO records_e3 (id, kind, created, sha256, name) VALUES (?, ?, ?, ?, ?)')
          .bind(`rec_${String(i).padStart(6, '0')}`, 'meas', 1000 + i, `sha_${i}`, `name_${i}`)
      );
    }
    await db.batch(stmts);

    // 第 1 頁查詢
    const p1 = await db.prepare('SELECT id, created FROM records_e3 WHERE kind = ? ORDER BY created DESC, id DESC LIMIT 51')
      .bind('meas')
      .all();
    assert.equal(p1.results.length, 51, '首頁應取得 51 筆 (含下一頁哨兵)');
    assert.ok(p1.meta.rows_read <= 52, `首頁 rows_read (${p1.meta.rows_read}) 必須 <= 52`);

    // 第 2 頁查詢 (帶上一頁最後一筆游標)
    const cursor = p1.results[50];
    const p2 = await db.prepare('SELECT id, created FROM records_e3 WHERE kind = ? AND (created, id) < (?, ?) ORDER BY created DESC, id DESC LIMIT 51')
      .bind('meas', cursor.created, cursor.id)
      .all();
    assert.ok(p2.results.length > 0, '第 2 頁應有結果');
    assert.ok(p2.meta.rows_read <= 52, `第 2 頁 rows_read (${p2.meta.rows_read}) 必須 <= 52`);
  } finally {
    await proxy.dispose();
  }
});

test('F-2: 稽核頁分頁讀取列數守衛 (LEFT JOIN records, rows_read <= 104)', async () => {
  const { getPlatformProxy } = await import('wrangler');
  const proxy = await getPlatformProxy();
  try {
    const db = proxy.env.DB;
    await db.exec('CREATE TABLE IF NOT EXISTS records_f2 (id TEXT PRIMARY KEY);');
    await db.exec('CREATE TABLE IF NOT EXISTS audit_log_f2 (seq INTEGER PRIMARY KEY, at INTEGER, target_id TEXT, target_type TEXT);');

    // 建立 100 筆稽核資料與 50 筆紀錄
    const rStmts = [];
    for (let i = 0; i < 50; i++) {
      rStmts.push(db.prepare('INSERT OR IGNORE INTO records_f2 (id) VALUES (?)').bind(`rec_${i}`));
    }
    await db.batch(rStmts);

    const aStmts = [];
    for (let i = 0; i < 100; i++) {
      aStmts.push(db.prepare('INSERT OR IGNORE INTO audit_log_f2 (seq, at, target_id, target_type) VALUES (?, ?, ?, ?)').bind(i + 1, 1000 + i, `rec_${i % 50}`, 'record'));
    }
    await db.batch(aStmts);

    // 查首頁 (limit 50 + 1)
    const sql = 'SELECT a.seq, a.at, a.target_id, (r.id IS NOT NULL) as target_exists FROM audit_log_f2 a LEFT JOIN records_f2 r ON a.target_id = r.id AND a.target_type = "record" ORDER BY a.seq DESC LIMIT 51';
    const res = await db.prepare(sql).all();
    assert.equal(res.results.length, 51);
    assert.ok(res.meta.rows_read <= 104, `稽核頁首頁 rows_read (${res.meta.rows_read}) 必須 <= 104`);

    // 查第 2 頁 (cursor seq < 50)
    const sqlP2 = 'SELECT a.seq, a.at, a.target_id, (r.id IS NOT NULL) as target_exists FROM audit_log_f2 a LEFT JOIN records_f2 r ON a.target_id = r.id AND a.target_type = "record" WHERE a.seq < ? ORDER BY a.seq DESC LIMIT 51';
    const resP2 = await db.prepare(sqlP2).bind(res.results[50].seq).all();
    assert.ok(resP2.results.length > 0);
    assert.ok(resP2.meta.rows_read <= 104, `稽核頁第 2 頁 rows_read (${resP2.meta.rows_read}) 必須 <= 104`);
  } finally {
    await proxy.dispose();
  }
});



