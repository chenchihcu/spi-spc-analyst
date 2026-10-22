// 單板異常嚴重度：偏離其他板但仍在規格內 → 最多「警示」；有超規焊墊才判「嚴重」
// 測試資料為自行組出的合成資料：10 片板 × 5 個元件群組 × 4 個焊墊，體積約 100%（規格 70–130%）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadCore, baseState } = require('./_load.js');
const core = loadCore();

const GROUPS = ['C1', 'C2', 'C3', 'C4', 'C5'];
function rows(tweak = () => 0) {
  let s = 12345;
  const noise = () => { s = (s * 1103515245 + 12345) % 2147483648; return (s / 2147483648 - 0.5) * 2; };
  const out = [];
  for (let b = 1; b <= 10; b++) {
    const board = 'B' + String(b).padStart(2, '0');
    for (const g of GROUPS) for (let p = 1; p <= 4; p++) {
      out.push({ board, comp: g, pad: `${g}-${p}`, group: g, volume: 100 + noise() + tweak(board, g, p) });
    }
  }
  return out;
}
const detect = (rs) => core.detectIssues(baseState(core, { rows: rs, metrics: ['volume'], metric: 'volume', group: 'ALL' }));
const sb = (F) => F.filter((x) => x.cat === '單板異常');

test('板×群組：規格內大幅偏移（|z| ≥ 6、沒有不良焊墊）只判警示', () => {
  const F = sb(detect(rows((b, g) => (b === 'B05' && g === 'C1' ? 15 : 0))));
  const c = F.find((x) => x.sig.t === 'local' && x.sig.b === 'B05' && x.sig.g === 'C1');
  assert.ok(c, '應偵測到 B05 的 C1 偏高');
  assert.equal(c.sig.nd, 0, '該區沒有不良焊墊');
  assert.equal(c.lv, 'warn');
});

test('板×群組：同樣大幅偏移，但該區有 1 個超規焊墊 → 嚴重', () => {
  const F = sb(detect(rows((b, g, p) => (b === 'B05' && g === 'C1' ? (p === 1 ? 33 : 25) : 0))));
  const c = F.find((x) => x.sig.t === 'local' && x.sig.b === 'B05' && x.sig.g === 'C1');
  assert.ok(c, '應偵測到 B05 的 C1 偏高');
  assert.equal(c.sig.nd, 1, '該區 1 個焊墊超出 USL 130');
  assert.equal(c.lv, 'ng');
});

test('整板：所有群組同向偏移但都在規格內 → 整板卡只判警示', () => {
  const F = sb(detect(rows((b) => (b === 'B05' ? 15 : 0))));
  const c = F.find((x) => x.sig.t === 'board' && x.sig.b === 'B05');
  assert.ok(c, '應偵測到 B05 整片板偏移');
  assert.equal(c.sig.nd, 0, '本板沒有不良焊墊');
  assert.equal(c.lv, 'warn');
});

test('整板：同向偏移且本板有超規焊墊 → 嚴重', () => {
  const F = sb(detect(rows((b, g, p) => (b === 'B05' ? (g === 'C1' && p === 1 ? 33 : 15) : 0))));
  const c = F.find((x) => x.sig.t === 'board' && x.sig.b === 'B05');
  assert.ok(c, '應偵測到 B05 整片板偏移');
  assert.ok(c.sig.nd >= 1, '本板有不良焊墊');
  assert.equal(c.lv, 'ng');
});

test('範例資料：單板異常卡的嚴重度不受影響（範例的嚴重卡都有不良焊墊）', () => {
  const F = sb(core.detectIssues(baseState(core, { rows: core.sampleData(), metrics: ['volume', 'height', 'area', 'offx', 'offy'], metric: 'volume', group: 'ALL' })));
  assert.deepEqual(JSON.parse(JSON.stringify(F.map((x) => [x.title, x.lv]))), [['B13 的 U2 BGA：體積偏低、面積偏低', 'ng']]);
});
