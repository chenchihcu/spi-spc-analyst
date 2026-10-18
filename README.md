# SPI·SPC 分析台

錫膏印刷檢測（SPI）數據的線上分析工具，用於品質工程與試產分析（類似 DFM）：從統計數據中把問題找出來，並比較試產回合、提出鋼板開孔修改建議。

不作為品質系統稽核或正式允收依據。

## 快速開始

1. 開啟分析台頁面，預設載入兩個範例試產回合（試產 1、試產 2）。
2. 首頁「問題偵測」會自動列出問題（每項預設收合成一行，點一下展開，或按「全部展開」）：上方「問題地圖」一眼看出哪幾片板、哪個元件群組有問題（點格子可篩選）；每張卡片附事實、推論（含信心）、證據迷你圖、相關佐證，以及「前往」證據圖表的按鈕，查證後可用「回到問題清單」返回。
3. 匯入自己的資料：到「資料與規格」→ 拖放或貼上 SPI 匯出 CSV，或直接選 Excel（.xlsx）→「讀取欄位」→ 確認欄位對應與單位 →「套用匯入」（可新增為新回合）。
4. 同一台機台的格式可「儲存設定檔」，下次匯入自動套用。
5. 量測紀錄與原始檔案自動同步至 Cloudflare 雲端資料庫（D1 + R2），登入後重新整理不會遺失；亦可在「資料與規格 → 資料庫」隨時調閱、下載原始檔、驗證 SHA-256 指紋或重新開啟分析。
6. 頁首「分享連結」把目前回合與畫面做成連結傳給同事（對方需登入，30 天失效）；「列印／存成 PDF」或「分析報告」可產生多頁結構化 PDF 報告（內嵌中文字型）與 3D 快照。

## 使用

系統介面依品質工程工作流程劃分為四大階段、共 14 個核心分頁：

| 階段 | 頁籤 | 用途 |
|---|---|---|
| **找問題** | 問題偵測 | 十個面向自動掃描：單板突發、子板位置、系統性能力、焊墊位置、持續漂移、空間梯度、刮刀方向、擦拭週期、對位、設計 DFM、量測一致性；附問題地圖與迷你趨勢圖 |
| | 總覽 | 試產整體品質評級、良率分佈、最差群組與關鍵指標摘要卡片 |
| **看證據** | 管制圖 | X̄-S（三向法）、X̄-R（AIAG 常數）、I-MR、Laney P′ 圖（過度離散校正）、EWMA、CUSUM、Hotelling T² 多變量管制圖；Nelson 8 條判異規則 |
| | 製程能力 | Cp／Cpk／Pp／Ppk、PPM、直方圖、Q-Q 圖、盒鬚圖；常態檢定（Anderson-Darling、Shapiro-Wilk）與非常態轉換（Box-Cox、Johnson 體系、ISO 21747 經驗百分位數法） |
| | 3D 錫膏模擬 | 依量測值立體重建錫膏沉積，支援焊墊點選、X/Y 偏移位移、微觀形貌（拉尖/共面性/橋接）渲染與 3D 快照下載 |
| | 交叉驗證 | 12 種錫膏印刷失效模式交叉比對矩陣（支持/矛盾證據鏈），多圖表互相佐證與常態性檢核 |
| | 進階分析 | 面積比 × 轉移效率、焊墊 Cpk 排行、對位分解、刮刀前後、擦拭週期、停線時效衰退迴歸、空間自相關（全局 Moran's I 與局部 LISA 聚類熱圖） |
| | 統計資料 | 跨板統計特徵萃取、FastMCD 2D 雙變數離群值分析、不良矩陣與 OOC 數據匯出 |
| **改善與驗證** | 試產比較 | A／B 兩回合逐元件群組比較，附每板不良率 Welch 檢定與改善判定 |
| | DFM 建議 | 元件群組風險排行、面積比檢核與鋼板開孔修改建議表（可直接匯出給鋼板廠與 Layout） |
| | 實驗驗證 | SPI × 回焊 AOI 關聯（推算最佳規格窗口）、印刷參數 DOE、GR&R（交叉 ANOVA，包含交互作用評估） |
| | AI 分析 | 透過 Cloudflare Workers 後端經 AI Gateway 呼叫 Claude 進行高維度工程診斷、補漏與實驗建議 |
| | 分析報告 | 結構化整頁報告，支援 10 個章節自訂勾選，可生成多頁專業 PDF 報告（內嵌 Noto Sans TC 子集中文字型），或透過 Web Share / 安全轉寄（#mail）分享 |
| **設定** | 資料與規格 | 雲端量測資料庫（D1 + R2，批號/料號回溯）、CSV/Excel 匯入、加工廠格式（通用、立榮等）、座標檔對應、鋼板與規格設定（支援階梯鋼板推估窗重算） |

