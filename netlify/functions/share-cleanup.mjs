// 每日清除：
//   1. 已過期的分享資料（分享連結即使從未再被開啟，30 天後資料也會刪除）
//   2. 已過期的登入鎖定紀錄（不會無限累積）
// 排程函式有 30 秒上限：逐頁處理、每批並行 20 筆、超過時間預算就停，剩下的隔天繼續。
import { getStore } from "@netlify/blobs";
import { purgeLockRecords } from "../../lib/auth-core.mjs";

/** 刪除已過期或缺少到期資訊的分享；讀取失敗的項目一律保留（不因暫時錯誤刪掉有效資料）。回傳刪除筆數 */
export async function purgeExpired(store, now = Date.now(), budgetMs = 20_000) {
  const t0 = Date.now();
  let removed = 0;
  for await (const page of store.list({ paginate: true })) {
    const keys = (page.blobs || []).map((b) => b.key);
    for (let i = 0; i < keys.length; i += 20) {
      await Promise.all(keys.slice(i, i + 20).map(async (key) => {
        let meta;
        try { meta = await store.getMetadata(key); } catch { return; } // 讀取失敗：略過
        if (!meta) return; // 已不存在
        if (!(meta.metadata?.exp > now)) { try { await store.delete(key); removed++; } catch { /* 下次再試 */ } }
      }));
      if (Date.now() - t0 > budgetMs) return removed;
    }
  }
  return removed;
}

export default async () => {
  const shares = await purgeExpired(getStore({ name: "spi-share", consistency: "strong" }), Date.now(), 15_000);
  const locks = await purgeLockRecords(getStore({ name: "spi-auth-lock", consistency: "strong" }), Date.now(), 8_000);
  console.log(`cleanup removed shares=${shares} lockRecords=${locks}`);
  return new Response(null, { status: 204 });
};

export const config = { schedule: "@daily" };
