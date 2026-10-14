// 從單頁 HTML 取出統計核心（第一段 <script>），在獨立環境執行並回傳匯出函式
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const HTML = path.join(__dirname, "..", "spi-spc.html");

function loadCore() {
  const html = fs.readFileSync(HTML, "utf8");
  const core = html.match(/<script id="core">([\s\S]*?)<\/script>/)[1];
  const sandbox = { module: { exports: {} }, Math, Date, JSON, console };
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

module.exports = { loadCore, baseState, HTML };
