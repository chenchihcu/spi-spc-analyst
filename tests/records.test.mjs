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

test("不支援壓縮的瀏覽器：可直接上傳原始檔、以 raw=1 取回原始檔，指紋相同", async () => {
  const st = memStore();
  const r = await handleRecords(new Request(U, { method: "POST", body: RAW, headers: { "x-spi-user": "a@x.tw", "content-type": "application/octet-stream", "x-rec-meta": encodeURIComponent(JSON.stringify(spi())) } }), st);
  assert.equal(r.status, 201);
  const { record } = await r.json();
  assert.equal(record.sha256, createHash("sha256").update(RAW).digest("hex"));
  const gz = await req(st, `?id=${record.id}`);
  assert.equal(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString(), RAW, "存檔仍為 gzip");
  const raw = await req(st, `?id=${record.id}&raw=1`);
  assert.equal(Buffer.from(await raw.arrayBuffer()).toString(), RAW);
});

test("重複判定包含面別、加工廠格式與座標檔：任一不同就另存，避免回合引用錯的設定", async () => {
  const st = memStore();
  assert.equal((await post(st, spi())).status, 201);
  assert.equal((await post(st, spi({ side: "BOT" }))).status, 201, "改了面別");
  assert.equal((await post(st, spi({ placeId: "A".repeat(22) }))).status, 201, "改了座標檔");
  assert.equal((await post(st, spi({ vendor: "generic" }))).status, 201, "改了格式");
  assert.equal((await post(st, spi({ side: "BOT" }))).status, 409, "全部相同才算重複");
});

test("同時上傳同一檔：後到者的 409 也帶既有紀錄代碼", async () => {
  const st = memStore();
  // 讓兩個請求都先通過第一次重複檢查：先讀索引，再一起寫
  const [a, b] = await Promise.all([post(st, spi()), post(st, spi())]);
  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [201, 409]);
  const win = await (a.status === 201 ? a : b).json(), lose = await (a.status === 409 ? a : b).json();
  assert.equal(lose.existing, win.record.id);
  assert.equal((await (await req(st, "")).json()).records.length, 1);
});

test("稽核紀錄寫入失敗時：刪除不會發生（可重試），新增不會留下沒有稽核紀錄的資料", async () => {
  const st = memStore();
  const { record } = await (await post(st, spi())).json();
  const orig = st.setJSON.bind(st); let fail = true;
  st.setJSON = async (k, v, o) => { if (k.startsWith("log/") && fail) { fail = false; throw new Error("blob 暫時錯誤"); } return orig(k, v, o); };
  assert.equal((await req(st, `?id=${record.id}`, "DELETE")).status, 503);
  assert.equal((await (await req(st, "")).json()).records.length, 1, "稽核寫不進去就不刪");
  assert.equal((await req(st, `?id=${record.id}`, "DELETE")).status, 200, "重試成功");
  const { entries } = await (await req(st, "?audit=1")).json();
  assert.deepEqual(entries.map((e) => e.action), ["delete", "create"]);
  fail = true;
  assert.equal((await post(st, spi({ lot: "L-NEW" }))).status, 503);
  assert.equal((await (await req(st, "")).json()).records.length, 0, "新增時稽核失敗不留資料");
  assert.equal([...st.m.keys()].filter((k) => k.startsWith("f/")).length, 0, "也不留檔案");
});

test("撤回失敗時稽核頁不誤報：依資料庫現況標示未完成", async () => {
  const st = memStore();
  const { record } = await (await post(st, spi())).json();
  // 刪除時索引寫入一直失敗，而撤回稽核紀錄也失敗 → 稽核紀錄殘留，但應標為未完成
  const setJ = st.setJSON.bind(st), del = st.delete.bind(st);
  st.setJSON = async (k, v, o) => { if (k === "index.json") throw new Error("索引寫入失敗"); return setJ(k, v, o); };
  st.delete = async (k) => { if (k.startsWith("log/")) throw new Error("刪除失敗"); return del(k); };
  assert.equal((await req(st, `?id=${record.id}`, "DELETE")).status, 503);
  st.setJSON = setJ; st.delete = del;
  let { entries } = await (await req(st, "?audit=1")).json();
  assert.deepEqual(entries.map((e) => [e.action, e.ok]), [["delete", false], ["create", true]], "刪除未完成、新增完成");
  // 之後真的刪除成功：最新的刪除為完成，先前那筆仍為未完成；新增仍算完成
  assert.equal((await req(st, `?id=${record.id}`, "DELETE", "a@x.tw", 9000)).status, 200);
  ({ entries } = await (await req(st, "?audit=1")).json());
  assert.deepEqual(entries.map((e) => [e.action, e.ok]), [["delete", true], ["delete", false], ["create", true]]);
});

test("舊瀏覽器取回未壓縮原始檔：超過 5 MB 時清楚說明（避免超過平台回應上限）", async () => {
  const st = memStore();
  const big = "x".repeat(5 * 1048576 + 10);
  const { record } = await (await post(st, spi(), big)).json();
  const r = await req(st, `?id=${record.id}&raw=1`);
  assert.equal(r.status, 413);
  assert.match((await r.json()).error, /請改用新版/);
  assert.equal((await req(st, `?id=${record.id}`)).status, 200, "壓縮版仍可取回");
});

test("兩個刪除同時進行且撤回失敗：以各筆實際結果標示，不會把失敗的那筆誤標為完成", async () => {
  const st = memStore();
  const { record } = await (await post(st, spi())).json();
  // 兩個刪除請求都先寫入稽核紀錄；只有先寫索引的那個成功。失敗那筆的撤回刪除也失敗（殘留）
  const del = st.delete.bind(st);
  st.delete = async (k) => { if (k.startsWith("log/")) throw new Error("撤回失敗"); return del(k); };
  const [a, b] = await Promise.all([req(st, `?id=${record.id}`, "DELETE", "a@x.tw", 5000), req(st, `?id=${record.id}`, "DELETE", "a@x.tw", 6000)]);
  st.delete = del;
  const ok = [a.status, b.status].sort();
  assert.deepEqual(ok, [200, 404]);
  const winAt = a.status === 200 ? 5000 : 6000;
  const { entries } = await (await req(st, "?audit=1")).json();
  const dels = entries.filter((e) => e.action === "delete");
  assert.equal(dels.length, 2);
  assert.deepEqual(dels.map((e) => [e.at, e.ok]).sort(), [[5000, winAt === 5000], [6000, winAt === 6000]], "成功的那筆才是完成");
});

test("完成標記寫入暫時失敗會重試：同時刪除時仍以實際成功的那筆為完成", async () => {
  const st = memStore();
  const { record } = await (await post(st, spi())).json();
  const del = st.delete.bind(st), setJ = st.setJSON.bind(st); let doneFails = 2;
  st.delete = async (k) => { if (k.startsWith("log/")) throw new Error("撤回失敗"); return del(k); };
  st.setJSON = async (k, v, o) => { if (k.startsWith("log/") && v.done && doneFails-- > 0) throw new Error("暫時失敗"); return setJ(k, v, o); };
  const [a, b] = await Promise.all([req(st, `?id=${record.id}`, "DELETE", "a@x.tw", 5000), req(st, `?id=${record.id}`, "DELETE", "a@x.tw", 6000)]);
  st.delete = del; st.setJSON = setJ;
  const winAt = a.status === 200 ? 5000 : 6000;
  const { entries } = await (await req(st, "?audit=1")).json();
  assert.deepEqual(entries.filter((e) => e.action === "delete").map((e) => [e.at, e.ok]).sort(), [[5000, winAt === 5000], [6000, winAt === 6000]]);
});
