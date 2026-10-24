# 受控匯入 staging 驗收紀錄（2026-10-24，UTC+8）

## 完成結果

- `verified`：獨立的 `spi-spc-analyst-staging` Worker、`spi-spc-staging` D1 與 `spi-spc-record-staging` R2 已建立。staging D1 的 `0001`–`0007` 均已套用，讀回為 `No migrations to apply`。
- `verified`：staging 目前 100% 使用 Worker 版本 `449b9769-2595-4dea-b15a-163379770c26`；公開 URL 為 <https://spi-spc-analyst-staging.chihfu-chen-tw.workers.dev/>。只有合成帳號與檔案進入 staging，沒有複製正式資料。
- `verified`：正式 Worker 在新版部署後的資料庫與稽核讀取曾回 `HTTP 503`；獲使用者授權後，100% 流量回退到 `633d5cbf-2fed-47a4-91e7-9d45c4ddfbcb`。公開頁面讀回 v10.2.3，登入後資料庫的量測、座標、規格清單及稽核紀錄均可讀取。

## 重要修改與驗證

- `wrangler.staging.jsonc` 將 Worker、D1、R2 及登入限流命名空間與正式資源分開；staging 的 AI 呼叫停用。`AUTH_USERS`、`AUTH_PEPPER`、`AUTH_SECRET`、`INITIAL_ADMIN_USER` 只設在 staging Worker 執行環境，未提交合成密碼或金鑰。
- `npm run release-check`：`Overall: READY`，45 個測試檔共 333 項通過，version／changelog／debug／docs／deps／secrets／a11y 全部 PASS。`npm run build:cloudflare`：exit 0，HTML 814172 bytes。staging `deploy --dry-run`：exit 0，bindings 指向 staging。
- 實際 staging API：管理者角色讀取 200、一般使用者 403；一般使用者上傳座標 403。受控座標首次上傳 201、同檔沿用 200、同範圍不同內容 409。量測未對應位號未確認 422，確認後 201；同原檔重複 409；同工單新檔 202 待判定；管理者修正後新檔 `active`、舊檔 `superseded`。座標封存後不再供新匯入選取，舊量測的 `place_id` 不變。
- 實際 staging 儲存：三份合成原檔下載後 bytes 與 SHA-256 均與上傳前一致。並行上傳同版不同座標得到 201／409，D1 僅一份；30,000 位號、722717 raw bytes／208040 gzip bytes 的檔案上傳與讀回通過；4395667 gzip bytes 的請求回 413。
- staging 瀏覽器：合成管理者登入後讀到 v10.3.1；資料庫呈現 2 筆量測（`active`／`superseded`）、1 筆已封存座標與角色清單，沒有資料庫 503。Windows CRLF 下的手機版斷言原只接受 LF，已改為同時接受兩種換行；相關 14 項測試通過。

## 未完成或未驗證

- `not verified`：正式 D1 的 `0007_controlled_coordinate_import.sql` 仍待套用；正式 Worker 目前為回退版本，新受控匯入尚未在線上開放。正式 `INITIAL_ADMIN_USER` 需在切換新版前，以使用者指定的既有登入帳號設於 Worker 執行環境，不將帳號名稱寫入 Git。
- `not verified`：正式環境須先取得切換當下的新 D1/R2 備份，檢查舊資料與附件、在本機副本演練 `0007`，再套用 migration、部署新版及於精確公開 URL 登入後驗證。此前的備份只證明其備份當時的狀態。
- `not verified`：staging 只驗收合成資料與上述檔案大小，未測實體 iPhone、完整 4 MiB 以下各種壓縮比或正式資料的真實負載。此紀錄不是正式上線驗收。
