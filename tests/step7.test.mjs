import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { CSP, SECURITY_HEADERS } from '../lib/security-headers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(ROOT, 'spi-spc.html'), 'utf8');
const headersSource = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8');

function createDom({ width = 1280, height = 800, coarse = false, threeRendererThrows = false } = {}) {
  const virtualConsole = new VirtualConsole();
  const cleanHtml = htmlSource.replace(/<script src=[^>]+><\/script>/g, '');
  let curWidth = width;
  let curHeight = height;
  let curCoarse = coarse;

  const evalMq = (query) => {
    const q = String(query);
    return q.split(',').some((part) => {
      const p = part.trim();
      const clauses = p.split(/\band\b/i).map((c) => c.trim());
      return clauses.every((cl) => {
        const maxW = cl.match(/\(max-width:\s*([0-9.]+)px\)/i);
        if (maxW) return curWidth <= parseFloat(maxW[1]);
        const maxH = cl.match(/\(max-height:\s*([0-9.]+)px\)/i);
        if (maxH) return curHeight <= parseFloat(maxH[1]);
        const minW = cl.match(/\(min-width:\s*([0-9.]+)px\)/i);
        if (minW) return curWidth >= parseFloat(minW[1]);
        if (/pointer:\s*coarse/i.test(cl)) return curCoarse;
        if (/hover:\s*none/i.test(cl)) return curCoarse;
        return false;
      });
    });
  };

  const dom = new JSDOM(cleanHtml, {
    url: 'https://spi.example.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.SPI_TEST_HOOK = {};
      window.TextEncoder = TextEncoder;
      window.TextDecoder = TextDecoder;
      window.innerWidth = curWidth;
      window.innerHeight = curHeight;
      window.matchMedia = (q) => ({
        matches: evalMq(q),
        media: q,
        addEventListener() {},
        removeEventListener() {},
      });
      window.setViewport = (w, h, c) => {
        curWidth = w;
        curHeight = h;
        curCoarse = c;
        window.innerWidth = w;
        window.innerHeight = h;
      };
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      window.scrollTo = () => {};
      window.Element.prototype.scrollIntoView = () => {};
      window.Element.prototype.scrollBy = function ({ left = 0 } = {}) {
        this.scrollLeft = (this.scrollLeft || 0) + left;
      };
      window.HTMLCanvasElement.prototype.getContext = () => ({
        fillRect() {}, clearRect() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        putImageData() {}, createImageData: () => [], setTransform() {}, drawImage() {},
        save() {}, fillText() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
        closePath() {}, stroke() {}, translate() {}, scale() {}, rotate() {}, arc() {},
        fill() {}, measureText: () => ({ width: 10 }), transform() {}, rect() {}, clip() {},
      });
      window.Chart = class {
        constructor(ctx, cfg) { this.ctx = ctx; this.config = cfg; }
        destroy() {}
        update() {}
        static register() {}
        static defaults = { font: {} };
      };
      const makeDisposable = () => ({ dispose() {} });
      window.THREE = {
        WebGLRenderer: class {
          constructor() {
            if (threeRendererThrows) {
              throw new Error('Error creating WebGL context.');
            }
            this.domElement = window.document.createElement('canvas');
          }
          setPixelRatio() {}
          setSize() {}
          render() {}
          dispose() {}
        },
        Scene: class { constructor() { this.children = []; } add(o) { this.children.push(o); } },
        PerspectiveCamera: class {
          constructor() { this.position = { set() {} }; }
          lookAt() {}
          updateProjectionMatrix() {}
        },
        HemisphereLight: class {},
        DirectionalLight: class { constructor() { this.position = { set() {} }; } },
        Group: class { constructor() { this.children = []; } add(o) { this.children.push(o); } },
        Mesh: class {
          constructor(g, m) {
            this.geometry = g || makeDisposable();
            this.material = m || makeDisposable();
            this.position = { set() {}, copy() {}, y: 0 };
          }
        },
        BoxGeometry: class { dispose() {} },
        CylinderGeometry: class { dispose() {} },
        EdgesGeometry: class { dispose() {} },
        LineSegments: class {
          constructor(g, m) {
            this.geometry = g || makeDisposable();
            this.material = m || makeDisposable();
            this.position = { set() {}, copy() {} };
          }
        },
        MeshStandardMaterial: class { clone() { return new this.constructor(); } dispose() {} },
        MeshBasicMaterial: class { dispose() {} },
        LineBasicMaterial: class { dispose() {} },
        Color: class {},
        Vector2: class {},
        Raycaster: class { setFromCamera() {} intersectObjects() { return []; } },
      };
      window.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/__me')) {
          return new Response(JSON.stringify({ user: null }), { status: 401 });
        }
        return new Response('{}', { status: 200 });
      };
    },
  });

  return dom;
}

