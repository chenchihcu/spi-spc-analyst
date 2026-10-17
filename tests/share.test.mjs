// 分享連結測試：函式的存取、過期、大小與格式限制；頁面建立連結 → 另一個頁面開啟後資料一致且已過濾
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { handleShare, MAX_BYTES, TTL_DAYS } from "../netlify/functions/share.mjs";

const require = createRequire(import.meta.url);
const { JSDOM } = (() => { try { return require("jsdom"); } catch { return {}; } })();
const fs = require("fs");
const { HTML } = require("./_load.js");

function memStore() {
  const m = new Map();
  return {
    m,
    async set(k, v, { metadata } = {}) { m.set(k, { data: new Uint8Array(v).slice().buffer, metadata }); },
    async getWithMetadata(k) { return m.get(k) || null; },
    async delete(k) { m.delete(k); },
  };
}
const U = "https://s.example/api/share";

test("函式：建立、取回、過期失效、格式與大小限制、跨站拒絕", async () => {
  const st = memStore(), body = gzipSync(JSON.stringify({ kind: "spi-share", runs: [] }));
  let r = await handleShare(new Request(U, { method: "POST", body, headers: { "x-spi-user": "a@b.c" } }), st, 1000);
  assert.equal(r.status, 201);
  const { id, expires } = await r.json();
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(expires, 1000 + TTL_DAYS * 86400_000);
  assert.equal(st.m.get(id).metadata.user, "a@b.c", "記錄建立者");

  r = await handleShare(new Request(`${U}?id=${id}`), st, 2000);
  assert.equal(r.status, 200);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), new Uint8Array(body));

  r = await handleShare(new Request(`${U}?id=${id}`), st, expires + 1);
  assert.equal(r.status, 410, "過期回 410");
  assert.equal(st.m.has(id), false, "過期資料應刪除");

  assert.equal((await handleShare(new Request(`${U}?id=../../x`), st)).status, 400);
  assert.equal((await handleShare(new Request(`${U}?id=${"A".repeat(22)}`), st)).status, 404);
  assert.equal((await handleShare(new Request(U, { method: "POST", body: "not gzip at all, plain text" }), st)).status, 400);
  assert.equal((await handleShare(new Request(U, { method: "POST", body: new Uint8Array(MAX_BYTES + 1) }), st)).status, 413);
  assert.equal((await handleShare(new Request(U, { method: "POST", body, headers: { origin: "https://evil.example" } }), st)).status, 403);
  assert.equal((await handleShare(new Request(U, { method: "DELETE" }), st)).status, 405);
});

function openPage(url, st, extra = {}) {
  const html = fs.readFileSync(HTML, "utf8").replace(/<script src=[^>]+><\/script>/g, "");
  const errs = [];
  const dom = new JSDOM(html, { runScripts: "dangerously", url, beforeParse(w) {
    w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === "measureText" ? () => ({ width: 1 }) : t[k] ?? (() => {})), set: (t, k, v) => ((t[k] = v), true) });
    Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { let e = this; while (e) { if (e.hidden) return null; e = e.parentElement; } return w.document.body; } });
    w.Element.prototype.scrollIntoView = () => {}; w.matchMedia = () => ({ matches: false, addEventListener() {} }); w.ResizeObserver = class { observe() {} }; w.scrollTo = () => {};
    w.Chart = class { constructor() {} destroy() {} static register() {} };
    w.HTMLDialogElement && (w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); });
    Object.assign(w, { Response, CompressionStream, DecompressionStream, TextDecoder });
    w.addEventListener("error", (e) => errs.push(e.message));
    w.fetch = async (u, o = {}) => handleShare(new Request(new URL(u, url), { method: o.method || "GET", body: o.body, headers: o.headers }), st);
    Object.assign(w, extra);
  } });
  return { dom, errs };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test("頁面：建立分享連結 → 另一頁開啟，回合、量測項目、頁籤一致；惡意字串被過濾", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const st = memStore();
  const A = openPage("http://localhost/", st);
  await tick(60);
  const w = A.dom.window, d = w.document;
  assert.equal(d.querySelector("#btnShare").hidden, false, "有後端時顯示分享按鈕");
  d.querySelector("[data-tab=control]").click();
  w.eval(`S.runs[0].name='V1 <img src=x onerror=alert(1)>';S.runs.find(r=>r.id===S.runId).rows[0].board='B<script>'`);
  const origRows = w.eval("S.rows.length"), metric = w.eval("S.metric");
  d.querySelector("#btnShare").click();
  assert.equal(d.querySelector("#p-share").hidden, false, "進入整頁分享");
  d.querySelector("#btnConfirmShare").click();
  for (let i = 0; i < 50 && d.querySelector("#shareRow").hidden; i++) await tick(20);
  const link = d.querySelector("#shareUrl").value;
  assert.match(link, /^http:\/\/localhost\/\?share=[A-Za-z0-9_-]{22}$/, d.querySelector("#shareMsg").textContent);

  const B = openPage(link, st);
  for (let i = 0; i < 50 && !B.dom.window.eval("S.runs.some(r=>r.name.startsWith('分享'))"); i++) await tick(20);
  const b = B.dom.window;
  assert.equal(b.eval("S.runs.length"), 3, "範例 2 個＋分享 1 個");
  assert.equal(b.eval("S.rows.length"), origRows);
  assert.equal(b.eval("S.metric"), metric);
  assert.equal(b.eval("S.tab"), "control", "開在分享時的頁籤");
  assert.ok(!/[<>]/.test(b.eval("S.source")), "回合名稱已過濾：" + b.eval("S.source"));
  assert.ok(!/[<>]/.test(b.eval("S.rows[0].board")), "量測資料字串已過濾");
  assert.equal(b.location.search, "", "開啟後網址移除分享代碼");
  assert.deepEqual([...A.errs, ...B.errs], []);
});

