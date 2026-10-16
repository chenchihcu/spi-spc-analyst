import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadCore, HTML, withIdb } = require('./_load.js');
const { JSDOM } = (() => { try { return require('jsdom'); } catch { return {}; } })();
const fs = require('fs');

const core = loadCore();

test('[D-05] Nelson 規則 4：邊界判定', async (t) => {
  await t.test('14 點連續上下交替觸發規則 4', () => {
    const z = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1];
    const res = core.nelson(z);
    const r4 = res.rules.find(r => r.id === 4);
    assert.ok(r4, '應有規則 4');
    assert.equal(r4.idx.length, 14, '14 點應全部標記為觸發');
  });

  await t.test('13 點連續上下交替不觸發規則 4', () => {
    const z = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0];
    const res = core.nelson(z);
    const r4 = res.rules.find(r => r.id === 4);
    assert.equal(r4.idx.length, 0, '13 點不足 14 點，不應觸發');
  });

  await t.test('第 14 點與第 13 點同方向打斷交替，不觸發規則 4', () => {
    const z = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 2, 3];
    const res = core.nelson(z);
    const r4 = res.rules.find(r => r.id === 4);
    assert.equal(r4.idx.length, 0, '同向打斷不應觸發規則 4');
  });

  await t.test('相鄰兩點差值為 0 不算方向交錯，不觸發規則 4', () => {
    const z = [0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
    const res = core.nelson(z);
    const r4 = res.rules.find(r => r.id === 4);
    assert.equal(r4.idx.length, 0, '差值為 0 不應觸發規則 4');
  });
});

test('[D-40] 欄位別名擴充與希臘字母處理', () => {
  const head = ['板號', '元件位號', '焊墊', '體積%', '高度µm', 'PartType'];
  const map = core.autoMap(head);
  assert.equal(head[map.board], '板號');
  assert.equal(head[map.comp], '元件位號');
  assert.equal(head[map.pad], '焊墊');
  assert.equal(head[map.volume], '體積%');
  assert.equal(head[map.height], '高度µm');
  assert.equal(head[map.pkg], 'PartType');

  // 測試希臘字母正則替換 normH
  assert.equal(core.normH('高度μm'), '高度', '希臘字母 μm 應被標準化為高度');
  assert.equal(core.normH('高度µm'), '高度', '微米符號 µm 應被標準化為高度');
});

test('[D-23] 數值解析：歐式逗號小數、百分比、千分位與 unparsed 統計', async (t) => {
  await t.test('歐式逗號小數與百分比', () => {
    const rows = [
      ['B1', 'R1', '1', '100,5', '120,0', '100%'],
      ['B1', 'R2', '1', '0,125', '110,0', '95%'],
      ['B1', 'R3', '1', '1,000', '110,0', '95%']
    ];
    const head = ['board', 'comp', 'pad', 'volume', 'height', 'area'];
    const map = core.autoMap(head);
    const res = core.buildRows({ head, data: rows }, map, core.guessOpts(head, map));
    assert.equal(res.rows[0].volume, 100.5, '100,5 應解析為 100.5');
    assert.equal(res.rows[1].volume, 0.125, '0,125 應解析為 0.125');
    assert.equal(res.rows[2].volume, 1.0, '1,000 在逗號小數模式應解析為 1.0');
    assert.equal(res.rows[0].area, 100, '100% 應解析為 100');
  });

  await t.test('英美式千分位逗號', () => {
    const rows = [
      ['B1', 'R1', '1', '1,234.5', '120.0', '100'],
      ['B1', 'R2', '1', '10,000', '110.0', '95']
    ];
    const head = ['board', 'comp', 'pad', 'volume', 'height', 'area'];
    const map = core.autoMap(head);
    const res = core.buildRows({ head, data: rows }, map, core.guessOpts(head, map));
    assert.equal(res.rows[0].volume, 1234.5, '1,234.5 應解析為 1234.5');
    assert.equal(res.rows[1].volume, 10000, '10,000 應解析為 10000');
  });

  await t.test('無法解析之格數 unparsed 記錄', () => {
    const rows = [
      ['B1', 'R1', '1', 'N/A', 'invalid', '100']
    ];
    const head = ['board', 'comp', 'pad', 'volume', 'height', 'area'];
    const map = core.autoMap(head);
    const res = core.buildRows({ head, data: rows }, map, core.guessOpts(head, map));
    assert.ok(res.info.unparsed.length >= 2, 'N/A 與 invalid 應被計入 unparsed');
  });
});

