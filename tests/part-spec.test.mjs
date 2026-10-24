// 料號規格（kind:"spec"）資料層：本體驗證（頁面與伺服器同規則）、records 欄位、D1 版本號／預設版原子切換與稽核、Worker 路由、本機模式
// 全部使用合成資料（不含客戶資料）
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { partSpecCheck, partSpecCanon, checkSpecBody, PART_SPEC_SCHEMA } from "../lib/part-spec-core.mjs";
import { checkMeta, handleRecords } from "../lib/records-core.mjs";
import { Repo } from "../lib/repo.mjs";
import { handleRequest } from "../cloudflare/worker.mjs";
import { issueToken, COOKIE } from "../lib/auth-handler.mjs";

const require = createRequire(import.meta.url);
const { loadCore, HTML, withIdb } = require("./_load.js");
const { JSDOM } = (() => { try { return require("jsdom"); } catch { return {}; } })();
const core = loadCore();

const W = (lsl, tgt, usl) => ({ lsl, tgt, usl });
const spec = (part = "301-000100124", extra = {}) => ({
  schema: PART_SPEC_SCHEMA, part, stencilRef: 88,
  specs: { volume: W(70, 100, 130), hpct: W(75, 100, 125), area: W(70, 100, 130), offx: W(-75, 0, 75), offy: W(-75, 0, 75) },
  groups: { "U2 BGA": { volume: W(80, 100, 120) } }, note: "合成測試", ...extra,
});
const body = (o) => Buffer.from(partSpecCanon(partSpecCheck(o).spec));
const sha = (b) => createHash("sha256").update(b).digest("hex");

/* ---------- 本體驗證：頁面 core 與伺服器 lib 同一套規則 ---------- */
const CASES = [
  ["合格", spec()],
  ["目標可空", spec("P1", { specs: { ...spec().specs, offx: { lsl: -50, usl: 50 } } })],
  ["版本錯", { ...spec(), schema: "x/1" }],
  ["缺料號", spec("  ")],
  ["缺項目", { ...spec(), specs: { volume: W(70, 100, 130) } }],
  ["LSL ≥ USL", spec("P1", { specs: { ...spec().specs, area: W(130, 100, 70) } })],
  ["字串數值", spec("P1", { specs: { ...spec().specs, area: { lsl: "70", tgt: 100, usl: 130 } } })],
  ["目標超出", spec("P1", { specs: { ...spec().specs, hpct: W(75, 140, 125) } })],
  ["群組不支援項目", spec("P1", { groups: { G: { height: W(1, 2, 3) } } })],
  ["群組名稱空白", spec("P1", { groups: { " ": { volume: W(80, 100, 120) } } })],
  ["空群組略過", spec("P1", { groups: { G: {} } })],
  ["HTML 字元清除", spec("<P1>", { note: "<b>x</b>" })],
  ["鋼板厚度超出範圍", spec("P1", { stencilRef: 9999 })],
  ["群組名稱含特殊字元", spec("P1", { groups: { "A&B": { volume: W(80, 100, 120) } } })],
  ["群組名稱前後空白", spec("P1", { groups: { " U2": { volume: W(80, 100, 120) } } })],
  ["群組名稱超過 64 字", spec("P1", { groups: { ["G".repeat(65)]: { volume: W(80, 100, 120) } } })],
];

