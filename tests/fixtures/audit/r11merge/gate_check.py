"""第 11 輪合併（v1.10）：驗證 9.5 的 SQL（第 1 步 SELECT 判定、第 2 步條件式 INSERT）
與基準 lockUntil 語意（lib/auth-core.mjs:163-169）在隨機序列上完全一致；並量測寫入列數。
只用 Python 標準庫 sqlite3。稽核方腳本，不得放進產品程式。"""
import random, sqlite3
W = L = 15 * 60_000; RET = 30 * 60_000; MAXF = 5
def lock_until(ts):
    t = sorted(ts); u = 0
    for i in range(MAXF - 1, len(t)):
        if t[i] - t[i - MAXF + 1] < W: u = max(u, t[i] + L)
    return u
SCHEMA = """CREATE TABLE auth_attempts(id INTEGER PRIMARY KEY, key_u TEXT NOT NULL, key_ip TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX auth_attempts_u ON auth_attempts(key_u, at); CREATE INDEX auth_attempts_ip ON auth_attempts(key_ip, at);"""
SEL = """SELECT 'u' AS k, at FROM (SELECT at FROM auth_attempts WHERE key_u=?1 AND at>?3-1800000 ORDER BY at DESC LIMIT 5)
UNION ALL SELECT 'ip', at FROM (SELECT at FROM auth_attempts WHERE key_ip=?2 AND at>?3-1800000 ORDER BY at DESC LIMIT 5)"""
INS = """INSERT INTO auth_attempts (key_u, key_ip, at) SELECT ?1, ?2, ?3
WHERE (SELECT COUNT(*) = 5 AND MAX(at) - MIN(at) < 900000 AND MAX(at) > ?3 - 900000
       FROM (SELECT at FROM auth_attempts WHERE key_u = ?1 AND at > ?3 - 1800000 ORDER BY at DESC LIMIT 5)) = 0
  AND (SELECT COUNT(*) = 5 AND MAX(at) - MIN(at) < 900000 AND MAX(at) > ?3 - 900000
       FROM (SELECT at FROM auth_attempts WHERE key_ip = ?2 AND at > ?3 - 1800000 ORDER BY at DESC LIMIT 5)) = 0
RETURNING id"""
def sel_locked(db, u, ip, now):
    rows = db.execute(SEL, (u, ip, now)).fetchall(); res = {}
    for k in ('u', 'ip'):
        ts = [a for kk, a in rows if kk == k]
        res[k] = (max(ts) + L) if (len(ts) == 5 and max(ts) - min(ts) < W and max(ts) > now - W) else 0
    return res
def run(seed, n=400):
    rnd = random.Random(seed); db = sqlite3.connect(':memory:'); db.executescript(SCHEMA)
    model = []  # (u, ip, t)
    users = [f'u{i}' for i in range(rnd.randint(1, 4))]; ips = [f'ip{i}' for i in range(rnd.randint(1, 4))]
    now = 1_900_000_000_000; ins = dele = 0; last_cron = now
    for _ in range(n):
        now += rnd.choice([0, 1, 1000, 30_000, 60_000, 299_999, 300_000, W - 1, W, W + 1, 3 * 60_000])
        while now - last_cron >= W:  # cron every 15 min
            last_cron += W; c = db.execute('DELETE FROM auth_attempts WHERE at < ?', (last_cron - RET,)).rowcount; dele += c
            model = [r for r in model if r[2] >= last_cron - RET]
        u, ip = rnd.choice(users), rnd.choice(ips); ok = rnd.random() < 0.08
        mu = lock_until([t for uu, _, t in model if uu == u]); mi = lock_until([t for _, ii, t in model if ii == ip])
        m_locked = max(mu, mi) > now; m_unlock = max(x for x in (mu, mi) if x > now) if m_locked else 0
        s = sel_locked(db, u, ip, now); s_unlock = max(s.values())
        assert (s_unlock > 0) == m_locked and s_unlock == m_unlock, (seed, now, s, mu, mi)
        rid = db.execute(INS, (u, ip, now)).fetchall()
        assert bool(rid) == (not m_locked), (seed, 'ins')
        if rid:
            ins += 1; model.append((u, ip, now))
            if ok:
                dele += db.execute('DELETE FROM auth_attempts WHERE key_u=?', (u,)).rowcount
                model = [r for r in model if r[0] != u]
    return ins, dele
def day_one_ip():
    db = sqlite3.connect(':memory:'); db.executescript(SCHEMA); now = t0 = 1_900_000_000_000
    ins = dele = 0; last = now; i = 0
    while now < t0 + 86_400_000:
        if now - last >= W:
            last += W; dele += db.execute('DELETE FROM auth_attempts WHERE at < ?', (last - RET,)).rowcount
        if db.execute(INS, (f'x{i}', 'ipA', now)).fetchall(): ins += 1
        now += 6000; i += 1  # 10 / 60 s = LOGIN_LIMIT
    return ins, dele
if __name__ == '__main__':
    for sd in range(500): run(sd)
    print('500 random sequences: SQL == lockUntil semantics (locked flag and unlockAt)')
    ins, dele = day_one_ip()
    # spec v1.12 (round 13, R13-1): Miniflare/workerd count INSERT = table + 2 indexes = 3 rows, DELETE = 1 row (index deletions not counted)
    print(f'one IP, 24 h at LOGIN_LIMIT: inserts={ins} cron_deletes={dele} '
          f'rows_written(measured rule)=ins*3+del={ins*3+dele}  conservative=(ins+del)*3={(ins+dele)*3} (<= 2880)')
