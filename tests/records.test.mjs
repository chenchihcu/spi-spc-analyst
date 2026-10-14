// 資料庫函式測試：新增、查詢、下載、不可修改、只有上傳者能刪除、稽核紀錄、重複檔、大小與格式限制
import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { handleRecords, checkMeta, MAX_GZ } from "../lib/records-core.mjs";

/* 記憶體版 Netlify Blobs：支援 etag 與 onlyIfNew／onlyIfMatch 條件寫入 */
function memStore() {
  const m = new Map(); let n = 0;
  const put = (k, data, metadata, o = {}) => {
    const cur = m.get(k);
    if (o.onlyIfNew && cur) return { modified: false };
    if (o.onlyIfMatch && (!cur || cur.etag !== o.onlyIfMatch)) return { modified: false };
    const etag = `e${++n}`; m.set(k, { data, metadata: metadata || {}, etag }); return { modified: true, etag };
  };
  return {
    m,
    async set(k, v, o = {}) { return put(k, new Uint8Array(v).slice(), o.metadata, o); },
    async setJSON(k, v, o = {}) { return put(k, JSON.stringify(v), o.metadata, o); },
    async get(k, { type } = {}) { const x = m.get(k); if (!x) return null; return type === "json" ? JSON.parse(x.data) : x.data; },
    async getWithMetadata(k, { type } = {}) {
      const x = m.get(k); if (!x) return null;
      const data = type === "json" ? JSON.parse(x.data) : type === "arrayBuffer" ? x.data.slice().buffer : x.data;
      return { data, metadata: x.metadata, etag: x.etag };
    },
    async delete(k) { m.delete(k); },
    async list({ prefix = "" } = {}) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, etag: m.get(key).etag })), directories: [] }; },
  };
}
const U = "https://s.example/api/records";
const RAW = "Component ID,Height(%)1,Volume(%)1\nC1_1,100,101\n";
const spi = (o = {}) => ({ kind: "spi", lot: "L2410-01", part: "301-000100124", side: "TOP", vendor: "lirong", name: "301_TOP.csv", rows: 40, boards: 20, pads: 2, ...o });
const post = (st, meta, raw = RAW, user = "a@x.tw", now = 1000) =>
  handleRecords(new Request(U, { method: "POST", body: gzipSync(Buffer.from(raw)), headers: { "x-spi-user": user, "x-rec-meta": encodeURIComponent(JSON.stringify(meta)) } }), st, now);
const req = (st, q, method = "GET", user = "a@x.tw", now = 2000) => handleRecords(new Request(U + q, { method, headers: { "x-spi-user": user } }), st, now);

test("新增量測紀錄：記錄批號、料號、上傳者、時間與 SHA-256；可列出與下載原始檔", async () => {
  const st = memStore();
  const r = await post(st, spi());
  assert.equal(r.status, 201);
  const { record } = await r.json();
  assert.match(record.id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(record.lot, "L2410-01"); assert.equal(record.part, "301-000100124"); assert.equal(record.user, "a@x.tw"); assert.equal(record.created, 1000);
  assert.equal(record.sha256, createHash("sha256").update(RAW).digest("hex"));
  assert.equal(record.bytes, Buffer.byteLength(RAW));
  const l = await (await req(st, "")).json();
  assert.equal(l.records.length, 1); assert.equal(l.me, "a@x.tw");
  const d = await req(st, `?id=${record.id}`);
  assert.equal(d.status, 200);
  assert.equal(d.headers.get("x-rec-sha256"), record.sha256);
  assert.equal(gunzipSync(Buffer.from(await d.arrayBuffer())).toString(), RAW, "下載的原始檔與上傳完全相同");
});

test("必填欄位：量測紀錄需批號與料號，座標檔需料號與版本；欄位內的 HTML 字元被移除", () => {
  assert.match(checkMeta(spi({ lot: "" })).error, /批號/);
  assert.match(checkMeta(spi({ part: "  " })).error, /料號/);
  assert.match(checkMeta({ kind: "place", part: "X3000" }).error, /版本/);
  assert.match(checkMeta({ kind: "other", part: "X" }).error, /類型/);
  assert.equal(checkMeta({ kind: "place", part: "X3000", rev: "V5", comps: 1000 }).meta.rev, "V5");
  assert.equal(checkMeta(spi({ lot: "<b>L1</b>" })).meta.lot, "bL1/b");
  assert.equal(checkMeta(spi({ placeId: "bad" })).meta.placeId, "");
});

test("不能修改：PUT／PATCH 一律拒絕，紀錄不變", async () => {
  const st = memStore();
  const { record } = await (await post(st, spi())).json();
  for (const m of ["PUT", "PATCH"]) {
    const r = await req(st, `?id=${record.id}`, m);
    assert.equal(r.status, 405);
    assert.match((await r.json()).error, /不能修改/);
  }
  assert.equal((await (await req(st, "")).json()).records[0].sha256, record.sha256);
});

test("刪除：只有上傳者能刪；刪除後檔案移除，稽核紀錄保留新增與刪除", async () => {
  const st = memStore();
  const { record } = await (await post(st, spi())).json();
  let r = await req(st, `?id=${record.id}`, "DELETE", "b@x.tw");
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /只有上傳者（a@x.tw）/);
  r = await req(st, `?id=${record.id}`, "DELETE", "a@x.tw", 5000);
  assert.equal(r.status, 200);
  assert.equal(st.m.has(`f/${record.id}`), false, "檔案已移除");
  assert.equal((await (await req(st, "")).json()).records.length, 0);
  assert.equal((await req(st, `?id=${record.id}`)).status, 404);
  assert.equal((await req(st, `?id=${record.id}`, "DELETE")).status, 404, "重複刪除回 404");
  const { entries } = await (await req(st, "?audit=1")).json();
  assert.deepEqual(entries.map((e) => e.action), ["delete", "create"], "新到舊");
  assert.equal(entries[0].by, "a@x.tw"); assert.equal(entries[0].lot, "L2410-01"); assert.equal(entries[0].sha256, record.sha256); assert.equal(entries[0].uploaded, 1000);
});

