import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require('jsdom');
const { HTML, withIdb } = require('./_load.js');

test('正式匯出以伺服器目前生命週期為準，讀取失敗時停止', async () => {
  const html = fs.readFileSync(HTML, 'utf8').replace(/<script src=[^>]+><\/script>/g, '');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, { runScripts: 'dangerously', virtualConsole, url: 'https://example.test/', beforeParse(w) {
    w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => k === 'measureText' ? () => ({ width: 1 }) : t[k] ?? (() => {}), set: (t, k, v) => ((t[k] = v), true) });
    Object.defineProperty(w.HTMLElement.prototype, 'offsetParent', { get() { return w.document.body; } });
    w.Element.prototype.scrollIntoView = () => {};
    w.matchMedia = () => ({ matches: false, addEventListener() {} });
    w.ResizeObserver = class { observe() {} };
    w.scrollTo = () => {};
    w.Chart = class { constructor() {} destroy() {} static register() {} };
    withIdb(w);
    w.SPI_TEST_HOOK = {};
  } });
  const w = dom.window;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(errors, []);
  let downloads = 0;
  w.claude = { use: async () => ({ save: async () => { downloads++; } }) };
  const hook = w.SPI_TEST_HOOK;
  hook.RecDB.mode = 'cloud';
  hook.curRun().info = { src: { id: 'source-1', lifecycle: 'active', part: 'P1', name: 'measurement.csv', unmatchedRefs: ['L87', 'R737', 'R738'] } };
  const statusButton = w.document.querySelector('#stateSpi');
  statusButton.focus();
  statusButton.click();
  const unmatchedModal = w.document.querySelector('#unmatchedRefsModal');
  assert.equal(unmatchedModal.hidden, false);
  assert.equal(w.document.querySelector('#unmatchedRefsTitle').textContent, '無座標位號（3）');
  assert.equal(w.document.querySelector('#unmatchedRefsList').textContent, 'L87、R737、R738');
  unmatchedModal.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(unmatchedModal.hidden, true);
  assert.equal(w.document.activeElement, statusButton);

  w.__lifecycle = 'superseded';
  hook.RecDB.jfetch = async () => ({ record: { lifecycle: w.__lifecycle } });
  w.document.querySelector('#btnExpMd').click();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(downloads, 0);
  assert.equal(hook.curRun().info.src.lifecycle, 'superseded');
  assert.match(w.document.querySelector('#expState').textContent, /歷史或待判定/);

  w.__lifecycle = 'active';
  w.document.querySelector('#btnExpMd').click();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(downloads, 1);

  hook.RecDB.jfetch = async () => { throw new Error('offline'); };
  w.document.querySelector('#btnExpMd').click();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(downloads, 1);
  assert.equal(hook.curRun().info.src.lifecycle, 'unavailable');
  assert.match(w.document.querySelector('#expState').textContent, /已停止匯出/);
  dom.window.close();
});
