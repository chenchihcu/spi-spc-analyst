# spi-spc-analyst 測試資料包（spec v1.14）

解壓到 repo 的 `tests/fixtures/audit/`，保留目錄結構。需求規格書中寫的 `audit3/testdata/X` 就是 `tests/fixtures/audit/audit3/testdata/X`。

- `audit*/`：合成測試資料（CSV）與稽核時下載的匯出檔，不含生產資料。
- `r*/`（含 `r13merge/`、`r14merge/`、`r15merge/`）、`pp/`：稽核方的驗證腳本與輸出，只供對照，不得放進產品程式。腳本中的 `/workspace/spc/...` 路徑要改成你的 checkout（`full/B` = spi-spc-analyst main 3137e3d）。
- 期望值以規格書的文字為準；腳本只是用來說明那些數字怎麼算出來的。
- v1.14 與 v1.13 的差別（第 15 輪）：新增 `r15merge/mf-r15.mjs`（Miniflare 本機 D1，D-59 的完整資料表與索引）與它的輸出 `r15merge/mf-r15.out.txt`——①稽核頁每一列的狀態只由該列決定（遷移列 `detail.done`、`migrate_exclude`／`delete` 列本身、目標已不在本站的中性文字），固定 SQL 每頁 1 句、`rows_read` ≤104（1,020 列 21 頁最多 102）；②每次匯出都有的 `shares.json` 算出的預期分享集合 E＝{S1, S2, S3}；③匯入後才排除的分享由工具撤回（本機 `rows_written` 5）、C5 過時未撤銷分享關卡（撤銷前 1、撤銷後 0）、`target_id` 必須存完整 22 字元 id。先在任一空資料夾 `npm i miniflare`，再 `node r15merge/mf-r15.mjs`（約 1 分鐘）。其他 99 檔逐位元組相同。
- v1.13 與 v1.12 的差別（第 14 輪）：新增 `r14merge/mf-r14.mjs`（Miniflare 本機 D1，D-59 的完整資料表與索引）與它的輸出 `r14merge/mf-r14.out.txt`——①規格 9.2 B4 ③ 的例子：匯入 5,000 筆紀錄、6,000 筆遷移稽核列、200 個分享的 `rows_written` 49,800，全部 DELETE 的實測 11,200（額度估算以 INSERT 的每筆列數計，同為 49,800）；②稽核頁列表（`audit_log LEFT JOIN records`、`ORDER BY seq DESC`、游標 `seq`，每頁 50 筆）每頁 `rows_read` ≤104（目標全部存在時 102）與 `EXPLAIN QUERY PLAN`。先在任一空資料夾 `npm i miniflare`，再 `node r14merge/mf-r14.mjs`（約 2 分鐘）。其他 97 檔逐位元組相同。
- v1.12 與 v1.11 的差別（第 13 輪）：新增 `r13merge/` 的四支 Miniflare 本機 D1 計數腳本——`mf-counts.mjs`（登入 SQL 與 cron／成功 DELETE、`records` 列表）、`mf-list.mjs`（keyset 列表首頁 51、第 2 頁 52、UPDATE／DELETE 的計數）、`mf-auth.mjs`（條件式 INSERT 讀 12 列）、`mf-al12.mjs`（AL-12 的 500 列 cron 刪除 `rows_written` 200、各表 INSERT／DELETE 列數、`shares` 列表與保存期限清除的 `EXPLAIN QUERY PLAN`）；先在任一空資料夾 `npm i miniflare`，再 `node <檔名>`。更新 `r11merge/gate_check.py`：單一 IP 一天的 rows written 同時輸出實測計法（INSERT 3 列、DELETE 1 列：1,865）與保守上限（2,775）。其他 92 檔逐位元組相同。
- v1.11 與 v1.10 的差別：只更新本說明檔（版本與差異說明）；其他檔案逐位元組相同，第 12 輪沒有新增腳本（規格的修正都是條文與驗收寫法）。
- v1.10 與 v1.9 的差別：新增 `r11merge/gate_check.py`（規格 9.5 的登入 SQL 與基準 `lockUntil` 在 500 組隨機序列上的等價性檢查，以及單一 IP 全速一天的寫入量；只用 Python 3 標準庫 `sqlite3`，直接 `python3 r11merge/gate_check.py`）與 `r11merge/land.js`（以 puppeteer-core＋Chrome 在 932×430 觸控 DPR3 量測現況版面；需要本機 HTTP 伺服器提供加上 doctype／viewport 的 `spi-spc.html` 暫存副本，網址與路徑要改成你的環境）；其他檔案逐位元組相同。
- v1.9 與 v1.8 的差別：只更新本說明檔（版本與差異說明）；其他檔案逐位元組相同，第 10 輪沒有新增腳本。
- v1.8 與 v1.7 的差別：新增 `r9/tv23.py`（第 9 輪以 Python 獨立重算 TV-23，未用 B 核心；路徑同樣要改成你的 checkout）；其他檔案逐位元組相同。
- 不隨附：稽核筆記（`audit*/README.md`、`audit*-notes.md`、`round*-code.md`）與 PDF 證據（`audit1/print_issues_demo1.pdf`、`audit4/testdata/N4-phone-capability-print.pdf`）。它們不是驗收輸入，而且含線上站網址、登入帳號或正式資料名稱（規格書「Gemini 執行須知」第 3 點）。
- 本資料包不含任何機密、session 資料，也不含舊主機平台的名稱字樣（9.2 D3 的字樣檢查不需要為它設例外）。
