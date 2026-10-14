// 每日清除已過期的分享資料：分享連結即使從未再被開啟，30 天後資料也會刪除，不會無限期保留。
import { getStore } from "@netlify/blobs";

/** 列出全部分享，刪除已過期或缺少到期資訊者；回傳刪除筆數（store 可注入，測試用記憶體版本） */
export async function purgeExpired(store, now = Date.now()) {
  let removed = 0, cursor;
  do {
    const page = await store.list(cursor ? { cursor } : {});
    for (const { key } of page.blobs || []) {
      const meta = await store.getMetadata(key).catch(() => null);
      if (!(meta?.metadata?.exp > now)) { await store.delete(key); removed++; }
    }
    cursor = page.cursor;
  } while (cursor);
  return removed;
}

export default async () => {
  const n = await purgeExpired(getStore({ name: "spi-share", consistency: "strong" }));
  console.log(`share cleanup removed=${n}`);
  return new Response(null, { status: 204 });
};

export const config = { schedule: "@daily" };
