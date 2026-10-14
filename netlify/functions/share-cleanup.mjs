// 每日清除：
//   1. 已過期的分享資料（分享連結即使從未再被開啟，30 天後資料也會刪除）
//   2. 已過期的登入鎖定紀錄（不會無限累積）
// 排程函式有 30 秒上限：逐頁處理、每批並行 20 筆、超過時間預算就停，剩下的隔天繼續。
import { getStore } from "@netlify/blobs";
import { purgeLockRecords } from "../../lib/auth-core.mjs";

// 分享代碼是隨機的 base64url：依第一個字元分成 64 段依序處理。
// 單次跑不完時，記下「停在哪一段的哪個代碼之後」，下次從那裡接著做（只列出不讀取，跳過很快），
// 跑完一輪再從頭開始，因此不論資料多少，每個分享都會輪到。
export const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * 刪除已過期或缺少到期資訊的分享；讀取失敗的項目一律保留（不因暫時錯誤刪掉有效資料）。
 * state＝上次的進度 { bucket, after }；回傳 { removed, state }（state 為 null 代表本輪已全部處理完）。
 */
export async function purgeExpired(store, now = Date.now(), budgetMs = 20_000, clock = Date.now, state = null) {
  const t0 = clock();
  let removed = 0;
  const startIdx = Math.max(0, ID_CHARS.indexOf(state?.bucket ?? ID_CHARS[0]));
  for (let bi = startIdx; bi < ID_CHARS.length; bi++) {
    const c = ID_CHARS[bi], after = bi === startIdx ? state?.after || "" : "";
    for await (const page of store.list({ prefix: c, paginate: true })) {
      const keys = (page.blobs || []).map((b) => b.key).filter((k) => k > after).sort();
      for (let i = 0; i < keys.length; i += 20) {
        const batch = keys.slice(i, i + 20);
        await Promise.all(batch.map(async (key) => {
          let meta;
          try { meta = await store.getMetadata(key); } catch { return; } // 讀取失敗：略過
          if (!meta) return; // 已不存在
          if (!(meta.metadata?.exp > now)) { try { await store.delete(key); removed++; } catch { /* 下次再試 */ } }
        }));
        if (clock() - t0 > budgetMs) return { removed, state: { bucket: c, after: batch[batch.length - 1] } };
      }
    }
    if (clock() - t0 > budgetMs) return { removed, state: bi + 1 < ID_CHARS.length ? { bucket: ID_CHARS[bi + 1], after: "" } : null };
  }
  return { removed, state: null };
}

export default async () => {
  const shares = getStore({ name: "spi-share", consistency: "strong" }), maint = getStore({ name: "spi-maint", consistency: "strong" });
  const prev = await maint.get("share-cleanup", { type: "json" }).catch(() => null);
  const { removed, state } = await purgeExpired(shares, Date.now(), 15_000, Date.now, prev);
  await maint.setJSON("share-cleanup", state).catch(() => {});
  const locks = await purgeLockRecords(getStore({ name: "spi-auth-lock", consistency: "strong" }), Date.now(), 8_000);
  console.log(`cleanup removed shares=${removed} lockRecords=${locks} resume=${state ? state.bucket : "-"}`);
  return new Response(null, { status: 204 });
};

export const config = { schedule: "@daily" };
