# RFC：Cpk 規格來源與判定邏輯（Audit + Plan）

- 狀態：草案（本輪只做稽核與規劃，未修改程式碼）
- 基準：`origin/main` v9.13.4（行號以該版 `spi-spc.html` 為準）
- 稽核資料：線上唯一一筆 SPI 紀錄「301-000100124 TOP 量測紀錄.csv」（立榮格式，20 板、2,383 焊墊、47,660 筆）

---

## 1. 稽核結論（FACT）

### 1.1 原始資料沒有機台 LSL／USL
- 原始檔 82 欄，基本欄名只有：`Component ID`、`PAD ID`、`Height(%)n`、`Volume(%)n`、`Area(%)n`、`Result n`（n＝板序）。**無任何 LSL／USL／Limit／Spec 欄位。**
- 資料庫目前只有這 1 筆 SPI 紀錄（vendor＝lirong），沒有其他格式樣本可驗證。
- 匯入欄位定義 `FIELDS`（:2331）與立榮轉換 `wideCols`／`unpivotWide`（:6585／:6616）都不辨識規格欄；就算檔案有，也會被丟棄。
- 百分比基準：`Height(%)`、`Volume(%)`、`Area(%)` 為機台相對值（相對機台程式內的標稱厚度／開孔）。`Height(%)` 匯入時乘以鋼板厚度轉成 µm（:6673），系統再以 `hpct = height ÷ 有效厚度` 還原（:1876 `padThk`）。

**影響：** 依需求 1、5，在取得正式規格前，本紀錄所有 Cpk 都應顯示 **N/A**。

### 1.2 目前的規格來源（`S.specSrc`）

| 來源 | 實作 | 粒度 | 性質 |
|---|---|---|---|
| `custom` 自訂 | 規格設定表、`DEF_SPECS`（:1865） | 全板每量測項目一組 | 人工輸入，**預設值會被當正式規格** |
| `machine` 機台判定 | `machineSpecs`／`envelope`（:1884／:1889） | 全板＋每群組 | **PASS 讀值 min–max 推估**，循環論證 |
| `workorder` 工單 | `parseWorkorderSpec`／`applyWorkorderSpec`（:2216／:2232） | 全板；只有 volume／area／height | 外部 JSON，**沒有 hpct、沒有群組／焊墊層級** |
| `aoi` AOI 建議窗 | 交叉驗證頁 | 全板 | 由 AOI 對照推估，屬參考 |

### 1.3 Cpk 計算點與各自的規格來源（不一致）

| # | 位置 | 規格取法 | 問題 |
|---|---|---|---|
| C1 | `analyzeBase`（:1950，cap 於 :2040–2078） | ALL＝`st.specs`；群組＝`specOfGroup`；機台模式＋群組規格時取「最差群組」 | 分析頁、管制圖、能力頁的來源 |
| C2 | `detectIssues` capCells（:3610 `machCap`） | 機台模式強制全板 `st.specs`（v9.13.2 改的） | **與 C1 不同**：ED20 高度% 分析頁 0.06、整體判定 0.32 |
| C3 | `detectIssues` 系統性／焊墊位置卡（:3692–3730） | 同 C2；以穩健 Cpk（中位數／MAD） | 定義與 C1（σ_within）不同，卻同名「Cpk」 |
| C4 | `overallVerdict`（:4510；文字 :4193–4199） | 取 C2 的最差群組 | 判定由 Cpk 驅動 |
| C5 | `advAnalyze` 焊墊 Cpk（:2769） | `specFor`（群組規格） | 與 C2 不同 |
| C6 | `buildStatsData`／`statsDataCsv`（:2900／:2955） | `specFor`／`specOfGroup` | 匯出 CSV |
| C7 | `runGroupStats`／`compareRuns`（:4331／:4345） | 「整體」＝`st.specs`；群組＝`specOfGroup` | 試產比較 |
| C8 | `dfmTable0`（:4361）robust_cpk | **固定 `st.specs.volume`** | 不看群組規格 |
| C9 | `calcNonNormalCapability`（:3218） | 呼叫端傳入 | 跟隨 C1 |
| C10 | `renderReport`（:8360）、PDF（:8669、:8719） | 讀 `A.groups[].cpk/cp/ppk` | **這些欄位不存在**（A.groups 只有 g、n、mean、sd），報告「最差群組 Cpk」與能力表 **一律「—」** |
| C11 | `capInfo`／規格來源標籤（:6940／:6952） | 文字說明 | 未標示「僅供參考」 |

線上實測（同一群組、同一量測項目 高度%厚 · ED20）：分析頁 **0.06**（群組推估 113.3–139.9）／整體判定與問題清單 **0.32**（全板推估 67.7–154.8）／報告與 PDF **「—」**。