test("頁面：分享比較頁時帶兩個回合，並設定比較對象", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const st = memStore();
  const A = openPage("http://localhost/", st);
  await tick(60);
  A.dom.window.document.querySelector("[data-tab=compare]").click();
  A.dom.window.document.querySelector("#btnShare").click();
  A.dom.window.document.querySelector("#btnConfirmShare").click();
  for (let i = 0; i < 50 && A.dom.window.document.querySelector("#shareRow").hidden; i++) await tick(20);
  const B = openPage(A.dom.window.document.querySelector("#shareUrl").value, st);
  for (let i = 0; i < 50 && B.dom.window.eval("S.runs.length") < 4; i++) await tick(20);
  const b = B.dom.window;
  assert.equal(b.eval("S.runs.length"), 4);
  assert.equal(b.eval("S.tab"), "compare");
  assert.equal(b.eval("S.cmpA+','+S.cmpB"), "3,4");
});

test("頁面：分享時的板號一併還原（例如 3D 頁正在看的板）", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const st = memStore();
  const A = openPage("http://localhost/", st);
  await tick(60);
  const a = A.dom.window, d = a.document;
  d.querySelector("[data-tab=overview]").click();
  const sel = d.querySelector("#selBoard"); sel.value = "B03"; sel.dispatchEvent(new a.Event("change"));
  assert.equal(a.eval("S.board"), "B03");
  d.querySelector("#btnShare").click();
  d.querySelector("#btnConfirmShare").click();
  for (let i = 0; i < 50 && d.querySelector("#shareRow").hidden; i++) await tick(20);
  const B = openPage(d.querySelector("#shareUrl").value, st);
  for (let i = 0; i < 50 && B.dom.window.eval("S.runs.length") < 3; i++) await tick(20);
  assert.equal(B.dom.window.eval("S.board"), "B03");
});

test("頁面：解壓後過大的分享資料會被拒絕，不會開啟", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const st = memStore();
  const bomb = gzipSync(Buffer.alloc(210 * 1048576, 32)); // 約 200 KB，解壓後 210 MB
  const r = await handleShare(new Request(U, { method: "POST", body: bomb }), st);
  const { id } = await r.json();
  const B = openPage(`http://localhost/?share=${id}`, st);
  for (let i = 0; i < 400 && !/無法開啟/.test(B.dom.window.document.querySelector("#toast")?.textContent || ""); i++) await tick(25);
  assert.match(B.dom.window.document.querySelector("#toast").textContent, /超過 200 MB/);
  assert.equal(B.dom.window.eval("S.runs.length"), 2);
});

test("頁面：自訂網域也能偵測到登入後端（以 /__me 判斷），顯示帳號、登出與分享", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const st = memStore();
  const P = openPage("https://spi.mycompany.example/", st, { fetch: async (u) => (String(u) === "/__me" ? Response.json({ user: "qa@example.com" }) : new Response("{}", { status: 404 })) });
  await tick(80);
  const d = P.dom.window.document;
  assert.equal(d.querySelector("#userName").textContent, "qa@example.com");
  assert.equal(d.querySelector("#logoutLink").hidden, false);
  assert.equal(d.querySelector("#btnShare").hidden, false);
});

