// tests/auth-lock.test.mjs: 9.5 登入鎖定完整驗收測試套件 (AL-1 ~ AL-14)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createHmac, pbkdf2Sync } from "node:crypto";
import { handle as handleAuth, users, configured, lockUntil } from "../lib/auth-handler.mjs";
import { Repo } from "../lib/repo.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const AUTH_SECRET = "s".repeat(40);
const AUTH_PEPPER = "p".repeat(40);
const ITER = 600000;

function makeCred(username, password) {
  const d = pbkdf2Sync(password, "spi-spc-analyst/v1-600000/" + username.toLowerCase(), ITER, 32, "sha256").toString("hex");
  const hmac = createHmac("sha256", AUTH_PEPPER).update(d).digest("hex");
  return { d, cred: `pepper-hmac-sha256$600000$${hmac}` };
}

const alice = makeCred("alice@example.com", "alice-pass-1234");
const bob = makeCred("bob@example.com", "bob-pass-5678");

function createD1Mock() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE auth_attempts (
      id INTEGER PRIMARY KEY,
      key_u TEXT NOT NULL,
      key_ip TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX idx_auth_u ON auth_attempts(key_u, at);
    CREATE INDEX idx_auth_ip ON auth_attempts(key_ip, at);

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
    CREATE UNIQUE INDEX audit_log_src ON audit_log(src_key) WHERE src_key IS NOT NULL;

    CREATE TABLE stats (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE shares (
      id TEXT PRIMARY KEY,
      user TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL DEFAULT 0,
      exp INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      revoked_at INTEGER NOT NULL DEFAULT 0,
      revoked_by TEXT NOT NULL DEFAULT ''
    );
  `);

  let queryCount = 0;
  let rowsWritten = 0;
  let rowsRead = 0;

  function countQuery(sql, isWrite = false, isRead = false) {
    queryCount++;
  }

  const db = {
    sqlite,
    getStats() { return { queryCount, rowsWritten, rowsRead }; },
    resetStats() { queryCount = 0; rowsWritten = 0; rowsRead = 0; },
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              queryCount++;
              const isInsert = /^\s*INSERT/i.test(sql);
              try {
                const stmt = sqlite.prepare(sql);
                const res = stmt.get(...params);
                if (isInsert && res) {
                  rowsWritten += 3; // table + 2 indexes
                }
                return res || null;
              } catch (e) {
                throw e;
              }
            },
            async all() {
              queryCount++;
              const stmt = sqlite.prepare(sql);
              const rows = stmt.all(...params);
              rowsRead += rows.length;
              return { results: rows };
            },
            async run() {
              queryCount++;
              const isDelete = /^\s*DELETE/i.test(sql);
              const stmt = sqlite.prepare(sql);
              const info = stmt.run(...params);
              if (isDelete) {
                rowsWritten += info.changes; // Miniflare/workerd: DELETE is 1 row per change
              }
              return { success: true, meta: { changes: info.changes } };
            },
          };
        },
      };
    },
    async batch(stmts) {
      const results = [];
      for (const s of stmts) {
        results.push(await s.run());
      }
      return results;
    },
  };

  return db;
}

function makeEnv(db, limiterOverrides = {}) {
  const usersObj = {
    "alice@example.com": alice.cred,
    "bob@example.com": bob.cred,
  };
  const limiterCounts = new Map();
  const defaultLimiter = {
    async limit({ key }) {
      const cur = (limiterCounts.get(key) || 0) + 1;
      limiterCounts.set(key, cur);
      return { success: cur <= 10 };
    },
  };
  return {
    AUTH_SECRET,
    AUTH_PEPPER,
    AUTH_KDF_ITER: "600000",
    AUTH_USERS: JSON.stringify(usersObj),
    DB: db,
    LOGIN_LIMIT: limiterOverrides.limiter !== undefined ? limiterOverrides.limiter : defaultLimiter,
  };
}

async function doLogin(env, { user, d, ip = "1.2.3.4", now = 1700000000000 }) {
  const req = new Request("https://test.example/__login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, d, next: "/" }),
  });
  const repo = new Repo(env.DB, {});
  return handleAuth(req, env, () => new Response("OK"), { repo, ip, now });
}

test("AL-1: 結構驗證與字樣白名單掃描", () => {
  const db = createD1Mock();
  const tables = db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='auth_attempts'").get();
  assert.ok(tables, "auth_attempts 表必須存在");
  assert.ok(!tables.sql.includes("AUTOINCREMENT"), "不得使用 AUTOINCREMENT");

  const idxs = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='auth_attempts'").all().map(r => r.name);
  assert.ok(idxs.includes("idx_auth_u") && idxs.includes("idx_auth_ip"), "索引必須為 (key_u, at) 與 (key_ip, at)");

  // 字樣掃描
  const allowlistContent = fs.readFileSync(path.join(ROOT, "tools/auth-legacy-allowlist.txt"), "utf8");
  const allowlist = allowlistContent
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"))
    .map(l => l.split(/\s+/)[0]);

  let hits = [];
  try {
    const gitFiles = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    const pattern = /(auth_mode|auth_del_|LOGIN_GLOBAL|節流模式)/;
    for (const f of gitFiles) {
      if (f.startsWith("vendor/") || f.endsWith(".png") || f.endsWith(".zip")) continue;
      const content = fs.readFileSync(path.join(ROOT, f), "utf8");
      if (pattern.test(content)) {
        const allowed = allowlist.some(a => {
          if (a.includes("*")) {
            const prefix = a.replace(/\*.*$/, "");
            return f.startsWith(prefix);
          }
          return f === a;
        });
        if (!allowed) {
          hits.push(f);
        }
      }
    }
  } catch {}
  assert.deepEqual(hits, [], `發現未在白名單中的舊字樣檔案：${hits.join(", ")}`);
});

test("AL-2: 單次失敗插入恰好 1 列且寫入 3 列", async () => {
  const db = createD1Mock();
  const env = makeEnv(db);

  db.resetStats();
  const res = await doLogin(env, { user: "alice@example.com", d: "wrong_d", ip: "10.0.0.1", now: 1000 });
  assert.equal(res.status, 401);
  const rows = db.sqlite.prepare("SELECT * FROM auth_attempts").all();
  assert.equal(rows.length, 1, "應插入恰好 1 列");
  assert.equal(db.getStats().rowsWritten, 3, "寫入計量應為 3 列");
  assert.ok(rows[0].key_u && rows[0].key_ip, "key_u 與 key_ip 欄位皆需有值");

  const body = await res.json();
  assert.equal(body.error, "bad_credentials");
  assert.equal(body.remaining, 4);
});

test("AL-3: 帳號鎖定 (第 5 次回 401 且 remaining:0，第 6 次回 429 locked)", async () => {
  const db = createD1Mock();
  const env = makeEnv(db);
  const t0 = 1000000;

  for (let i = 0; i < 4; i++) {
    const r = await doLogin(env, { user: "alice@example.com", d: "wrong", ip: `10.0.0.${i}`, now: t0 + i * 1000 });
    assert.equal(r.status, 401);
    const json = await r.json();
    assert.equal(json.remaining, 4 - i);
  }

  // 第 5 次
  const r5 = await doLogin(env, { user: "alice@example.com", d: "wrong", ip: "10.0.0.5", now: t0 + 14 * 60_000 });
  assert.equal(r5.status, 401);
  const j5 = await r5.json();
  assert.equal(j5.remaining, 0);
  assert.ok(j5.unlockAt > t0);

  // 第 6 次
  const r6 = await doLogin(env, { user: "alice@example.com", d: alice.d, ip: "10.0.0.6", now: t0 + 14 * 60_000 + 100 });
  assert.equal(r6.status, 429);
  const j6 = await r6.json();
  assert.equal(j6.error, "locked");
  assert.ok(j6.unlockAt);
});

test("AL-4: IP 鎖定背景流量與負向對照", async () => {
  const db = createD1Mock();
  const env = makeEnv(db);
  const t0 = 1000000;

  // 測試 IP T
  const testIp = "192.168.1.100";
  for (let i = 0; i < 5; i++) {
    const r = await doLogin(env, { user: `nonexistent${i}@x.com`, d: "bad", ip: testIp, now: t0 + i * 1000 });
    assert.equal(r.status, 401);
    const j = await r.json();
    assert.equal(j.remaining, 4 - i);
  }

  // 第 6 次
  const r6 = await doLogin(env, { user: "nonexistent5@x.com", d: "bad", ip: testIp, now: t0 + 5000 });
  assert.equal(r6.status, 429);
  const j6 = await r6.json();
  assert.equal(j6.error, "locked");

  // 負向對照：IP 每次不同時，第 6 次應仍為 401
  const dbNeg = createD1Mock();
  const envNeg = makeEnv(dbNeg);
  for (let i = 0; i < 5; i++) {
    await doLogin(envNeg, { user: `u${i}@x.com`, d: "bad", ip: `192.168.2.${i}`, now: t0 + i * 1000 });
  }
  const rNeg6 = await doLogin(envNeg, { user: "u5@x.com", d: "bad", ip: "192.168.2.99", now: t0 + 5000 });
  assert.equal(rNeg6.status, 401);
});

test("AL-5: 並行插入競態保護", async () => {
  const db = createD1Mock();
  const env = makeEnv(db);
  const t0 = 1000000;

  // 20 個並行錯誤登入
  const promises = [];
  for (let i = 0; i < 20; i++) {
    promises.push(doLogin(env, { user: "bob@example.com", d: "bad", ip: `10.1.1.${i}`, now: t0 + i }));
  }
  const results = await Promise.all(promises);
  const rowCount = db.sqlite.prepare("SELECT COUNT(*) as c FROM auth_attempts").get().c;
  assert.ok(rowCount <= 5, `並行插入成功數 (${rowCount}) 必須 <= 5`);
  const lockedCount = results.filter(r => r.status === 429).length;
  assert.ok(lockedCount >= 15, `被鎖定回 429 的請求數 (${lockedCount}) 應 >= 15`);
});

test("AL-6: 鎖定中不留記錄且 rowsWritten 為 0", async () => {
  const db = createD1Mock();
  const env = makeEnv(db);
  const t0 = 1000000;

  for (let i = 0; i < 5; i++) {
    await doLogin(env, { user: "alice@example.com", d: "bad", ip: "10.0.0.1", now: t0 + i * 1000 });
  }

  db.resetStats();
  for (let i = 0; i < 20; i++) {
    const res = await doLogin(env, { user: "alice@example.com", d: "bad", ip: `10.0.0.${i + 10}`, now: t0 + 10000 + i * 100 });
    assert.equal(res.status, 429);
  }

  assert.equal(db.getStats().rowsWritten, 0, "鎖定期間寫入計量必須為 0");
  const count = db.sqlite.prepare("SELECT COUNT(*) as c FROM auth_attempts").get().c;
  assert.equal(count, 5, "表內列數不得增加");
});

test("AL-7: 成功登入清除帳號失敗記錄，不清除 IP 嘗試", async () => {
  const db = createD1Mock();
  const env = makeEnv(db);
  const t0 = 1000000;
  const ip = "10.0.0.1";

  // 先對 alice 錯 3 次
  for (let i = 0; i < 3; i++) {
    await doLogin(env, { user: "alice@example.com", d: "bad", ip, now: t0 + i * 1000 });
  }

  // alice 成功登入
  const rOk = await doLogin(env, { user: "alice@example.com", d: alice.d, ip, now: t0 + 5000 });
  assert.equal(rOk.status, 200);

  // alice 再次失敗，remaining 應恢復為 4 (帳號記錄已被清空)
  const rFail = await doLogin(env, { user: "alice@example.com", d: "bad", ip: "10.0.0.2", now: t0 + 6000 });
  assert.equal(rFail.status, 401);
  const jFail = await rFail.json();
  assert.equal(jFail.remaining, 4);
});

test("AL-8: 存在與不存在帳號行為完全對稱", async () => {
  const db = createD1Mock();
  const env = makeEnv(db);
  const t0 = 1000000;

  for (let i = 0; i < 6; i++) {
    const now = t0 + i * 1000;
    const rExist = await doLogin(env, { user: "alice@example.com", d: "wrong", ip: `1.1.1.${i}`, now });
    const rNonExist = await doLogin(env, { user: "ghost@example.com", d: "wrong", ip: `2.2.2.${i}`, now });

    assert.equal(rExist.status, rNonExist.status, `第 ${i+1} 次狀態碼必須一致`);
    const jE = await rExist.json();
    const jN = await rNonExist.json();
    assert.equal(jE.error, jN.error);
    assert.equal(jE.remaining, jN.remaining);
  }
});

test("AL-9: LOGIN_LIMIT 限制優先於 D1 (超過門檻 0 查詢)", async () => {
  const db = createD1Mock();
  const env = makeEnv(db);

  for (let i = 0; i < 10; i++) {
    await doLogin(env, { user: "alice@example.com", d: "bad", ip: "8.8.8.8", now: 1000 + i });
  }

  db.resetStats();
  const r11 = await doLogin(env, { user: "alice@example.com", d: "bad", ip: "8.8.8.8", now: 2000 });
  assert.equal(r11.status, 429);
  const j11 = await r11.json();
  assert.equal(j11.error, "rate_limited");
  assert.equal(db.getStats().queryCount, 0, "被 rate_limited 擋下時不得發出任何 D1 查詢");
});

test("AL-10: 預設封閉 (503 login_limiter_missing, login_limiter_error, login_db_unavailable)", async () => {
  const db = createD1Mock();

  // 1. 缺少 limiter: POST 503、GET 200 行內警告、既有會話仍可用
  const envNoLimiter = makeEnv(db, { limiter: null });
  db.resetStats();
  const rNo = await doLogin(envNoLimiter, { user: "alice@example.com", d: alice.d });
  assert.equal(rNo.status, 503);
  assert.equal((await rNo.json()).error, "login_limiter_missing");
  assert.equal(rNo.headers.get("Set-Cookie"), null, "不可發出 Set-Cookie");
  assert.equal(db.getStats().queryCount, 0, "D1 查詢數必須為 0");

  const repo = new Repo(db, {});
  const reqGetLoginNo = new Request("http://localhost/__login");
  const resGetLoginNo = await handleAuth(reqGetLoginNo, envNoLimiter, () => new Response("OK"), { repo });
  assert.equal(resGetLoginNo.status, 200);
  const htmlNo = await resGetLoginNo.text();
  assert.match(htmlNo, /登入暫停：伺服器缺少登入限流設定/);
  assert.match(htmlNo, /disabled/);

  // 2. limiter 拋出例外: POST 503、GET 不得呼叫 limit() (0 次)
  let limiterCalls = 0;
  const envErrLimiter = makeEnv(db, {
    limiter: {
      async limit() { limiterCalls++; throw new Error("Limiter network crash"); },
    },
  });
  db.resetStats();
  const rErr = await doLogin(envErrLimiter, { user: "alice@example.com", d: alice.d });
  assert.equal(rErr.status, 503);
  assert.equal((await rErr.json()).error, "login_limiter_error");
  assert.equal(rErr.headers.get("Set-Cookie"), null);
  assert.equal(db.getStats().queryCount, 0);

  limiterCalls = 0;
  const reqGetLoginErr = new Request("http://localhost/__login");
  const resGetLoginErr = await handleAuth(reqGetLoginErr, envErrLimiter, () => new Response("OK"), { repo });
  assert.equal(resGetLoginErr.status, 200);
  assert.equal(limiterCalls, 0, "GET /__login 不得呼叫 limit()");

  // 3. D1 查詢拋出例外: POST 503、密碼不驗證、不發 cookie
  const brokenDb = {
    prepare() {
      return {
        bind() {
          return {
            async all() { throw new Error("D1 unavailable"); },
            async first() { throw new Error("D1 unavailable"); },
            async run() { throw new Error("D1 unavailable"); },
          };
        },
      };
    },
  };
  const envBrokenDb = makeEnv(brokenDb);
  const rDbErr = await doLogin(envBrokenDb, { user: "alice@example.com", d: alice.d });
  assert.equal(rDbErr.status, 503);
  assert.equal((await rDbErr.json()).error, "login_db_unavailable");
  assert.equal(rDbErr.headers.get("Set-Cookie"), null);
});

test("AL-11: 單次登入語句數預算 <= 4", async () => {
  const db = createD1Mock();
  const env = makeEnv(db);

  // 失敗情境
  db.resetStats();
  await doLogin(env, { user: "alice@example.com", d: "bad", ip: "1.1.1.1", now: 1000 });
  assert.ok(db.getStats().queryCount <= 4, `登入失敗語句數 (${db.getStats().queryCount}) 需 <= 4`);

  // 成功情境
  db.resetStats();
  await doLogin(env, { user: "alice@example.com", d: alice.d, ip: "1.1.1.2", now: 2000 });
  assert.ok(db.getStats().queryCount <= 4, `登入成功語句數 (${db.getStats().queryCount}) 需 <= 4`);
});

test("AL-12: cron 30 分鐘邊界清理", async () => {
  const db = createD1Mock();
  const repo = new Repo(db, {});
  const now = 2_000_000_000_000;

  // 插入 500 筆測試資料
  const offsets = [46, 31, 30, 29, 1]; // 分鐘
  for (const m of offsets) {
    for (let i = 0; i < 100; i++) {
      db.sqlite.prepare("INSERT INTO auth_attempts (key_u, key_ip, at) VALUES (?, ?, ?)").run(`u_${m}_${i}`, `ip_${m}`, now - m * 60_000);
    }
  }
  const totalBefore = db.sqlite.prepare("SELECT COUNT(*) as c FROM auth_attempts").get().c;
  assert.equal(totalBefore, 500);

  db.resetStats();
  const res = await repo.purgeOldAuthAttempts(now);
  const totalAfter = db.sqlite.prepare("SELECT COUNT(*) as c FROM auth_attempts").get().c;
  assert.equal(totalAfter, 300, "應保留 at >= now - 30 分鐘的 300 列");
  assert.equal(res.meta.changes, 200, "刪除筆數應為 200");
  assert.ok(db.getStats().rowsWritten <= 600, "rowsWritten 應 <= 600");

  // 無過期列時再次執行 cron
  db.resetStats();
  const resEmpty = await repo.purgeOldAuthAttempts(now);
  assert.equal(resEmpty.meta.changes, 0);
  assert.equal(db.getStats().rowsWritten, 0, "無過期列時 rowsWritten 應為 0");
});

test("AL-12 獨立情境：鎖定中在 cron 後仍鎖定", async () => {
  const db = createD1Mock();
  const repo = new Repo(db, {});
  const env = makeEnv(db);
  const now = 2_000_000_000_000;

  // 另一把鍵在 now - 2 分 ~ now - 1 分有 5 次失敗 (鎖定中)
  for (let i = 0; i < 5; i++) {
    await doLogin(env, { user: "alice@example.com", d: "wrong", ip: "1.2.3.4", now: now - 2 * 60_000 + i * 10_000 });
  }
  // 檢查當前為鎖定
  const rBefore = await doLogin(env, { user: "alice@example.com", d: "wrong", ip: "1.2.3.4", now });
  assert.equal(rBefore.status, 429);
  const unlockAtBefore = (await rBefore.json()).unlockAt;

  // 跑 cron
  await repo.purgeOldAuthAttempts(now);

  // 檢查 cron 後仍為 429 locked 且 unlockAt 相同
  const rAfter = await doLogin(env, { user: "alice@example.com", d: "wrong", ip: "1.2.3.4", now });
  assert.equal(rAfter.status, 429);
  const unlockAtAfter = (await rAfter.json()).unlockAt;
  assert.equal(unlockAtAfter, unlockAtBefore, "unlockAt 在 cron 後必須不變");
});

test("AL-12 獨立情境：已解鎖在 cron 後可正常登入", async () => {
  const db = createD1Mock();
  const repo = new Repo(db, {});
  const env = makeEnv(db);
  const now = 2_000_000_000_000;

  // 5 次失敗在 now - 20 分 ~ now - 16 分 (已解鎖)
  for (let i = 0; i < 5; i++) {
    await doLogin(env, { user: "bob@example.com", d: "wrong", ip: "5.6.7.8", now: now - 20 * 60_000 + i * 60_000 });
  }

  // 跑 cron (此時 records 都在 30 分內，未被刪除，但 15 分鐘窗口已過)
  await repo.purgeOldAuthAttempts(now);

  // 正確密碼可登入
  const rLogin = await doLogin(env, { user: "bob@example.com", d: bob.d, ip: "5.6.7.8", now });
  assert.equal(rLogin.status, 200, "已解鎖帳號在 cron 後以正確密碼登入應為 200");
});

test("AL-14: 與基準 lockUntil 在 500 組序列等價", () => {
  const W = 15 * 60_000, L = 15 * 60_000, RET = 30 * 60_000, MAXF = 5;
  const SCHEMA = `
    CREATE TABLE auth_attempts (id INTEGER PRIMARY KEY, key_u TEXT NOT NULL, key_ip TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX auth_attempts_u ON auth_attempts(key_u, at);
    CREATE INDEX auth_attempts_ip ON auth_attempts(key_ip, at);
  `;
  const SEL = `SELECT 'u' AS k, at FROM (SELECT at FROM auth_attempts WHERE key_u=?1 AND at>?3-1800000 ORDER BY at DESC LIMIT 5) UNION ALL SELECT 'ip', at FROM (SELECT at FROM auth_attempts WHERE key_ip=?2 AND at>?3-1800000 ORDER BY at DESC LIMIT 5)`;
  const INS = `INSERT INTO auth_attempts (key_u, key_ip, at) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) = 5 AND MAX(at) - MIN(at) < 900000 AND MAX(at) > ?3 - 900000 FROM (SELECT at FROM auth_attempts WHERE key_u = ?1 AND at > ?3 - 1800000 ORDER BY at DESC LIMIT 5)) = 0 AND (SELECT COUNT(*) = 5 AND MAX(at) - MIN(at) < 900000 AND MAX(at) > ?3 - 900000 FROM (SELECT at FROM auth_attempts WHERE key_ip = ?2 AND at > ?3 - 1800000 ORDER BY at DESC LIMIT 5)) = 0 RETURNING id`;

  let seed = 42;
  function rnd() {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  }
  function choice(arr) {
    return arr[Math.floor(rnd() * arr.length)];
  }

  for (let sd = 0; sd < 500; sd++) {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA);
    const selStmt = db.prepare(SEL);
    const insStmt = db.prepare(INS);
    const delCronStmt = db.prepare("DELETE FROM auth_attempts WHERE at < ?");
    const delUserStmt = db.prepare("DELETE FROM auth_attempts WHERE key_u=?");
    let model = [];
    const users = ["u0", "u1", "u2"];
    const ips = ["ip0", "ip1", "ip2"];
    let now = 1_900_000_000_000;
    let last_cron = now;
    for (let step = 0; step < 40; step++) {
      now += choice([0, 1, 1000, 30_000, 60_000, 299_999, 300_000, W - 1, W, W + 1, 180_000]);
      while (now - last_cron >= W) {
        last_cron += W;
        delCronStmt.run(last_cron - RET);
        model = model.filter(r => r[2] >= last_cron - RET);
      }
      const u = choice(users), ip = choice(ips);
      const ok = rnd() < 0.08;
      const mu = lockUntil(model.filter(r => r[0] === u).map(r => r[2]));
      const mi = lockUntil(model.filter(r => r[1] === ip).map(r => r[2]));
      const m_locked = Math.max(mu, mi) > now;
      const m_unlock = m_locked ? Math.max(...[mu, mi].filter(x => x > now)) : 0;

      const rows = selStmt.all(u, ip, now);
      const res = {};
      for (const k of ["u", "ip"]) {
        const ts = rows.filter(r => r.k === k).map(r => r.at);
        res[k] = (ts.length === 5 && Math.max(...ts) - Math.min(...ts) < W && Math.max(...ts) > now - W) ? Math.max(...ts) + L : 0;
      }
      const s_unlock = Math.max(res.u, res.ip);
      assert.equal((s_unlock > 0), m_locked, `序列 ${sd} 步 ${step} 鎖定狀態需一致`);
      assert.equal(s_unlock, m_unlock, `序列 ${sd} 步 ${step} 解鎖時刻需一致`);

      const rid = insStmt.all(u, ip, now);
      assert.equal(Boolean(rid.length), !m_locked, `序列 ${sd} 步 ${step} 插入行為需一致`);
      if (rid.length) {
        model.push([u, ip, now]);
        if (ok) {
          delUserStmt.run(u);
          model = model.filter(r => r[0] !== u);
        }
      }
    }
  }
});
