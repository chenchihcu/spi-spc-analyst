// Step 10 驗證測試：D-24、D-44＋D-70、D-57、D-69、D-67＋D-71
// 匯入解析穩健性與機台判定推估重算
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

function createTestContext(url = "https://spi.example/#data") {
  const dom = new JSDOM(html(), {
    runScripts: "dangerously",
    url,
    beforeParse(w) {
      w.scrollTo = () => {};
      w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {} });
      w.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,mock";
      w.SPI_TEST_HOOK = {};
    }
  });
  return { dom, hook: dom.window.SPI_TEST_HOOK };
}

test("D-24: RFC 4180 CSV 狀態機解析支援引號內換行、跳脫雙引號與含逗號之標題", () => {
  const { hook } = createTestContext();
  const csvText = `"Board ID","Pad, Name","Remark","Volume (%)"\r\n` +
    `"B01","U1-1","This is a ""quoted"" remark",105.5\r\n` +
    `"B02","U1-2","Line 1\r\nLine 2\r\nLine 3",98.2\r\n` +
    `"B03","U1-3","Normal",102.0`;

  const parsed = hook.csvTable(csvText);
  assert.equal(parsed.head.length, 4);
  assert.equal(parsed.head[1], "Pad, Name");
  assert.equal(parsed.head[3], "Volume (%)");
  assert.equal(parsed.data.length, 3);

  // 驗證跳脫引號
  assert.equal(parsed.data[0][2], 'This is a "quoted" remark');
  assert.equal(parsed.data[0][3], "105.5");

  // 驗證引號內多行換行保持單一欄位
  assert.equal(parsed.data[1][0], "B02");
  assert.equal(parsed.data[1][1], "U1-2");
  assert.ok(parsed.data[1][2].includes("Line 1"));
  assert.ok(parsed.data[1][2].includes("Line 2"));
  assert.ok(parsed.data[1][2].includes("Line 3"));
  assert.equal(parsed.data[1][3], "98.2");

  // 第 3 列正常解析
  assert.equal(parsed.data[2][0], "B03");
  assert.equal(parsed.data[2][1], "U1-3");
});

test("D-44 + D-70: AOI 匯入支援多板別名、焊墊鍵去前導零正規化與交集板數比對", () => {
  const { hook } = createTestContext();

  // 1. 測試 normPadKey
  assert.equal(hook.normPadKey("U2-01"), "U2-1");
  assert.equal(hook.normPadKey("u2-005"), "U2-5");
  assert.equal(hook.normPadKey("r1-001"), "R1-1");
  assert.equal(hook.normPadKey("c10-2"), "C10-2");

  // 2. 測試 parseAOI 支援 boardno, pcbid, boardbarcode 別名
  const aoiCsv1 = `pcbid,pad,result\r\nB01,U2-01,NG\r\nB02,U2-02,OK\r\nB03,R1-01,NG`;
  const t1 = hook.csvTable(aoiCsv1);
  const aoi1 = hook.parseAOI(t1);
  assert.equal(aoi1.length, 3);
  assert.equal(aoi1[0].board, "B01");
  assert.equal(aoi1[0].pad, "U2-01");

  // 3. 測試 aoiCorr 交集比對
  // 構造 SPI 資料：B01, B02
  const spiRows = [
    { board: "B01", pad: "U2-1", comp: "U2" },
    { board: "B01", pad: "U2-2", comp: "U2" },
    { board: "B02", pad: "U2-1", comp: "U2" }
  ];
  hook.S.rows = spiRows;

  // AOI 資料有 B01, B02, B03，其中 B01, B02 在 SPI 中，B03 不在
  const corr = hook.aoiCorr(aoi1, spiRows);
  assert.equal(corr.boardsAOI, 3);
  assert.equal(corr.boardsMatched, 2); // B01, B02
  assert.equal(corr.padsMatched, 2);   // U2-1, U2-2
});

test("D-57: 立榮寬表缺失 Component ID 欄位時拋出包含 4 項要素的詳細錯誤，並支援 designator/location/元件位號別名", () => {
  const { hook } = createTestContext();

  // 缺少 Component ID 欄位的寬表
  const wideMissingComp = {
    head: ["PadID", "Height(%)1", "Height(%)2", "Volume(%)1", "Volume(%)2"],
    data: [
      ["1", "100", "102", "99", "101"],
      ["2", "95", "98", "96", "97"]
    ]
  };

  try {
    hook.unpivotWide(wideMissingComp);
    assert.fail("Should have thrown error for missing component id");
  } catch (err) {
    const msg = err.message;
    // 驗證 4 大要素
    assert.ok(msg.includes("Component ID") || msg.includes("元件位號"), "應提及缺失的欄位名稱");
    assert.ok(msg.includes("refdes") && msg.includes("designator"), "應列出系統接受的別名清單");
    assert.ok(msg.includes("PadID") && msg.includes("Height(%)1"), "應列出檔案前 10 個偵測到的欄位");
    assert.ok(msg.includes("下載立榮範本 CSV"), "應提示下載立榮範本 CSV");
  }

  // 測試支援 designator 別名
  const wideWithDesignator = {
    head: ["designator", "PadID", "Height(%)1", "Height(%)2", "Volume(%)1", "Volume(%)2"],
    data: [
      ["U1", "1", "100", "102", "99", "101"],
      ["U1", "2", "95", "98", "96", "97"]
    ]
  };
  const unpivoted = hook.unpivotWide(wideWithDesignator, { stencil: 120 });
  assert.equal(unpivoted.tab.head.includes("Component ID"), true);
  assert.equal(unpivoted.tab.data.length, 4); // 2 pads x 2 boards
});

