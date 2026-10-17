# Netlify 資源徹底下線與清理手冊 (Netlify Teardown Runbook)

本文件依據《SPI·SPC 分析台規格書 v1.20》第 9.2 節之 D2 階段編寫，供帳戶持有人（系統管理員）在 Cloudflare 7 天穩定期（D0）屆滿且確認不回滾後，依序執行 Netlify 平台資源之徹底刪除。

> [!CAUTION]
> **不可回復警告 (Irreversible Actions)**：本手冊第 2 步執行刪除 Netlify Blobs 之後，舊站資料將永久消失，**完全失去回滾至 Netlify 之可能性**。請務必在確認第 1 步離線備份驗證無誤、且正式站穩定運行無虞後方可執行。

---

## 執行前提條件

- [ ] **1. 穩定期要求**：自切換時間戳（T_cut）起算已滿 **7 天**（只可延長，不可縮短）。
- [ ] **2. 穩定性要求**：Cloudflare 正式站點每日巡檢正常，無 P1/P2 重大缺陷，無回滾決策。
- [ ] **3. 權限具備**：操作者具備 Netlify 帳戶管理者權限與 GitHub 儲存庫管理員權限。

---

## 清理執行清單

### 步驟 1：最後完整離線備份與封存
- [ ] **1.1 執行最後一次全量匯出**
  - 在受控安全目錄執行完整匯出：
    ```bash
    node tools/migrate-netlify-blobs.mjs export /safe/final-offline-backup --worker-url <WORKER_URL>
    ```
- [ ] **1.2 離線備份封存與安全加密**
  - 由帳戶持有人決定加密方式（例如 AES-256 加密壓縮包或硬體加密磁碟）。
  - **存放嚴禁事項**：嚴禁提交至 Git 儲存庫、公開雲端空間或 Cloudflare R2。
  - 建議保存期限：**至少 90 天**。
  - 記錄備份資訊：
    - 備份時間 (UTC+8): `________________________`
    - 檔案雜湊 (SHA-256): `________________________`
    - 安全存放位置說明: `________________________`
    - 預定銷毀日期: `________________________`

---

### 步驟 2：完全清空並刪除 Netlify Blobs（⛔ 不可回復點）
- [ ] **2.1 列舉並清空四個 Blobs 儲存區**
  - 對下列各 Store 執行全量物件刪除：
    1. `spi-records`（原始上傳量測紀錄與座標檔）
    2. `spi-share`（歷史分享資料）
    3. `spi-maint`（維護狀態標記）
    4. `spi-auth-lock`（登入失敗鎖定紀錄）
- [ ] **2.2 驗證清空**
  - 以 Netlify Blobs API 或 SDK 執行 `list()`，確認各 Store 物件數均為 0 筆。
  - **不可回復點宣告**：完成此步後，回滾程序（D1）之資料來源已徹底消除，不可再回滾。

---

### 步驟 3：刪除 Netlify 環境變數
- [ ] **3.1 移除所有環境設定**
  - 前往 Netlify 控制台：`Site configuration` → `Environment variables`。
  - 刪除所有變數，包含但不限於：
    - `AUTH_USERS`
    - `AUTH_USER`
    - `AUTH_PASS_SHA256`
    - `AUTH_SECRET`
    - `ANTHROPIC_API_KEY`
    - 所有 AI Gateway 相關金鑰及自訂變數。
- [ ] **3.2 驗證清理**
  - 執行 `netlify env:list --site <SITE_ID>` 或重新整理控制台頁面，確認環境變數清單完全為空。

---

### 步驟 4：刪除所有部署與 Netlify 站點（⛔ 不可回復）
- [ ] **4.1 刪除個別歷史部署**
  - 透過 Netlify API 列出並刪除所有剩餘部署（`DELETE /api/v1/sites/<SITE_ID>/deploys/<DEPLOY_ID>`）。
- [ ] **4.2 徹底刪除站點 (Delete Site)**
  - 前往 `Site configuration` → `General` → 最下方點擊 **「Delete this site」**。
  - 輸入站點名稱確認刪除。
- [ ] **4.3 驗證站點消除**
  - 測試主網址：`curl -sI https://spi-spc-analyst.netlify.app/` → 返回 404 或 Netlify "Site not found"。
  - 測試歷史部署網址，均返回 404。
  - Netlify 儀表板站點列表已無此專案。

---

### 步驟 5：解除 GitHub 儲存庫連結與授權
- [ ] **5.1 移除 GitHub 整合授權**
  - 前往 GitHub 儲存庫：`Settings` → `Integrations`（GitHub Apps / Authorized OAuth Apps）。
  - 撤銷 Netlify 對 `chenchihcu/spi-spc-analyst` 的存取權限。
- [ ] **5.2 清理 Webhooks 與 Deploy Keys**
  - 檢查 `Settings` → `Webhooks`，若有 Netlify 項目則刪除。
  - 檢查 `Settings` → `Deploy keys`，若有 Netlify 建立的公鑰則刪除。
  - 驗收：提交程式碼至 `main` 時，不再觸發任何 Netlify 狀態檢查（check runs）。

---

### 步驟 6：撤銷 Netlify Personal Access Token 與本機登出
- [ ] **6.1 撤銷存取權杖**
  - 前往 Netlify 使用者設定：`User settings` → `Applications` → `Personal access tokens`。
  - 撤銷遷移及管理專用之 `NETLIFY_AUTH_TOKEN`。
- [ ] **6.2 本機安全清理**
  - 清理終端機環境變數與歷史指令中的 Token：
    ```bash
    netlify logout
    ```
- [ ] **6.3 驗證權限終止**
  - 測試 API 呼叫：`curl -sI -H "Authorization: Bearer <TOKEN>" https://api.netlify.com/api/v1/sites` → 必須返回 **401 Unauthorized**。

---

## 完成簽核與稽核登記

- [ ] **完成紀錄填寫**
  - 執行人員簽名: `________________________`
  - 完成日期時間 (UTC+8): `________________________`
- [ ] **Cloudflare 稽核日誌登記**
  - 於正式 Cloudflare 系統之 `audit_log` 寫入一筆操作紀錄：
    - Action: `netlify_teardown`
    - By: 帳戶持有人帳號
    - Detail: 標註 Netlify 資源已徹底刪除，離線備份已安全封存。