### 1.4 判定邏輯混用
- **單點 NG**：`classify`（:1897）在機台模式依 `Result`（機台判定碼），不依 Cpk；自訂模式依規格。這部分本身正確。
- **製程趨勢**：CUSUM、Nelson、單板異常等以穩健 z、中位數為基準，大多不依規格；但「≥8% 規格寬」等效果量門檻（:3622、:3633）與 M-03 單位檢查會讀規格寬。
- **能力**：系統性能力卡、整體判定的 Cpk 門檻（<1.00／<1.33）直接把推估規格當正式規格使用。

---

## 2. 目標設計

### 2.1 正式規格（Formal Spec）與參考規格分層
新增一層「正式規格」（不擴充既有 `specs` 共用契約，依核心規則 §6 獨立成層）：

```
st.formalSpec = {
  source: "machine-file" | "recipe" | "workorder" | "manual",
  file, importedAt, sha256,          // 可追溯
  part, side, recipe,                // 產品／Recipe
  entries: [ { scope: "pad"|"comp"|"group"|"all", key, metric, lsl, usl, tgt, unit, basis } ]
}
```

- 查找順序（最具體優先）：**焊墊 → 元件位號 → 群組（封裝） → 全板**；找不到 → **N/A**，不得退回推估值或 `DEF_SPECS`。
- `basis` 明確記錄百分比基準（例如 `hpct` 相對鋼板厚度、`volume` 相對開孔體積），單位不符時拒絕套用並提示。
- 既有 `machine` 的 PASS min–max（全板／群組）保留，改名顯示為「推估窗（Reference Only）」，只供圖上參考線與說明，**不參與 Cpk、問題卡等級、整體判定**。

### 2.2 單一能力表（Single Source of Truth）
新增純函式 `capTable(st)`（核心區），每個「群組 × 量測項目」（及需要時的焊墊）只算一次：

```
{ g, k, n, nBoards, mean, sigmaW, sigmaLT, cp, cpk, pp, ppk, ci,
  lsl, usl, specScope, specSource, specFile, status: "ok" | "na-nospec" | "na-n<10" | "na-sigma0" }
```

- C1–C11 全部改讀 `capTable`；`advAnalyze` 焊墊 Cpk 與穩健 Cpk 若保留，**改名區分**（例如「焊墊位置穩健能力指數」），不再叫 Cpk。
- 依 `anKey`／`clsSig` 同一組設定快取，報告、PDF、CSV、XLSX、AI 摘要讀同一份結果。

### 2.3 判定分離（需求 6）
| 類別 | 依據 | 是否需要正式規格 |
|---|---|---|
| 單點 NG | 機台判定碼（有時）或正式規格 | 機台模式不需要 |
| 製程趨勢／統計異常 | 穩健 z、CUSUM、Nelson | 否；效果量門檻改用「資料本身尺度」或正式規格，缺規格時只用 z 門檻 |
| 能力（Cpk／Ppk） | 正式規格 | **是**；缺 → N/A，不出系統性能力卡、不進整體判定 |

整體判定在 Cpk 為 N/A 時，理由改為「無正式規格，未評估製程能力」，等級只由 NG 與趨勢卡決定。

---

## 3. 修改位置

| 區塊 | 位置 | 修改 |
|---|---|---|
| 正式規格匯入 | 新增；`FIELDS`（:2331）、`wideCols`（:6585）、`parseWorkorderSpec`（:2216） | 辨識原始檔的 LSL／USL 欄（若有）；擴充工單規格 JSON 支援 `hpct` 與 group／comp／pad 範圍；可選機台 Recipe 規格檔匯入（需樣本） |
| 規格查找 | `specOfGroup`／`specFor`（:1895／:2722） | 新增 `formalSpecFor(r|g, k, st)`；舊函式保留供參考線 |
| 推估規格 | `machineSpecs`／`envelope`（:1884–1893） | 保留計算，結果改存 `st.refSpecs`，UI 標「Reference Only」 |
| 能力表 | 新增 `capTable` | C1–C9 改讀 |
| 問題偵測 | `detectIssues`（:3610、:3692–3730、:3622 效果量） | 系統性能力卡只在正式規格存在時產生；移除 v9.13.2 的 `machCap` 特例 |
| 整體判定 | `overallVerdict`（:4510） | 讀 `capTable`；N/A 時不以 Cpk 判定 |
| 報告／PDF | `renderReport`（:8360）、`generateReportPdfBlob`（:8669、:8719）、`reportMd`（:6888） | 讀 `capTable`，每筆附規格來源、LSL／USL、n；修正目前永遠「—」 |
| 匯出 | `statsDataCsv`、`buildStatsData`、`issuesCsv`／`issuesXlsx` | 新增欄 `spec_source`、`spec_scope`、`lsl`、`usl`、`cap_status`；既有欄位不刪不改名（相容） |
| UI 標示 | `capInfo`（:6940）、規格來源標籤（:6952）、規格設定頁 | 顯示正式規格來源；推估窗標 Reference Only；N/A 顯示原因 |
| 比較／DFM | `compareRuns`（:4345）、`dfmTable0`（:4361） | 讀 `capTable`；DFM 不再固定用全板 volume 規格 |