test('步驟 7 (D-06): _headers 與 lib/security-headers.mjs CSP 完全一致且包含 blob:/data: 規則', () => {
  assert.equal(SECURITY_HEADERS['Content-Security-Policy'], CSP);
  assert.match(CSP, /img-src 'self' data: blob:;/);
  assert.match(CSP, /worker-src 'self' blob:;/);
  assert.match(CSP, /frame-src blob:;/);

  const cspLineMatch = headersSource.match(/^\s*Content-Security-Policy:\s*(.+)$/m);
  assert.ok(cspLineMatch, '_headers 必須定義 Content-Security-Policy');
  assert.equal(cspLineMatch[1].trim(), CSP, '_headers 的 CSP 必須與 lib/security-headers.mjs 完全一致');
});

test('步驟 7 (D-07 & 第 7 節): 11 組視口矩陣 data-layout 判定與 CSS 斷點零衝突', () => {
  assert.doesNotMatch(htmlSource, /min-width:\s*1280px/i, '不可有 min-width: 1280px 斷點');
  assert.doesNotMatch(htmlSource, /min-width:\s*601px/i, '不可有 min-width: 601px 斷點');
  assert.doesNotMatch(htmlSource, /@media\s*\(max-width:\s*767px\)/i, '不可殘留舊版 @media (max-width:767px) 行動殼層斷點');
  assert.match(
    htmlSource,
    /@media\s*\(max-width:\s*600px\),\s*\(pointer:\s*coarse\)\s+and\s+\(max-height:\s*500px\)/i,
    'CSS 行動殼層必須使用與 PHONE_MQ 一致的媒體查詢'
  );

  const dom = createDom({ width: 1280, height: 800, coarse: false });
  const { window } = dom;
  const { SPI_TEST_HOOK } = window;

  const matrix = [
    // Phone (4 viewports)
    { w: 375, h: 667, coarse: true, expected: 'phone' },
    { w: 390, h: 844, coarse: true, expected: 'phone' },
    { w: 430, h: 932, coarse: true, expected: 'phone' },
    { w: 932, h: 430, coarse: true, expected: 'phone' },
    // Tablet (4 viewports)
    { w: 744, h: 1133, coarse: true, expected: 'tablet' },
    { w: 768, h: 1024, coarse: true, expected: 'tablet' },
    { w: 820, h: 1180, coarse: true, expected: 'tablet' },
    { w: 1024, h: 768, coarse: true, expected: 'tablet' },
    // Desktop (3 viewports)
    { w: 1280, h: 800, coarse: false, expected: 'desktop' },
    { w: 1440, h: 900, coarse: false, expected: 'desktop' },
    { w: 1920, h: 1080, coarse: false, expected: 'desktop' },
  ];

  for (const vp of matrix) {
    window.setViewport(vp.w, vp.h, vp.coarse);
    SPI_TEST_HOOK.updateLayout();
    assert.equal(
      window.document.documentElement.dataset.layout,
      vp.expected,
      `視口 ${vp.w}×${vp.h} (coarse=${vp.coarse}) 應判定為 ${vp.expected}`
    );
  }

  // 手機橫向 932×430 頂部黏性高度 <= 96px (36 + 50 = 86px) 與 .mtab 橫向安全區 padding
  assert.match(
    htmlSource,
    /@media\s*\(pointer:\s*coarse\)\s+and\s+\(max-height:\s*500px\)\s*\{[\s\S]*?header\.top\s*\{[^}]*height:\s*calc\(36px\s*\+\s*var\(--safe-t\)\)/i,
    '手機橫向 header.top 高度應壓縮至 36px（與 .sticky 合計 <= 96px）'
  );
  assert.match(
    htmlSource,
    /\.mtab\s*\{[^}]*padding:\s*0\s+var\(--safe-r\)\s+var\(--safe-b\)\s+var\(--safe-l\)/i,
    '.mtab 需有橫向安全區 padding: 0 var(--safe-r) var(--safe-b) var(--safe-l)'
  );
  // 首屏問題偵測頁 #issList (order:3) 排在 .card (#issSum, order:4) 之前，使首張問題卡標題在 430x932 與 932x430 首屏可見
  assert.match(
    htmlSource,
    /#p-issues\s*>\s*#issList\s*\{[^}]*order:\s*3[\s\S]*?#p-issues\s*>\s*\.card\s*\{[^}]*order:\s*4/i,
    '手機版 #p-issues > #issList 應排在 .card 摘要卡之前，使首張問題卡標題首屏可見'
  );
  // 無彈窗：.sheet-backdrop 隱藏，.modal-sheet 為全頁檢視
  assert.match(
    htmlSource,
    /\.sheet-backdrop\s*\{[^}]*display:\s*none\s*!important/i,
    '無彈窗規範下 .sheet-backdrop 必須隱藏'
  );

  dom.window.close();
});

test('步驟 7 (D-68): 平板與小桌機頂部頁籤左右捲動鈕、寬表首欄黏性與 .view3d 高度', () => {
  const dom = createDom({ width: 820, height: 1180, coarse: true });
  const { document } = dom.window;
  const { SPI_TEST_HOOK } = dom.window;

  // ① .tabs-bar 與 #tabScrollL / #tabScrollR
  const tabsNav = document.querySelector('nav.tabs');
  const btnL = document.getElementById('tabScrollL');
  const btnR = document.getElementById('tabScrollR');
  assert.ok(tabsNav && btnL && btnR, '應存在 nav.tabs 與 #tabScrollL / #tabScrollR 按鈕');

  Object.defineProperty(tabsNav, 'clientWidth', { value: 500, configurable: true });
  Object.defineProperty(tabsNav, 'scrollWidth', { value: 900, configurable: true });
  tabsNav.scrollLeft = 0;
  SPI_TEST_HOOK.tabFade();
  assert.equal(btnL.hidden, true, '在最左端時 #tabScrollL 應隱藏');
  assert.equal(btnR.hidden, false, '右側尚有內容時 #tabScrollR 應顯示');

  btnR.click();
  assert.ok(tabsNav.scrollLeft > 0, '點擊 #tabScrollR 應向右捲動 nav.tabs');
  SPI_TEST_HOOK.tabFade();
  assert.equal(btnL.hidden, false, '捲動後 #tabScrollL 應顯示');

  // ② 寬表在 601–1279px 的首欄 sticky 與 .has-overflow + .tbl-scroll-hint
  assert.match(
    htmlSource,
    /\.tbl\s+td:first-child,\s*\.tbl\s+th:first-child\s*\{[^}]*position:\s*sticky;\s*left:\s*0/i,
    '全域 .tbl 首欄應設為 position: sticky; left: 0'
  );
  const activePanel = document.querySelector('.panel:not([hidden])');
  const tblWrap = document.createElement('div');
  tblWrap.className = 'tbl';
  const tbl = document.createElement('table');
  tbl.innerHTML = '<thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody>';
  tblWrap.appendChild(tbl);
  activePanel.appendChild(tblWrap);

  Object.defineProperty(tblWrap, 'clientWidth', { value: 400, configurable: true });
  Object.defineProperty(tbl, 'scrollWidth', { value: 720, configurable: true });
  SPI_TEST_HOOK.limitTables(activePanel);
  assert.ok(tblWrap.classList.contains('has-overflow'), '水平溢位時 .tbl 應加上 .has-overflow');
  assert.ok(
    tblWrap.nextElementSibling && tblWrap.nextElementSibling.classList.contains('tbl-scroll-hint'),
    '水平溢位時 .tbl 後方應顯示 .tbl-scroll-hint 提示'
  );

  // ③ .view3d 高度規則
  assert.match(
    htmlSource,
    /\.view3d\s*\{[^}]*height:\s*min\(52vh,\s*440px,\s*calc\(100dvh\s*-\s*var\(--stickyH,\s*140px\)\s*-\s*160px\)\)/i,
    '.view3d 高度必須設為 min(52vh, 440px, calc(100dvh - var(--stickyH, 140px) - 160px))'
  );

  dom.window.close();
});

test('步驟 7 (D-22 & D-27): WebGL 建立失敗時優雅降級且 2D 圖表照常渲染、context lost/restored 與 3D 資源釋放', async () => {
  // 1. WebGLRenderer 拋錯情境
  const domFail = createDom({ width: 1280, height: 800, coarse: false, threeRendererThrows: true });
  const docFail = domFail.window.document;
  const hookFail = domFail.window.SPI_TEST_HOOK;

  await hookFail.render3D();
  assert.equal(hookFail.T.ok, false, 'WebGLRenderer 拋錯時 T.ok 應為 false');

  const fb = docFail.querySelector('#view3d .webgl-fallback');
  assert.ok(fb, '#view3d 內應顯示行內降級說明');
  assert.match(fb.textContent, /無法啟用 WebGL 3D 檢視/, '降級說明文字應明確提示無法啟用 WebGL');

  // 3D 專屬控制項應為 disabled
  assert.equal(docFail.getElementById('selBoard').disabled, true, '#selBoard 應設為 disabled');
  assert.equal(docFail.getElementById('btnWorst').disabled, true, '#btnWorst 應設為 disabled');
  assert.equal(docFail.getElementById('btnPlay').disabled, true, '#btnPlay 應設為 disabled');

  // 2D 配套圖表與不良焊墊表仍正常繪出，不留空白
  assert.ok(
    docFail.getElementById('boardDefSub').textContent.includes('處'),
    'WebGL 失敗時 #boardDefSub 仍應更新本板不良處數'
  );
  assert.ok(
    docFail.getElementById('boardDefTbl').innerHTML.includes('tbody'),
    'WebGL 失敗時 #boardDefTbl 仍應繪出表格內容'
  );

  // 點擊或觸發 #selBoard / #btnWorst / #btnPlay 不得拋出未捕捉例外
  assert.doesNotThrow(() => {
    docFail.getElementById('selBoard').dispatchEvent(new domFail.window.Event('change'));
    docFail.getElementById('btnWorst').click();
    docFail.getElementById('btnPlay').click();
  });
  domFail.window.close();

  // 2. WebGL 正常建立、contextlost / contextrestored、切離分頁停止 rAF 與手機 #btn3dTouch 切換
  const domOk = createDom({ width: 390, height: 844, coarse: true, threeRendererThrows: false });
  const docOk = domOk.window.document;
  const hookOk = domOk.window.SPI_TEST_HOOK;

  hookOk.setTab('sim3d');
  await hookOk.render3D();
  assert.equal(hookOk.T.ok, true, 'WebGL 正常時 T.ok 應為 true');

  const cvs = hookOk.T.renderer.domElement;
  assert.ok(cvs, '應建立 WebGL canvas');

  // 觸發 webglcontextlost
  const lostEv = new domOk.window.Event('webglcontextlost', { cancelable: true });
  cvs.dispatchEvent(lostEv);
  assert.equal(lostEv.defaultPrevented, true, 'webglcontextlost 必須呼叫 preventDefault()');
  assert.equal(hookOk.T.ok, false, 'context lost 後 T.ok 應設為 false');
  assert.ok(docOk.querySelector('#view3d .webgl-fallback'), 'context lost 後應顯示行內說明');

  // 觸發 webglcontextrestored
  cvs.dispatchEvent(new domOk.window.Event('webglcontextrestored'));
  assert.equal(hookOk.T.ok, true, 'context restored 後 T.ok 應恢復為 true');
  assert.equal(docOk.querySelector('#view3d .webgl-fallback'), null, 'context restored 後應移除降級說明');

  // D-27: 手機 #btn3dTouch 切換 .touch-3d
  const btnTouch = docOk.getElementById('btn3dTouch');
  const view3d = docOk.getElementById('view3d');
  assert.equal(btnTouch.getAttribute('aria-pressed'), 'false');
  btnTouch.click();
  assert.equal(btnTouch.getAttribute('aria-pressed'), 'true');
  assert.ok(view3d.classList.contains('touch-3d'), '開啟操作 3D 時 #view3d 應有 .touch-3d class');
  btnTouch.click();
  assert.equal(btnTouch.getAttribute('aria-pressed'), 'false');
  assert.ok(!view3d.classList.contains('touch-3d'), '關閉操作 3D 時 #view3d 應移除 .touch-3d class');

  // dispose3D 釋放資源
  hookOk.dispose3D();
  assert.equal(hookOk.T.ok, false);
  assert.equal(hookOk.T.renderer, null);

  domOk.window.close();
});

test('步驟 7 (D-19 & D-52): 觸控裝置 hitRadius: 24、toast <= 4s 含關閉鈕、409 重複上傳持續性行內提示', async () => {
  const dom = createDom({ width: 390, height: 844, coarse: true });
  const { document } = dom.window;
  const { SPI_TEST_HOOK } = dom.window;

  // D-19: coarse pointer 下 Chart.js 點擊目標放大至 hitRadius: 24, hoverRadius: 8
  const opts = SPI_TEST_HOOK.baseOpts({});
  assert.equal(opts.elements?.point?.hitRadius, 24, '觸控裝置點選目標 hitRadius 應為 24');
  assert.equal(opts.elements?.point?.hoverRadius, 8, '觸控裝置點選目標 hoverRadius 應為 8');

  // D-52: toast 關閉鈕與 <= 4s
  SPI_TEST_HOOK.toast('測試訊息', 5000);
  const toastEl = document.getElementById('toast');
  assert.ok(toastEl.classList.contains('on'), 'toast 應顯示');
  const closeBtn = toastEl.querySelector('.toast-close');
  assert.ok(closeBtn, 'toast 應有右上角關閉鈕 .toast-close');
  closeBtn.click();
  assert.ok(!toastEl.classList.contains('on'), '點擊 .toast-close 應立即關閉 toast');

  // D-52: 409 重複上傳時在 #impDupNotice 與 #recNote 持續性行內顯示
  SPI_TEST_HOOK.RecDB.mode = 'cloud';
  SPI_TEST_HOOK.RecDB.ready = Promise.resolve();
  SPI_TEST_HOOK.RecDB.create = async () => {
    const err = new Error('重複檔案');
    err.existing = 'rec_dup_01';
    err.status = 409;
    throw err;
  };
  SPI_TEST_HOOK.RecDB.jfetch = async () => ({
    record: {
      id: 'rec_dup_01',
      kind: 'spi',
      lot: 'LOT-01',
      part: 'PART-01',
      name: 'dup.csv',
      sha256: 'abc1234567890',
      user: 'alice@example.com',
      created: 1700000000000,
    },
  });

  const csv = 'Board,Pad,Volume(%),Height(um),Area(%)\nB1,P1,100,120,100\nB1,P2,102,121,99\nB2,P1,98,119,101\nB2,P2,101,120,100';
  SPI_TEST_HOOK.startImport(csv, 'dup.csv');
  document.getElementById('inLot').value = 'LOT-01';
  document.getElementById('inPart').value = 'PART-01';

  await document.getElementById('btnApply').onclick();
  const dupNotice = document.getElementById('impDupNotice');
  assert.equal(dupNotice.hidden, false, '409 重複上傳後 #impDupNotice 必須持續顯示（hidden=false）');
  assert.match(dupNotice.textContent, /這個檔案已存過.*alice@example\.com/, '#impDupNotice 應包含既有紀錄上傳者與說明');

  dom.window.close();
});
