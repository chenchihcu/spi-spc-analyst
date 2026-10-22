// 料號規格（kind:"spec"）規格檔本體的驗證與標準化序列化。
// 頁面 spi-spc.html 的 partSpecCheck／partSpecCanon 與這裡同一套規則（tests/part-spec.test.mjs 核對兩邊一致）。
//
// 規格檔 = 標準化 JSON（鍵排序、無空白）的 UTF-8；SHA-256 對這份文字計算，所以內容相同就是同一個指紋。
import { clean } from "./records-core.mjs";

export const PART_SPEC_SCHEMA = "spi-part-spec/1";
export const PART_SPEC_METRICS = ["volume", "hpct", "area", "offx", "offy"];
export const MAX_SPEC_RAW = 256 * 1024;   // 規格檔解壓後上限
export const MAX_SPEC_GROUPS = 500;

const LABEL = { volume: "體積", hpct: "高度 %", area: "面積", offx: "X 偏移", offy: "Y 偏移" };

/* 單一量測項目的規格窗：lsl < usl，目標可空，有值時須介於兩者之間 */
function win(w, where) {
  if (!w || typeof w !== "object" || Array.isArray(w)) return { error: `${where} 格式不正確` };
  const lsl = typeof w.lsl === "number" ? w.lsl : NaN, usl = typeof w.usl === "number" ? w.usl : NaN;
  if (!Number.isFinite(lsl) || !Number.isFinite(usl)) return { error: `${where} 的 LSL／USL 必須是數字` };
  if (!(lsl < usl)) return { error: `${where} 的 LSL 必須小於 USL` };
  let tgt = null;
  if (w.tgt != null) {
    tgt = typeof w.tgt === "number" ? w.tgt : NaN;
    if (!Number.isFinite(tgt) || tgt < lsl || tgt > usl) return { error: `${where} 的目標必須介於 LSL 與 USL 之間` };
  }
  return { w: { lsl, tgt, usl } };
}

/** 驗證並整理規格檔；回傳 { spec } 或 { error }（error 指出哪個欄位） */
export function partSpecCheck(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return { error: "規格檔格式不正確" };
  if (o.schema !== PART_SPEC_SCHEMA) return { error: `規格檔版本必須是 ${PART_SPEC_SCHEMA}` };
  const part = clean(o.part, 64);
  if (!part) return { error: "規格檔缺少產品料號" };
  if (!o.specs || typeof o.specs !== "object") return { error: "規格檔缺少全板規格" };
  const specs = {};
  for (const k of PART_SPEC_METRICS) {
    const r = win(o.specs[k], `全板 ${LABEL[k]}`);
    if (r.error) return r;
    specs[k] = r.w;
  }
  const groups = {};
  if (o.groups != null) {
    if (typeof o.groups !== "object" || Array.isArray(o.groups)) return { error: "群組覆寫格式不正確" };
    const keys = Object.keys(o.groups);
    if (keys.length > MAX_SPEC_GROUPS) return { error: `群組覆寫最多 ${MAX_SPEC_GROUPS} 個` };
    for (const g0 of keys) {
      const g = clean(g0, 64), src = o.groups[g0];
      if (!g) return { error: "群組覆寫的群組名稱不可空白" };
      // 群組名稱須與量測資料的群組完全相同才會套用，所以只驗證、不改寫
      if (g !== g0) return { error: `群組名稱「${g}」含不支援的字元、前後空白或超過 64 字` };
      if (!src || typeof src !== "object" || Array.isArray(src)) return { error: `群組 ${g} 格式不正確` };
      const ov = {};
      for (const k of Object.keys(src)) {
        if (!PART_SPEC_METRICS.includes(k)) return { error: `群組 ${g} 的量測項目 ${clean(k, 32)} 不支援` };
        const r = win(src[k], `群組 ${g} ${LABEL[k]}`);
        if (r.error) return r;
        ov[k] = r.w;
      }
      if (!Object.keys(ov).length) continue;
      groups[g] = ov;
    }
  }
  const sr = typeof o.stencilRef === "number" && Number.isFinite(o.stencilRef) && o.stencilRef >= 30 && o.stencilRef <= 300 ? o.stencilRef : null;
  return { spec: { schema: PART_SPEC_SCHEMA, part, stencilRef: sr, specs, groups, note: clean(o.note, 200) } };
}

/** 標準化序列化：物件鍵依字典序排序、無空白 */
export function partSpecCanon(v) {
  if (Array.isArray(v)) return "[" + v.map(partSpecCanon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + partSpecCanon(v[k])).join(",") + "}";
  return JSON.stringify(v);
}

/** 上傳時核對規格檔本體（已解壓的位元組）：可解析、通過驗證、已是標準化格式、料號與紀錄欄位相同 */
export function checkSpecBody(raw, meta) {
  if (!raw || raw.length > MAX_SPEC_RAW) return { error: `規格檔超過上限 ${MAX_SPEC_RAW / 1024} KB` };
  let text, o;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); o = JSON.parse(text); } catch { return { error: "規格檔不是有效的 JSON" }; }
  const chk = partSpecCheck(o);
  if (chk.error) return chk;
  if (partSpecCanon(chk.spec) !== text) return { error: "規格檔必須是標準化格式（請由系統產生）" };
  if (chk.spec.part !== meta.part) return { error: "規格檔的產品料號與紀錄欄位不同" };
  return { spec: chk.spec };
}
