# Cloudflare 切換執行手冊 (Cutover Runbook)

本文件依據《SPI·SPC 分析台規格書 v1.20》第 9.2 節（A～D1 階段）編寫，供帳戶持有人（系統管理員）執行從 Netlify 遷移至 Cloudflare Workers 的完整切換流程。

> [!WARNING]
> **非機密設定單一來源宣告 (SSOT)**：所有非機密變數（如 `AUTH_KDF_ITER`、`ADMIN_USERS`、`AI_ENABLED`、`AI_LOG_PAYLOAD` 等）一律由儲存庫內之 `wrangler.jsonc` 透過 PR 維護。**嚴禁**在 Cloudflare 控制台儀表板新增或手動修改非機密變數，亦不得使用 `keep_vars`，否則 Workers Builds 與本機部署將直接覆蓋儀表板設定。

---

## 階段 A：切換準備

### A 前置（於伺服器端變更合併前完成）
- [ ] **A1 凍結 Netlify 自動建置**
  - 前往 Netlify 站點：`Site configuration` → `Build & deploy` → `Continuous deployment`，點擊 **「Stop builds」**（必做）。
  - 建議同時點擊 **「Unlink repository」** 解除 GitHub 連動。
  - 記錄當前正式部署資訊：
    - Deploy ID: `________________________`
    - Commit SHA (A1 commit): `________________________`
    - 凍結時間 (UTC+8): `________________________`
  - 驗收：後續 push/merge 至 `main`，Netlify Deploys 頁不再產生新建置。

- [ ] **A2 Cloudflare 雲端資源就位（Workers 免費方案）**
  - 在 Cloudflare 控制台建立**私有** R2 bucket：`spi-spc-record`。
  - 建立 D1 資料庫：`spi-spc`，並記錄資料庫 UUID。
  - 核對 `wrangler.jsonc` 中的 D1 `database_id` 是否相符。

- [ ] **A3 連接 Git 與初次部署**
  - Cloudflare Workers 控制台「連接 Git」：
    - Worker 名稱：`spi-spc-analyst`
    - Build command: `npm run build:cloudflare`
    - Deploy command: `npx wrangler deploy`
    - 建置環境變數：`NODE_VERSION=22`
  - 執行遠端 migration：`npx wrangler d1 migrations apply spi-spc --remote`
  - 設定初期 Secrets：
    - `npx wrangler secret put AUTH_SECRET`（輸入 ≥32 字元隨機字串）
    - `npx wrangler secret put AUTH_USERS`（放入舊格式測試帳號紀錄，確保初期 503 檢查正常）
  - 驗收：訪問 workers.dev 站點，未登入訪問返回登入頁或 401。

### A 後段（伺服器端變更合併前夕）
- [ ] **A4 程式端 Migration 與配置準備**
  - 確認包含 `0002_free_plan_schema.sql`、`ratelimits`、`cron` 與新版 `hash-password.mjs` 之 PR 已審查通過。
- [ ] **A5 合併前遠端指令執行**
  - 執行 D1 schema 更新：`npx wrangler d1 migrations apply spi-spc --remote`
  - 驗證已套用清單：`npx wrangler d1 migrations list spi-spc --remote`
  - 設定安全胡椒密鑰：`npx wrangler secret put AUTH_PEPPER`（≥32 bytes 隨機字串）
  - 使用新工具產生測試帳號紀錄：`node tools/hash-password.mjs`，並寫入：`npx wrangler secret put AUTH_USERS`
  - 設置 AI 專用機密（若有）：`CF_AI_GATEWAY_TOKEN`、`ANTHROPIC_API_KEY`。

---

## 階段 B：開發期演練（切換前一週內）

- [ ] **B1 真機量測 PBKDF2 運算次數 (ITER)**
  - 在 iPhone 16 Pro Max 及 iPad 之 Safari 開啟 workers.dev 登入頁。
  - 量測 600,000 次雜湊耗時（各取 5 次中位數）。
  - 若中位數 ≤1.5 秒，維持 `AUTH_KDF_ITER="600000"`；若超過，開 PR 改為 `"310000"` 並重新產生帳號紀錄。
  - 實測耗時紀錄：iPhone: `______` ms / iPad: `______` ms。

- [ ] **B2 完整資料匯出與匯入演練**
  - 建立 repo 外受控目錄（如 `/safe/export-drill`）。
  - 執行匯出：`node tools/migrate-netlify-blobs.mjs export /safe/export-drill --worker-url <WORKER_URL>`
  - 執行 dry-run：`node tools/migrate-netlify-blobs.mjs import /safe/export-drill --remote --worker-url <WORKER_URL> --exclude-lot-prefix TEST-`
  - 執行套用：`node tools/migrate-netlify-blobs.mjs import /safe/export-drill --remote --worker-url <WORKER_URL> --exclude-lot-prefix TEST- --apply`
  - 記錄 rows written 估算值與耗時。

- [ ] **B3 回滾演練 (Rollback Drill)**
  - 在 Netlify 上傳測試批號 `DRILL-演練` 並建立分享。
  - 匯入至 Cloudflare，並於 Cloudflare 端撤銷該分享、刪除該紀錄。
  - 執行反向匯出：`node tools/migrate-netlify-blobs.mjs export-cloudflare --since <演練開始時間>`
  - 同步回 Netlify：`node tools/migrate-netlify-blobs.mjs netlify-sync-deletions <輸出目錄> --site <SITE_ID> --apply`
  - 驗證 Netlify 上該分享返回 404，`DRILL-演練` 紀錄已自 `index.json` 移除。
  - 測試在 A1 commit 建立 Netlify 草稿部署，驗證完成後**立即以 API 刪除草稿**。

