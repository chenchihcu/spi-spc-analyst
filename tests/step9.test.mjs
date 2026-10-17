// Step 9 驗證測試：D-02 / R-MAIL 瀏覽器端 Web Share、安全轉寄、mailto 截斷規則與零伺服器寄信
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

function createPage(url = "https://spi.example/#mail", extra = {}, mockNav = null) {
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  return new JSDOM(html(), {
    runScripts: "dangerously",
    url,
    beforeParse(w) {
      if (mockNav) {
        for (const [k, v] of Object.entries(mockNav)) {
          try {
            Object.defineProperty(w.navigator, k, { value: v, configurable: true, writable: true });
          } catch(e) {}
        }
      }
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

      // Mock Chart.js
      w.Chart = class MockChart {
        constructor(canvas, cfg) {
          this.canvas = canvas;
          this.config = cfg;
        }
        destroy() {}
        static register() {}
      };

      w.SPI_TEST_HOOK = {};
      Object.assign(w, extra);
    }
  });
}

test("D-02 / R-MAIL：整頁「轉寄」畫面 (#mail) 欄位與無彈窗規範", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const dom = createPage("https://spi.example/#mail");
  await tick(80);
  const w = dom.window, d = w.document, H = w.SPI_TEST_HOOK;

  // 1. 面板存在且包含全部必要欄位
  const mailPanel = d.querySelector("#p-mail");
  assert.ok(mailPanel, "存在 #p-mail 面板");
  assert.equal(mailPanel.hidden, false, "#mail 路由下 #p-mail 面板為顯示狀態");

  // 2. 聲明文字
  assert.match(mailPanel.textContent, /郵件由您的郵件 App 寄出，本系統不寄信、不保存收件人/, "寫明零伺服器郵件聲明");

  // 3. 輸入欄位與按鈕
  assert.ok(d.querySelector("#mailTo"), "存在收件人欄位 #mailTo");
  assert.ok(d.querySelector("#mailCc"), "存在副本欄位 #mailCc");
  assert.ok(d.querySelector("#mailSubject"), "存在主旨欄位 #mailSubject");
  assert.ok(d.querySelector("#mailBody"), "存在內文/摘要欄位 #mailBody");
  assert.ok(d.querySelector("#mailBodyLen"), "存在字數統計 #mailBodyLen");
  assert.ok(d.querySelector("#mailUrlLen"), "存在 mailto 長度統計 #mailUrlLen");
  assert.ok(d.querySelector("#btnMailCopySummary"), "存在複製摘要按鈕");
  assert.ok(d.querySelector("#btnSharePdf"), "存在主分享按鈕 #btnSharePdf");
  assert.ok(d.querySelector("#btnSharePdfWithSummary"), "存在連同摘要分享按鈕 #btnSharePdfWithSummary");
  assert.ok(d.querySelector("#btnMailDlPdf"), "存在下載 PDF 按鈕 #btnMailDlPdf");
  assert.ok(d.querySelector("#btnMailOpenMailto"), "存在開啟郵件按鈕 #btnMailOpenMailto");
  assert.ok(d.querySelector("#btnMailBack"), "存在返回報告按鈕 #btnMailBack");

  // 4. 10 個章節勾選框皆存在
  for (let i = 1; i <= 10; i++) {
    assert.ok(d.querySelector("#chkMailRep" + i), `存在轉寄章節 ${i} 勾選框`);
  }

  // 5. 無 modal 規範檢驗：全檔不含 showModal 與 <dialog>
  const fileContent = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "spi-spc.html"), "utf8");
  assert.equal(/<dialog\b/i.test(fileContent), false, "全檔不得出現 <dialog>");
  assert.equal(/\bshowModal\s*\(/i.test(fileContent), false, "全檔不得出現 showModal()");
});

test("D-02 / R-MAIL：mailto 1800 字元長度限制與完整句截斷規則", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const dom = createPage("https://spi.example/");
  await tick(80);
  const H = dom.window.SPI_TEST_HOOK;
  assert.ok(H.buildMailtoUrl, "公開 buildMailtoUrl hook");
  assert.ok(H.validateEmailList, "公開 validateEmailList hook");

  // 1. Email 格式檢驗
  assert.equal(H.validateEmailList(""), true, "空字串允許");
  assert.equal(H.validateEmailList("alice@example.com"), true, "合規單筆 email");
  assert.equal(H.validateEmailList("alice@example.com, bob@corp.org; charlie@test.tw"), true, "合規多筆 email（支援逗號與分號）");
  assert.equal(H.validateEmailList("invalid-email"), false, "不合規 email");
  assert.equal(H.validateEmailList("alice@example.com, invalid@"), false, "混合時只要有一筆錯誤即回 false");

  // 2. 典型主旨下「150 字中文摘要＋分享連結」網址 ≤ 1800 字元且不截斷
  const typicalSubject = "SPI·SPC 分析報告｜SAMPLE 試產_1｜正常";
  const typicalBody150 = "【SPI·SPC 製程分析報告摘要】\n• 試產回合：範例資料\n• 整體判定：正常（正常）\n• 產生時間：2026/10/17 19:30:00 (UTC+8)\n• 製程穩定且能力充足，無異常問題。\n• 線上分享連結：https://spi.example/#share-6wCR2h_123456789012345（30 天有效，需登入）\n\n（完整 10 章節結構化圖表與數據請參閱附件 PDF 報告）";
  const urlTypical = H.buildMailtoUrl("user@example.com", "", typicalSubject, typicalBody150);
  assert.ok(urlTypical.length <= 1800, `典型 150 字摘要 mailto 網址長度應 <= 1800 (實際: ${urlTypical.length})`);
  assert.ok(!urlTypical.includes("內容過長已截斷"), "未超過 1800 時不得被截斷");

  // 3. 800 字超長中文摘要被截斷且包含提示文字
  const longBody800 = "問題詳情分析說明：\n" + "這是一段很長很長的製程分析紀錄文本，用來測試郵件網址超過長度限制時是否能被優雅截斷。".repeat(25);
  assert.ok(longBody800.length >= 800, "測試文本長度大於 800 字");
  const urlLong = H.buildMailtoUrl("user@example.com", "boss@example.com", typicalSubject, longBody800);
  assert.ok(urlLong.length <= 1800, `長文本截斷後 mailto 網址長度必須 <= 1800 (實際: ${urlLong.length})`);
  assert.ok(decodeURIComponent(urlLong).includes("（內容過長已截斷，完整內容見 PDF 或分享連結）"), "長文本截斷後必須包含提示文字");
  assert.ok(decodeURIComponent(urlLong).includes(typicalSubject), "主旨不得被截斷");
});

