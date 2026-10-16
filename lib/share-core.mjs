// lib/share-core.mjs: 分享 API 核心邏輯 (D1 shares + R2)
// 實作規範：A-6, D-04, 9.1
import { randomBytes } from "node:crypto";

const json = (obj, status = 200) => Response.json(obj, { status, headers: { "Cache-Control": "no-store" } });

export async function handleShare(req, repo, user, env = {}) {
  const url = new URL(req.url);

  if (req.method === "GET") {
    if (url.searchParams.get("mine") === "1") {
      const shares = await repo.listShares({ user, all: false, limit: 50 });
      return json({ shares });
    }
    if (url.searchParams.get("all") === "1") {
      const adminList = (env.ADMIN_USERS || "").split(",").map((x) => x.trim().toLowerCase());
      if (!adminList.includes(user.toLowerCase())) return json({ error: "需要管理員權限" }, 403);
      const shares = await repo.listShares({ all: true, limit: 100 });
      return json({ shares });
    }

    const id = url.searchParams.get("id") || "";
    const share = await repo.getShare(id);
    if (!share) return json({ error: "找不到這個分享連結（可能已被刪除）" }, 404);
    if (share.revoked_at || share.exp < Date.now()) {
      return json({ error: "找不到這個分享連結（已被撤銷或已過期）" }, 404);
    }
    const file = await repo.getShareFile(id);
    if (!file) return json({ error: "分享資料不存在" }, 404);
    return new Response(file.body, {
      headers: {
        "Content-Type": "application/gzip",
        "Cache-Control": "no-store",
        "X-Share-Expires": String(share.exp),
      },
    });
  }

  if (req.method === "POST") {
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) return json({ error: "不接受其他網站的請求" }, 403);
    const len = +req.headers.get("content-length") || 0;
    if (len > 4 * 1024 * 1024) return json({ error: "分享資料超過上限 4 MB" }, 413);
    const buf = new Uint8Array(await req.arrayBuffer());
    if (buf.length > 4 * 1024 * 1024) return json({ error: "分享資料超過上限 4 MB" }, 413);
    if (buf.length < 20 || buf[0] !== 0x1f || buf[1] !== 0x8b) return json({ error: "資料格式不正確（需為 gzip 壓縮）" }, 400);

    let shareName = "試產回合分享";
    try {
      const h = req.headers.get("x-share-name");
      if (h) shareName = decodeURIComponent(h);
    } catch {
      shareName = req.headers.get("x-share-name") || "試產回合分享";
    }
    const id = randomBytes(16).toString("base64url");
    const exp = Date.now() + 30 * 86400_000;
    await repo.createShare(id, shareName, user, buf, exp);
    return json({ id, expires: exp }, 201);
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id") || "";
    if (!id) return json({ error: "缺少 id 參數" }, 400);
    const adminList = (env.ADMIN_USERS || "").split(",").map((x) => x.trim().toLowerCase());
    const isAdmin = adminList.includes(user.toLowerCase());
    const res = await repo.revokeShare(id, user, isAdmin);
    if (res.error) return json(res, res.status || 500);
    return json({ revoked: id });
  }

  return json({ error: "只接受 GET, POST 或 DELETE" }, 405);
}
