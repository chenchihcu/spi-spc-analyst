# RFC：料號規格（Part Spec）— 規格可編輯、儲存並綁定產品料號

- 狀態：已定案（VERIFY 已確認，見 §7；尚未實作）
- 基準：`origin/main` v9.13.5（行號以該版 `spi-spc.html` 為準）
- 相關：[`spec-cpk-spec-source-rfc.md`](spec-cpk-spec-source-rfc.md)（料號規格即該文 `formalSpec` 的 `source:"part"`）

---

## 0. 現況稽核（FACT）

| 項目 | 現況 | 位置 |
|---|---|---|
| 規格表可否編輯 | 只有 `specSrc !== "machine"` 時可編輯；「與機台判定一致」時整列 `disabled` | `renderSpecTbl`（:6487） |
| 規格存在哪裡 | 只存在**各回合設定** `snapCfg()`，寫入 IndexedDB `spi-spc` → `kv/runs`，只在這台電腦 | `snapCfg`（:6494）、`RunDB`／`saveRunsNow`（:6515–6523） |
| 依料號儲存 | **沒有**。換回合、換電腦、同料號新匯入都要重填 | — |
| 匯入工單規格 | 讀到的 `part` 只寫到 `S.part`；規格直接改當回合 `S.specs`；`woSpecFile` 不在 `snapCfg`，重新整理後遺失 | `parseWorkorderSpec`／`applyWorkorderSpec`（:2216–2242） |
| 可沿用的資料庫模式 | 座標檔 `kind:"place"`：依料號存入 records（雲端 D1＋R2／本機 `LocalRec`），不可變、SHA-256、稽核、`isDefault` 預設版 | `repo.setDefaultPlacement`（lib/repo.mjs:207）、`RecDB.setDefaultPlace`（:7370）、`?places_for=`（cloudflare/worker.mjs:73） |
| Schema 限制 | `records.kind` 為 `TEXT`，無 CHECK；已有索引 `idx_records_part_kind (part, kind, created DESC)` | migrations 0002、0005 |
| 回合的料號 | `runSrc(curRun()).part`；範例回合沒有料號 | `srcInfo`／`runSrc`（:7409–7410） |
| 高度規格 | µm 規格＝鋼板厚度 × `htol`；高度 % 才是可攜帶的規格 | `applyStencil`（:4839） |

**結論：** 目前欄位在自訂模式可編輯，但只存到當回合、當台電腦，**無法定義到產品料號**。

---

## 1. 問題與目標

### 問題
同一產品料號每次匯入都要重新輸入規格；不同電腦、不同使用者看到的規格可能不同；報告無法追溯「用的是哪一版規格」。機台模式只能用 PASS 範圍推估的規格窗，無法輸入加工廠提供的正式規格。

### 目標
- **G1** 規格表在「料號規格」模式可編輯。
- **G2** 一鍵「儲存為料號規格」，產生新的不可變版本（含建立者、時間、SHA-256）。
- **G3** 同料號新匯入或從資料庫開啟紀錄時，自動套用該料號的預設版。
- **G4** 分析頁、報告、PDF、匯出標示「料號規格 `<料號>` v`<n>`（SHA-256 前 12 碼）」。
- **G5** 建立、設為預設、刪除全部寫入稽核紀錄。

### 已決定事項
| # | 決策 |
|---|---|
| D1 | 綁定鍵：**只綁料號**（TOP／BOT 共用一組） |
| D2 | 粒度：**全板 6 項 ＋ 元件群組覆寫**；找不到群組規格時退回全板 |
| D3 | 版本：**不可變版本 ＋ 預設版**（與座標檔一致） |
| D4 | 與機台模式：**料號規格取代機台判定**。有料號規格時好壞依料號規格判定，機台判定碼只在「機台判定比對」頁對照 |
| D5 | 設為預設：**任何登入者**都可以（與座標檔一致），每次切換寫入稽核紀錄 |
| D6 | 匯入工單規格：**載入為料號規格草稿**，使用者確認後按「儲存為新版本」才寫入資料庫 |

### 非目標
- 面別、鋼板版本分開的規格。
- 焊墊／元件位號層級覆寫。
- 機台 Recipe 規格檔匯入。
- 前一份 RFC 的單一能力表 `capTable`（另案）。

---

## 2. 系統架構

### 2.1 規格來源
`specSrc` 新增 `"part"`，下拉選單 `#selSpecSrc`（:1187）新增「料號規格」。

匯入或開啟紀錄時的預設順序：

1. 該料號有預設版料號規格 → `part`
2. 資料有機台判定碼 → `machine`（現行行為）
3. 其他 → `custom`（現行行為）

### 2.2 判定
| 函式 | 修改 |
|---|---|
| `specOfGroup`（:1895） | `specSrc` 為 `machine` **或** `part` 時都讀 `st.specsG[g]`，否則用全板 |
| `classify`（:1897） | `part` 模式套用該群組規格後走 `specClassify`；**不走**機台判定碼早退分支（D4） |
| 機台判定比對（:6552） | `part` 模式下 `cs=S.specs`，自然變成「機台碼 vs 料號規格」；只改說明文字 |

