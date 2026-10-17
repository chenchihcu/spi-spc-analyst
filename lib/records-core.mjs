// 量測紀錄與座標檔資料庫：上傳、查詢、下載、刪除（沒有修改功能，原始檔存入後不可變更）
//   GET    /api/records            → { records, me }          全部紀錄的索引（新到舊）
//   GET    /api/records?id=…       → 原始檔（gzip 壓縮）       標頭 X-Rec-Sha256 為原始檔的 SHA-256
//   GET    /api/records?audit=1    → { entries }               稽核紀錄（新增、刪除，新到舊，最多 500 筆）
//   GET    /api/records?id=…&raw=1 → 原始檔（未壓縮；給不支援解壓縮的瀏覽器）
//   POST   /api/records            本文＝原始檔 gzip（不支援壓縮的瀏覽器可直接送原始檔）；標頭 X-Rec-Meta＝encodeURIComponent(JSON 欄位)
//   DELETE /api/records?id=…       只有上傳者本人可刪除；檔案移除，稽核紀錄保留
// 儲存結構（Netlify Blobs）：f/<id> 原始檔 gzip；index.json 全部紀錄的欄位（條件寫入，避免同時上傳互相覆蓋）；log/<時間>-<亂數> 稽核紀錄
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash, randomBytes } from "node:crypto";

