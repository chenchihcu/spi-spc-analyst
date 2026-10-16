import test from 'node:test';
import assert from 'node:assert/strict';

// 金標測試骨架 (M-04, TV-21)
// 依規則 0.5: 依賴尚未完成項目的測試使用 test.todo 或 test.skip 標示依賴項目

test.todo('[D-10] no_coords: 空間分布與問題地圖顯示不適用，無空間問題卡');
test.todo('[D-10] partial_spec: area 無規格時顯示無規格，不為 0 或 NaN');
test.todo('[M-02] sigma_zero_constant: 能力與管制圖拒算並顯示原因');
test.todo('[M-02] sample_lt_10: 樣本數不足 10 顯示原因不輸出數值');
test.todo('[D-42] duplicate_refdes_coords: 座標重複時取第一筆並列出忽略座標');
test.todo('[D-42] refdes_suffix_strip_join: 位號 _N 後綴剝除後比對 join');
test.todo('[D-25] partial_coord_match: 依多欄重複鍵去重，對不上列出位號');
test.todo('[D-43] panel_id_instead_of_board: PanelId 自動對應為板號');
test.todo('[D-43] time_only_measurements: 純時間序推定板號');
test.todo('[D-43] timestamp_alias_measurements: Timestamp 欄位別名');
test.todo('[D-43] timestamp_lowercase_measurements: timestamp 小寫別名');
test.todo('[D-43] datetime_alias_measurements: DateTime 欄位別名');

test('normal_baseline: 基礎數值驗證骨架', () => {
  assert.ok(true, 'normal_baseline 骨架備妥');
});
