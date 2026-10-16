# Apple iPhone / Safari 網站 UI/UX 設計與驗收規範

> **用途**：提供 Gemini（Vibe Coding AI Agent）在既有或新建 Website / Web App 專案中，進行 UI/UX 規劃、程式實作、Code Review 與驗收時使用。
>
> **版本**：v1.0｜**整理日期**：2026-10-16｜**主要裝置**：iPhone 16 Pro Max｜**語言**：繁體中文（保留技術英文）
>
> **適用對象**：以 iPhone Safari 為優先使用情境，仍需支援其他 iPhone、桌面 Chrome / Edge / Safari 的響應式網站。**這是 Web 規範，不是將 Apple 原生 App 的所有規則直接當成 HTML/CSS 標準。**

---

## 0. AI Agent 執行契約（先讀）

你是負責此專案的 **Senior Frontend Engineer + iOS Safari UI/UX Reviewer + Accessibility QA**。

1. **先稽核後修改**：先辨識現行框架、CSS 架構、路由、頁面清單、共用元件、既有設計系統與測試能力。先提交問題清單、影響範圍與修改計畫；除非任務明確授權，勿直接大規模重構。
2. **保持既有功能**：UI 優化不得破壞 API、資料欄位、身分驗證、權限、表單驗證、資料排序、查詢條件、業務邏輯或桌面操作流程。
3. **以內容決定斷點**：Mobile-first，但不可只針對 440px 硬編碼。桌機保留資訊密度；手機確保主要操作完整。
4. **遵循優先級**：先修 P0 阻斷操作／內容遭遮蔽／資訊遺失，再修 P1 操作效率與無障礙問題，最後優化 P2 視覺精緻度。若規範與已核准的專案需求衝突，先標記衝突並提出最小風險方案。
5. **務必驗證**：程式碼完成 ≠ 測試通過 ≠ iPhone 真機驗收。沒有真機或測試工具就明列 `NOT TESTED`，不得宣稱「Safari 已驗證」。
6. **禁止無目的變動**：不可為了「Apple 風格」擅自改字體套件、導入 UI framework、加入動畫、變更導航資訊架構或修改資料模型。
7. **交付證據**：至少輸出變更檔案、修改摘要、測試命令與結果、手機／桌機截圖或無法取得原因、未解風險與 Acceptance Gate 結果。

### 規範用語

- **MUST**：本專案預設之必要驗收條件；法規／WCAG 層級另於條文標明。
- **SHOULD**：強烈建議；有既有設計或技術理由可例外，須說明影響。
- **MAY**：選用功能；僅在需求成立且成本合理時實作。
- **P0 / P1 / P2**：修復優先順序；**非** Apple 官方分類。
- **官方依據** vs **專案建議**：不可混為一談，尤其是尺寸、字級、效能門檻。

## 1. 設計基準與裝置特性

| 項目 | 基準 | 性質／備註 |
|---|---|---|
| 主要裝置 | iPhone 16 Pro Max（6.9 吋） | Apple 技術規格 |
| 實體解析度 | **1320 × 2868 physical px** | Apple 技術規格；**不是** CSS `width` |
| Apple 介面版面尺寸 | **440 × 956 pt @3x**（直向） | Apple HIG 列載；螢幕點數不代表瀏覽器可見內容高度 |
| 一般預設 CSS 版面參考 | 約 **440 CSS px** 寬（直向） | 正常 Viewport 設定下常見；實際以 `window.innerWidth` / `visualViewport` 為準 |
| 主要輸入模式 | 手指觸控、直向單手操作 | 專案使用情境 |
| 螢幕避讓 | Dynamic Island、圓角、Home Indicator | 使用 safe-area，不寫死劉海高度 |
| Mobile 測試寬度 | **320 / 375 / 390 / 393 / 402 / 430 / 440 CSS px** | 涵蓋小螢幕、Reflow 與常見 iPhone；僅為測試案例 |
| 桌面測試寬度 | 768 / 1024 / 1280 / 1440 CSS px | 專案建議，不是固定斷點 |
| 方向 | Portrait + Landscape | 若某互動僅適合單一方向，提供可理解的替代使用方式 |