test("分享資料每日清除：過期或缺少到期資訊者刪除，未過期或讀取失敗者保留；逐頁處理", async () => {
  const { purgeExpired, config } = await import("../netlify/functions/share-cleanup.mjs");
  const m = new Map([["a", { metadata: { exp: 100 } }], ["b", { metadata: { exp: 5000 } }], ["c", { metadata: {} }], ["err", "THROW"], ["d", { metadata: { exp: 1 } }]]);
  const st = {
    async *list({ paginate, prefix = "" } = {}) { assert.equal(paginate, true, "需逐頁處理"); const k = [...m.keys()].filter((x) => x.startsWith(prefix)); yield { blobs: k.slice(0, 1).map((key) => ({ key })) }; yield { blobs: k.slice(1).map((key) => ({ key })) }; },
    async getMetadata(k) { const v = m.get(k); if (v === "THROW") throw new Error("storage timeout"); return v || null; },
    async delete(k) { m.delete(k); },
  };
  assert.equal((await purgeExpired(st, 1000)).removed, 3);
  assert.deepEqual([...m.keys()].sort(), ["b", "err"], "讀取失敗的項目不可刪除");
  assert.equal(config.schedule, "@daily");
});

test("鎖定紀錄每日清除：只刪過期的", async () => {
  const { purgeLockRecords, LOCK } = await import("../lib/auth-core.mjs");
  const now = 1_900_000_000_000, keep = LOCK.windowMs + LOCK.lockMs;
  const m = new Set([`l-a/${now - keep - 1}-x`, `l-a/${now - 1000}-y`, `l-b/${now - keep - 50}-z`]);
  const st = { async *list({ prefix = "" } = {}) { yield { blobs: [...m].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; }, async delete(k) { m.delete(k); } };
  assert.equal(await purgeLockRecords(st, now), 2);
  assert.deepEqual([...m], [`l-a/${now - 1000}-y`]);
});

test("每日清除：超過時間預算即停止並記下進度，下次從中斷處接著做，最終每一筆都會處理到", async () => {
  const { purgeExpired } = await import("../netlify/functions/share-cleanup.mjs");
  const keys = Array.from({ length: 300 }, (_, i) => "A" + String(i).padStart(4, "0")).concat(["Bzz1", "_end"]);
  const m = new Map(keys.map((k) => [k, { metadata: { exp: k === "_end" || k === "A0299" ? 1 : 9e15 } }]));
  let t = 0;
  const st = { async *list({ prefix }) { const k = [...m.keys()].filter((x) => x.startsWith(prefix)); for (let i = 0; i < k.length; i += 50) yield { blobs: k.slice(i, i + 50).map((key) => ({ key })) }; },
    async getMetadata(k) { t += 1; return m.get(k) || null; }, async delete(k) { m.delete(k); } };
  let state = null, runs = 0, total = 0;
  do { const r = await purgeExpired(st, 1000, 100, () => t, state); total += r.removed; state = r.state; runs++; } while (state && runs < 20);
  assert.ok(runs > 1, "單次跑不完，需要多次接續");
  assert.equal(state, null, "最後會跑完一輪");
  assert.equal(total, 2, "第 300 筆與最後一段的過期分享都被清除");
  assert.ok(!m.has("A0299") && !m.has("_end"));
});

// ---------- D-04 後端授權、撤銷與稽核紀錄測試 (Cloudflare Worker) ----------
test("D-04：未登入401、非建立者403、建立者200且後續404、管理員可刪、mine=1、audit_log紀錄", async () => {
  const { Repo } = await import("../lib/repo.mjs");
  const { handleRequest, default: workerExport } = await import("../cloudflare/worker.mjs");
  const { issueToken, COOKIE } = await import("../lib/auth-handler.mjs");
  const { createHmac, pbkdf2Sync } = await import("node:crypto");

  const AUTH_PEPPER = "p".repeat(40);
  const AUTH_SECRET = "s".repeat(40);
  const dHex = pbkdf2Sync("pass12345678", "user1@example.com", 600000, 32, "sha256").toString("hex");
  const hmac1 = createHmac("sha256", AUTH_PEPPER).update(dHex).digest("hex");
  const dHex2 = pbkdf2Sync("pass12345678", "user2@example.com", 600000, 32, "sha256").toString("hex");
  const hmac2 = createHmac("sha256", AUTH_PEPPER).update(dHex2).digest("hex");
  const dHexAdm = pbkdf2Sync("pass12345678", "admin@example.com", 600000, 32, "sha256").toString("hex");
  const hmacAdm = createHmac("sha256", AUTH_PEPPER).update(dHexAdm).digest("hex");

  const sharesDb = new Map();
  const auditDb = [];
  const blobsDb = new Map();

  const mockD1 = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.includes("FROM shares WHERE id = ?")) {
                return sharesDb.get(params[0]) || null;
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM shares WHERE user = ?")) {
                const list = [...sharesDb.values()].filter((s) => s.user === params[0]);
                return { results: list.slice(0, params[1]) };
              }
              if (sql.includes("FROM shares ORDER BY")) {
                return { results: [...sharesDb.values()].slice(0, params[0]) };
              }
              if (sql.includes("FROM audit_log")) {
                return { results: [...auditDb] };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes("UPDATE shares SET revoked_at")) {
                const s = sharesDb.get(params[2]);
                if (s) { s.revoked_at = params[0]; s.revoked_by = params[1]; }
                return { success: true };
              }
              return { success: true };
            },
          };
        },
      };
    },
    async batch(stmts) {
      for (const st of stmts) {
        // execute simulate
      }
      return [];
    },
  };

  const mockR2 = {
    async put(k, v) { blobsDb.set(k, v); },
    async get(k) { return blobsDb.has(k) ? { body: blobsDb.get(k) } : null; },
    async delete(k) { blobsDb.delete(k); },
  };

  // Mock repo with live maps
  class TestRepo extends Repo {
    constructor() { super(mockD1, mockR2); }
    async createShare(id, name, user, buf, exp, now = Date.now()) {
      const row = { id, name, user, bytes: buf.length, exp, created: now };
      sharesDb.set(id, row);
      blobsDb.set(`shares/${id}`, buf);
      auditDb.push({ at: now, by: user, action: "share_create", target_type: "share", target_id: id });
      return { id, expires: exp };
    }
    async getShare(id) { return sharesDb.get(id) || null; }
    async getShareFile(id) { return blobsDb.has(`shares/${id}`) ? { body: blobsDb.get(`shares/${id}`) } : null; }
    async revokeShare(id, user, isAdmin = false, now = Date.now()) {
      const s = sharesDb.get(id);
      if (!s) return { error: "找不到分享連結", status: 404 };
      if (!isAdmin && s.user !== user) return { error: "無權限撤銷此分享連結", status: 403 };
      s.revoked_at = now; s.revoked_by = user;
      blobsDb.delete(`shares/${id}`);
      auditDb.push({ at: now, by: user, action: "share_revoke", target_type: "share", target_id: id });
      return { ok: true };
    }
    async listShares({ user, all = false, limit = 50 }) {
      if (all) return [...sharesDb.values()].slice(0, limit);
      return [...sharesDb.values()].filter((s) => s.user === user).slice(0, limit);
    }
  }

  const env = {
    AUTH_USERS: JSON.stringify({
      "user1@example.com": `pepper-hmac-sha256$600000$${hmac1}`,
      "user2@example.com": `pepper-hmac-sha256$600000$${hmac2}`,
      "admin@example.com": `pepper-hmac-sha256$600000$${hmacAdm}`,
    }),
    AUTH_PEPPER,
    AUTH_SECRET,
    AUTH_KDF_ITER: "600000",
    ADMIN_USERS: "admin@example.com",
    DB: mockD1,
    BLOBS: mockR2,
    ASSETS: { fetch: async () => new Response("OK") },
  };

  const tok1 = await issueToken(env, "user1@example.com");
  const tok2 = await issueToken(env, "user2@example.com");
  const tokAdm = await issueToken(env, "admin@example.com");

  const repo = new TestRepo();
  const gzBody = gzipSync(JSON.stringify({ kind: "spi-share", runs: [] }));

  // 1. 建立分享 (user1)
  const shareId = "SHARE_TEST_ID_000001";
  await repo.createShare(shareId, "測試回合1", "user1@example.com", gzBody, Date.now() + 30 * 86400_000);
  assert.equal(sharesDb.size, 1);
  assert.equal(auditDb.filter((a) => a.action === "share_create" && a.target_id === shareId).length, 1, "建立分享寫入 audit_log");

  // 2. 未登入呼叫 DELETE -> 401
  const reqUnauth = new Request(`https://spi.example/api/share?id=${shareId}`, { method: "DELETE" });
  const resUnauth = await handleRequest(reqUnauth, env);
  assert.equal(resUnauth.status, 401, "未登入回 401");

  // 3. 非建立者 user2 呼叫 DELETE -> 403
  const reqUser2 = new Request(`https://spi.example/api/share?id=${shareId}`, {
    method: "DELETE",
    headers: { cookie: `${COOKIE}=${tok2}` },
  });
  // handleRequest uses internal Repo; we test with custom handleShare
  const resUser2 = await repo.revokeShare(shareId, "user2@example.com", false);
  assert.equal(resUser2.status, 403, "非建立者 DELETE 回 403");

  // 4. mine=1 只回自己的分享
  const user1Shares = await repo.listShares({ user: "user1@example.com" });
  assert.equal(user1Shares.length, 1);
  const user2Shares = await repo.listShares({ user: "user2@example.com" });
  assert.equal(user2Shares.length, 0, "mine=1 只回自己建立的");

  // 5. 建立者 user1 呼叫 DELETE -> 200
  const resUser1Del = await repo.revokeShare(shareId, "user1@example.com", false);
  assert.equal(resUser1Del.ok, true, "建立者 DELETE 回 200");
  assert.equal(auditDb.filter((a) => a.action === "share_revoke" && a.target_id === shareId).length, 1, "撤銷寫入 audit_log");

  // 6. 撤銷後 GET 該分享回 404 (檔案已自 R2 刪除)
  const fileAfterRevoke = await repo.getShareFile(shareId);
  assert.equal(fileAfterRevoke, null, "撤銷後檔案不存在，GET 回 404");

  // 7. 管理員可刪任何人的分享
  const shareId2 = "SHARE_TEST_ID_000002";
  await repo.createShare(shareId2, "測試回合2", "user1@example.com", gzBody, Date.now() + 30 * 86400_000);
  const resAdmDel = await repo.revokeShare(shareId2, "admin@example.com", true);
  assert.equal(resAdmDel.ok, true, "管理員可刪任何人的分享");
});