## 4. 影響範圍與相容性
- **資料結構：** 回合 `cfg` 新增 `formalSpec`（可選）。舊回合沒有此欄位 → 能力 N/A，原始資料與既有欄位不變。分享連結 payload 帶上 `formalSpec`；舊分享照常開啟。
- **API／D1：** 不改既有 `/api/records` 契約。正式規格檔若要存入資料庫，沿用 records（`kind:"spec"`），需另確認 migration（目前不需要）。
- **使用者可見行為：** 本紀錄現在顯示的 65 項中，**系統性能力卡與「最差群組 Cpk」理由會消失**（改 N/A），整體判定改由 NG 與趨勢卡決定。自訂模式使用者手動輸入的規格會被視為正式規格（`source: manual`），行為與現在相同。
- **既有測試：** `golden`、`verdict-sim`、`stats`、`report-ai`、`print`、`machine-cap` 的期望值會變，需逐項確認差異只來自規格來源調整。

## 5. 風險

| 風險 | 說明 | 緩解 |
|---|---|---|
| R1 沒有正式規格來源 | 立榮匯出檔沒有 LSL／USL，改完後本紀錄 Cpk 全部 N/A | 需要你提供：機台程式／Recipe 規格匯出，或工單／管制計畫規格（含群組、焊墊層級） |
| R2 百分比基準不一 | `Height(%)` 的基準是機台程式厚度；若與系統鋼板厚度不同，hpct 與規格比較會偏 | 正式規格記錄 `basis`；匯入時檢查厚度一致，不一致就提示 |
| R3 判定結果改變 | 整體判定、問題卡數量會變，影響已發出的報告比對 | CHANGELOG 與報告標示規格來源；保留舊版 PDF |
| R4 自訂預設規格被誤用為正式 | `DEF_SPECS` 預設值目前就是「正式」 | 未經使用者確認的預設值標記 `source: default`，視為 Reference Only |
| R5 範圍大 | C1–C11 共 11 個消費端 | 分階段：先建 `capTable`＋報告修正（不改判定），再切換規格來源 |

## 6. 分階段計畫
1. **P1 單一能力表（不改判定）：** 新增 `capTable`，C1–C11 全部改讀；修正報告／PDF 永遠「—」。加跨輸出一致性測試。
2. **P2 正式規格層：** `formalSpec` 資料結構、查找順序、N/A 規則；推估窗標 Reference Only；判定分離。
3. **P3 規格匯入：** 擴充工單規格 JSON（hpct、群組／焊墊範圍）；原始檔 LSL／USL 欄自動辨識（拿到含規格欄的樣本後實作）；可選 Recipe 匯入。
4. **P4 UI 與匯出：** 規格來源標示、N/A 原因、CSV／XLSX 新欄位。

## 7. 驗收方法
- **一致性（自動測試）：** 同一份測試資料，比對分析頁 `analyze`、`capTable`、`overallVerdict`、報告 DOM、PDF 文字、`statsDataCsv`、`issuesXlsx` 中每個「群組 × 量測項目」的 Cpk，**數值逐位相同**，且 LSL／USL、規格來源一致。
- **可追溯：** 每筆 Cpk 都帶 `specSource`、`specScope`、`lsl`、`usl`、`n`，報告與匯出可查。
- **不混用：** 測試資料設定兩個群組不同規格（含焊墊層級覆寫），確認每列都套用對應規格，沒有用到全板規格。
- **缺規格：** 無正式規格、規格無效（usl ≤ lsl、單位不符）、n < 10、σ = 0 → 全部顯示 N/A 與原因，不產生能力卡、不進整體判定。
- **公式：** 以手算資料驗證 Cp／Cpk／Pp／Ppk（σ_within＝合併組內標準差，σ_overall＝樣本標準差）與 95% 信賴區間。
- **前後端一致：** Worker 端（`lib/analyze-core.mjs`、AI 摘要）與頁面計算結果相同。
- **回歸：** `npm test` 全數通過；線上同一紀錄重跑，確認各頁顯示一致。

## 8. 需要你確認（VERIFY）
1. 正式規格從哪裡來：機台程式／Recipe 匯出檔、工單、管制計畫，還是人工輸入？能否提供一份樣本（含群組或焊墊層級）？
2. 立榮機台是否能匯出含 LSL／USL 的報表格式？
3. 機台 `Height(%)` 的基準厚度是機台程式設定值（88 µm？）還是其他？
4. 自訂模式的 `DEF_SPECS` 預設值（例如體積 70–130%）是否視為正式規格？建議否。