export const MAX_GZ = 4 * 1024 * 1024;        // 上傳本文（gzip）上限；函式本文上限約 4.5 MB
export const MAX_RAW = 100 * 1024 * 1024;     // 解壓後上限，防止惡意壓縮檔
export const AUDIT_MAX = 500;
export const MAX_RAW_DL = 5 * 1024 * 1024;  // 未壓縮下載上限：Netlify 函式回應上限約 6 MB
export const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const json = (obj, status = 200) => Response.json(obj, { status, headers: { "Cache-Control": "no-store" } });
const newId = () => randomBytes(16).toString("base64url");
/* 文字欄位只保留可見文字：去除 HTML 特殊字元與控制字元 */
export const clean = (v, max) => String(v ?? "").replace(/[<>"'`&\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
export const int = (v) => (Number.isFinite(+v) && +v >= 0 ? Math.floor(+v) : 0);

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
    meta.supplierWo = clean(m.supplierWo, 64);
    meta.outsourceWo = clean(m.outsourceWo, 64);
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
  const key = `log/${String(now).padStart(15, "0")}-${randomBytes(4).toString("hex")}`;
  await store.setJSON(key, entry);
  return key;
}
/* 重複判定：內容相同且回溯欄位全部相同（量測紀錄含面別、加工廠格式、使用的座標檔），任一不同就另存一筆 */
/* 稽核紀錄在動作前先寫入，動作成功後在同一筆標上 done（以每筆實際結果為準）；
   沒有 done 標記時（標記寫入失敗等）才以資料庫現況推定：刪除＝該筆已不在且為同一筆最新的刪除；新增＝該筆仍在或之後有完成的刪除 */
export function auditStatus(entries, list) {
  const live = new Set(list.map((r) => r.id)), lastDel = new Map(), delDone = new Set(), marked = new Set();
  for (const e of entries) if (e.action === "delete" && e.done) { delDone.add(e); marked.add(e.id); }
  for (const e of entries) if (e.action === "delete" && !lastDel.has(e.id)) lastDel.set(e.id, e); // entries 為新到舊
  for (const [id, e] of lastDel) if (!live.has(id) && !marked.has(id)) delDone.add(e);
  return entries.map((e) => ({ ...e, ok: e.action === "delete" ? delDone.has(e) : !!e.done || live.has(e.id) || [...delDone].some((d) => d.id === e.id) }));
}
/* 動作成功後在稽核紀錄標上 done；失敗時再試（共 3 次），仍失敗才改以現況推定 */
async function markDone(store, key, entry) { for (let i = 0; i < 3; i++) { try { await store.setJSON(key, { ...entry, done: true }); return; } catch { /* 再試 */ } } }
/* 撤回用：失敗時再試，盡力而為（撤回不成功時，稽核頁仍會依現況標成未完成） */
async function tryDelete(store, key) { for (let i = 0; i < 3; i++) { try { await store.delete(key); return; } catch { /* 再試 */ } } }
export const sameFile = (a, b) => a.kind === b.kind && a.sha256 === b.sha256 && a.part === b.part &&
  (a.kind === "spi" ? a.lot === b.lot && (a.side || "") === (b.side || "") && (a.vendor || "") === (b.vendor || "") && (a.supplierWo || "") === (b.supplierWo || "") && (a.outsourceWo || "") === (b.outsourceWo || "") && (a.placeId || "") === (b.placeId || "") : a.rev === b.rev);

export function entC(rec, user, now = Date.now()) {
  return { action: "create", at: now, by: user, id: rec.id, kind: rec.kind, lot: rec.lot || "", part: rec.part, rev: rec.rev || "", supplierWo: rec.supplierWo || "", outsourceWo: rec.outsourceWo || "", name: rec.name, sha256: rec.sha256, bytes: rec.bytes || 0 };
}

export function entD(r0, user, now = Date.now()) {
  return { action: "delete", at: now, by: user, id: r0.id, kind: r0.kind, lot: r0.lot || "", part: r0.part, rev: r0.rev || "", supplierWo: r0.supplierWo || "", outsourceWo: r0.outsourceWo || "", name: r0.name, sha256: r0.sha256, bytes: r0.bytes || 0, uploaded: r0.created || r0.uploaded || 0 };
}

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
      const raw = url.searchParams.get("raw") === "1";
      if (raw && rec.bytes > MAX_RAW_DL) return json({ error: `原始檔 ${(rec.bytes / 1048576).toFixed(1)} MB，超過舊版瀏覽器可直接取回的上限 5 MB；請改用新版 Chrome、Edge、Firefox 或 Safari` }, 413);
      return new Response(raw ? gunzipSync(new Uint8Array(hit.data), { maxOutputLength: MAX_RAW }) : hit.data, { headers: { "Content-Type": raw ? "application/octet-stream" : "application/gzip", "Cache-Control": "no-store", "X-Rec-Sha256": rec.sha256 } });
    }
    if (url.searchParams.get("audit")) {
      const { blobs } = await store.list({ prefix: "log/" });
      const keys = blobs.map((b) => b.key).sort().reverse().slice(0, AUDIT_MAX), entries = [];
      for (let i = 0; i < keys.length; i += 25) entries.push(...(await Promise.all(keys.slice(i, i + 25).map((k) => store.get(k, { type: "json" })))).filter(Boolean));
      return json({ entries: auditStatus(entries, (await readIndex(store)).list) });
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
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.length > MAX_GZ) return json({ error: "檔案壓縮後超過上限 4 MB" }, 413);
    // 一般瀏覽器送 gzip；不支援壓縮的瀏覽器直接送原始檔（同樣受 4 MB 上限），由這裡壓縮後存檔
    const isGz = body.length >= 20 && body[0] === 0x1f && body[1] === 0x8b && req.headers.get("content-type") !== "application/octet-stream";
    let raw, gz;
    if (isGz) { try { raw = gunzipSync(body, { maxOutputLength: MAX_RAW }); } catch { return json({ error: "檔案解壓失敗或解壓後超過 100 MB" }, 400); } gz = body; }
    else { raw = body; gz = gzipSync(body); }
    if (!raw.length) return json({ error: "檔案是空的" }, 400);
    const rec = { id: newId(), ...chk.meta, bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex"), user, created: now };
    // 先檢查重複，再存檔，最後寫索引（寫索引時再檢查一次，避免同時上傳同一檔）
    const { list } = await readIndex(store);
    const dup = list.find((r) => sameFile(r, rec));
    if (dup) return json({ error: "這個檔案已經存過（相同內容與相同回溯欄位）", existing: dup.id }, 409);
    const w = await store.set(`f/${rec.id}`, gz, { onlyIfNew: true, metadata: { sha256: rec.sha256 } });
    if (w?.modified === false) return json({ error: "紀錄代碼衝突，請重試" }, 503);
    // 稽核紀錄先寫，再加入索引；加入失敗時撤回稽核紀錄與檔案（不會有沒有稽核紀錄的資料）
    let logKey;
    const entryC = entC(rec, user, now);
    try { logKey = await audit(store, entryC, now); }
    catch (e) { try { await store.delete(`f/${rec.id}`); } catch { /* 忽略 */ } return json({ error: "資料庫暫時無法寫入，請稍後再試" }, 503); }
    let res;
    try { res = await updateIndex(store, (l) => { const d = l.find((r) => sameFile(r, rec)); return d ? { error: "這個檔案已經存過（相同內容與相同回溯欄位）", status: 409, existing: d.id } : { list: [...l, rec] }; }); }
    catch (e) { res = { error: "資料庫暫時無法寫入，請稍後再試", status: 503 }; }
    if (res.error) { await tryDelete(store, logKey); await tryDelete(store, `f/${rec.id}`); return json(res.existing ? { error: res.error, existing: res.existing } : { error: res.error }, res.status || 503); }
    await markDone(store, logKey, entryC);
    console.log(`record created kind=${rec.kind} id=${rec.id.slice(0, 6)}… bytes=${rec.bytes} user=${user}`);
    return json({ record: rec }, 201);
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id") || "";
    if (!ID_RE.test(id)) return json({ error: "紀錄代碼格式不正確" }, 400);
    // 先寫稽核紀錄再移除：稽核寫入失敗時紀錄仍在、可重試；移除失敗時撤回剛寫的稽核紀錄
    const { list } = await readIndex(store), r0 = list.find((x) => x.id === id);
    if (!r0) return json({ error: "找不到這筆紀錄（可能已被刪除）" }, 404);
    if (r0.user !== user) return json({ error: `只有上傳者（${r0.user}）可以刪除這筆紀錄` }, 403);
    let logKey;
    const entryD = entD(r0, user, now);
    try { logKey = await audit(store, entryD, now); }
    catch (e) { return json({ error: "資料庫暫時無法寫入，請稍後再試（紀錄未刪除）" }, 503); }
    let res;
    try {
      res = await updateIndex(store, (l) => {
        const r = l.find((x) => x.id === id);
        if (!r) return { error: "找不到這筆紀錄（可能已被刪除）", status: 404 };
        if (r.user !== user) return { error: `只有上傳者（${r.user}）可以刪除這筆紀錄`, status: 403 };
        return { list: l.filter((x) => x.id !== id) };
      });
    } catch (e) { res = { error: "資料庫暫時無法寫入，請稍後再試", status: 503 }; }
    if (res.error) { await tryDelete(store, logKey); return json({ error: res.error }, res.status || 503); }
    await markDone(store, logKey, entryD);
    try { await store.delete(`f/${id}`); } catch { /* 索引已移除，檔案無法再被取用；殘留檔不影響回溯 */ }
    console.log(`record deleted id=${id.slice(0, 6)}… user=${user}`);
    return json({ deleted: id });
  }

  return json({ error: "原始量測紀錄與座標檔不能修改；只能新增或刪除" }, 405);
}