## 設定

- **鋼板**：厚度、高度規格（佔厚度 %）、階梯鋼板區域（支援推估規格窗重算 `recomputeMachineSpecs`）、開孔（縮減 % 或指定尺寸）
- **規格**：各量測項目 LSL／目標／USL。規格來源可選「與機台判定一致」（資料有機台判定碼時的預設：好壞直接採用機台結果，規格窗由各元件群組的 PASS 範圍推估；真正規格只會更寬，所以能力指標為下限）或「自訂規格」
- **刮刀行程方向**：沿 PCB X 或 Y（預設 Y），用於判讀空間梯度的成因；若資料無方向欄位或不完整，自動顯示「無法比較」並略過刮刀檢定
- **擦拭間隔**：每幾片擦拭一次（預設 5）；第一次擦拭在哪片板不必知道，系統會掃描所有起點並以 Bonferroni 校正

## 統計方法重點

- **製程能力**：Cp／Cpk 用組內 σ（同板、同元件群組內的合併標準差），Pp／Ppk 用長期 σ（扣除群組平均）。全部元件模式下逐群組計算並以最差群組為代表，預估 PPM 為各群組加權；Cpk 附 95% 信賴區間（NIST 公式）；製程未穩定時標示「僅供參考」。
- **非常態能力分析 (RFC-SPI-2026-001)**：結合 Anderson-Darling 檢定，偏態或厚尾數據可自動或手動切換 Box-Cox 冪次轉換、Johnson SB/SU/SL 體系轉換，或採 ISO 21747 經驗百分位數法，客觀評估非常態 PPM 與能力指標。
- **3D 微觀形貌指標 (RFC-SPI-2026-001)**：擴充五大幾何指標——相鄰焊墊橋接間距餘裕（Bridge Margin）、脫模拉尖（Peaking）、頂部平整度/共面性（Coplanarity）、孔壁覆蓋率（Coverage）與坍塌（Slump），連動 3D 沉積幾何拉尖渲染。
- **停線時效衰退模型 (RFC-SPI-2026-001)**：以時間戳記差分模型自動標定「停線首片（First Print After Pause）」，迴歸停線靜置時間（Dwell Time）與體積衰退曲線，推算產線安全靜置上限。
- **印刷機閉環補償 (RFC-SPI-2026-001)**：滾動阻尼濾波計算印刷機台即時補償向量（Offset X/Y 與角度 Theta），設置 Clamp 上限防護，並提供動態 AGI 鋼板擦拭觸發指標。
- **空間自相關分析 (RFC-SPI-2026-001)**：實作空間統計自相關引擎，以全局 Moran's I 與局部 LISA 聚類熱圖（High-High/Low-Low）精準標定頂針懸空與載具局部塌陷熱區。
- **管制圖體系**：S 圖中心線 c4(n)·σ̂、界限 ±3σ̂√(1−c4²)；不良率採 Laney P′ 圖（板間過度離散時放寬界限，揭露 σz）；判異規則依圖別套用；擴充 Xbar-R 管制圖（AIAG 常數）與 Hotelling T² 多變量管制圖；以 FastMCD 2D 雙變數離群值演算法進行卡方門檻保護。
- **失效模式交叉比對**（交叉驗證頁）：12 種錫膏印刷失效模式，各列支持與矛盾證據，證據分屬形狀、時間、空間、設計、對位、量測六個獨立面向；至少兩個面向支持、含必要面向且無矛盾才判「可能」；連動 SPI 製程知識庫 R001–R030。
- **結構化報告與分享**：支援多頁整頁結構化 PDF 報告輸出，嵌入 Noto Sans TC TrueType 子集中文字型（無豆腐字）；提供 Web Share 原生分享與整頁安全轉寄（#mail，mailto 1800 字元截斷防護）。