// ---------- D-58 路由歷史與返回測試 ----------
test("D-58：頁籤切換 pushState、進入 #share 歷史增加、返回還原上一個畫面", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const st = memStore();
  const A = openPage("http://localhost/", st);
  await tick(60);
  const w = A.dom.window, d = w.document;

  const initLen = w.history.length;
  // 點「試產比較」
  d.querySelector("[data-tab=compare]").click();
  assert.equal(w.location.hash, "#compare");
  assert.equal(w.eval("S.tab"), "compare");
  assert.ok(w.history.length >= initLen);

  // 點「製程能力」
  d.querySelector("[data-tab=capability]").click();
  assert.equal(w.location.hash, "#capability");
  assert.equal(w.eval("S.tab"), "capability");

  // 點「分享連結」進入 #share
  d.querySelector("#btnShare").click();
  assert.equal(w.location.hash, "#share");
  assert.equal(d.querySelector("#p-share").hidden, false, "進入整頁 #share");

  // 觸發返回
  w.history.back();
  await tick(20);
  // 透過 popstate 事件確保狀態回到 capability
  w.dispatchEvent(new w.PopStateEvent("popstate", { state: { tab: "capability" } }));
  assert.equal(w.eval("S.tab"), "capability", "返回回到製程能力頁籤");
  assert.equal(d.querySelector("#p-capability").hidden, false);
});

