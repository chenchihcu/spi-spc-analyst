// 網站登入測試：帳密驗證、cookie 簽章與到期、未設定時拒絕、登入流程與 API 保護
import test from "node:test";
import assert from "node:assert/strict";
import { sha256Hex, checkCredentials, authenticate, issueToken, verifyToken, readCookie, safeNext, configured, users, COOKIE, LOCK } from "../lib/auth-core.mjs";
import { handle } from "../netlify/edge-functions/auth.mjs";

// 測試用帳密（與正式環境無關）
const E = { AUTH_USER: "tester@example.com", AUTH_PASS_SHA256: await sha256Hex("12345678"), AUTH_SECRET: "x".repeat(40) };
const ok = () => new Response("PAGE", { status: 200 });
const form = (o) => new URLSearchParams(o);

test("帳密：帳號不分大小寫，密碼必須完全相同", async () => {
  assert.equal(await checkCredentials(E, " Tester@Example.com ", "12345678"), true);
  assert.equal(await checkCredentials(E, "tester@example.com", "12345679"), false);
  assert.equal(await checkCredentials(E, "other@example.com", "12345678"), false);
  assert.equal(await checkCredentials(E, "tester@example.com", ""), false);
});

test("未設定或設定不完整時一律拒絕（fail closed）", async () => {
  assert.equal(configured({}), false);
  assert.equal(configured({ ...E, AUTH_SECRET: "short" }), false);
  assert.equal(await checkCredentials({}, "", ""), false);
  const r = await handle(new Request("https://s.example/"), {}, ok);
  assert.equal(r.status, 503);
});

test("憑證：可驗證、竄改或過期即失效、換密鑰即失效", async () => {
  const now = 1_800_000_000, t = await issueToken(E, now);
  assert.equal(await verifyToken(E, t, now + 60), "tester@example.com");
  assert.equal(await verifyToken(E, t.replace(/.$/, (c) => (c === "0" ? "1" : "0")), now), null);
  assert.equal(await verifyToken(E, t, now + 13 * 3600), null);
  assert.equal(await verifyToken({ ...E, AUTH_SECRET: "y".repeat(40) }, t, now), null);
  assert.equal(await verifyToken(E, "garbage", now), null);
  assert.equal(await verifyToken({ ...E, AUTH_PASS_SHA256: await sha256Hex("changed!") }, t, now), null, "改密碼後舊登入失效");
});

test("cookie 讀取與返回路徑安全檢查", () => {
  assert.equal(readCookie(`a=1; ${COOKIE}=abc; b=2`), "abc");
  assert.equal(safeNext("/spi-spc.html#issues"), "/spi-spc.html#issues");
  assert.equal(safeNext("//evil.example"), "/");
  assert.equal(safeNext("https://evil.example"), "/");
  assert.equal(safeNext("/__logout"), "/");
});

test("流程：未登入看到登入頁、API 回 401；登入後可進入；錯誤密碼不發憑證；登出清除", async () => {
  let r = await handle(new Request("https://s.example/spi-spc.html"), E, ok);
  assert.equal(r.status, 401);
  assert.match(await r.text(), /name="user"[\s\S]*name="pass"/);
  r = await handle(new Request("https://s.example/api/analyze", { method: "POST", body: "{}" }), E, ok);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, "請先登入");

  r = await handle(new Request("https://s.example/__login", { method: "POST", body: form({ user: "tester@example.com", pass: "wrong", next: "/" }) }), E, ok);
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("set-cookie"), null);

  r = await handle(new Request("https://s.example/__login", { method: "POST", body: form({ user: "tester@example.com", pass: "12345678", next: "//evil.example" }) }), E, ok);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/", "不可導向其他網站");
  const cookie = r.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/);

  const sess = cookie.split(";")[0];
  r = await handle(new Request("https://s.example/spi-spc.html", { headers: { cookie: sess } }), E, ok);
  assert.equal(await r.text(), "PAGE");
  r = await handle(new Request("https://s.example/api/analyze", { headers: { cookie: sess } }), E, ok);
  assert.equal(await r.text(), "PAGE");

  r = await handle(new Request("https://s.example/__logout"), E, ok);
  assert.match(r.headers.get("set-cookie"), /Max-Age=0/);
});