test("D-02 / R-MAIL：Web Share「先產生後分享」、iOS/iPadOS 只送檔案、非 Apple 送檔案+文字", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  let shareCalls = [];
  const dom = createPage("https://spi.example/#mail", {}, {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
    platform: "iPhone",
    maxTouchPoints: 5,
    canShare: (data) => !!(data && data.files && data.files.length),
    share: async (data) => {
      shareCalls.push(data);
      return Promise.resolve();
    },
    clipboard: {
      writeText: async (t) => t
    }
  });

  await tick(100);
  const w = dom.window, d = w.document, H = w.SPI_TEST_HOOK;

  // 1. 先產生後分享：等待 updateMailPdf 在背景產生完畢並啟用分享按鈕
  await H.updateMailPdf();
  const btnShare = d.querySelector("#btnSharePdf");
  assert.equal(btnShare.disabled, false, "PDF 產生完成後主分享按鈕啟用");

  // 2. 測試 Apple 裝置主按鈕只送 { files: [file] }
  assert.equal(H.isAppleDevice(), true, "iPhone UA 判定為 Apple 裝置");
  btnShare.click();
  assert.equal(shareCalls.length, 1, "觸發 navigator.share 一次");
  const call1 = shareCalls[0];
  assert.ok(call1.files && call1.files.length === 1, "包含 1 個檔案");
  assert.equal(call1.title, undefined, "Apple 裝置主按鈕不送 title");
  assert.equal(call1.text, undefined, "Apple 裝置主按鈕不送 text");

  // 3. 測試次要按鈕「連同摘要分享」送 files, title, text
  const btnShareSummary = d.querySelector("#btnSharePdfWithSummary");
  assert.equal(btnShareSummary.disabled, false, "PDF 產生完成後次要分享按鈕啟用");
  btnShareSummary.click();
  assert.equal(shareCalls.length, 2, "觸發 navigator.share 第二次");
  const call2 = shareCalls[1];
  assert.ok(call2.files && call2.files.length === 1, "包含 1 個檔案");
  assert.ok(call2.title, "送出 title");
  assert.ok(call2.text, "送出 text");

  // 4. 測試複製摘要按鈕
  const btnCopy = d.querySelector("#btnMailCopySummary");
  btnCopy.click();
  await tick(50);
  assert.equal(btnCopy.textContent, "已複製", "點擊後文字切換為已複製");
});

test("D-02 / R-MAIL：零伺服器寄信稽核（無 /api/mail、無 send_email、無 MAIL_* 變數）", async () => {
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

  // 1. 檢查 wrangler.jsonc
  const wranglerJsonc = fs.readFileSync(path.join(ROOT, "wrangler.jsonc"), "utf8");
  assert.equal(wranglerJsonc.includes("send_email"), false, "wrangler.jsonc 不得包含 send_email binding");
  assert.equal(/\bMAIL_[A-Z0-9_]+\b/.test(wranglerJsonc), false, "wrangler.jsonc 不得包含 MAIL_* 變數");

  // 2. 檢查路由表與後端檔案
  const workerCode = fs.readFileSync(path.join(ROOT, "cloudflare", "worker.mjs"), "utf8");
  assert.equal(workerCode.includes('"/api/mail"'), false, "路由表不得提供 /api/mail");

  // 3. 掃描 cloudflare/ 與 lib/ 目錄中的 .mjs 檔案
  const checkDir = (dir) => {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      if (st.isDirectory()) checkDir(full);
      else if (f.endsWith(".mjs") || f.endsWith(".js")) {
        const c = fs.readFileSync(full, "utf8");
        assert.equal(c.includes('"/api/mail"'), false, `${f} 不得包含 /api/mail`);
        assert.equal(c.includes("send_email"), false, `${f} 不得包含 send_email`);
        // 排除 EMAIL_RE 等前面有字母的情況，只檢查 MAIL_* 前綴變數
        const mailVarMatches = c.match(/\bMAIL_[A-Z0-9_]+\b/g) || [];
        assert.deepEqual(mailVarMatches, [], `${f} 不得包含 MAIL_* 變數`);
      }
    }
  };
  checkDir(path.join(ROOT, "cloudflare"));
  checkDir(path.join(ROOT, "lib"));
});
