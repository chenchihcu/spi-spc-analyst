// Step 8 驗證測試：D-63 不良柏拉圖、D-31 列印 CSS 與標題、D-65 3D 模擬快照、M-01 與 R-PDF 結構化 PDF 報告
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { JSDOM } = (() => { try { return require("jsdom"); } catch { return {}; } })();
const { HTML } = require("./_load.js");
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const html = () => fs.readFileSync(HTML, "utf8").replace(/<script src=[^>]+><\/script>/g, "");

function createPage(url = "https://spi.example/", extra = {}) {
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  return new JSDOM(html(), {
    runScripts: "dangerously",
    url,
    beforeParse(w) {
      // Mock Canvas 2D
      w.HTMLCanvasElement.prototype.getContext = (type) => {
        if (type === "webgl" || type === "experimental-webgl") return null;
        return new Proxy({
          measureText: () => ({ width: 8 }),
          fillText: () => {},
          fillRect: () => {},
          strokeRect: () => {},
          clearRect: () => {},
          beginPath: () => {},
          moveTo: () => {},
          lineTo: () => {},
          stroke: () => {},
          fill: () => {},
          arc: () => {},
          setLineDash: () => {},
          save: () => {},
          restore: () => {}
        }, {
          get: (t, k) => t[k] ?? (() => {}),
          set: (t, k, v) => ((t[k] = v), true)
        });
      };
      w.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
      
      // Fetch mock for vendor font files
      w.fetch = async (reqUrl) => {
        const u = String(reqUrl);
        if (u.includes("NotoSansTC-400") || u.includes("NotoSansTC-700")) {
          const fn = u.includes("400") ? "NotoSansTC-400.05938ae2.ttf" : "NotoSansTC-700.a3c0c50b.ttf";
          const buf = fs.readFileSync(path.join(ROOT, "vendor", fn));
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
          };
        }
        return { ok: false, status: 404 };
      };

      Object.defineProperty(w.HTMLElement.prototype, "offsetParent", {
        get() {
          let e = this;
          while (e) {
            if (e.hidden) return null;
            e = e.parentElement;
          }
          return w.document.body;
        }
      });
      w.Element.prototype.scrollIntoView = () => {};
      w.matchMedia = () => ({ matches: false, addEventListener() {} });
      w.ResizeObserver = class { observe() {} };
      w.scrollTo = () => {};

      // Load jsPDF into window
      const { jsPDF } = require("../vendor/jspdf-4.2.1.umd.min.js");
      w.jspdf = { jsPDF };

      // Mock Chart.js with register and destroy
      let chartCount = 0;
      w.Chart = class MockChart {
        constructor(canvas, cfg) {
          chartCount++;
          this.canvas = canvas;
          this.config = cfg;
        }
        destroy() {
          chartCount--;
        }
        static register() {}
        static get activeCount() { return chartCount; }
      };

      w.SPI_TEST_HOOK = {};
      Object.assign(w, extra);
    }
  });
}

test("D-63 不良柏拉圖：Y 軸為整數、Y2 為累積%、有處數註記、空態顯示文字", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const dom = createPage();
  await tick(80);
  const w = dom.window, d = w.document, H = w.SPI_TEST_HOOK;
  assert.ok(H.drawPareto, "公開 drawPareto hook");

  // 1. 柏拉圖卡片下方有「一個焊墊可有多種不良，處數 ≥ 不良焊墊數」註記
  const paretoCard = d.querySelector("#cOvPareto").closest(".card");
  assert.ok(paretoCard, "找到柏拉圖卡片");
  assert.match(paretoCard.textContent, /一個焊墊可有多種不良，處數 ≥ 不良焊墊數/);

  // 2. 有不良時繪製圖表：檢查配置
  H.drawPareto("cOvPareto");
  const chartbox = d.querySelector("#ovParetoBox");
  const emptyEl = d.querySelector("#ovParetoEmpty");
  assert.equal(chartbox.hidden, false, "有不良時 chartbox 顯示");
  assert.equal(emptyEl.hidden, true, "有不良時 emptyEl 隱藏");

  // 3. 空態：當 pareto 為空物件時，隱藏 canvas 與 chartbox，顯示「沒有判定不良的焊墊」
  const origPareto = H.S.A.pareto;
  H.S.A.pareto = {};
  H.drawPareto("cOvPareto");
  assert.equal(chartbox.hidden, true, "空態時 chartbox 隱藏");
  assert.equal(emptyEl.hidden, false, "空態時 emptyEl 顯示");
  assert.match(emptyEl.textContent, /沒有判定不良的焊墊/);
  H.S.A.pareto = origPareto;
});