## 資料格式

最少需要一個數值欄位。建議欄位（中英文欄名自動辨識）：

`Board`、`Panel`、`Figure`、`Component`、`Package`（封裝，作為元件群組）、`Pin`／`Pad`、`PosX`、`PosY`、`Volume(%)`、`Height(um)`、`Area(%)`、`OffsetX`、`OffsetY`、`Pad L/W`、`Aperture L/W`、`Result`、`Stroke`、`Date`、`Time`、`Pressure`、`Speed`、`Separation speed`、`supplierWo`、`outsourceWo`

### 資料回溯（雲端資料庫）

- 匯入量測紀錄前填寫**批號**與**產品料號**（必填）；上傳座標檔前填寫**產品料號**與**版本**（必填）。原始檔自動上傳存入 Cloudflare 雲端資料庫（D1 + R2），之後在「資料與規格 → 資料庫」可搜尋、開啟分析、下載原始檔、驗證 SHA-256 指紋與刪除（限上傳者）。
- 回合、列印與分析報告都會帶批號、料號與原始檔指紋，可回溯到當初上傳的檔案。
- 量測資料庫 100% 依賴 Cloudflare 雲端（D1 + R2），不設在地 IndexedDB 或沙盒降級備援分支；未登入狀態維持 Fail-Closed 阻擋存取。

### 加工廠 SPI 格式

每家委外加工廠的 SPI 匯出格式不同，匯入前先在「① 加工廠 SPI 格式」選擇：

- **通用格式**：一列一筆量測，依欄名自動對應（也可存成機台格式設定檔）。
- **立榮電子**：一列一個焊墊，各板量測橫向排列（`Component ID`、`PAD ID`、`Height(%)1`、`Volume(%)1`、`Area(%)1`、`Result1`…`Result20`）。系統轉成一列一筆；高度 % 依鋼板厚度換算成 µm，**匯入前請先確認鋼板厚度**。TOP、BOT 各匯入成一個回合（依檔名判斷，也可手動指定）。
- **座標檔（選用）**：Layout 匯出的元件座標（`PartType`、`RefDes`、`X`、`Y`、`Layer`、`Orient.`），以位號對應補上板面位置並依封裝分群；單位 mil／mm／inch 可自動判斷。座標檔只有元件中心，同一元件的焊墊位置為近似。
- 新增其他加工廠格式時，在 `spi-spc.html` 的「加工廠 SPI格式」選單加一個選項，並在 `convertImp` 加入對應的轉換。

## 開發與測試

```bash
npm install            # 安裝測試用依賴 (jsdom, fake-indexeddb, wrangler)
npm test               # 執行全套 31 個測試檔、共 259 項單元與整合測試
npm run release-check  # 上線前檢查（版本、更新紀錄、除錯殘留、文件、相依、測試、機密、無障礙）
npm run test:slow      # 執行蒙地卡羅慢速整體判定模擬測試
```

## 部署

