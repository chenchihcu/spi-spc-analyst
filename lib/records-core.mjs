// 量測紀錄與座標檔資料庫：上傳、查詢、下載、刪除（沒有修改功能，原始檔存入後不可變更）
//   GET    /api/records            → { records, me }          全部紀錄的索引（新到舊）
//   GET    /api/records?id=…       → 原始檔（gzip 壓縮）       標頭 X-Rec-Sha256 為原始檔的 SHA-256
//   GET    /api/records?audit=1    → { entries }               稽核紀錄（新增、刪除，新到舊，最多 500 筆）
//   POST   /api/records            本文＝原始檔 gzip；標頭 X-Rec-Meta＝encodeURIComponent(JSON 欄位)
//   DELETE /api/records?id=…       只有上傳者本人可刪除；檔案移除，稽核紀錄保留
// 儲存結構（Netlify Blobs）：f/<id> 原始檔 gzip；index.json 全部紀錄的欄位（條件寫入，避免同時上傳互相覆蓋）；log/<時間>-<亂數> 稽核紀錄
import { gunzipSync } from "node:zlib";
import { createHash, randomBytes } from "node:crypto";

export const MAX_GZ = 4 * 1024 * 1024;        // 上傳本文（gzip）上限；函式本文上限約 4.5 MB
export const MAX_RAW = 100 * 1024 * 1024;     // 解壓後上限，防止惡意壓縮檔
export const AUDIT_MAX = 500;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const json = (obj, status = 200) => Response.json(obj, { status, headers: { "Cache-Control": "no-store" } });
const newId = () => randomBytes(16).toString("base64url");
/* 文字欄位只保留可見文字：去除 HTML 特殊字元與控制字元 */
const clean = (v, max) => String(v ?? "").replace(/[<>"'`&\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
const int = (v) => (Number.isFinite(+v) && +v >= 0 ? Math.floor(+v) : 0);

/** 驗證並整理上傳欄位；回傳 { meta } 或 { error } */
export function checkMeta(m) {
  if (!m || typeof m !== "object") return { error: "缺少紀錄欄位" };
  const kind = m.kind === "spi" || m.kind === "place" ? m.kind : null;
  if (!kind) return { error: "紀錄類型必須是量測紀錄或座標檔" };
  const meta = { kind, part: clean(m.part, 64), name: clean(m.name, 200) || (kind === "spi" ? "量測紀錄.csv" : "座標檔.csv") };
  if (!meta.part) return { error: "請填寫產品料號" };
  if (kind === "spi") {
    meta.lot = clean(m.lot, 64);
    if (!meta.lot) return { error: "請填寫批號" };
    meta.side = m.side === "TOP" || m.side === "BOT" ? m.side : "";
    meta.vendor = clean(m.vendor, 32);
    meta.rows = int(m.rows); meta.boards = int(m.boards); meta.pads = int(m.pads);
    meta.placeId = ID_RE.test(m.placeId || "") ? m.placeId : "";
  } else {
    meta.rev = clean(m.rev, 32);
    if (!meta.rev) return { error: "請填寫座標檔版本" };
    meta.comps = int(m.comps);
  }
  return { meta };
}

/* 讀取索引 */
async function readIndex(store) {
  const hit = await store.getWithMetadata("index.json", { type: "json" });
  return { list: Array.isArray(hit?.data) ? hit.data : [], etag: hit?.etag };
}
/* 以條件寫入更新索引；別人同時寫入時重讀再試（最多 8 次） */
async function updateIndex(store, fn) {
  for (let i = 0; i < 8; i++) {
    const { list, etag } = await readIndex(store);
    const next = fn(list);
    if (next.error) return next;
    const res = await store.setJSON("index.json", next.list, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
    if (res?.modified !== false) return next;
  }
  return { error: "資料庫忙碌中，請稍後再試", status: 503 };
}
async function audit(store, entry, now) {
  await store.setJSON(`log/${String(now).padStart(15, "0")}-${randomBytes(4).toString("hex")}`, entry);
}
const sameFile = (a, b) => a.kind === b.kind && a.sha256 === b.sha256 && a.part === b.part && (a.kind === "spi" ? a.lot === b.lot : a.rev === b.rev);

/** 與執行環境無關的處理邏輯；store 可注入（測試用記憶體版本） */
export async function handleRecords(req, store, now = Date.now()) {
  const url = new URL(req.url);
  const user = req.headers.get("x-spi-user") || "";
  if (!user) return json({ error: "需要登入" }, 401);
  const origin = req.headers.get("origin");
  if (req.method !== "GET" && origin && origin !== url.origin) return json({ error: "不接受其他網站的請求" }, 403);

  if (req.method === "GET") {
    const id = url.searchParams.get("id");
    if (id != null) {
      if (!ID_RE.test(id)) return json({ error: "紀錄代碼格式不正確" }, 400);
      const { list } = await readIndex(store);
      const rec = list.find((r) => r.id === id);
      const hit = rec && (await store.getWithMetadata(`f/${id}`, { type: "arrayBuffer" }));
      if (!rec || !hit) return json({ error: "找不到這筆紀錄（可能已被刪除）" }, 404);
      return new Response(hit.data, { headers: { "Content-Type": "application/gzip", "Cache-Control": "no-store", "X-Rec-Sha256": rec.sha256 } });
    }
    if (url.searchParams.get("audit")) {
      const { blobs } = await store.list({ prefix: "log/" });
      const keys = blobs.map((b) => b.key).sort().reverse().slice(0, AUDIT_MAX), entries = [];
      for (let i = 0; i < keys.length; i += 25) entries.push(...(await Promise.all(keys.slice(i, i + 25).map((k) => store.get(k, { type: "json" })))).filter(Boolean));
      return json({ entries });
    }
    const { list } = await readIndex(store);
    return json({ records: list.slice().sort((a, b) => b.created - a.created), me: user });
  }

  if (req.method === "POST") {
    let m;
    try { m = JSON.parse(decodeURIComponent(req.headers.get("x-rec-meta") || "")); } catch { return json({ error: "紀錄欄位格式不正確" }, 400); }
    const chk = checkMeta(m);
    if (chk.error) return json({ error: chk.error }, 400);
    const len = +req.headers.get("content-length") || 0;
    if (len > MAX_GZ) return json({ error: `檔案壓縮後 ${(len / 1048576).toFixed(1)} MB，超過上限 4 MB` }, 413);
    const gz = new Uint8Array(await req.arrayBuffer());
    if (gz.length > MAX_GZ) return json({ error: "檔案壓縮後超過上限 4 MB" }, 413);
    if (gz.length < 20 || gz[0] !== 0x1f || gz[1] !== 0x8b) return json({ error: "資料格式不正確（需為 gzip 壓縮）" }, 400);
    let raw;
    try { raw = gunzipSync(gz, { maxOutputLength: MAX_RAW }); } catch { return json({ error: "檔案解壓失敗或解壓後超過 100 MB" }, 400); }
    if (!raw.length) return json({ error: "檔案是空的" }, 400);
    const rec = { id: newId(), ...chk.meta, bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex"), user, created: now };
    // 先檢查重複，再存檔，最後寫索引（寫索引時再檢查一次，避免同時上傳同一檔）
    const { list } = await readIndex(store);
    const dup = list.find((r) => sameFile(r, rec));
    if (dup) return json({ error: "這個檔案已經存過（相同內容與相同批號／料號）", existing: dup.id }, 409);
    const w = await store.set(`f/${rec.id}`, gz, { onlyIfNew: true, metadata: { sha256: rec.sha256 } });
    if (w?.modified === false) return json({ error: "紀錄代碼衝突，請重試" }, 503);
    const res = await updateIndex(store, (l) => (l.find((r) => sameFile(r, rec)) ? { error: "這個檔案已經存過（相同內容與相同批號／料號）", status: 409 } : { list: [...l, rec] }));
    if (res.error) { await store.delete(`f/${rec.id}`); return json({ error: res.error }, res.status || 503); }
    await audit(store, { action: "create", at: now, by: user, id: rec.id, kind: rec.kind, lot: rec.lot || "", part: rec.part, rev: rec.rev || "", name: rec.name, sha256: rec.sha256, bytes: rec.bytes }, now);
    console.log(`record created kind=${rec.kind} id=${rec.id.slice(0, 6)}… bytes=${rec.bytes} user=${user}`);
    return json({ record: rec }, 201);
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id") || "";
    if (!ID_RE.test(id)) return json({ error: "紀錄代碼格式不正確" }, 400);
    let gone = null;
    const res = await updateIndex(store, (l) => {
      const r = l.find((x) => x.id === id);
      if (!r) return { error: "找不到這筆紀錄（可能已被刪除）", status: 404 };
      if (r.user !== user) return { error: `只有上傳者（${r.user}）可以刪除這筆紀錄`, status: 403 };
      gone = r;
      return { list: l.filter((x) => x.id !== id) };
    });
    if (res.error) return json({ error: res.error }, res.status || 503);
    await store.delete(`f/${id}`);
    await audit(store, { action: "delete", at: now, by: user, id, kind: gone.kind, lot: gone.lot || "", part: gone.part, rev: gone.rev || "", name: gone.name, sha256: gone.sha256, bytes: gone.bytes, uploaded: gone.created }, now);
    console.log(`record deleted id=${id.slice(0, 6)}… user=${user}`);
    return json({ deleted: id });
  }

  return json({ error: "原始量測紀錄與座標檔不能修改；只能新增或刪除" }, 405);
}
