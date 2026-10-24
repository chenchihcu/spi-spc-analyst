# 受控匯入 staging 驗收紀錄（2026-10-24，UTC+8）

## 完成結果

- `verified`：獨立的 `spi-spc-analyst-staging` Worker、`spi-spc-staging` D1 與 `spi-spc-record-staging` R2 已建立。staging D1 的 `0001`–`0007` 均已套用，讀回為 `No migrations to apply`。
- `verified`：`deployments status` 讀回 staging 100% 使用 Worker 版本 `f7536cb9-6184-4bb0-aed3-f999237485e0`；公開 URL 為 <https://spi-spc-analyst-staging.chihfu-chen-tw.workers.dev/>。只有合成帳號與檔案進入 staging，沒有複製正式資料。
- `verified`：正式 Worker 在新版部署後的資料庫與稽核讀取曾回 `HTTP 503`；獲使用者授權後，100% 流量回退到 `633d5cbf-2fed-47a4-91e7-9d45c4ddfbcb`。公開頁面讀回 v10.2.3，登入後資料庫的量測、座標、規格清單及稽核紀錄均可讀取。

## 重要修改與驗證

- `wrangler.staging.jsonc` 將 Worker、D1、R2 及登入限流命名空間與正式資源分開；staging 的 AI 呼叫停用。`AUTH_USERS`、`AUTH_PEPPER`、`AUTH_SECRET`、`INITIAL_ADMIN_USER` 只設在 staging Worker 執行環境，未提交合成密碼或金鑰。
- `npm run release-check`：`Overall: READY`，45 個測試檔共 333 項通過，version／changelog／debug／docs／deps／secrets／a11y 全部 PASS。`npm run build:cloudflare`：exit 0，HTML 814327 bytes。staging `deploy --dry-run`：exit 0，bindings 指向 staging。
- 實際 staging API：管理者角色讀取 200、一般使用者 403；一般使用者上傳座標 403。受控座標首次上傳 201、同檔沿用 200、同範圍不同內容 409。量測未對應位號未確認 422，確認後 201；同原檔重複 409；同工單新檔 202 待判定；管理者修正後新檔 `active`、舊檔 `superseded`。座標封存後不再供新匯入選取，舊量測的 `place_id` 不變。
- 實際 staging 儲存：三份合成原檔下載後 bytes 與 SHA-256 均與上傳前一致。並行上傳同版不同座標得到 201／409，D1 僅一份；30,000 位號、722717 raw bytes／208040 gzip bytes 的檔案上傳與讀回通過；4395667 gzip bytes 的請求回 413。
- staging 新版本驗收：以新的合成料號上傳故意填入 `999` 計數的座標與量測檔，伺服器回覆座標元件數 1、量測板數 2／焊墊數 1／量測點數 2，D1 清單讀回一致。瀏覽器讀到 v10.3.2，資料庫顯示「有效」、「已被修正」、`48 B`、`2 × 1` 及座標元件數 1。原先在修正前匯入的合成紀錄沒有計數回填，仍顯示 `—`。Windows CRLF 下的手機版斷言已改為接受兩種換行；相關 21 項測試通過。
- 正式切換前備份（22:10 UTC+8）：D1 匯出 8522 bytes，SHA-256 `75A4BF07BA4426C695B147474B2114ABD4A6E6EB2E0F91FFF09ADDE3BEB6BF16`；依該 D1 清單重新下載 5 個 R2 原檔，解壓後 bytes 與 SHA-256 均相符。備份存放在 repo 外的私人資料夾。於本機 D1 副本套用 `0007` 通過，原有 5 筆紀錄全部原欄位相同，新表為空。

## 未完成或未驗證

- `not verified`：正式 D1 的 `0007_controlled_coordinate_import.sql` 仍待套用；正式 Worker 目前為回退版本，新受控匯入尚未在線上開放。正式 `INITIAL_ADMIN_USER` 需在切換新版前，以使用者指定的既有登入帳號設於 Worker 執行環境，不將帳號名稱寫入 Git。
- `not verified`：上述備份只代表 22:10 的正式資料狀態；真正切換前若資料改變，必須再比對／更新備份。正式 D1 `migrations list --remote` 仍列出待套用 `0007`，Worker `deployments status` 仍為 100% 回退版本。後續須在核定的切換窗口設定正式初始管理者、套用 migration、合併 PR 觸發自動部署，並於精確公開 URL 登入後驗證。
- `not verified`：staging 只驗收合成資料與上述檔案大小，未測實體 iPhone、完整 4 MiB 以下各種壓縮比或正式資料的真實負載。此紀錄不是正式上線驗收。
