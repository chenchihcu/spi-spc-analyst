import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, APP_BUILT } from '../lib/version.mjs';
import { loginPage } from '../lib/auth-handler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(ROOT, 'spi-spc.html'), 'utf8');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = (await import('jsdom')).default || (await import('jsdom')));
} catch {}

test('1. 版本與更新時間三方一致性 (version.mjs, CHANGELOG.md, spi-spc.html)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(APP_VERSION, `v${pkg.version}`, 'APP_VERSION 應與 package.json 一致');
  
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const clMatch = changelog.match(/^##\s+(v[0-9.]+)\s+—\s+([0-9-]{10}(?:\s+[0-9:]{8})?)/m);
  assert.ok(clMatch, 'CHANGELOG 應有最新版條目');
  assert.equal(clMatch[1], APP_VERSION, 'CHANGELOG 最新版號應與 APP_VERSION 一致');
  
  const appVerMatch = htmlSource.match(/id="appVer">([^<]+)</);
  const appBuiltMatch = htmlSource.match(/id="appBuilt">([^<]+)</);
  assert.ok(appVerMatch, 'spi-spc.html 應有 #appVer');
  assert.equal(appVerMatch[1], APP_VERSION, '#appVer 應與 APP_VERSION 一致');
  assert.ok(appBuiltMatch, 'spi-spc.html 應有 #appBuilt');
  assert.equal(appBuiltMatch[1], APP_BUILT, '#appBuilt 應與 APP_BUILT 一致');
});

test('2. 登入頁行動版規格 (lib/auth-handler.mjs loginPage)', () => {
  const resp = loginPage('/?test=1');
  assert.equal(resp.status, 200);
  
  // 檢查 HTML 內容
  return resp.text().then(html => {
    // a. color-scheme 與 theme-color 及預設明亮主題
    assert.match(html, /<html[^>]*data-theme="light"/i, '登入頁需預設 data-theme="light"');
    assert.match(html, /<meta\s+name="color-scheme"\s+content="light dark">/i, '需有 color-scheme meta');
    assert.match(html, /<meta\s+name="theme-color"[^>]*content="#F2F4F0"/i, '需有淺色 theme-color');
    assert.match(html, /<meta\s+name="theme-color"[^>]*content="#0F1311"/i, '需有深色 theme-color');

    // b. viewport
    assert.match(html, /viewport-fit=cover/i, 'viewport 需包含 viewport-fit=cover');
    assert.doesNotMatch(html, /user-scalable\s*=\s*no/i, '不可包含 user-scalable=no');
    assert.doesNotMatch(html, /maximum-scale/i, '不可包含 maximum-scale');

    // c. 移除 autofocus 防止行動版鍵盤彈出遮擋
    assert.doesNotMatch(html, /<input[^>]+id="user"[^>]+autofocus/i, '帳號欄位不可含 autofocus');

    // d. CSS 規則：input 17px, label 15px, toggle min 44x44, brand max-height <= 160px
    assert.match(html, /input\{[^}]*font-size:\s*17px/i, 'input 需設定 17px 字級防止 iOS Safari 放大');
    assert.match(html, /label\{[^}]*font-size:\s*15px/i, 'label 需設定 15px 字級');
    assert.match(html, /\.toggle\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px/i, '.toggle 觸控區域至少 44×44');
    assert.match(html, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.brand\{[^}]*max-height:\s*160px/i, '手機寬度品牌區高度需限制在 160px 以內');
  });
});

