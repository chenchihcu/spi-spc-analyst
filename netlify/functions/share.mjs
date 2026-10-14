// 分享連結：把目前的試產回合（已在瀏覽器壓縮成 gzip）存到 Netlify Blobs，回傳一組短代碼。
//   POST /api/share        本文＝gzip 位元組，回傳 { id, expires }
//   GET  /api/share?id=…   取回 gzip 位元組（過期即刪除並回 410）
// 整個網站（含本函式）都在登入保護之後，只有已登入的人能建立或開啟分享連結。
import { getStore } from "@netlify/blobs";

export const MAX_BYTES = 4 * 1024 * 1024; // 二進位本文經 Base64 編碼後，函式實際上限約 4.5 MB，留餘裕
export const TTL_DAYS = 30;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;

const json = (obj, status = 200) => Response.json(obj, { status, headers: { "Cache-Control": "no-store" } });

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 與執行環境無關的處理邏輯；store 可注入（測試用記憶體版本） */
export async function handleShare(req, store, now = Date.now()) {
  const url = new URL(req.url);
  const user = req.headers.get("x-spi-user") || "";

  if (req.method === "GET") {
    const id = url.searchParams.get("id") || "";
    if (!ID_RE.test(id)) return json({ error: "分享代碼格式不正確" }, 400);
    const hit = await store.getWithMetadata(id, { type: "arrayBuffer" });
    if (!hit) return json({ error: "找不到這個分享連結（可能已被刪除）" }, 404);
    if (!(hit.metadata?.exp > now)) {
      await store.delete(id);
      return json({ error: `這個分享連結已超過 ${TTL_DAYS} 天，已失效` }, 410);
    }
    return new Response(hit.data, { headers: { "Content-Type": "application/gzip", "Cache-Control": "no-store", "X-Share-Expires": String(hit.metadata.exp) } });
  }

  if (req.method !== "POST") return json({ error: "只接受 GET 或 POST" }, 405);
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) return json({ error: "不接受其他網站的請求" }, 403);

  const len = +req.headers.get("content-length") || 0;
  if (len > MAX_BYTES) return json({ error: `資料太大（${(len / 1048576).toFixed(1)} MB），分享上限 4 MB` }, 413);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > MAX_BYTES) return json({ error: "資料太大，分享上限 4 MB" }, 413);
  if (buf.length < 20 || buf[0] !== 0x1f || buf[1] !== 0x8b) return json({ error: "資料格式不正確（需為 gzip 壓縮）" }, 400);

  const id = newId(), exp = now + TTL_DAYS * 86400_000;
  await store.set(id, buf, { metadata: { created: now, exp, user, bytes: buf.length } });
  console.log(`share created id=${id.slice(0, 6)}… bytes=${buf.length} user=${user || "-"}`);
  return json({ id, expires: exp }, 201);
}

export default async (req) => handleShare(req, getStore({ name: "spi-share", consistency: "strong" }));

export const config = { path: "/api/share" };