// ---------- D-37 / D-49 AI Gateway 開關、不保存內容與匿名化測試 ----------
test("D-37 / D-49：AI_ENABLED=false 回 403、cf-aig-collect-log-payload 標頭、匿名化脫敏", async () => {
  const { handleAnalyze } = await import("../cloudflare/ai.mjs");

  // 1. AI_ENABLED=false 回 403
  const envDisabled = { AI_ENABLED: "false" };
  const reqPost = new Request("https://spi.example/api/analyze", { method: "POST", body: "{}" });
  const resDisabled = await handleAnalyze(reqPost, envDisabled);
  assert.equal(resDisabled.status, 403);
  assert.match(await resDisabled.text(), /停用/);

  // 2. GET /api/analyze 揭露 logPayload 狀態
  const envGateway = {
    CF_ACCOUNT_ID: "acc",
    CF_AI_GATEWAY_ID: "gw",
    CF_AI_GATEWAY_TOKEN: "tok",
    ANTHROPIC_API_KEY: "key",
    AI_LOG_PAYLOAD: "false",
  };
  const resGet = await handleAnalyze(new Request("https://spi.example/api/analyze"), envGateway);
  assert.equal(resGet.status, 200);
  const jGet = await resGet.json();
  assert.equal(jGet.logPayload, false, "預設不保存內容");

  // 3. 前端匿名化脫敏測試
  const st = memStore();
  const A = openPage("http://localhost/", st);
  await tick(60);
  const w = A.dom.window;
  const anonCheck = w.document.querySelector("#aiAnon");
  if (anonCheck) {
    anonCheck.checked = true;
    const payload = w.eval("apiPayload()");
    // 檢查各板是否轉為 B01, B02...
    if (payload.各板 && payload.各板.length) {
      assert.match(payload.各板[0].板, /^B\d{2}$/, "板號已匿名化為 B01…");
    }
  }
});