test('[D-25] 重複鍵去重與保留模式', () => {
  const head = ['board', 'comp', 'pad', 'volume', 'pkg'];
  const data = [
    ['B1', 'R1', '1', '100', '0402'],
    ['B1', 'R1', '1', '105', '0402'],
    ['B1', 'R2', '1', '90', '0402'],
    ['B1', 'R2', '1', '95', '0603']
  ];
  const map = core.autoMap(head);
  const opts = core.guessOpts(head, map);
  opts.dupMode = 'last';
  const res = core.buildRows({ head, data }, map, opts);

  assert.equal(res.rows.length, 3, '總筆數應為 3 筆');
  const r1 = res.rows.find(r => r.comp === 'R1');
  assert.equal(r1.volume, 105, '應保留最後一筆 105');
  assert.equal(res.info.duplicates, 1, '重複筆數應為 1');
});

test('[D-26] 日期解析自動判斷與歧義旗標', () => {
  const head = ['board', 'comp', 'pad', 'volume', 'date'];
  const map = core.autoMap(head);

  // 明確 YMD
  const dataYmd = [['B1', 'R1', '1', '100', '2026/03/15']];
  const resYmd = core.buildRows({ head, data: dataYmd }, map, core.guessOpts(head, map));
  assert.equal(resYmd.info.ambiguousDate, false, '明確 YMD 不應有歧義');

  // 歧義日期：前兩欄 ≤12，第三欄為年（如 03/04/2026）
  const dataAmb = [['B1', 'R1', '1', '100', '03/04/2026']];
  const resAmb = core.buildRows({ head, data: dataAmb }, map, core.guessOpts(head, map));
  assert.equal(resAmb.info.ambiguousDate, true, '03/04/2026 應標記為歧義日期');
});

test('[D-41] 振順豐格式偵測、高度換算與缺開孔拒算', { skip: !JSDOM && '未安裝 jsdom' }, () => {
  const html = fs.readFileSync(HTML, 'utf8');
  assert.match(html, /<option value="zsf">振順豐（絕對值橫排）<\/option>/, 'UI 應有振順豐選項');
  assert.match(html, /同一檔案同時包含振順豐 \(mm\) 與立榮 \(%\) 橫排欄位/, '應有振順豐與立榮互斥檢驗');
  assert.match(html, /缺開孔尺寸或鋼板厚度時將拒絕換算/, '應有缺開孔或鋼板厚度時拒絕換算之說明');
});

test('[D-43] 無 pad 欄時以位號充當，無板號欄推定板號', () => {
  const head = ['time', 'comp', 'volume'];
  const data = [
    ['2026-03-01 08:00:01', 'R1', '100'],
    ['2026-03-01 08:00:03', 'R2', '100'],
    ['2026-03-01 08:00:05', 'R1', '102'],
    ['2026-03-01 08:00:07', 'R2', '102']
  ];
  const map = core.autoMap(head);
  const opts = core.guessOpts(head, map);
  const res = core.buildRows({ head, data }, map, opts);

  assert.equal(res.info.boards, 2, '焊墊重複出現應推定為 2 片板');
  assert.ok(res.rows[0].board.includes('推定'), '板號應標記推定');
  assert.equal(res.rows[0].pad, 'R1', '無 pad 欄位時焊墊 ID 應等於位號');
});

test('[D-45] 無封裝欄時群組推定為位號本身與保留字 __ALL__', () => {
  const head = ['board', 'comp', 'pad', 'volume'];
  const data = [
    ['B1', 'U1', '1', '100'],
    ['B1', 'U2', '1', '100']
  ];
  const map = core.autoMap(head);
  const opts = core.guessOpts(head, map);
  opts.grpFallback = 'ref';
  const res = core.buildRows({ head, data }, map, opts);

  assert.equal(res.rows[0].group, 'U1', 'U1 的群組應推定為位號本身 U1');
  assert.equal(res.rows[1].group, 'U2', 'U2 的群組應推定為位號本身 U2');
  assert.ok(res.rows[0].groupInferred, '應標記 groupInferred');
  assert.equal(core.ALL_GRP, '__ALL__', '保留字應為 __ALL__');
});

test('[D-50] Excel 百分比格式數值自動 ×100 與 pctCount 統計', () => {
  const html = fs.readFileSync(HTML, 'utf8');
  assert.match(html, /pctCount\+\+/, 'Excel 解析中應統計百分比格數');
  assert.match(html, /已依 Excel 百分比格式換算/, '預覽應包含百分比格式換算提示');
});

test('[D-66] realXY 排除格點假座標，alignFit 無真實座標只估平移', () => {
  const fakeRows = [
    { board: 'B1', pad: 'P1', offx: 10, offy: 15, x: 100, y: 100, gridPos: true },
    { board: 'B1', pad: 'P2', offx: 12, offy: 14, x: 200, y: 200, gridPos: true }
  ];
  assert.equal(core.realXY(fakeRows[0]), false, 'gridPos: true 應被 realXY 判定為 false');

  const fit = core.alignFit(fakeRows);
  assert.ok(fit.noCoords, '無真實座標時 alignFit 應回傳 noCoords: true');
  assert.equal(fit.thDeg, 0, '旋轉角度應為 0');
  assert.equal(fit.tx, 11, '平移量應正常計算平均值');
});