test('3. 主頁 Head Meta 與 CSS Tokens (spi-spc.html)', () => {
  // a. Head meta 與預設明亮主題
  assert.match(htmlSource, /<html[^>]*data-theme="light"/i, '主頁需預設 data-theme="light"');
  assert.match(htmlSource, /<meta\s+name="color-scheme"\s+content="light dark">/i, '需有 color-scheme');
  assert.match(htmlSource, /<meta\s+name="theme-color"[^>]*content="#F2F4F0"/i, '需有淺色 theme-color');
  assert.match(htmlSource, /<meta\s+name="theme-color"[^>]*content="#0F1311"/i, '需有深色 theme-color');
  assert.match(htmlSource, /<meta\s+name="viewport"[^>]*content="[^"]*viewport-fit=cover[^"]*"/i, 'viewport 需包含 viewport-fit=cover');
  assert.doesNotMatch(htmlSource, /user-scalable\s*=\s*no/i, '主頁不可包含 user-scalable=no');
  assert.doesNotMatch(htmlSource, /maximum-scale\s*=\s*1/i, '主頁不可包含 maximum-scale=1');

  // b. Tokens in :root
  assert.match(htmlSource, /--tap-min:\s*44px;/i, '需定義 --tap-min');
  assert.match(htmlSource, /--tabbar-h:\s*49px;/i, '需定義 --tabbar-h');
  assert.match(htmlSource, /--navbar-h:\s*44px;/i, '需定義 --navbar-h');
  assert.match(htmlSource, /--r-card:\s*16px;/i, '需定義 --r-card');
  assert.match(htmlSource, /--r-sheet:\s*20px;/i, '需定義 --r-sheet');
  assert.match(htmlSource, /--safe-t:\s*env\(safe-area-inset-top,\s*0px\);/i, '需定義 --safe-t');
  assert.match(htmlSource, /--safe-b:\s*env\(safe-area-inset-bottom,\s*0px\);/i, '需定義 --safe-b');
  assert.match(htmlSource, /--c-bar:/i, '需定義 --c-bar');

  // c. 禁止以 overflow-x:hidden 掩蓋溢出
  assert.doesNotMatch(htmlSource, /body\s*\{[^}]*overflow-x:\s*hidden/i, '不可在 body 使用 overflow-x:hidden');
  assert.doesNotMatch(htmlSource, /html\s*\{[^}]*overflow-x:\s*hidden/i, '不可在 html 使用 overflow-x:hidden');
});

test('4. 行動版 DOM 結構與分頁控制 (JSDOM 驗證)', { skip: !JSDOM && '未安裝 jsdom' }, async () => {
  const dom = new JSDOM(htmlSource.replace(/<script src=[^>]+><\/script>/g, ''), {
    runScripts: 'dangerously',
    url: 'https://example.test/',
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === 'measureText' ? () => ({ width: 1 }) : t[k] ?? (() => {})), set: (t, k, v) => ((t[k] = v), true) });
      Object.defineProperty(w.HTMLElement.prototype, 'offsetParent', { get() { return w.document.body; } });
      w.Element.prototype.scrollIntoView = () => {};
      w.matchMedia = (query) => ({ matches: query.includes('max-width: 767px'), addEventListener() {} });
      w.ResizeObserver = class { observe() {} };
      w.scrollTo = () => {};
      w.Chart = class { constructor() {} destroy() {} static register() {} static defaults = { font: {} }; };
    },
  });

  const d = dom.window.document;
  const $ = (s) => d.querySelector(s);
  const $$ = (s) => [...d.querySelectorAll(s)];

  // a. 底部分頁列 (<nav class="mtab">) 結構與項目
  const mtab = $('nav.mtab');
  assert.ok(mtab, '需存在 nav.mtab 底部分頁列');
  assert.equal(mtab.getAttribute('aria-label'), '主要分頁', 'nav.mtab 需有 aria-label="主要分頁"');
  
  const mtabButtons = $$('nav.mtab button.mtab-btn');
  assert.equal(mtabButtons.length, 5, '底部分頁列需恰好 5 個項目');
  
  const tabKeys = mtabButtons.map(b => b.dataset.tab || b.id);
  assert.deepEqual(tabKeys, ['issues', 'overview', 'control', 'capability', 'mtabMore'], '底部分頁列 5 項定義需正確');

  // b. 更多 Sheet (role="dialog" aria-modal="true")
  const moreSheet = $('#moreSheet');
  assert.ok(moreSheet, '需存在 #moreSheet');
  assert.equal(moreSheet.getAttribute('role'), 'dialog', 'moreSheet 需有 role="dialog"');
  assert.equal(moreSheet.getAttribute('aria-modal'), 'true', 'moreSheet 需有 aria-modal="true"');
  assert.ok($('#moreBackdrop'), '需有 #moreBackdrop 遮罩');
  assert.ok($('#moreSheetClose'), '需有 #moreSheetClose 關閉鈕');
  assert.ok(moreSheet.querySelector('.sheet-handle'), '需有拖曳把手 .sheet-handle');

  // c. 更多 Sheet 內涵蓋全部次要分頁（共 4+9=13 個分頁）
  const subTabs = $$('#moreSheet [data-mtab]').map(b => b.dataset.mtab);
  assert.deepEqual(subTabs, ['sim3d', 'cross', 'adv', 'compare', 'dfm', 'lab', 'ai', 'report', 'data'], '需涵蓋其餘 9 個分頁');

  // d. 更多 Sheet 內涵蓋操作與帳號
  assert.ok($('#mBtnTheme'), '需有行動版主題切換鈕');
  assert.ok($('#btnTheme'), '需有桌機版主題切換鈕');
  assert.ok($('#mBtnPrint'), '需有行動版列印鈕');
  assert.ok($('#mBtnShare'), '需有行動版分享鈕');
  assert.ok($('#mBtnMyShares'), '需有行動版我的分享鈕');
  assert.ok($('#mLogoutLink'), '需有行動版登出連結');

  // e. 頂部 Sticky Chip 摘要列 (#btnRailChip & #railSheet)
  const chip = $('#btnRailChip');
  assert.ok(chip, '需存在 #btnRailChip 摘要晶片');
  assert.equal(chip.getAttribute('aria-haspopup'), 'dialog', 'chip 需有 aria-haspopup="dialog"');
  assert.ok($('#railSheet'), '需存在 #railSheet');

  // f. 點擊測試：點擊底欄項目應切換分頁
  const btnOverview = $('nav.mtab [data-tab="overview"]');
  btnOverview.click();
  assert.equal(btnOverview.getAttribute('aria-selected'), 'true', '切換至 overview 時 aria-selected 應為 true');
  assert.equal($('nav.mtab [data-tab="issues"]').getAttribute('aria-selected'), 'false', '原 issues aria-selected 應為 false');

  // g. 點擊更多 sheet 內的次要分頁（例如 dfm）
  const btnDfm = $('#moreSheet [data-mtab="dfm"]');
  btnDfm.click();
  // 當前分頁不在前四項時，mtabMore 應標記為 selected
  const mtabMore = $('#mtabMore');
  assert.equal(mtabMore.getAttribute('aria-selected'), 'true', '在次級分頁時更多按鈕需顯示 active/selected');
});