test("D-69 / TV-22: 機台判定碼自訂 codeMap 對照（例如 WARNING 映射為 OK）", () => {
  const { hook } = createTestContext();

  const tab = {
    head: ["board", "pad", "volume", "height", "area", "result"],
    data: [
      ["B01", "P01", "100", "120", "100", "PASS"],
      ["B01", "P02", "100", "120", "100", "WARNING"],
      ["B01", "P03", "100", "120", "100", "CUSTOM_DEFECT"],
      ["B01", "P04", "100", "120", "100", "UNKNOWN_CODE"]
    ]
  };
  const map = { board: 0, pad: 1, volume: 2, height: 3, area: 4, result: 5 };

  // 1. 不帶自訂 codeMap：WARNING 與 CUSTOM_DEFECT 視為 NG
  const resDefault = hook.buildRows(tab, map);
  assert.equal(resDefault.rows[0].mNG, false); // PASS -> OK
  assert.equal(resDefault.rows[1].mNG, true);  // WARNING -> NG
  assert.equal(resDefault.rows[2].mNG, true);  // CUSTOM_DEFECT -> NG

  // 2. 帶有 codeMap: { warning: "ok", custom_defect: "ng" }
  const resCustom = hook.buildRows(tab, map, {
    codeMap: { warning: "ok", custom_defect: "ng" }
  });
  assert.equal(resCustom.rows[0].mNG, false); // PASS -> OK
  assert.equal(resCustom.rows[1].mNG, false); // WARNING -> OK (透過 codeMap 映射)
  assert.equal(resCustom.rows[2].mNG, true);  // CUSTOM_DEFECT -> NG
  assert.equal(resCustom.rows[3].mNG, true);  // UNKNOWN_CODE -> NG
});

test("D-67 + D-71 / TV-23: 階梯鋼板推估規格窗重算 (recomputeMachineSpecs) 與涵蓋提示", () => {
  const { hook, dom } = createTestContext();
  const S = hook.S;

  // 構造 25 筆 OK 焊墊資料（高度在 110 ~ 130 之間分散以有變異）
  const rows = [];
  for (let i = 1; i <= 25; i++) {
    rows.push({
      board: "B01",
      pad: "U1-" + i,
      comp: "U1",
      group: "U1",
      x: 10 + i * 2,
      y: 20,
      w: 0.5,
      d: 0.5,
      height: 110 + (i % 5) * 5, // 110, 115, 120, 125, 130
      volume: 100,
      area: 100,
      result: "PASS",
      mNG: false
    });
  }
  S.rows = rows;
  S.specSrc = "machine";
  S.stencil = 120;
  S.step = { on: false, zones: [] };

  // 1. 基礎厚度 120 µm 時推估 specs
  hook.recomputeMachineSpecs();
  assert.ok(S.specs.hpct);
  const baseHpctLsl = S.specs.hpct.lsl;
  const baseHpctUsl = S.specs.hpct.usl;
  // 110 / 120 * 100 = 91.7%, 130 / 120 * 100 = 108.3%
  assert.equal(baseHpctLsl, 91.7);
  assert.equal(baseHpctUsl, 108.3);

  // 2. 啟用階梯鋼板，將 U1 區域設定為 100 µm
  S.step = {
    on: true,
    zones: [{ id: 1, name: "階梯區1", mode: "group", group: "U1", t: 100 }]
  };

  // 呼叫 zonesChanged 觸發 recomputeMachineSpecs
  hook.zonesChanged();

  // 驗證 height / hpct 推估規格已重算：
  // 在 100 µm 下，110 µm 高度的 hpct 為 110 / 100 * 100 = 110%
  // 130 µm 高度的 hpct 為 130 / 100 * 100 = 130%
  assert.equal(S.specs.hpct.lsl, 110);
  assert.equal(S.specs.hpct.usl, 130);

  // 3. 測試 renderZones 在找不到群組時插入（資料中沒有：...）選項
  S.step.zones.push({ id: 2, name: "無效區", mode: "group", group: "NON_EXISTENT", t: 150 });
  hook.renderZones();
  const zoneTblHtml = dom.window.document.getElementById("zoneTbl").innerHTML;
  assert.ok(zoneTblHtml.includes("資料中沒有：NON_EXISTENT"));
  assert.ok(zoneTblHtml.includes("目前資料無此群組"));

  // 4. 測試鋼板厚度 header 與提示
  hook.syncControls();
  const railSumText = dom.window.document.getElementById("railSum").textContent;
  assert.ok(railSumText.includes("階梯 2 區"));
  assert.ok(railSumText.includes("涵蓋 25 焊墊")); // 25 筆 U1 焊墊被涵蓋
});