test("規格檔驗證：頁面 partSpecCheck／partSpecCanon 與伺服器 lib 結果完全相同", () => {
  for (const [name, o] of CASES) {
    const a = partSpecCheck(o), b = core.partSpecCheck(JSON.parse(JSON.stringify(o)));
    assert.deepEqual(JSON.parse(JSON.stringify(b)), JSON.parse(JSON.stringify(a)), name);
    if (a.spec) assert.equal(core.partSpecCanon(b.spec), partSpecCanon(a.spec), name + "（標準化）");
  }
  assert.equal(partSpecCheck(spec()).spec.groups["U2 BGA"].volume.lsl, 80);
  assert.match(partSpecCheck(CASES[5][1]).error, /面積 的 LSL 必須小於 USL/);
  assert.match(partSpecCheck(CASES[6][1]).error, /必須是數字/);
  assert.deepEqual(partSpecCheck(CASES[10][1]).spec.groups, {});
  assert.equal(partSpecCheck(CASES[11][1]).spec.part, "P1");
  assert.equal(partSpecCheck(CASES[12][1]).spec.stencilRef, null);
  for (const i of [13, 14, 15]) assert.match(partSpecCheck(CASES[i][1]).error, /群組名稱/, CASES[i][0] + "：不改寫群組名稱，直接拒收");
});

test("標準化：鍵順序不同的同一份規格產生相同位元組與指紋；本體檢查擋下非標準化、料號不符與壞 JSON", () => {
  const flip = (v) => (v && typeof v === "object" ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, flip(v[k])])) : v);
  const o = spec(), rev = flip(o);
  assert.notEqual(JSON.stringify(rev), JSON.stringify(o));
  assert.equal(partSpecCanon(partSpecCheck(rev).spec), partSpecCanon(partSpecCheck(o).spec));
  const enc = core.partSpecEncode(o);
  assert.equal(Buffer.from(enc.bytes).toString(), body(o).toString(), "頁面產生的位元組與伺服器標準化相同");
  const meta = { part: o.part };
  assert.ok(checkSpecBody(body(o), meta).spec);
  assert.match(checkSpecBody(Buffer.from(JSON.stringify(o, null, 2)), meta).error, /標準化/);
  assert.match(checkSpecBody(body(o), { part: "OTHER" }).error, /料號/);
  assert.match(checkSpecBody(Buffer.from("{bad"), meta).error, /JSON/);
  assert.equal(core.partSpecBodyCheck(new Uint8Array(body(o)), meta).spec.part, o.part, "頁面版本體檢查");
  assert.match(core.partSpecBodyCheck(new Uint8Array(body(o)), { part: "OTHER" }).error, /料號/);
});

test("records 欄位：kind spec 只需料號；note／basedOn 清理；舊 Netlify 處理器拒收料號規格", async () => {
  const m = checkMeta({ kind: "spec", part: "P1", note: "<x>", basedOn: "bad", makeDefault: 1 }).meta;
  assert.deepEqual(m, { kind: "spec", part: "P1", name: "料號規格.json", note: "x", basedOn: "", makeDefault: true });
  assert.match(checkMeta({ kind: "spec", part: "" }).error, /料號/);
  assert.match(checkMeta({ kind: "other", part: "X" }).error, /類型/);
  const r = await handleRecords(new Request("https://x.test/api/records", { method: "POST", body: gzipSync(body(spec())), headers: { "x-spi-user": "a", "x-rec-meta": encodeURIComponent(JSON.stringify({ kind: "spec", part: "301-000100124" })) } }), {});
  assert.equal(r.status, 400);
});