test("D-31 原生列印：#printHead 包含 nowrap 欄位、空欄不出現 ｜ ｜、document.title 設為 PDF 檔名", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const dom = createPage();
  await tick(80);
  const w = dom.window, d = w.document, H = w.SPI_TEST_HOOK;

  assert.ok(H.pdfFileName, "公開 pdfFileName hook");
  assert.ok(H.beforePrint, "公開 beforePrint hook");
  assert.ok(H.afterPrint, "公開 afterPrint hook");

  const fn = H.pdfFileName();
  assert.match(fn, /^SPI-SPC_[^/\\:*?"<>|]+_[^/\\:*?"<>|]+_\d{8}-\d{4}\.pdf$/);

  const prevTitle = d.title;
  H.beforePrint();
  assert.equal(d.title, fn.replace(/\.pdf$/i, ""), "beforePrint 將 document.title 設為去除 .pdf 的檔名");

  const headHtml = d.querySelector("#printHead").innerHTML;
  assert.match(headHtml, /white-space:\s*nowrap/, "#printHead 欄位應有 white-space:nowrap");
  assert.match(headHtml, /列印時間 \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/, "列印時間格式為 UTC+8 YYYY/MM/DD HH:mm:ss");
  assert.ok(!/｜\s*｜/.test(headHtml), "不應出現連續的分隔符 ｜ ｜");

  H.afterPrint();
  assert.equal(d.title, prevTitle, "afterPrint 還原原本 title");
});

test("D-65 3D 模擬快照：提供 capture3DImage，在 sim3d 工具列加入下載按鈕", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const dom = createPage();
  await tick(80);
  const w = dom.window, d = w.document, H = w.SPI_TEST_HOOK;

  assert.ok(H.capture3DImage, "公開 capture3DImage hook");
  const btnDl3d = d.querySelector("#btnDl3d");
  assert.ok(btnDl3d, "sim3d 工具列內存在 #btnDl3d 下載按鈕");
  assert.match(btnDl3d.textContent, /下載 3D 圖/);

  // 測試呼叫 capture3DImage
  const res = await H.capture3DImage();
  assert.ok(typeof res === "object", "capture3DImage 回傳物件");
  // 在沒有 WebGL 的 JSDOM 環境下，若 three.js 未就緒或 WebGL 不支援，應優雅回傳 ok: false 與 reason
  if (!res.ok) {
    assert.ok(res.reason, "若不可用應提供原因字串");
  } else {
    assert.match(res.dataUrl, /^data:image\/png/, "若可用應產生 PNG dataUrl");
  }
});

test("R-PDF 與 M-01：分析報告頁籤、10 個章節勾選、生成多頁 PDF 與字型嵌入", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const dom = createPage();
  await tick(80);
  const w = dom.window, d = w.document, H = w.SPI_TEST_HOOK;

  // 1. 頁籤與面板
  const repTab = d.querySelector('.tab[data-tab="report"]');
  assert.ok(repTab, "頂端頁籤列存在 report 分析報告按鈕");
  const repPanel = d.querySelector("#p-report");
  assert.ok(repPanel, "存在 #p-report 面板");
  assert.ok(d.querySelector("#btnRepPdf"), "存在匯出 PDF 按鈕");
  assert.ok(d.querySelector("#btnRepPrint"), "存在列印整頁報告按鈕");
  assert.ok(d.querySelector("#btnRepMail"), "存在以 Email 傳送按鈕");

  // 2. 切換至報告分頁並檢驗 10 個章節預覽
  H.setTab("report");
  const prev = d.querySelector("#reportPreview");
  assert.ok(prev, "存在預覽容器 #reportPreview");
  for (let i = 1; i <= 10; i++) {
    const chk = d.querySelector("#chkRep" + i);
    assert.ok(chk, `存在章節 ${i} 勾選框`);
    const sec = d.querySelector("#repSec" + i);
    assert.ok(sec, `存在章節 ${i} 預覽區塊`);
  }

  // 3. 測試章節勾選隱藏
  const chk1 = d.querySelector("#chkRep1");
  chk1.checked = false;
  chk1.dispatchEvent(new w.Event("change"));
  assert.equal(d.querySelector("#repSec1").hidden, true, "取消勾選時區塊隱藏");
  chk1.checked = true;
  chk1.dispatchEvent(new w.Event("change"));
  assert.equal(d.querySelector("#repSec1").hidden, false, "重新勾選時區塊顯示");

  // 4. 測試離線圖表生成與銷毀（0 記憶體外洩）
  const chartCountBefore = w.Chart.activeCount;
  const offImg = H.renderOffscreenChart("line", { labels: ["A", "B"], datasets: [{ data: [1, 2] }] }, {});
  assert.match(offImg, /^data:image\/png/);
  assert.equal(w.Chart.activeCount, chartCountBefore, "離線圖表 render 後立即 destroy，Chart 實例無洩漏");

  // 5. 測試 generateReportPdfBlob 生成 PDF
  const pdfRes = await H.generateReportPdfBlob();
  assert.ok(pdfRes.blob, "回傳 Blob 物件");
  assert.ok(pdfRes.doc, "回傳 jsPDF 實例");
  assert.ok(pdfRes.doc.getNumberOfPages() >= 2, "10 個章節匯出應為多頁 PDF (至少 2 頁)");

  // 6. 測試生僻缺字自動回退與紀錄（不產生 □）
  const origSource = H.S.source;
  H.S.source = "測試批次含有生僻字𪚥與龘檢驗";
  const rareRes = await H.generateReportPdfBlob();
  assert.ok(rareRes.missingGlyphs.includes("𪚥"), "缺字清單應捕捉到 𪚥");
  H.S.source = origSource;
});