**Important**：瀏覽器頂部／底部工具列、Display Zoom、縮放設定、PWA standalone mode、鍵盤及橫直切換，都可能影響 `visualViewport`。**不得假設可用高度永遠是 956px，也不可把實體解析度直接當 CSS viewport。**

## 2. 需求矩陣（AI 實作優先讀這一節）

| ID | 優先級 | 要求與驗收標準 | 依據類型 | 驗證方法 |
|---|---|---|---|---|
| IOS-01 | P0 | 必須設置 `width=device-width, initial-scale=1`；保持使用者縮放能力 | Web/WCAG + 專案 | Inspect viewport meta；實機縮放 |
| IOS-02 | P0 | 主要資訊、表單操作與導覽不得被 Dynamic Island、圓角、Home Indicator、Safari 工具列遮擋 | Apple HIG / WebKit | 真機直向與橫向檢查 |
| IOS-03 | P0 | 一般內容在 **320 CSS px** 寬應可重排，不需水平捲動；資料表、地圖等雙向操作必要元素可例外 | WCAG 2.2 SC 1.4.10 AA | 320px Reflow、200% 字體縮放 |
| IOS-04 | P0 | **主要互動元件建議至少 44×44 CSS px 的可點擊區域**；不足者須檢討 | Apple HIG 44×44 **pt**（原生）轉化成 Web 專案準則；非 WCAG 原文 | DOM bounding box + 人工觸控 |
| IOS-05 | P0 | WCAG 2.2 AA 觸控目標符合 SC 2.5.8：一般至少 **24×24 CSS px** 或滿足正式例外條件；專案仍以 IOS-04 較嚴格目標優先 | WCAG 2.2 AA | 量測目標大小與間距 |
| IOS-06 | P0 | iOS 螢幕鍵盤出現時，焦點欄位、錯誤訊息、儲存／送出操作仍可使用 | 專案高風險驗收項目 | 真機逐欄測試 |
| IOS-07 | P0 | 表單資料不因導覽、旋轉、失焦而意外遺失；不可重複送出造成重複交易 | 專案功能完整性 | E2E + 真機 |
| IOS-08 | P0 | 禁止把 `user-scalable=no` 或 `maximum-scale=1` 當作修復輸入欄位放大問題的捷徑 | WCAG / 專案 | Source inspection |
| IOS-09 | P1 | 文字、卡片、表格、圖表在小螢幕不得被裁切而使關鍵資料不可取得 | Apple 適應式設計 / 專案 | 視覺回歸 + 操作 |
| IOS-10 | P1 | 主操作明確，容易以單手觸達；固定底部操作列不得與 Safari 或 Home Indicator 衝突 | 專案建議 | 真機操作與截圖 |
| IOS-11 | P1 | 支援鍵盤操作、焦點顯示、可見欄位標籤、VoiceOver 語意 | WCAG 2.2 AA | Accessibility tree + 人工 |
| IOS-12 | P1 | 文字對比：一般文字 ≥4.5:1、大文字 ≥3:1；非文字 UI 關鍵邊界／狀態 ≥3:1（依例外） | WCAG 2.2 AA | 對比工具 |
| IOS-13 | P1 | 顏色不可作為 OK／NG／Warning 唯一判斷依據；須搭配文字或可辨識圖示 | WCAG 原則 / 專案 | 視覺／灰階驗證 |
| IOS-14 | P1 | 不依賴 hover 才顯示必要操作；手勢需有非複雜手勢的替代操作 | Mobile / WCAG | Touch only 測試 |
| IOS-15 | P1 | Light / Dark Mode 內容具足夠對比；支援時應維持狀態顏色語意一致 | 專案建議 | 雙模式截圖 |
| IOS-16 | P1 | 防止異常水平溢出：檢查子元素、表格、SVG、長字串，而非全面套用 `overflow-x:hidden` 掩蓋問題 | 專案建議 | 320/440px 檢查 |
| IOS-17 | P2 | 動效輕量並支援 `prefers-reduced-motion`；禁止無必要的轉場造成操作延遲 | Apple Accessibility / WCAG 相關精神 | 系統減少動態效果測試 |
| IOS-18 | P2 | 需要「加入主畫面」時，再評估 manifest、standalone、圖示、離線與快取策略 | WebKit（條件性） | Safari + Home Screen 測試 |

