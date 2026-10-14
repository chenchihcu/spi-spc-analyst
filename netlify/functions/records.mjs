// 量測紀錄與座標檔資料庫（Netlify Blobs「spi-records」）；處理邏輯在 lib/records-core.mjs
// 整個網站（含本函式）都在登入保護之後；x-spi-user 由登入邊緣函式設定，用戶端無法偽造
import { getStore } from "@netlify/blobs";
import { handleRecords } from "../../lib/records-core.mjs";

export default async (req) => handleRecords(req, getStore({ name: "spi-records", consistency: "strong" }));

export const config = { path: "/api/records" };
