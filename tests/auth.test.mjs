// 網站登入測試：帳密驗證、cookie 簽章與到期、未設定時拒絕、登入流程與 API 保護
import test from "node:test";
import assert from "node:assert/strict";
import { sha256Hex, checkCredentials, issueToken, verifyToken, readCookie, safeNext, configured, COOKIE } from "../lib/auth-core.mjs";
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
  assert.equal(await verifyToken(E, t, now + 60), true);
  assert.equal(await verifyToken(E, t.replace(/.$/, (c) => (c === "0" ? "1" : "0")), now), false);
  assert.equal(await verifyToken(E, t, now + 13 * 3600), false);
  assert.equal(await verifyToken({ ...E, AUTH_SECRET: "y".repeat(40) }, t, now), false);
  assert.equal(await verifyToken(E, "garbage", now), false);
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