### 2.1 觸控尺寸判定的重要區別

Apple HIG 對 **iOS 原生觸控控制項**提出 44×44 **pt** 的典型尺寸；WCAG 2.2 SC 2.5.8（AA）談的是 24×24 **CSS px** 及例外。這兩者不是同一件事。**本文件的「主要控制項 44×44 CSS px」是為 iPhone Web UI 設定的保守工程目標，不應引用為 Apple 強制規定的 Web CSS 像素值。**

## 3. Responsive Layout 與 Safe Area

### 3.1 必須採用的基礎 Viewport

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
```

- `viewport-fit=cover` 讓內容可以延伸到螢幕邊緣。**若採用此設定，務必自行處理 safe-area**；若專案不需要 edge-to-edge，可使用預設 inset 行為，勿為追求全螢幕而增加風險。
- 不加入 `user-scalable=no`、`maximum-scale=1`。

### 3.2 建議 CSS 基底（依現行設計系統調整）

```css
:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --tap-target: 44px; /* Web 專案觸控目標，不是 Apple HIG 原文 */
  --mobile-nav-size: 56px;
}

*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; min-width: 0; }
img, video, canvas, svg { max-width: 100%; }
img, video { height: auto; }

/* 內容區左右保留基本 margin；橫向 safe area 取較大值，避免過度留白 */
.page-content {
  padding-inline: max(16px, env(safe-area-inset-left, 0px))
                  max(16px, env(safe-area-inset-right, 0px));
  min-width: 0;
}

/* 真正要佔滿視窗的頁面容器；一般長內容優先自然滾動 */
.app-shell {
  min-height: 100vh;  /* fallback */
  min-height: 100svh; /* 減少網址列顯示／收合造成的初始跳動 */
}

/* 使用固定底部導覽時：保留導覽高度與 safe-area 的閱讀空間 */
.page-content.has-bottom-nav {
  padding-bottom: calc(var(--mobile-nav-size) + 16px + env(safe-area-inset-bottom, 0px));
}
.bottom-nav {
  position: fixed;
  inset-inline: 0;
  bottom: 0;
  min-height: var(--mobile-nav-size);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  padding-inline: max(12px, env(safe-area-inset-left, 0px))
                  max(12px, env(safe-area-inset-right, 0px));
  /* 背景色、邊框及 stacking context 請沿用專案 tokens */
}

button, .icon-button, .primary-action {
  min-width: var(--tap-target);
  min-height: var(--tap-target);
}

input, select, textarea {
  font-size: 16px; /* iOS Safari focus 時減少自動放大風險的實務基準 */
}

:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .decorative-motion { animation: none; transition: none; }
}
```

**實作提醒**：上例是可調整的 starter snippet，不可直接覆蓋既有 CSS 導致樣式衝突。Safe Area 應由共同 Shell / Header / Bottom Bar **統一管理**，避免每層重複加 `env()` 造成雙倍空白。若底部導覽的內容高度超出 56px，須以實際尺寸調整預留空間。

### 3.3 Viewport 高度與鍵盤

- **SHOULD**：一般表單與長頁面使用自然 `overflow-y:auto` 與 `min-height`，不要全部設成固定 `height:100vh`。
- `100svh` 適合偏穩定的小 viewport；`100dvh` 適合需跟隨 Safari UI 改變的滿版區域。**兩者都不能保證在軟體鍵盤開啟時完全等於可見可操作高度**。
- 當頁面包含固定底部輸入框、聊天輸入列或複雜編輯器，**先做 iPhone 實測**；必要時再使用 `window.visualViewport` 觀察尺寸／位移，實作集中且有移除事件監聽的補償邏輯。
- 鍵盤展開時不得發生：焦點輸入框被蓋住、送出鍵無法按、畫面無限彈跳、捲動鎖死。

### 3.4 Breakpoints

- 依內容在何寬度開始溢出決定 breakpoint，而非規定「所有頁面都是 768px 切手機」。
- 320–440px：通常單欄、主要資訊優先、導覽精簡；不得刪掉關鍵功能。
- 600–900px：視內容考慮雙欄／側欄縮合；數值只是設計探索區間。
- ≥1024px：保持現有桌機密集資料操作體驗。
- 以 `minmax(0, 1fr)`、`min-width:0`、容器查詢／Grid／Flex 解決真實溢出，不透過縮小文字硬塞。

## 4. Typography、Spacing 與內容密度

| 元素 | 建議 Web 尺寸 | 注意事項 |
|---|---:|---|
| 內文 | 16–17 CSS px | 專案建議，非 Apple 法定下限；字距與長行另評估 |
| 內文行高 | 1.45–1.65 | 中文、英文及數字混排要檢查換行 |
| 次要文字 | 優先 ≥14 CSS px | 不能因為「高密度」讓必要內容難讀 |
| 表單 input / select / textarea | ≥16 CSS px | iOS Safari 字級過小可能觸發聚焦放大；為相容性實務建議 |
| 頁面標題 | 約 24–28 CSS px | 依內容與既有層級調整 |
| 區塊標題 | 約 18–22 CSS px | 保持與內文有可見層級 |
| 頁面左右邊距 | 16–20 CSS px | Safe Area 在橫向另行避讓 |
| 卡片內距 | 12–16 CSS px | 常用操作不宜過度疏鬆 |
| 操作元件間距 | 通常 ≥8 CSS px | 此數值為專案設計值；實際需防止誤觸 |

- 優先採 `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`，避免無必要的額外下載字體；中文實際 glyph 由系統 fallback 處理。
- 使用 `rem`／相對尺寸，保留瀏覽器文字縮放；不得固定元素高度導致放大後截字。
- 數字、單位、狀態、SN、批號、日期皆須顯示完整；必要縮寫要有點擊展開／詳細頁。
- 文字與背景對比按 WCAG AA 驗證；不以顏色單獨表示流程狀態。

## 5. Navigation 與觸控互動

### 5.1 導覽原則

- **MUST**：手機任務流程可在有限步驟內完成；桌面側邊欄若縮成 Drawer，所有原功能仍可抵達。
- **SHOULD**：主要導覽項數量少且穩定；底部分頁適用於少量同層級高頻入口，**不是所有頁面都應強制做成底部 Tab Bar**。
- **MUST**：目前所在頁有明確標示。深層頁面具備清楚的返回／上一層路徑，不截斷 iOS Safari 原生返回手勢。
- **MUST**：`button` 處理動作、`a` 處理導航；圖示按鈕需可辨識名稱 (`aria-label`)，不可只用無語意 `div` 點擊。
- **MUST**：hover-only 功能必須在 touch 可用；滑動、拖曳、長按不能是完成核心操作的唯一途徑。
- **SHOULD**：破壞性操作（刪除、撤銷、批次更新）有確認機制或可恢復策略；資訊明確說明影響。
- **MUST**：不要以自訂事件攔截與系統衝突的 edge swipe／pinch-zoom。

### 5.2 Modal / Sheet / Toast

- 表單很多的 Modal 在手機應採可捲動 Sheet / Fullscreen Dialog；提供明確關閉方式。
- Dialog 需有標題、焦點管理、Escape／關閉鍵，背景狀態不被錯誤操作；不要用 `z-index:999999` 掩蓋 layering 問題。
- 警告／錯誤不能只用消失很快的 Toast；關鍵失敗需保留可閱讀的訊息與重試路徑。
- 顯示載入／送出中狀態；防止重複送出。不能以禁用所有功能替代正確處理併發及錯誤。

## 6. Forms、iOS 鍵盤與資料完整性

- 每個可輸入元件都具有可見 `label`；錯誤訊息與欄位以 `aria-describedby` 等方式關聯。
- `input` 設計按語意提供 `type`、`inputmode`、`autocomplete`；例如 email、電話、數字，但數字字串／工單號／序號不可未評估就使用會截斷前導零的 `type=number`。
- 錯誤資訊緊鄰輸入欄位並能在提交後定位；不得只有紅框沒有文字。
- 必填欄位與非必填欄位清楚標示；按鈕停用需提示原因（或可發現的修正方法）。
- 送出按鈕在鍵盤開啟時可以捲動到；**不要**只用 `position:fixed; bottom:0` 解決所有表單。
- 對可破壞性變更或長表單，依原專案需求採用 dirty-state 離開提醒／草稿保護；禁止偷偷增加自動儲存或交易語意。
- 錯誤／空資料／載入中／無權限／離線等狀態必須分開處理。

**特殊功能（僅在網站確實有需要時）**：相機、QR 掃描、檔案上傳須考慮 HTTPS、使用者授權、拒絕後提示、重試、人工輸入備援、後鏡頭選擇及方向切換。不得假定權限或相機一定可用。

## 7. 高資訊密度網站的手機版（表格、儀表板、分析圖）

**適用於後台管理系統、品質管理、稽核、製程分析、追溯、庫存等 Web App。**

| 桌面常見元件 | 手機優先處理方式 | 驗收重點 |
|---|---|---|
| 10+ 欄大型資料表 | 關鍵欄卡片化，詳情展開；仍可保留有標示的橫向捲動表格 | 不刪欄位／不截斷 ID、SN、數值與單位；排序／過濾仍可用 |
| 多欄篩選器 | Filter Sheet／可折疊區域，顯示目前條件與清除入口 | 套用與清除互斥清楚，回到列表狀態保留 |
| KPI Dashboard | 首屏顯示 2–4 項最關鍵 KPI，其餘依序排列 | 數值與期間／母數／單位不混淆 |
| 大型趨勢圖 | 適應容器、可觸控資料點、提供表格或可讀摘要 | 圖例／刻度／Tooltip 不被裁切、不得只靠顏色區分 |
| 長流程表單 | 分段與步驟進度；明確保存狀態 | 切頁／回上一步不遺失輸入 |
| 稽核／異常追蹤紀錄 | 主列表顯示狀態、單號、負責、時間；進入詳情 | 保持來源資料、狀態與稽核軌跡正確 |

**禁止事項**：為了讓手機「乾淨」，默默隱藏必要欄位、截斷關鍵資料、刪除錯誤訊息、改寫商業規則，或以只顯示數字不顯示單位／期間的 KPI 代替完整資訊。

## 8. Accessibility（WCAG 2.2 AA 作為目標）

實作必須涵蓋：

1. **文字對比**：一般至少 4.5:1、大文字至少 3:1；必要圖示、輸入框邊界等非文字內容通常至少 3:1（依 WCAG 例外判定）。
2. **縮放與重排**：至少支援 200% 文字放大與 320 CSS px 寬度 Reflow；不得因固定高度讓欄位／按鈕不可達。
3. **觸控尺寸**：驗證 WCAG 2.2 SC 2.5.8 AA（24×24 CSS px 或合法例外），並以專案 44px 主要控制項目標提升實務觸控性。
4. **焦點可見且不被遮擋**：Keyboard focus 有可見框；Sticky Header / Bottom Bar 不得完全遮擋焦點元件（SC 2.4.11 AA）。
5. **語意 HTML**：適當的 heading、landmark、label、button、link、table header；VoiceOver 可唸出名稱、角色、狀態。
6. **錯誤與狀態**：不只顏色；進度／錯誤／成功訊息在必要時以 ARIA live region 合理告知，避免過量播報。
7. **動作替代**：拖曳、複雜指勢需有等效操作路徑；不依賴精準點小圖示才能完成主要工作。

> 自動掃描（如 axe / Lighthouse）只能找出部分問題；VoiceOver、真機觸控與完整任務流程仍須人工驗收。

## 9. 視覺風格、系統模式與 PWA

- **Apple-like ≠ 複製 Apple 官方介面**。優先簡潔、清楚層級、足夠留白、操作狀態明確，不擅自大幅更改品牌色或模擬原生 App 元件。
- Light / Dark 依既有專案需求與 `prefers-color-scheme` 實作。若已有使用者主題切換，應尊重使用者選擇，避免與系統設定競爭。
- 可採用系統字體、適度圓角與輕量動畫；是否使用玻璃效果、模糊背景、液態玻璃風格，**應以可讀性、效能與既有品牌為先**，非必要規範。
- 支援 `prefers-reduced-motion`；無須為裝飾性動畫犧牲反應時間。
- **PWA 為條件性功能**：若使用者需要加到 iPhone 主畫面，可配置 manifest、app icons、`apple-touch-icon`、standalone 和適當快取。切記 Safari 分頁與 Home Screen Web App 的視窗、權限、登入、瀏覽行為應分別測試。
- Safari 26（iOS 26）起「加入主畫面」預設可開啟為 Web App，但仍受使用者選項影響；**不要把 PWA 行為寫成所有 iOS 版本相同**。
- 避免為了 PWA 而引入會快取過期業務資料的 Service Worker；涉及庫存、狀態、品管紀錄等資料時，須有明確同步／更新策略。

## 10. Performance 與可維護性

### 建議量測指標（不是 Apple HIG 門檻）

| 指標 | 建議目標 | 來源與解讀 |
|---|---|---|
| Largest Contentful Paint (LCP) | ≤2.5 秒 | Core Web Vitals；**正式現場數據以 P75 為判定** |
| Interaction to Next Paint (INP) | ≤200 ms | Core Web Vitals；**正式現場數據以 P75 為判定** |
| Cumulative Layout Shift (CLS) | ≤0.1 | Core Web Vitals；**正式現場數據以 P75 為判定** |

- 以上屬**效能目標**；新專案可列入 Gate，既有專案無實際量測基線時先建立 baseline，不能假裝已通過。
- 圖片使用適合的尺寸、格式與延遲載入；避免首次載入將所有大型圖表／資料表渲染完畢。
- 避免滾動時大量 re-render、無必要的 JS 動畫、複製多套 iPhone 專用元件。
- 既有框架、UI 套件、狀態管理優先沿用；新增第三方依賴須說明目的與必要性。
- 變更必須避免全域 CSS 覆蓋造成其他頁面 regressions。

## 11. 測試矩陣與 Acceptance Gates

### 11.1 測試環境

| 編號 | 裝置／Viewport | 必測項目 | 驗收證據 |
|---|---|---|---|
| T01 | **iPhone 16 Pro Max 真機 / Safari / Portrait** | 首屏、導覽、表單、觸控、Dynamic Island、Home Indicator | 實機截圖 + 手動操作結果 |
| T02 | **同機 / Safari / Landscape** | 左右 Safe Area、圖表、表格、固定導覽 | 實機截圖 |
| T03 | 同機 / 鍵盤開啟 | 欄位焦點、捲動、底部儲存鍵、錯誤訊息 | 逐欄操作紀錄 |
| T04 | 同機 / Safari 工具列展開與收合 | Sticky／Fixed 元件不跳動、不遮擋 | 兩狀態截圖 |
| T05 | 同機 / 文字放大、系統 Dark Mode | 換行、不截字、對比度、焦點 | 截圖 + checklist |
| T06 | CSS 320px（瀏覽器可重現環境） | WCAG Reflow：非例外內容無雙向捲動 | 視覺截圖／DOM 記錄 |
| T07 | CSS 390 / 402 / 430 / 440px | 代表性 iPhone 寬度與斷點回歸 | 截圖比對 |
| T08 | Desktop 1024 / 1440px | 不破壞桌面導覽、表格、操作與可讀性 | 截圖 + smoke test |
| T09 | **有 PWA 需求時**：Home Screen Web App | standalone、登入、返回、導覽、快取／刷新 | 真機證據 |
| T10 | VoiceOver／鍵盤導覽（可用環境） | 按鈕名稱、焦點順序、錯誤與狀態語意 | 手動紀錄 |

### 11.2 Acceptance Gates

**Gate A — Architecture / Scope（實作前）**

- [ ] 已盤點路由、重要功能頁、導覽、表單、表格、圖表與既有樣式。
- [ ] 已列出「不允許變動」的 API、schema、資料驗證、業務規則與桌面流程。
- [ ] 已建立 P0/P1/P2 問題清單及影響範圍。
- [ ] 已確認哪些項目可以自動化、哪些必須 iPhone 真機驗收。

**Gate B — Implementation（實作後）**

- [ ] IOS-01～IOS-08 所有 P0 項目都已檢查；不符合的已修復或明列阻擋原因。
- [ ] Safe Area、底部導覽、鍵盤、320px Reflow 處理正確。
- [ ] 關鍵資料未因手機卡片化而遺失／更改。
- [ ] 主要控制項觸控熱區符合專案 44px 目標，例外附理由。
- [ ] 程式碼遵循既有元件與樣式系統，沒有非必要依賴。

**Gate C — Automated Verification（執行測試並記錄）**

- [ ] lint / type-check / unit tests：記錄實際命令與 Pass/Fail。
- [ ] build：記錄實際命令與 Pass/Fail。
- [ ] 代表性頁面 browser smoke test：登入、導航、查詢、編輯、儲存、錯誤路徑。
- [ ] 視覺與 Accessibility 工具掃描：記錄問題，不以工具無警告等同 WCAG 合規。
- [ ] 出現失敗時，附失敗原因、重現方式、修復狀態；不宣稱全數通過。

**Gate D — iPhone 真機驗收（不可由模擬器自動替代）**

- [ ] T01～T05 實機通過；若無設備，標記 **NOT TESTED**。
- [ ] 能單手完成至少一條主要任務流程，且沒有誤觸／遮擋。
- [ ] 實際輸入、錯誤提示、鍵盤收合、表單提交正常。
- [ ] 無資料遺失、無核心功能失效、無非預期水平溢出。
- [ ] 必要截圖與測試結果可追溯至版本／commit／頁面。

### 11.3 缺陷回報格式

```text
Issue ID:
Page / Route:
Device / iOS / Safari version:
Viewport / Orientation:
Severity: P0 | P1 | P2
Expected:
Actual:
Reproduction steps:
Screenshot / video:
Affected requirement: IOS-XX
Root cause hypothesis (not yet proven):
Fix / Change file:
Retest result: PASS | FAIL | NOT TESTED
Residual risk:
```

## 12. Gemini 建議工作流程（固定使用）

```text
Phase 0: Read / Audit
  → 查現有檔案、UI 架構與路由；列出 P0/P1/P2 問題與重現條件。
  → 本階段預設不改碼。