/* ---------- D1（node:sqlite 模擬，套用正式 migrations） ---------- */
function makeD1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of ["0002_free_plan_schema.sql", "0003_v110.sql", "0005_record_catalog_enhancement.sql", "0006_placement_and_snapshot.sql", "0007_controlled_coordinate_import.sql"])
    sqlite.exec(readFileSync(new URL(`../cloudflare/migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (sql, params) => ({
    async first() { return sqlite.prepare(sql).get(...params) || null; },
    async all() { return { results: sqlite.prepare(sql).all(...params) }; },
    async run() { const i = sqlite.prepare(sql).run(...params); return { success: true, meta: { changes: i.changes } }; },
  });
  return {
    sqlite,
    prepare: (sql) => ({ bind: (...p) => stmt(sql, p) }),
    // D1 batch 為單一交易：任一句失敗全部撤回
    async batch(list) { sqlite.exec("BEGIN"); try { const out = []; for (const s of list) out.push(await s.run()); sqlite.exec("COMMIT"); return out; } catch (e) { sqlite.exec("ROLLBACK"); throw e; } },
  };
}
const r2 = () => { const m = new Map(); return { m, put: async (k, v) => m.set(k, v), get: async (k) => (m.has(k) ? { body: m.get(k) } : null), delete: async (k) => m.delete(k) }; };
let seq = 0;
const newId = () => ("id" + String(++seq).padStart(20, "0")).slice(0, 22);
const specRec = (o, extra = {}) => { const b = body(o); return { rec: { id: newId(), kind: "spec", part: o.part, name: "料號規格.json", note: o.note, basedOn: "", makeDefault: false, bytes: b.length, sha256: sha(b), user: "a@x.tw", created: Date.now() + seq, ...extra }, gz: gzipSync(b) }; };
const defaults = (db, part) => db.sqlite.prepare("SELECT id FROM records WHERE kind='spec' AND part=? AND json_extract(meta,'$.isDefault')=1").all(part).map((r) => r.id);
const audits = (db, action) => db.sqlite.prepare("SELECT * FROM audit_log WHERE action=? ORDER BY seq").all(action).map((r) => ({ ...r, detail: JSON.parse(r.detail) }));

test("D1：版本號依同料號遞增；設為預設與建立同一交易，同料號只有一個預設，稽核記錄 from／to", async () => {
  const db = makeD1(), repo = new Repo(db, r2());
  const a = specRec(spec(), { makeDefault: true });
  const r1 = await repo.createRecord(a.rec, a.gz);
  assert.equal(r1.record.ver, 1); assert.equal(r1.record.isDefault, true); assert.equal(r1.record.makeDefault, undefined);
  const b = specRec(spec(undefined, { note: "第二版" }), { makeDefault: true });
  const r2v = await repo.createRecord(b.rec, b.gz);
  assert.equal(r2v.record.ver, 2);
  assert.deepEqual(defaults(db, "301-000100124"), [b.rec.id], "舊預設已清除");
  const sw = audits(db, "set_default_spec");
  assert.equal(sw.length, 2);
  assert.deepEqual(sw[1].detail.from, [a.rec.id]); assert.equal(sw[1].detail.to, b.rec.id); assert.equal(sw[1].by, "a@x.tw");
  // 不設為預設的新版本：版本號照樣遞增，預設不變
  const c = specRec(spec(undefined, { note: "第三版" }));
  assert.equal((await repo.createRecord(c.rec, c.gz)).record.ver, 3);
  assert.deepEqual(defaults(db, "301-000100124"), [b.rec.id]);
  // 其他料號各自從 v1 開始
  const o = specRec(spec("P-OTHER"));
  assert.equal((await repo.createRecord(o.rec, o.gz)).record.ver, 1);
  // 列表：新到舊、meta 攤平、只含該料號
  const list = await repo.getSpecsForPart("301-000100124");
  assert.deepEqual(list.map((x) => x.ver), [3, 2, 1]);
  assert.deepEqual(list.map((x) => x.isDefault), [false, true, false]);
  assert.equal(list[1].note, "第二版");
  assert.deepEqual(Object.keys(list[0]).sort(), ["basedOn", "bytes", "created", "id", "isDefault", "kind", "name", "note", "part", "sha256", "user", "ver"]);
});

test("D1：相同內容同料號回 409 並指出既有版本；刪除最新版後版本號接續現存最大值", async () => {
  const db = makeD1(), repo = new Repo(db, r2());
  const a = specRec(spec());
  await repo.createRecord(a.rec, a.gz);
  const dup = specRec(spec());
  const r = await repo.createRecord(dup.rec, dup.gz);
  assert.equal(r.status, 409); assert.equal(r.existing, a.rec.id);
  const b = specRec(spec(undefined, { note: "v2" }));
  await repo.createRecord(b.rec, b.gz);
  await repo.deleteRecord(b.rec.id, "a@x.tw");
  const c = specRec(spec(undefined, { note: "v3" }));
  assert.equal((await repo.createRecord(c.rec, c.gz)).record.ver, 2, "MAX(ver)+1：刪除最新版後重新編號為 2");
});

test("D1：任何登入者都能設為預設；已是預設時不重複寫稽核；座標檔代碼不可當料號規格", async () => {
  const db = makeD1(), repo = new Repo(db, r2());
  const a = specRec(spec(), { makeDefault: true }), b = specRec(spec(undefined, { note: "v2" }));
  await repo.createRecord(a.rec, a.gz); await repo.createRecord(b.rec, b.gz);
  const res = await repo.setDefaultSpec(b.rec.id, "other@x.tw");
  assert.equal(res.success, true); assert.deepEqual(res.from, [a.rec.id]);
  assert.deepEqual(defaults(db, "301-000100124"), [b.rec.id]);
  const n = audits(db, "set_default_spec").length;
  assert.equal((await repo.setDefaultSpec(b.rec.id, "other@x.tw")).unchanged, true);
  assert.equal(audits(db, "set_default_spec").length, n);
  assert.equal(audits(db, "set_default_spec").at(-1).by, "other@x.tw");
  const place = { id: newId(), kind: "place", part: "301-000100124", rev: "V1", name: "座標檔.csv", isDefault: true, bytes: 3, sha256: sha("abc"), user: "a@x.tw", created: 1 };
  await repo.createRecord(place, gzipSync("abc"));
  assert.equal((await repo.setDefaultSpec(place.id, "a@x.tw")).status, 404);
  assert.equal((await repo.setDefaultSpec("bad", "a@x.tw")).status, 400);
  assert.equal(JSON.parse(db.sqlite.prepare("SELECT meta FROM records WHERE id=?").get(place.id).meta).isDefault, true, "座標檔預設不受影響");
});

test("D1 並行：建立新版設預設與切換預設同時發生（都以同一份舊狀態讀取），執行後同料號仍恰好一個預設", async () => {
  const db = makeD1(), repo = new Repo(db, r2());
  const a = specRec(spec(), { makeDefault: true }), b = specRec(spec(undefined, { note: "v2" }));
  await repo.createRecord(a.rec, a.gz); await repo.createRecord(b.rec, b.gz);
  // 兩個請求都讀完舊預設後才放行各自的 batch（D1 依序執行 batch）
  const batch = db.batch.bind(db), waiting = [];
  db.batch = (list) => new Promise((ok, no) => { waiting.push(() => batch(list).then(ok, no)); if (waiting.length === 2) waiting.reduce((p, f) => p.then(f), Promise.resolve()); });
  const c = specRec(spec(undefined, { note: "v3" }), { makeDefault: true });
  await Promise.all([repo.createRecord(c.rec, c.gz), repo.setDefaultSpec(b.rec.id, "other@x.tw")]);
  const sw = audits(db, "set_default_spec").slice(-2);
  assert.deepEqual(sw[0].detail.from, [a.rec.id]);
  assert.deepEqual(sw[1].detail.from, [sw[0].detail.to], "from 於 batch 執行當下取得：記錄實際被取代的版本，而非請求前讀到的舊狀態");
  assert.equal(defaults(db, "301-000100124").length, 1, "清除在交易執行當下選取資料列，不會留下兩個預設");
  assert.deepEqual(defaults(db, "301-000100124"), [sw[1].detail.to], "後執行者（稽核順序在後）勝出");
});

test("D1：版本列表依版本號排序（建立時間相同也不錯序）；料號規格不可修改中繼資料", async () => {
  const db = makeD1(), repo = new Repo(db, r2());
  const a = specRec(spec(), { id: "zzzzzzzzzzzzzzzzzzzzzz", created: 5 }), b = specRec(spec(undefined, { note: "v2" }), { id: "aaaaaaaaaaaaaaaaaaaaaa", created: 5 });
  await repo.createRecord(a.rec, a.gz); await repo.createRecord(b.rec, b.gz);
  assert.deepEqual((await repo.getSpecsForPart("301-000100124")).map((x) => [x.ver, x.id]), [[2, b.rec.id], [1, a.rec.id]]);
  const r = await repo.updateRecordMeta(a.rec.id, { note: "改備註" }, "a@x.tw");
  assert.equal(r.status, 400); assert.match(r.error, /不能修改/);
});

/* ---------- Worker 路由（含登入） ---------- */
test("Worker：POST 料號規格由伺服器驗證本體與指紋；specs_for 列出版本；PATCH set_default_spec 切換預設", async () => {
  const AUTH = { AUTH_USERS: JSON.stringify({ "local@example.com": "pepper-hmac-sha256$600000$" + "0".repeat(64) }), AUTH_PEPPER: "p".repeat(40), AUTH_SECRET: "s".repeat(40), AUTH_KDF_ITER: "600000" };
  const db = makeD1(), env = { ...AUTH, DB: db, BLOBS: r2(), ASSETS: { fetch: async () => new Response("") } };
  const cookie = `${COOKIE}=${await issueToken(env, "local@example.com")}`;
  const U = "https://spi.example.test/api/records";
  const post = (b, meta, shaHdr = sha(b)) => handleRequest(new Request(U, { method: "POST", body: gzipSync(b), headers: { cookie, origin: "https://spi.example.test", "content-type": "application/gzip", "x-raw-bytes": String(b.length), "x-raw-sha256": shaHdr, "x-rec-meta": encodeURIComponent(JSON.stringify(meta)) } }), env);
  const meta = { kind: "spec", part: "301-000100124", makeDefault: true };
  const ok = await post(body(spec()), meta);
  assert.equal(ok.status, 201, await ok.clone().text());
  const v1 = (await ok.json()).record;
  assert.equal(v1.ver, 1); assert.equal(v1.isDefault, true); assert.equal(v1.user, "local@example.com");
  assert.equal((await post(Buffer.from(JSON.stringify(spec(), null, 1)), meta)).status, 400, "非標準化");
  assert.equal((await post(body(spec("OTHER")), meta)).status, 400, "料號不符");
  assert.equal((await post(body(spec(undefined, { note: "v2" })), meta, "0".repeat(64))).status, 400, "指紋不符");
  const bad = spec(); bad.specs.volume = W(130, 100, 70);
  assert.match((await (await post(Buffer.from(JSON.stringify(bad)), meta)).json()).error, /LSL 必須小於 USL/);
  const v2 = (await (await post(body(spec(undefined, { note: "v2" })), { ...meta, makeDefault: false, note: "標頭的另一種說法" })).json()).record;
  assert.equal(v2.note, "v2", "索引的備註取自已驗證的規格檔本體，不採用標頭");
  const list = await (await handleRequest(new Request(U + "?specs_for=301-000100124", { headers: { cookie } }), env)).json();
  assert.deepEqual(list.specs.map((x) => [x.ver, x.isDefault]), [[2, false], [1, true]]);
  const sw = await handleRequest(new Request(U, { method: "PATCH", body: JSON.stringify({ action: "set_default_spec", id: v2.id }), headers: { cookie, origin: "https://spi.example.test", "content-type": "application/json" } }), env);
  assert.equal(sw.status, 200, await sw.clone().text());
  assert.deepEqual(defaults(db, "301-000100124"), [v2.id]);
  // 量測紀錄列表（預設 kind=spi）不會混入料號規格
  assert.equal((await (await handleRequest(new Request(U, { headers: { cookie } }), env)).json()).records.length, 0);
});

/* ---------- 本機模式（IndexedDB）與雲端行為對等 ---------- */
/* 本機模式頁面（IndexedDB 以 withIdb 模擬）；run 在頁面內執行並把結果轉成本 realm 的普通物件 */
async function localPage() {
  const html = readFileSync(HTML, "utf8").replace(/<script src=[^>]+><\/script>/g, ""), errs = [];
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://example.test/", beforeParse(w) {
    w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === "measureText" ? () => ({ width: 1 }) : t[k] ?? (() => {})), set: (t, k, v) => ((t[k] = v), true) });
    Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { let e = this; while (e) { if (e.hidden) return null; e = e.parentElement; } return w.document.body; } });
    w.Element.prototype.scrollIntoView = () => {}; w.matchMedia = () => ({ matches: false, addEventListener() {} }); w.ResizeObserver = class { observe() {} }; w.scrollTo = () => {};
    w.Chart = class { constructor() {} destroy() {} static register() {} };
    Object.assign(w, { Response, DecompressionStream });
    withIdb(w);
    w.SPI_TEST_HOOK = {};
    w.addEventListener("error", (e) => errs.push(e.message));
  } });
  const w = dom.window;
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(errs, [], "頁面載入無錯誤");
  w.__spec = (o) => w.partSpecEncode(o).bytes;
  w.__s1 = spec(); w.__s2 = spec(undefined, { note: "v2" }); w.__s3 = spec(undefined, { note: "v3" });
  // 結果轉成本 realm 的普通物件，避免跨 realm 陣列在嚴格比較時原型不同
  const run = (js) => w.eval(`(async()=>{${js}})()`).then((v) => JSON.parse(JSON.stringify(v ?? null)));
  return { w, errs, run };
}

test("本機模式：歷史料號規格可讀，正式新增與預設切換被拒絕且不產生稽核", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { errs, run } = await localPage();
  const historical = await run(`return SPI_TEST_HOOK.LocalRec.create({kind:"spec",part:"301-000100124",makeDefault:true},__spec(__s1),"historical@example.test")`);
  assert.equal(historical.ver, 1);
  assert.deepEqual((await run(`return SPI_TEST_HOOK.RecDB.specsFor("301-000100124")`)).map(x => [x.ver, x.isDefault]), [[1, true]]);
  const before = await run(`return SPI_TEST_HOOK.RecDB.audit()`);
  await assert.rejects(run(`return SPI_TEST_HOOK.RecDB.create({kind:"spec",part:"301-000100124",makeDefault:true},__spec(__s2))`), /正式新紀錄必須登入/);
  await assert.rejects(run(`return SPI_TEST_HOOK.RecDB.setDefaultSpec(${JSON.stringify(historical.id)})`), /本機舊資料僅供查閱/);
  await assert.rejects(run(`return SPI_TEST_HOOK.RecDB.updateMeta(${JSON.stringify(historical.id)},{note:"x"})`), /本機舊資料僅供查閱/);
  assert.equal((await run(`return SPI_TEST_HOOK.RecDB.specsFor("301-000100124")`)).length, 1);
  assert.deepEqual(await run(`return SPI_TEST_HOOK.RecDB.audit()`), before, '拒絕操作不新增稽核或修改舊資料');
  assert.deepEqual(errs, []);
});

/* ---------- 座標檔預設版：同料號同面別只留一個預設，切換稽核記錄 from／to（雲端與本機相同） ---------- */
const placeRec = (extra = {}) => { const id = newId(); return { id, kind: "place", part: "P-PL", rev: "V1", side: "TOP", name: "座標檔.csv", isDefault: false, bytes: 3, sha256: sha(id), user: "a@x.tw", created: Date.now() + seq, ...extra }; };
const placeDefaults = (db, part) => db.sqlite.prepare("SELECT id FROM records WHERE kind='place' AND part=? AND json_extract(meta,'$.isDefault')=1").all(part).map((r) => r.id).sort();

test("D1：座標檔上傳勾選預設與切換預設都在同一交易內清除同範圍舊預設，稽核記錄 from／to；已是預設時不重複寫稽核", async () => {
  const db = makeD1(), repo = new Repo(db, r2());
  const a = placeRec({ isDefault: true }), b = placeRec({ rev: "V2", isDefault: true }), c = placeRec({ rev: "V1", side: "BOT", isDefault: true });
  for (const r of [a, b, c]) await repo.createRecord(r, gzipSync("abc"));
  assert.deepEqual(placeDefaults(db, "P-PL"), [b.id, c.id].sort(), "TOP 只留後上傳的 V2；BOT 不受影響");
  let sw = audits(db, "set_default_place");
  assert.equal(sw.length, 3);
  assert.deepEqual(sw[1].detail.from, [a.id]); assert.equal(sw[1].detail.to, b.id);
  assert.equal(sw[1].detail.kind, "place"); assert.equal(sw[1].detail.name, "座標檔.csv"); assert.equal(sw[1].detail.side, "TOP");
  assert.deepEqual(sw[2].detail.from, [], "BOT 原本沒有預設");
  // 不分面別的座標檔設為預設：兩面的預設都被取代
  const d = placeRec({ rev: "V3", side: "" });
  await repo.createRecord(d, gzipSync("abc"));
  const res = await repo.setDefaultPlacement(d.id, "other@x.tw");
  assert.deepEqual([...res.from].sort(), [b.id, c.id].sort());
  assert.deepEqual(placeDefaults(db, "P-PL"), [d.id]);
  // 切回 TOP 的 V1：取代不分面別的 V3
  assert.deepEqual((await repo.setDefaultPlacement(a.id, "a@x.tw")).from, [d.id]);
  const n = audits(db, "set_default_place").length;
  assert.equal((await repo.setDefaultPlacement(a.id, "a@x.tw")).unchanged, true);
  assert.equal(audits(db, "set_default_place").length, n, "已是唯一預設：不再寫稽核");
  // 稽核 API 帶出 kind／from／to 給稽核頁
  const top = (await repo.listAuditLog())[0];
  assert.equal(top.action, "set_default_place"); assert.equal(top.kind, "place"); assert.deepEqual(top.from, [d.id]); assert.equal(top.to, a.id);
  assert.equal((await repo.setDefaultPlacement(newId(), "a@x.tw")).status, 404);
});

test("本機模式：舊座標檔仍可查閱，正式新增與預設切換被拒絕且不改舊資料", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { errs, run } = await localPage();
  const historical = await run(`return SPI_TEST_HOOK.LocalRec.create({kind:"place",part:"P-PL",rev:"V1",side:"TOP",name:"座標檔.csv",unit:"mm",isDefault:true},new TextEncoder().encode("RefDes,X,Y,Layer\\nU1,1,2,TOP\\n"),"historical@example.test")`);
  assert.equal(historical.rev, 'V1');
  const before = await run(`return SPI_TEST_HOOK.RecDB.audit()`);
  await assert.rejects(run(`return SPI_TEST_HOOK.RecDB.create({kind:"place",part:"P-PL",rev:"V2",side:"TOP",unit:"mm",name:"新版.csv"},new TextEncoder().encode("RefDes,X,Y,Layer\\nU1,3,4,TOP\\n"))`), /正式新紀錄必須登入/);
  await assert.rejects(run(`return SPI_TEST_HOOK.RecDB.setDefaultPlace(${JSON.stringify(historical.id)})`), /本機舊資料僅供查閱/);
  assert.deepEqual((await run(`return SPI_TEST_HOOK.RecDB.list()`)).filter(r => r.kind === 'place').map(r => [r.id, r.rev, r.isDefault]), [[historical.id, 'V1', true]]);
  assert.deepEqual(await run(`return SPI_TEST_HOOK.RecDB.audit()`), before);
  assert.deepEqual(errs, []);
});