test("重複檔：相同內容＋相同批號料號擋下並指出既有紀錄；不同批號可存", async () => {
  const st = memStore();
  const { record } = await (await post(st, spi())).json();
  const r = await post(st, spi());
  assert.equal(r.status, 409);
  assert.equal((await r.json()).existing, record.id);
  assert.equal((await post(st, spi({ lot: "L2410-02" }))).status, 201);
  assert.equal((await post(st, { kind: "place", part: "301-000100124", rev: "V5", name: "X3000_V5.csv" })).status, 201, "同內容但類型不同可存");
  assert.equal((await post(st, { kind: "place", part: "301-000100124", rev: "V5", name: "again.csv" })).status, 409);
  assert.equal((await (await req(st, "")).json()).records.length, 3);
});

test("同時上傳：索引以條件寫入，不會互相覆蓋", async () => {
  const st = memStore();
  const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => post(st, spi({ lot: "L" + i }), RAW + i)));
  assert.deepEqual(rs.map((r) => r.status), [201, 201, 201, 201, 201]);
  assert.equal((await (await req(st, "")).json()).records.length, 5);
});

test("限制：未登入、跨站、格式錯誤、檔案過大、解壓炸彈、代碼格式", async () => {
  const st = memStore();
  assert.equal((await handleRecords(new Request(U), st)).status, 401, "沒有登入者");
  const cross = await handleRecords(new Request(U, { method: "POST", body: gzipSync("x"), headers: { "x-spi-user": "a", origin: "https://evil.example", "x-rec-meta": encodeURIComponent(JSON.stringify(spi())) } }), st);
  assert.equal(cross.status, 403);
  const notGz = await handleRecords(new Request(U, { method: "POST", body: "plain text that is long enough", headers: { "x-spi-user": "a", "x-rec-meta": encodeURIComponent(JSON.stringify(spi())) } }), st);
  assert.equal(notGz.status, 400);
  const badMeta = await handleRecords(new Request(U, { method: "POST", body: gzipSync("x"), headers: { "x-spi-user": "a", "x-rec-meta": "%E0%A4%A" } }), st);
  assert.equal(badMeta.status, 400);
  const big = await handleRecords(new Request(U, { method: "POST", body: new Uint8Array(MAX_GZ + 1), headers: { "x-spi-user": "a", "x-rec-meta": encodeURIComponent(JSON.stringify(spi())) } }), st);
  assert.equal(big.status, 413);
  const bomb = await handleRecords(new Request(U, { method: "POST", body: gzipSync(Buffer.alloc(101 * 1048576)), headers: { "x-spi-user": "a", "x-rec-meta": encodeURIComponent(JSON.stringify(spi())) } }), st);
  assert.equal(bomb.status, 400);
  assert.equal((await req(st, "?id=../index.json")).status, 400);
  assert.equal((await req(st, "?id=x", "DELETE")).status, 400);
  assert.equal(st.m.size, 0, "失敗的請求不留任何資料");
});
