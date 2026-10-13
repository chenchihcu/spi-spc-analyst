# Release Readiness Report

**Project:** SPI·SPC 分析台（單頁 HTML 工具）
**Version:** v9.0.0
**Date:** 2026-10-13 23:38:55（UTC+8）
**Overall Status:** READY（技術面）；量產上線前仍需完成「真實資料校正」一項人工確認

## Summary

依 validate-production-release 七大類檢查，並改寫為適用單頁 HTML 工具的版本（原技能的 Python 檢查腳本未隨技能提供，改以 `tools/release-check.js` 實作同等檢查）。初檢 v8 有 4 類未通過，已修正；複檢 8 類全部通過，自動化測試 15 項全數通過。

## Checks

| Category | 初檢 v8 | 複檢 v9 | Findings | Next Action |
|----------|--------|--------|----------|-------------|
| Version & Packaging | ⚠️ | ✅ | FACT：v8 版本字串寫死在主頁與 4 份匯出報告中，非語意化版本。v9 改為主頁單一來源 `v9.0.0`，報告一律讀取主頁值，時間格式到秒 | 之後每次更新只改主頁版本與時間 |
| Changelog | ❌ | ✅ | FACT：v8 無 CHANGELOG。v9 新增，最新條目 v9.0.0 與主頁一致並含時間 | — |
| Debug Artifacts | ✅ | ✅ | FACT：無 console 輸出、debugger、alert、TODO、本機位址 | — |
| Documentation | ❌ | ✅ | FACT：v8 無 README。v9 新增，含快速開始、使用、設定、資料格式、已知限制 | — |
| Dependencies | ✅ | ✅ | FACT：Chart.js 4.4.1、three.js r128 皆鎖定版本；測試用 jsdom 24.1.3 鎖版。INFERENCE：three.js r128 較舊但穩定 | 升級 three.js 時需重驗 3D 頁 |
| Tests | ❌ | ✅ | FACT：v8 無專案內測試。v9 新增 14 項統計核心單元測試（已知答案比對、範例偵測、純雜訊不誤報）與 1 項介面冒煙測試，15/15 通過 | 每次更新後執行 `npm test` |
| Secrets & API | ✅ | ✅ | FACT：無 API 金鑰、無直接呼叫外部 API；AI 分析使用頁面內建 Claude 功能 | — |
| Accessibility（附加） | ⚠️ | ✅ | FACT：v8 有 2 個控制項缺少標籤（貼上 CSV、新回合名稱），v9 已補 | — |

## Blockers

無。

## Warnings

- [Robustness] FACT：v8 在 CDN 被阻擋時圖表靜默空白。v9 已加頁首提示，數據分析與問題偵測不受影響。
- [Data] INFERENCE：問題偵測門檻（穩健 z ≥ 3.5、p < 0.05 等）只以範例資料校正，真實試產資料的雜訊結構可能不同。
- [Data] FACT：試產回合資料只存在頁面記憶體，重新整理後還原為範例；鋼板設定與機台格式設定檔存在瀏覽器。
- [UI] FACT：介面以 jsdom 驗證流程與執行錯誤，未做實機瀏覽器的視覺預覽（版面、3D 渲染）。

## Recommendations — Next Best Step

**最優先：** 拿一份真實試產 SPI CSV 匯入，比對「問題偵測」清單與現場已知狀況，並儲存為機台格式設定檔；若有誤報或漏抓，回報門檻調整。

其次：
1. 在桌機與手機各開一次頁面，確認版面與 3D 頁顯示正常。
2. 需要分享給團隊時，從頁面的「分享」選單開啟權限（目前僅本人可見）。
3. 每次更新後執行 `npm test` 與 `npm run release-check`，並同步更新主頁版本時間與 CHANGELOG。
