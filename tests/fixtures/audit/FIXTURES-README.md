# spi-spc-analyst 測試資料包（spec v1.7）

解壓到 repo 的 `tests/fixtures/audit/`，保留目錄結構。需求規格書中寫的 `audit3/testdata/X` 就是 `tests/fixtures/audit/audit3/testdata/X`。

- `audit*/`：合成測試資料（CSV）與稽核時下載的匯出檔，不含生產資料。
- `r*/`、`pp/`：稽核方的驗證腳本與輸出，只供對照，不得放進產品程式。腳本中的 `/workspace/spc/...` 路徑要改成你的 checkout（`full/B` = spi-spc-analyst main 3137e3d）。
- 期望值以規格書的文字為準；腳本只是用來說明那些數字怎麼算出來的。
