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
