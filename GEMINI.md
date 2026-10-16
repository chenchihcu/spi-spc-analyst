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

