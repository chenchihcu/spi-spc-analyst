// 從單頁 HTML 取出統計核心（第一段 <script>），在獨立環境執行並回傳匯出函式
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const HTML = path.join(__dirname, "..", "spi-spc.html");

function loadCore() {
  const html = fs.readFileSync(HTML, "utf8");
  const core = html.match(/<script id="core">([\s\S]*?)<\/script>/)[1];
  const sandbox = { module: { exports: {} }, Math, Date, JSON, console, TextEncoder, TextDecoder, Uint8Array, DataView, ArrayBuffer };
  vm.runInNewContext(core, sandbox, { filename: "core.js" });
  return sandbox.module.exports;
}

function baseState(core, extra = {}) {
  const clone = (o) => JSON.parse(JSON.stringify(o));
  return {
    ...core.S,
    specs: clone(core.DEF_SPECS),
    stencil: 120,
    htol: { lo: 75, hi: 125 },
    step: { on: false, zones: [] },
    aperture: { groups: {} },
    wipe: 5,
    ...extra,
  };
}

// jsdom 沒有 IndexedDB：每個測試頁面給一個獨立的記憶體版（資料庫功能在 claude.ai／本機檔案時存在瀏覽器）
function withIdb(w) {
  const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
  w.indexedDB = new IDBFactory(); w.IDBKeyRange = IDBKeyRange;
  if (!w.TextEncoder) w.TextEncoder = TextEncoder; // jsdom 沒有，瀏覽器都有
  if (!w.TextDecoder) w.TextDecoder = TextDecoder;
}

// 規格一律由使用者定義：匯入流程測試先替料號存一版料號規格並設為預設（數值等同內建起始值、鋼板 120 µm），
// 匯入同料號時就會自動套用並帶入鋼板厚度，分析結果與改版前相同
async function seedPartSpec(w, part, { stencil = 120, specs = null, groups = {} } = {}) {
  const js = `(async()=>{const sp={schema:"spi-part-spec/1",part:${JSON.stringify(part)},stencilRef:${stencil},specs:{},groups:${JSON.stringify(groups)},note:"測試"};
    const src=${specs ? JSON.stringify(specs) : "DEF_SPECS"};for(const k of PART_SPEC_METRICS)sp.specs[k]={...src[k]};
    const e=partSpecEncode(sp);if(e.error)throw new Error(e.error);
    // Historical fixture only: product RecDB.create remains cloud-only.
    try{return await SPI_TEST_HOOK.LocalRec.create({kind:"spec",part:sp.part,makeDefault:true},e.bytes,"fixture@example.test")}
    catch(er){if(er.existing)return null;throw er}})()`;
  return w.eval(js);
}

module.exports = { loadCore, baseState, HTML, withIdb, seedPartSpec };