Phase 1: Plan
  → 逐項對應 IOS-XX 規則、修改位置、設計方式、風險與驗證。
  → 優先 minimal-diff，不為美觀重寫架構。

Phase 2: Implement
  → 先共用基礎元件和 Safe Area，再修頁面型問題。
  → 保持原資料語意、使用者流程與 desktop behavior。

Phase 3: Verify
  → lint / typecheck / tests / build / responsive screenshots / accessibility。
  → 執行到的才記 PASS；無 iPhone 真機就記 NOT TESTED。

Phase 4: Report
  → 問題→修正→驗證→剩餘風險的追溯表；附 commit 和截圖。
  → 未通過 Gate D 不得宣稱「iPhone 真機驗收完成」。
```

### 12.1 可直接貼給 Gemini 的任務提示詞

> 請將 `APPLE_IPHONE_WEB_UI_UX_STANDARD.md` 視為此網站的 UI/UX 設計與驗收準則。主要裝置是 iPhone 16 Pro Max，操作環境為 iOS Safari；仍須維持 desktop 正常使用。先盤點整個專案（路由、主要頁面、共用元件、表單、資料表、圖表、導覽、既有測試），**本輪先做 Audit + Plan，不要修改程式碼**。以 IOS-XX 規則逐項對照，輸出 P0/P1/P2 問題、截圖或程式碼證據、原因假說、影響範圍、建議修正、驗證方式與驗收 Gate。待獲准實作時採最小必要變更，不得改動 API、權限、資料欄位或業務邏輯。所有未執行的真機測試一律標記 NOT TESTED，不得以模擬截圖冒稱真機 PASS。

## 13. 參考文獻與適用性

以下網站為本文件的主要資料依據（查核日期：2026-10-16）。官方文件如有更新，以當時版本及專案契約要求重新核對。

1. **Apple iPhone 16 Pro Max 技術規格**：https://support.apple.com/zh-tw/121032 — 6.9 吋、1320×2868 實體像素、Dynamic Island、ProMotion。
2. **Apple Human Interface Guidelines — Layout**：https://developer.apple.com/design/human-interface-guidelines/layout — 自適應介面、safe area、方向與系統特性。
3. **Apple UI Design Dos and Don'ts**：https://developer.apple.com/design/tips/ — 原生控制項 44 pt 觸控參考、文字與版面建議。
4. **WebKit — Designing Websites for iPhone X**：https://webkit.org/blog/7929/designing-websites-for-iphone-x/ — Web `viewport-fit=cover`、`env(safe-area-inset-*)`、安全區域處理。雖為較早文章，所述 API 仍屬 WebKit 基礎做法。
5. **WebKit — Safari 15.4**：https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/ — `svh`、`lvh`、`dvh` 與現代 CSS。
6. **W3C WCAG 2.2 — Target Size (Minimum)**：https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum — 24 CSS px 與例外；**不是 Apple 44 pt 規範**。
7. **W3C WCAG 2.2 — Reflow**：https://www.w3.org/WAI/WCAG22/Understanding/reflow.html — 320 CSS px 的 Reflow 原則與例外。
8. **W3C WCAG 2.2 — Focus Not Obscured**：https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum — 固定元件不得完全遮擋焦點。
9. **W3C ACT — Meta Viewport Allows Zoom**：https://www.w3.org/WAI/standards-guidelines/act/rules/b4f0c3/ — viewport 不應限制縮放。
10. **Google web.dev — Core Web Vitals Thresholds**：https://web.dev/articles/defining-core-web-vitals-thresholds — LCP、INP、CLS 良好範圍與 P75。
11. **WebKit — Safari 26.0**：https://webkit.org/blog/17333/webkit-features-in-safari-26-0/ — iOS 26 Home Screen Web Apps 行為。
12. **Gemini CLI — GEMINI.md Context Files**：https://geminicli.com/docs/cli/gemini-md/ — 專案規範檔及 `@...md` 匯入機制。

### 不得誤用的結論

- **不是**「iPhone 16 Pro Max 網頁只能設計 440×956px」；這只是裝置版面參考，不是可見視窗固定值。
- **不是**「所有元素都必須 44pt／44px」；Apple 原生 44pt、WCAG AA 24 CSS px 和本專案 44 CSS px 目標須分清。
- **不是**「使用 `100dvh` 就自動解決鍵盤遮擋」。
- **不是**「所有網站都要做底部 Tab Bar、PWA 或 Liquid Glass」。
- **不是**「模擬器截圖正常就代表 iPhone Safari 真機已驗收」。

---

**文件維護規則**：每次修訂更新版本號、日期、IOS-XX 受影響項目與原因；驗收結果應記錄在專案測試報告，不要把這份通用規範當成實際測試完成紀錄。
