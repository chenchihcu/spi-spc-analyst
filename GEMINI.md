# Gemini 專案 UI/UX 指令入口

本專案所有 iPhone／行動版 Web UI/UX 規劃、實作與驗收任務，必須先閱讀以下文件：

@./APPLE_IPHONE_WEB_UI_UX_STANDARD.md

執行規則：
- 先 Audit + Plan，除非使用者明確要求直接實作。
- 以 `IOS-XX` 規則、`P0/P1/P2` 及 Acceptance Gates 追溯修改。
- 不破壞 API、資料結構、權限、業務邏輯、既有桌面版。
- 完成開發不等於完成 iPhone 真機驗收；未實測標記 `NOT TESTED`。

## 資料庫與雲端架構守則
- 本系統量測資料庫 100% 依賴 Cloudflare 雲端（D1 + R2），不設在地 IndexedDB（LocalRec）或平台沙盒備援分支。
- 未登入雲端帳號或離線環境存取時，必須維持 Fail-Closed 阻擋存取並提示需登入，嚴禁重新引入在地降級回退機制。

## 開發與測試環境守則
- **SPA 啟動路徑完整性**：修改 `analyze()`、`loadExample()` 或頂層計算邏輯時，不可遺漏局部變數宣告或造成運行時例外；頁面初始化失敗會阻斷 `<script>` 尾端 `window.SPI_TEST_HOOK` 掛載，導致跨步驟測試連鎖報錯。
  - 檢查：修改核心計算函式後，先以 `node --test tests/ui.smoke.test.js` 驗證頁面能無例外完成啟動。
  - 出處：步驟 14 實作除錯紀錄 (2026-10-17)。
- **Node.js VM 沙盒二進位物件相容**：在 `tests/_load.js` 的 `loadCore()` 執行沙盒中，必須完整提供 `TextEncoder`、`TextDecoder`、`Uint8Array`、`DataView` 與 `ArrayBuffer` 等 Web 標準二進位全域物件；核心純 JS 模組若使用二進位編碼，亦應具備防禦性相容回退。
  - 檢查：執行包含二進位解析/匯出測試時（如 `tests/step14.test.mjs`），無 `ReferenceError: TextEncoder is not defined`。
  - 出處：步驟 14 M-20 OpenXML 匯出除錯紀錄 (2026-10-17)。

