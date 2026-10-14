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
  for (let i = 0; i < 200 && !/無法開啟/.test(B.dom.window.document.querySelector("#toast")?.textContent || ""); i++) await tick(25);
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
  assert.equal(await purgeExpired(st, 1000), 3);
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

test("每日清除：超過時間預算即停止，且每天從不同分段開始（輪流處理，不會永遠卡在前面）", async () => {
  const { purgeExpired, rotation, ID_CHARS } = await import("../netlify/functions/share-cleanup.mjs");
  assert.notEqual(rotation(ID_CHARS, 0)[0], rotation(ID_CHARS, 86400_000)[0], "隔天起點不同");
  const firsts = new Set(Array.from({ length: 64 }, (_, d) => rotation(ID_CHARS, d * 86400_000)[0]));
  assert.equal(firsts.size, 64, "64 天內每個分段都會當過起點");
  let t = 0, calls = 0;
  const st = { async *list({ prefix }) { calls++; yield { blobs: [{ key: prefix + "x" }] }; }, async getMetadata() { t += 10; return { metadata: { exp: 9e15 } }; }, async delete() {} };
  await purgeExpired(st, 0, 25, () => t);
  assert.ok(calls < 10, `應在預算內停止（掃描 ${calls} 段）`);
});
