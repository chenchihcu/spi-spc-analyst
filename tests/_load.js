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

module.exports = { loadCore, baseState, HTML, withIdb };