### 2.3 編輯流程
```
選「料號規格」 → 載入預設版（或指定版本）→ 欄位可編輯
   └ 任一欄位改動 → 草稿（dirty），分析即時套用草稿值，標示「已修改，尚未存成新版本」
        ├ 「儲存為新版本」→ 產生規格 JSON → RecDB.create(kind:"spec") → 成為新預設（可勾選）
        └ 「放棄修改」→ 重新載入目前版本
切換回合、切換規格來源、離開頁面時有未存草稿 → 確認對話框
```
- 範例回合（無料號）：「儲存為料號規格」disabled，提示「請先匯入含產品料號的量測紀錄」。
- 自訂模式也可「儲存為料號規格」：把目前自訂規格存為該料號新版本並切到 `part`。

### 2.4 高度規格
- 以**高度 %** 為主；套用版本時寫入 `S.htol`，µm 高度由當回合鋼板厚度推算（沿用 `applyStencil` 邏輯）。
- 版本內記錄 `stencilRef`（儲存時的鋼板厚度）；與當回合厚度不同時提示，不自動改厚度。
- 階梯鋼板區域照現行規則，以區域厚度 × `htol` 計算。

### 2.5 群組覆寫編輯器
規格表下方新增「元件群組覆寫」子表：
- 選群組（清單取自目前資料的群組）→ 該群組 6 項 LSL／目標／USL，可新增、移除。
- 未覆寫的量測項目顯示全板值（淡色），表示沿用全板。
- 長群組名稱省略並以 tooltip 顯示全名。

---

## 3. 資料模型與介面

### 3.1 規格檔本體
存為 record 的原始檔（JSON，key 排序後的 canonical 序列化再算 SHA-256）：

```json
{
  "schema": "spi-part-spec/1",
  "part": "301-000100124",
  "stencilRef": 88,
  "specs": {
    "volume": { "lsl": 70, "tgt": 100, "usl": 130 },
    "hpct":   { "lsl": 75, "tgt": 100, "usl": 125 },
    "area":   { "lsl": 70, "tgt": 100, "usl": 130 },
    "offx":   { "lsl": -75, "tgt": 0, "usl": 75 },
    "offy":   { "lsl": -75, "tgt": 0, "usl": 75 }
  },
  "groups": {
    "U2 BGA": { "volume": { "lsl": 80, "tgt": 100, "usl": 120 } }
  },
  "note": "依加工廠 SPI 規格 2026-10"
}
```

驗證規則：數值皆為有限數、`lsl < usl`、`tgt` 在 `[lsl, usl]` 內（可空）；`groups` 的量測項目只限上列 5 項。不合格時拒絕套用並指出欄位。

### 3.2 Record 欄位
| 欄位 | 值 |
|---|---|
| `kind` | `"spec"`（新增值） |
| `part` | 產品料號（必填） |
| `side`、`rev`、`lot`、`vendor`、`place_id` | 空字串 |
| `name` | `規格_<料號>.json` |
| `meta` | `{ isDefault, note, basedOn }`（`basedOn`＝來源版本 id） |

- 版本號 v1…vn 由同料號依建立時間排序推得，不存欄位。
- 內容完全相同時，既有重複判定（`idx_records_same_file`、`findDuplicate`）回 409，不會產生重複版本。

### 3.3 後端（只新增 kind 值與動作，不改既有欄位）
| 檔案 | 修改 |
|---|---|
| `lib/records-core.mjs` `checkMeta` | 接受 `kind:"spec"`：必填 `part`，`isDefault`、`note`、`basedOn` |
| `lib/repo.mjs` | `setDefaultPlacement` 抽成 `setDefault(id, kind, user)`（place 依 part＋side、spec 依 part），原函式保留為包裝；新增 `getSpecsForPart(part)` |
| `cloudflare/worker.mjs` | `GET /api/records?specs_for=<料號>` → `{ specs, part }`；`PATCH action:"set_default_spec"`；`set_default_place` 不變 |
| 權限 | 刪除沿用「只有建立者」；建立、設為預設、刪除都寫 `audit_log` |
| Migration | **不需要** |