test('5. 觸控修正與無障礙樣式規範 (CSS 規則檢驗)', () => {
  // a. .card .cbtn, .toc button, .how summary min-height >= 44px
  assert.match(htmlSource, /\.how summary\{[^}]*min-height:\s*44px/i, '.how summary 需有 min-height: 44px');
  assert.match(htmlSource, /\.card \.cbtn[^}]*\{[^}]*min-height:\s*44px/i, '.card .cbtn 需有 min-height: 44px');
  assert.match(htmlSource, /\.toc button[^}]*\{[^}]*min-height:\s*44px/i, '.toc button 需有 min-height: 44px');

  // b. .subtab segmented 樣式 (44px)
  assert.match(htmlSource, /\.subtab\{[^}]*min-height:\s*44px/i, '.subtab 需有 min-height: 44px');

  // c. .pmap-cells 每格 min-width: 28px, min-height: 44px
  assert.match(htmlSource, /\.pmap-cells\s+button\{[^}]*min-width:\s*28px[^}]*min-height:\s*44px/i, '問題地圖格子需符合 28×44 規格');

  // d. 表格與浮動元件避讓
  assert.match(htmlSource, /#toTop,#toast\{[^}]*bottom:\s*calc\(var\(--tabbar-h\)\s*\+\s*var\(--safe-b\)\s*\+\s*12px\)/i, '#toTop 與 #toast 需避讓底欄');

  // e. Sticky 表頭在手機下頂部避讓 44px + safe-top
  assert.match(htmlSource, /\.tbl\.sticky-head\s+thead\s+th\{[^}]*top:\s*calc\(44px\s*\+\s*env\(safe-area-inset-top,\s*0px\)\)/i, '表格 sticky 表頭需配合 44px 頂欄避讓');
});