- **Cloudflare Workers（正式環境）**：
  - 專案使用 `npm run build:cloudflare` 建置前端資產，由 `wrangler.jsonc` 配置發布 Worker 與 `dist/` 中的首頁與 `vendor/`。
  - 後端整合 Cloudflare D1 資料庫（`spi-spc`）、R2 儲存桶（`spi-spc-record`）、Cloudflare AI Gateway（呼叫 Claude 3.5 Sonnet）與速率限制器（`LOGIN_LIMIT` 10 reqs/60s）。
  - 詳細切換與部署手冊見 [`docs/cutover-runbook.md`](file:///c:/Users/user/Documents/spi-spc%20analyst/docs/cutover-runbook.md)。
- **Netlify（歷史下線狀態）**：
  - 系統已完成由 Netlify 至 Cloudflare 之架構遷移。Netlify 平台資源之徹底下線與 Blobs 清理步驟詳見 [`docs/netlify-teardown.md`](file:///c:/Users/user/Documents/spi-spc%20analyst/docs/netlify-teardown.md)。
- **AI 分析**：
  - 在 claude.ai 內使用頁內 Claude；正式站點由後端 `/api/analyze` 透過 Cloudflare AI Gateway 呼叫 Claude（可用環境變數 `AI_MODEL` 指定模型）。只傳送統計摘要與問題清單，不傳送原始逐焊墊 SPI 資料。
- **全站登入防護**：
  - Cloudflare Worker 對全站頁面與 `/api/*` 要求帳號與加鹽 PBKDF2/PEPPER-HMAC 密碼驗證。同帳號或 IP 15 分鐘內失敗達門檻自動鎖定。

## 發版流程（每次改版必做）

1. **版本一致性**：更新版本號與更新時間（UTC+8，`YYYY-MM-DD HH:mm:ss`），確保以下單一來源完全一致：
   - `spi-spc.html` 內的 `#appVer` 與 `#appBuilt`
   - `lib/version.mjs` 的 `APP_VERSION` 與 `APP_BUILT`
   - `CHANGELOG.md` 最上方條目
   - `package.json` 的 `version`
2. **本機驗證閘門**：
   - 執行 `npm test`（31 個測試檔、259 項測試必須 100% 通過）
   - 執行 `node tools/release-check.js`（狀態必須為 `Overall: READY`）
   - 執行 `npm run build:cloudflare; npx wrangler deploy --dry-run`（建置資產產出且 dry-run 成功）
3. **部署至 Cloudflare Workers**：
   - 合併至 `main` 分支，由 Cloudflare Workers Git CI/CD 自動建置部署，或由系統管理員執行 `npm run build:cloudflare; npx wrangler deploy` 發布。
   - 確認 Cloudflare Workers 控制台或部署日誌顯示 Success / Deployed。
4. **線上版本與功能核對**：
   - 開啟正式站點 URL，核對頁首顯示的版本號與更新時間與步驟 1 完全相符。
   - 檢查登入、`/__me`、`/api/records` 正常運作，且瀏覽器 Console 無任何未預期錯誤。
5. **claude.ai 成品同步（選用）**：
   - 若同步維護 claude.ai 成品，使用同一份 `spi-spc.html` 更新 claude.ai 成品「SPI·SPC 分析台」，核對頁首版本與更新時間一致。

## 已知限制

- 只支援新版 Excel（.xlsx），舊版 .xls 請另存；讀取第一個有資料的工作表。
- 問題偵測門檻以範例與 60 組無異常蒙地卡羅模擬資料校正（警示以上誤報約 3%），真實資料若雜訊結構不同可透過自訂規格微調。
- 大量資料（20 萬筆以上）匯入時問題偵測改由背景 Web Worker 執行以避免主執行緒阻塞。
- DFM 建議值與 AOI 推算的規格窗口為依資料估算，開鋼板或修改規格前需實際驗證。
- 刮刀方向在資料沒有方向欄位或欄位不完整時，不再以板序奇偶推定，改顯示「無法比較」並略過刮刀檢定。
- 量測資料庫 100% 依賴 Cloudflare 雲端（D1 + R2），未登入或離線環境維持 Fail-Closed 阻擋存取。