### 3.4 前端
| 位置 | 修改 |
|---|---|
| `recCheck`（:7307）、`recSame`（:7322） | spec 分支 |
| `LocalRec`、`RecDB`（:7324–7400） | `specsFor(part)`、`setDefaultSpec(id)`，本機模式對等實作 |
| `snapCfg`（:6494） | 新增 `partSpec: { id, part, ver, sha, dirty }`；舊回合沒有此欄 → 行為不變 |
| `setSpecSrc`（:6499）、`importCfg`（:6496）、匯入流程（:6799 起） | `part` 分支；匯入時先查該料號預設版 |
| `renderSpecTbl`（:6487）、`specSrcNote`（:4756） | `part` 模式可編輯、草稿標示、版本資訊、儲存／放棄按鈕 |
| `capInfo`／規格來源標籤（:6954）、報告（:8357）、PDF（:8656） | 顯示「料號規格 `<料號>` v`<n>`（SHA-256 前 12 碼）」 |
| 資料庫頁 | 類型篩選加入「料號規格」；可檢視版本、設為預設、套用、驗證指紋、下載 JSON |
| 分享連結 | cfg 已帶規格與 `partSpec`，分享頁自足，不需查資料庫 |

---

## 4. 安全、效能與上線

### 威脅模型
- 規格 JSON 由前端產生；後端對文字欄位沿用 `clean()`，數值在套用前驗證（§3.1）。
- 讀取與寫入都經既有登入（`x-spi-user`）；沒有新的公開端點。
- 設為預設會影響其他使用者的自動套用 → 寫入稽核紀錄（設定者、時間、前後版本）。

### 效能
- 每料號版本數預期少於數十筆；`specs_for` 走既有 `idx_records_part_kind`，單次查詢。
- 規格 JSON 小於 10 KB，不影響 R2／D1 用量。

### 相容與回退
- 無 migration；舊回合、舊分享照常開啟。
- 回退：移除下拉選項與自動套用即可，資料庫中的 spec 紀錄保留。

### 使用者可見變化
- 有料號規格的料號，原本機台模式的回合會改依料號規格判好壞（D4）：NG 數、問題清單、整體判定都可能改變。
- Cpk 在 `part` 模式使用料號規格（不是推估窗），不再標「下限」。
- CHANGELOG、報告註明規格來源與版本；版本號 minor 遞增。

---

## 5. 驗收與測試

| 類別 | 內容 | 測試檔 |
|---|---|---|
| 後端 | `checkMeta` spec 分支；`setDefault` 只切同料號、同 kind；相同內容回 409 | `tests/records.test.mjs`、`tests/cf-routes.test.mjs` |
| 判定 | `part` 模式＋群組覆寫：每列套用正確規格；未覆寫群組退回全板；有機台判定碼也依料號規格判定 | `tests/stats.test.js`、新增 `tests/part-spec.test.js` |
| 流程（jsdom） | 編輯 → 存版本 → 同料號新匯入自動套用 → 報告顯示「料號規格 v2」 | 比照 `tests/report-ai.test.mjs` |
| 本機／雲端 | 兩種 `RecDB` 模式行為一致 | `tests/records-ui.test.mjs` |
| 相容 | 舊回合（無 `partSpec`）、舊分享照常 | `tests/share.test.mjs`、`tests/golden.test.mjs` |
| UI | 桌面與手機寬度；未存草稿提示；鍵盤可操作；長 CJK 群組名稱省略＋tooltip | 手動截圖檢查 |
| 回歸 | `npm test` 全數通過 | — |

---

## 6. 分階段

1. **P1 資料層**：records-core、repo、worker、`RecDB`／`LocalRec`；加測試。
2. **P2 判定**：`specSrc:"part"`、`specOfGroup`／`classify`、群組覆寫；加測試。
3. **P3 規格設定頁**：版本清單、草稿、儲存／放棄、群組覆寫子表、匯入時自動套用、工單規格載入為草稿（§7 D6）。
4. **P4 標示與文件**：報告、PDF、匯出、資料庫頁；CHANGELOG、README、`package.json` version。

---

## 7. 已確認事項（原 VERIFY）

| # | 問題 | 決定 | 落實方式 |
|---|---|---|---|
| 1 | 誰可以「設為預設」 | **任何登入者**（D5） | `setDefault` 不檢查建立者；`audit_log` 記錄設定者、時間、前一預設版 id 與新預設版 id。刪除仍只限建立者 |
| 2 | 「匯入工單規格」怎麼處理 | **載入為料號規格草稿**（D6） | 見下 |

**匯入工單規格（D6）流程：**
- `applyWorkorderSpec`（:2232）改為：切到 `part` 模式，以目前料號版本（無則 `DEF_SPECS`）為底，覆上工單的 volume／area／height，標成草稿；不再直接改當回合 `S.specs` 後就結束。
- 工單只有 µm 高度時，依當回合鋼板厚度換算為高度 %（`hpct = height ÷ stencil × 100`），並提示換算基準。
- 工單 JSON 的 `part` 與當回合料號不同時，顯示警告並要求確認，不自動改料號。
- 按「儲存為新版本」時，`note` 預設帶入「工單規格：`<檔名>`」，`basedOn` 記錄原版本 id；修正目前 `woSpecFile` 重新整理後遺失的問題（改由版本 `note` 保存）。
- 歸入 **P3**；測試：工單匯入 → 草稿 → 儲存 → 版本 `note` 含檔名、`hpct` 換算正確。
