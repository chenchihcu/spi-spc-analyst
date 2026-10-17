# PDF 報告中文字型子集建置說明（8.1 P1-b / D-48）

## 為什麼需要自建 TrueType (`glyf`) 子集？
`jsPDF` 只支援嵌入 **TrueType (`glyf`)** 靜態字型，不支援 OpenType CFF (`CFF ` / `CFF2`) 或可變字型 (`fvar`)（參見 jsPDF issue #2276、#3152）。此外，為了讓前端離線可快取且符合 Cloudflare Workers 免費方案靜態資產限制，我們使用 `fonttools` 將 Google Fonts 的 `NotoSansTC[wght].ttf` 固定字重並裁切子集。

## 字集範圍 (`tools/font-charset.txt`)
1. ASCII 可列印字元（`0x20`–`0x7E`）與全形標點符號。
2. 教育部常用國字標準字體表（4,808 字）與次常用字中的工廠／工程／姓名常用字。
3. 統計與工程符號：`σ μ ≥ ≤ ± × ÷ ℃ ° ① ② ③ ④ ⑤ Ø ² ³ → ← ↑ ↓ ‰ ％ µ ′ ″ X̄`。
4. 若報告中出現字集以外的罕用字（例如「堃」若不在子集中），前端 PDF 產生器會在嵌入前掃描字元，將含缺字的段落改以 Canvas 繪製點陣圖嵌入，並於報告附錄列出缺字清單，確保永遠不出現 `□` 豆腐字。

## 建置步驟
1. 安裝 Python 與 `fonttools`：
   ```bash
   pip install fonttools brotli
   ```
2. 準備來源字型 `NotoSansTC[wght].ttf`（或使用系統內建的 `C:\Windows\Fonts\NotoSansTC-VF.ttf`，亦可透過環境變數 `NOTO_FONT_SRC` 指定路徑）。
3. 執行建置腳本：
   ```bash
   bash tools/build-font.sh
   ```
4. 腳本會自動執行：
   - `fontTools.varLib.instancer` 固定字重 `wght=400` 與 `wght=700`（移除 `fvar`/`gvar`/`HVAR`/`STAT`）。
   - `fontTools.subset`（即 `pyftsubset`）依 `tools/font-charset.txt` 裁切字集，加上 `--no-hinting --desubroutinize --layout-features=""`。
   - 自動驗證輸出 TTF 必含 `glyf` 表、不含 `CFF ` / `CFF2` / `fvar` 表，且 `cmap` 必含 `format 4` 子表。
   - 以內容 SHA-256 前 8 碼輸出至 `vendor/NotoSansTC-400.<hash>.ttf` 與 `vendor/NotoSansTC-700.<hash>.ttf`。