test("登入頁會跳脫輸入的帳號，避免注入", async () => {
  const r = await handle(new Request("https://s.example/__login", { method: "POST", body: form({ user: '"><script>alert(1)</script>', pass: "x" }) }), E, ok);
  assert.ok(!(await r.text()).includes("<script>alert(1)"));
});

test("登入頁：品牌區、焊墊識別圖、顯示密碼、版本與主頁一致", async () => {
  const fs = await import("node:fs");
  const { APP_VERSION, APP_BUILT } = await import("../lib/version.mjs");
  const html = fs.readFileSync(new URL("../spi-spc.html", import.meta.url), "utf8");
  assert.equal(html.match(/id="appVer">([^<]+)</)[1], APP_VERSION, "登入頁版本需與主頁一致");
  assert.equal(html.match(/id="appBuilt">([^<]+)</)[1], APP_BUILT, "登入頁更新時間需與主頁一致");
  const page = await (await handle(new Request("https://s.example/__login"), E, ok)).text();
  assert.match(page, /class="brand"/);
  assert.equal((page.match(/class="pad/g) || []).length, 48, "6 × 8 焊墊陣列");
  assert.equal((page.match(/ bad"/g) || []).length, 1, "恰好一顆異常焊墊");
  assert.match(page, /id="tg"[^>]*aria-pressed="false"/);
  assert.match(page, new RegExp(APP_VERSION.replace(".", "\\.")));
  const err = await (await handle(new Request("https://s.example/__login", { method: "POST", body: new URLSearchParams({ user: "a@b.c", pass: "x" }) }), E, ok)).text();
  assert.match(err, /帳號或密碼不正確/);
  assert.match(err, /value="a@b\.c"/, "錯誤後保留帳號");
  assert.match(err, /id="pass"[^>]*autofocus/, "錯誤後游標移到密碼欄");
});

// ---------- 多帳號、使用者識別、鎖定、安全標頭 ----------
function memStore() {
  const m = new Map();
  return { m, async set(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); }, async list({ prefix = "" } = {}) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; } };
}
const E2 = { AUTH_USERS: JSON.stringify({ "Alice@Example.com": await sha256Hex("alice-pass-1"), "bob@example.com": await sha256Hex("bob-pass-22"), "bad@x": "not-a-hash" }), AUTH_SECRET: "z".repeat(40) };

test("多帳號：AUTH_USERS（物件或陣列）可與舊設定並存；格式錯誤的項目略過", async () => {
  assert.deepEqual([...users(E2).keys()].sort(), ["alice@example.com", "bob@example.com"]);
  assert.equal(await authenticate(E2, "alice@example.com", "alice-pass-1"), "alice@example.com");
  assert.equal(await authenticate(E2, "bob@example.com", "alice-pass-1"), null, "不可用別人的密碼");
  const arr = { AUTH_USERS: JSON.stringify([{ user: "c@x.com", sha256: await sha256Hex("cpass") }]), ...E, };
  assert.equal(await authenticate(arr, "c@x.com", "cpass"), "c@x.com");
  assert.equal(await authenticate(arr, "tester@example.com", "12345678"), "tester@example.com", "舊設定仍可用");
  assert.equal(configured({ AUTH_USERS: "{broken", AUTH_SECRET: "z".repeat(40) }), false);
  const t = await issueToken(E2, "bob@example.com", 1_800_000_000);
  assert.equal(await verifyToken(E2, t, 1_800_000_100), "bob@example.com");
  const removed = { ...E2, AUTH_USERS: JSON.stringify({ "alice@example.com": await sha256Hex("alice-pass-1") }) };
  assert.equal(await verifyToken(removed, t, 1_800_000_100), null, "刪除帳號後舊登入失效");
});

test("登入後：/__me 回傳帳號；API 請求帶 x-spi-user（覆寫用戶端偽造值）；靜態頁不改動", async () => {
  const st = memStore();
  let r = await handle(new Request("https://s.example/__login", { method: "POST", body: form({ user: "ALICE@example.com", pass: "alice-pass-1" }) }), E2, ok, { store: st });
  assert.equal(r.status, 303);
  const sess = r.headers.get("set-cookie").split(";")[0];
  r = await handle(new Request("https://s.example/__me", { headers: { cookie: sess } }), E2, ok);
  assert.deepEqual(await r.json(), { user: "alice@example.com" });
  assert.equal((await handle(new Request("https://s.example/__me"), E2, ok)).status, 401);
  let seen = null;
  await handle(new Request("https://s.example/api/analyze", { method: "POST", body: "{}", headers: { cookie: sess, "x-spi-user": "evil@x" } }), E2, (q) => { seen = q.headers.get("x-spi-user"); return ok(); });
  assert.equal(seen, "alice@example.com");
  let passed = "unset";
  await handle(new Request("https://s.example/spi-spc.html", { headers: { cookie: sess } }), E2, (q) => { passed = q; return ok(); });
  assert.equal(passed, undefined, "靜態頁直接放行");
});

test("鎖定：同一帳號連續失敗 5 次即鎖定，鎖定中正確密碼也不放行；15 分鐘後恢復；成功登入清除失敗紀錄", async () => {
  const st = memStore(), t0 = 1_900_000_000_000;
  const tryLogin = (pass, now, ip = "10.0.0.1") => handle(new Request("https://s.example/__login", { method: "POST", body: form({ user: "bob@example.com", pass }) }), E2, ok, { store: st, ip, now, noDelay: true });
  for (let i = 0; i < LOCK.maxFails - 1; i++) assert.equal((await tryLogin("wrong", t0 + i)).status, 401);
  assert.equal((await tryLogin("bob-pass-22", t0 + 10)).status, 303, "未達門檻時仍可登入");
  for (let i = 0; i < LOCK.maxFails; i++) await tryLogin("wrong", t0 + 100 + i, "10.0.0." + (i + 2));
  const locked = await tryLogin("bob-pass-22", t0 + 200, "10.9.9.9");
  assert.equal(locked.status, 429);
  assert.match(await locked.text(), /嘗試次數過多/);
  assert.equal((await tryLogin("bob-pass-22", t0 + 200 + LOCK.lockMs - 10, "10.9.9.9")).status, 429, "鎖定中再嘗試會延長鎖定");
  assert.equal((await tryLogin("bob-pass-22", t0 + 200 + 2 * LOCK.lockMs, "10.9.9.9")).status, 303, "最後一次嘗試後滿 15 分鐘可登入");
});

test("鎖定：同一 IP 對多個帳號亂試也會被鎖", async () => {
  const st = memStore(), t0 = 1_900_000_000_000;
  for (let i = 0; i < LOCK.maxFails; i++) await handle(new Request("https://s.example/__login", { method: "POST", body: form({ user: `u${i}@x.com`, pass: "x" }) }), E2, ok, { store: st, ip: "1.2.3.4", now: t0 + i, noDelay: true });
  const r = await handle(new Request("https://s.example/__login", { method: "POST", body: form({ user: "alice@example.com", pass: "alice-pass-1" }) }), E2, ok, { store: st, ip: "1.2.3.4", now: t0 + 50, noDelay: true });
  assert.equal(r.status, 429);
});

test("安全標頭：登入頁有 CSP、禁止被嵌入、HSTS；netlify.toml 對全站設定相同標頭", async () => {
  const r = await handle(new Request("https://s.example/"), E, ok);
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.match(r.headers.get("strict-transport-security"), /max-age=\d+/);
  const fs = await import("node:fs");
  const toml = fs.readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
  for (const h of ["Content-Security-Policy", "X-Frame-Options", "Strict-Transport-Security", "Permissions-Policy"]) assert.match(toml, new RegExp(h));
  assert.match(toml, /worker-src[^"\n]*blob:/, "背景計算需要 blob: worker");
});

test("AUTH_USERS 與舊設定同名時以 AUTH_USERS 為準（改密碼後舊密碼失效）", async () => {
  const env = { AUTH_USER: "tester@example.com", AUTH_PASS_SHA256: await sha256Hex("old-pass"), AUTH_USERS: JSON.stringify({ "Tester@Example.com": await sha256Hex("new-pass") }), AUTH_SECRET: "z".repeat(40) };
  assert.equal(await authenticate(env, "tester@example.com", "new-pass"), "tester@example.com");
  assert.equal(await authenticate(env, "tester@example.com", "old-pass"), null);
});

test("鎖定：同時大量失敗不會因互相覆蓋而少算（每次失敗獨立記錄）", async () => {
  const st = memStore(), t0 = 1_900_000_000_000;
  await Promise.all(Array.from({ length: 12 }, (_, i) => handle(new Request("https://s.example/__login", { method: "POST", body: form({ user: "alice@example.com", pass: "x" + i }) }), E2, ok, { store: st, ip: "5.5.5." + i, now: t0, noDelay: true })));
  const r = await handle(new Request("https://s.example/__login", { method: "POST", body: form({ user: "alice@example.com", pass: "alice-pass-1" }) }), E2, ok, { store: st, ip: "6.6.6.6", now: t0 + 10, noDelay: true });
  assert.equal(r.status, 429);
});

test("密碼紀錄：支援加鹽 PBKDF2（新）與 SHA-256（舊）；同一密碼每次產生的紀錄不同；改密碼後舊登入失效", async () => {
  const { makeCred } = await import("../lib/auth-core.mjs");
  const c1 = await makeCred("pbkdf-pass-9"), c2 = await makeCred("pbkdf-pass-9");
  assert.match(c1, /^pbkdf2-sha256\$100000\$/);
  assert.notEqual(c1, c2, "每個紀錄各自隨機加鹽");
  const env = { AUTH_USERS: JSON.stringify({ "p@x.com": c1, "legacy@x.com": await sha256Hex("old-style-1") }), AUTH_SECRET: "z".repeat(40) };
  assert.equal(await authenticate(env, "p@x.com", "pbkdf-pass-9"), "p@x.com");
  assert.equal(await authenticate(env, "p@x.com", "pbkdf-pass-8"), null);
  assert.equal(await authenticate(env, "legacy@x.com", "old-style-1"), "legacy@x.com");
  const t = await issueToken(env, "p@x.com", 1_800_000_000);
  assert.equal(await verifyToken(env, t, 1_800_000_100), "p@x.com");
  const changed = { ...env, AUTH_USERS: JSON.stringify({ "p@x.com": c2 }) };
  assert.equal(await verifyToken(changed, t, 1_800_000_100), null, "換新紀錄（新鹽）後舊登入失效");
});

test("鎖定：同時送出大量嘗試時，最多只有 5 次會進到密碼驗證（先登記再驗證）", async () => {
  const st = memStore(), t0 = 1_900_000_000_000;
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => handle(new Request("https://s.example/__login", { method: "POST", body: form({ user: "bob@example.com", pass: "guess" + i }) }), E2, ok, { store: st, ip: "7.7.7." + i, now: t0, noDelay: true })));
  const evaluated = rs.filter((r) => r.status !== 429).length;
  assert.ok(evaluated <= LOCK.maxFails, `進到驗證的次數 ${evaluated}`);
});