test('6. PWA 與進階無障礙 (Apple Touch Icon, scroll-margin, 44px 報告標籤, WCAG --warn 對比度)', () => {
  // a. PWA 與 Apple Touch Icon
  assert.match(htmlSource, /<meta\s+name="apple-mobile-web-app-capable"\s+content="yes">/i, '需有 apple-mobile-web-app-capable');
  assert.match(htmlSource, /<link\s+rel="apple-touch-icon"/i, '需有 apple-touch-icon');
  assert.match(htmlSource, /<meta\s+name="apple-mobile-web-app-title"\s+content="SPI·SPC">/i, '需有 apple-mobile-web-app-title');

  // b. WCAG 2.2 AA 對比度：--warn 應為 #9B650E (4.75:1)
  assert.match(htmlSource, /--warn:\s*#9B650E/i, '--warn 需符合 WCAG AA 4.5:1 標準 (#9B650E)');

  // c. 表單 scroll-margin 防固定頂底欄遮擋
  assert.match(htmlSource, /scroll-margin-bottom:\s*calc\(var\(--tabbar-h\)\s*\+\s*var\(--safe-b\)\s*\+\s*16px\)/i, '表單輸入需配置 scroll-margin-bottom');

  // d. 報告與郵件章節標籤 44px 觸控熱區
  assert.match(htmlSource, /#p-report label,\s*#p-mail label\{[^}]*min-height:\s*44px/i, '報告與郵件標籤需有 min-height: 44px');

  // e. 登入頁包含橫向 safe-area 避讓
  const resp = loginPage('/?test=1');
  return resp.text().then(html => {
    assert.match(html, /env\(safe-area-inset-left/i, '登入頁需支援 safe-area-inset-left 避讓');
    assert.match(html, /env\(safe-area-inset-right/i, '登入頁需支援 safe-area-inset-right 避讓');
  });
});

test('7. 版面回歸：同權重 CSS 的先後順序、flex 壓縮與行內高度 (Playwright 稽核找到的問題)', () => {
  const at = (s) => { const i = htmlSource.indexOf(s); assert.ok(i >= 0, `找不到 CSS：${s}`); return i; };

  // a. 手機頁首隱藏 chip 的選擇器權重須高於後面的 .chip.chipBtn{display:inline-flex!important}，否則頁首按鈕會蓋住設定鈕與子分頁
  assert.match(htmlSource, /header\.top \.toprow \.chip\{display:none!important\}/, '手機頁首 chip 隱藏規則需提高權重');
  assert.doesNotMatch(htmlSource, /\n\s*\.toprow \.chip\{display:none!important\}/, '不可退回與 .chip.chipBtn 同權重的寫法');

  // b. 問題卡片：長規則名稱可換行，欄寬不被內容撐開
  assert.match(htmlSource, /\.iss-detail\{[^}]*grid-template-columns:minmax\(0,1fr\)/, '.iss-detail 欄寬需為 minmax(0,1fr)');
  assert.match(htmlSource, /\.iss-head \.pill\{[^}]*white-space:normal/, '問題卡片的規則標籤需可換行');

  // c. 觸控 44px 規則須排在基準高度之後（同權重時後者勝出）
  assert.ok(at('@media (pointer:coarse){.seg button,#startupDbBanner button,#recPickerQ,#recPickerReload{min-height:44px') >
    at('.seg button{border:none;border-radius:0;background:var(--surface);min-height:32px'), '觸控 .seg 規則需在基準規則之後');
  assert.match(htmlSource, /\.how summary, details\.fm>summary\{min-height:44px/, '交叉驗證失效模式摘要需有 44px 觸控高度');
  assert.match(htmlSource, /@media \(pointer:coarse\)\{\n\s*button,select,input\[type=number\],input\[type=text\],input\[type=date\],textarea\{min-height:44px/, '日期欄位需在觸控 44px 規則內');

  // d. 行內 min-height 會蓋過觸控規則，改由 CSS 管理
  for (const id of ['btnBannerLoadDb', 'btnBannerGoImport', 'btnBannerDismiss', 'recPickerQ', 'recPickerReload']) {
    const tag = htmlSource.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))[0];
    assert.doesNotMatch(tag, /min-height/, `#${id} 不可有行內 min-height`);
  }

  // e. 可橫向捲動的列不可壓縮項目（觸控 min-width:44px 取代了 flex 預設的 min-width:auto，文字會互相重疊）
  assert.match(htmlSource, /\n\.tab\{[^}]*flex-shrink:0/, '頁籤不可被壓縮');
  assert.match(htmlSource, /\n\.toc button\{[^}]*flex-shrink:0/, '本頁目錄按鈕不可被壓縮');
  assert.match(htmlSource, /#p-issues>#issFilter>\*\{flex-shrink:0\}/, '手機問題篩選 chip 不可被壓縮');

  // f. 欄位容器是直向 flex，flex-basis 會變成高度：版本欄位不可用 flex 基準寬
  const rev = htmlSource.match(/<input[^>]*id="placeRev"[^>]*>/)[0];
  assert.doesNotMatch(rev, /flex:/, '#placeRev 不可設定 flex（會變成 90px 高）');
});