- [ ] **B4 匯入策略二選一決定**
  - 依演練數據判定切換日匯入方式：
    - `[ ]` (i) 清空 Cloudflare 資料，切換日重新完整匯入（僅限總額度估算 ≤80,000 列且小於當日餘額）。
    - `[ ]` (ii) 保留演練資料，切換日僅匯入差額 `--since`（推薦，差額估算 ≤50,000 列）。
  - 決定方式：`________________________`。

---

## 階段 C：切換日執行程序

- [ ] **C1 發布維護公告**
  - 提前通知所有使用者停機切換時段，提醒切換後需使用新密碼登入。

- [ ] **C2 停止 Netlify 寫入與歷史部署清理**
  - 於 repo 外部空目錄放置「搬遷中」靜態 `index.html`。
  - 發布靜態部署：`netlify deploy --prod --dir . --site <SITE_ID> --no-build`（若問 unlock 回答「否」）。
  - 驗證寫入阻擋：
    - `curl -s -o /dev/null -w '%{http_code}' -X POST https://spi-spc-analyst.netlify.app/api/records` → 回 404 或 405。
    - `curl -s -o /dev/null -w '%{http_code}' -X POST https://spi-spc-analyst.netlify.app/__login` → 回 404 或 405。
  - **刪除所有舊部署**：使用 Netlify API 列出並刪除除了本次「搬遷中」部署以外的所有部署，防範歷史函式與舊密碼外洩。
  - 驗證：歷史部署永久網址全部回 404，控制台部署清單僅剩 1 個。

- [ ] **C3 執行正式資料遷移與雙向核對**
  - 匯出差額（或完整）：`node tools/migrate-netlify-blobs.mjs export /safe/cutover-data --since <B4匯出時間> --worker-url <WORKER_URL>`
  - 執行 dry-run 比對：`node tools/migrate-netlify-blobs.mjs import /safe/cutover-data --remote --worker-url <WORKER_URL> --same-options`
  - 正式套用寫入：`node tools/migrate-netlify-blobs.mjs import /safe/cutover-data --remote --worker-url <WORKER_URL> --same-options --apply`
  - 雙向資料一致性核對：
    - `records` 筆數與 SHA-256 吻合。
    - `shares` 逐筆比對，有效分享 SHA-256 一致，過時未撤銷分享為 0。
    - `audit_log` 子集合核對通過，`exclude:*` 預期集合完全一致。

- [ ] **C4 更新正式帳號密碼**
  - 使用新版 `hash-password.mjs` 為所有正式使用者產生新密碼（≥12 字元）。
  - 更新 Cloudflare 密鑰：`npx wrangler secret put AUTH_USERS`。
  - 更新 Netlify 環境變數 `AUTH_USERS`（僅供 D1 回滾草稿備用，弱雜湊）。
  - 透過安全管道（非 Email 明文）個別交付使用者新密碼。

- [ ] **C5 線上功能與健康度完整驗證**
  - 訪問正式網址，未登入 303 導向 `/__login`，登入頁 200，API 401。
  - 瀏覽器主控台無 favicon 401 或 CSP 違規。
  - 使用正式帳號登入成功，驗證 `/__me`、紀錄列表與下載。
  - 使用測試帳號上傳 `TEST-切換-01`，驗證建立分享、我的分享、撤銷分享與刪除紀錄。
  - 驗證 Cron 觸發紀錄正常。

- [ ] **C6 暫時性 302 導流設定（選用）**
  - 於 repo 外部空資料夾建立包含 `_redirects` 之靜態站，設定 302 暫時轉址至新站。
  - 發布至 Netlify：`netlify deploy --prod --dir . --site <SITE_ID> --no-build`。
  - 驗證 `curl -sI 'https://spi-spc-analyst.netlify.app/?share=TESTID'` 返回 302 且保留 Query String。

- [ ] **C7 記錄正式切換時間戳 (T_cut)**
  - 記錄 T_cut (UTC+8): `________________________`。
  - 於 Cloudflare `audit_log` 記錄 `cutover` 標記。

---

## 階段 D：穩定期與回滾保護

- [ ] **D0 7 天穩定期 (T_cut ~ T_cut + 7 天)**
  - 本期間不得縮短，可視需要延長。
  - 每日巡檢：D1/R2 用量、登入嘗試率與 Cron 狀態。
  - **重要限制**：穩定期內合併之 PR 嚴禁包含 D1 schema migration，亦不得變更 `records` / `shares` / `audit_log` 之寫入格式。

- [ ] **D1 回滾應變程序（僅於 C5 失敗或穩定期發現重大瑕疵時執行）**
  - 匯出 Cloudflare 新增與異動：`node tools/migrate-netlify-blobs.mjs export-cloudflare --since <T_cut>`
  - 將刪除與撤銷同步回 Netlify：`node tools/migrate-netlify-blobs.mjs netlify-sync-deletions <輸出目錄> --site <SITE_ID> --apply`
  - 在 A1 commit 建立回滾草稿：`netlify deploy --build --site <SITE_ID>`，檢查後發布至 production。
  - 通知使用者切回舊站。
