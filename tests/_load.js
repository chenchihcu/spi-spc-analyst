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

// jsdom 沒有 IndexedDB：供頁面試產回合暫存（RunDB）在測試環境使用
function withIdb(w) {
  const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
  w.indexedDB = new IDBFactory(); w.IDBKeyRange = IDBKeyRange;
  if (!w.TextEncoder) w.TextEncoder = TextEncoder; // jsdom 沒有，瀏覽器都有
  if (!w.TextDecoder) w.TextDecoder = TextDecoder;
  if (!w.Blob) w.Blob = Blob;
  if (!w.CompressionStream) w.CompressionStream = CompressionStream;
  if (!w.DecompressionStream) w.DecompressionStream = DecompressionStream;
  if (!w.Response) w.Response = Response;

  // 測試環境預設 Mock 雲端 API（若測試未自訂 w.fetch）
  if (!w.fetch) {
    const memRecords = [];
    w.fetch = async (url, opts = {}) => {
      const u = new URL(url, "https://example.test/");
      if (u.pathname === "/__me") {
        return Response.json({ user: "測試員" });
      }
      if (u.pathname === "/api/records") {
        const method = (opts.method || "GET").toUpperCase();
        if (method === "GET") {
          return Response.json({ records: memRecords, me: "測試員" });
        }
        if (method === "POST") {
          const headers = opts.headers || {};
          let meta = {};
          try { meta = JSON.parse(decodeURIComponent(headers["X-Rec-Meta"] || headers["x-rec-meta"] || "")); } catch {}
          const id = "REC" + Math.random().toString(36).slice(2, 10);
          const rec = { ...meta, id, user: "測試員", created: Date.now(), bytes: +(headers["X-Raw-Bytes"] || 0), sha256: headers["X-Raw-SHA256"] || "" };
          memRecords.unshift(rec);
          return Response.json({ record: rec });
        }
      }
      return new Response("Not found", { status: 404 });
    };
  }
}

module.exports = { loadCore, baseState, HTML, withIdb };
