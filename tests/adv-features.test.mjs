import test from "node:test";
import assert from "node:assert/strict";
import { loadCore, baseState } from "./_load.js";
import { mulberry32, makeNormal, getTemplatePads } from "../tools/gen-stable.mjs";

const core = loadCore();

test("TV-ADV-01: Box-Cox 冪次轉換對數常態數據常態化", () => {
  // 對數常態數據（已知 ln(X) ~ N(4.6, 0.3)）
  const vals = [];
  for (let i = 0; i < 300; i++) {
    // 盒繆勒轉換產生常態分佈
    const u1 = (i + 1) / 302;
    const u2 = ((i * 7 + 13) % 301) / 301;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    vals.push(Math.exp(4.6 + 0.3 * z));
  }

  const rawAd = core.andersonDarling(vals);
  assert.ok(rawAd.p < 0.01, `原始數據應拒絕常態，實際 p=${rawAd.p}`);

  const bc = core.fitBoxCox(vals);
  assert.equal(bc.valid, true);
  assert.equal(bc.method, "Box-Cox");
  // 對於對數常態數據，最佳 lambda 應接近 0（ln 轉換）
  assert.ok(Math.abs(bc.lambda) < 0.3, `最佳 lambda 應接近 0，實際 ${bc.lambda}`);
  assert.ok(bc.adP > 0.05, `轉換後 AD 檢定應大於 0.05，實際 p=${bc.adP}`);
});

test("TV-ADV-02: Johnson SB 轉換配適有界百分比數據", () => {
  // 生成雙峰厚尾且有界 (0, 100) 的錫膏體積數據
  const vals = [];
  for (let i = 0; i < 400; i++) {
    const u = (i + 0.5) / 400;
    // 邏輯斯蒂映射
    const logit = Math.log(u / (1 - u));
    vals.push(+(100 / (1 + Math.exp(-0.8 * logit))).toFixed(2));
  }

  const jh = core.fitJohnson(vals);
  assert.equal(jh.valid, true);
  assert.equal(jh.method, "Johnson");
  assert.ok(["SB", "SL", "SU"].includes(jh.family));
  assert.ok(isFinite(jh.gamma) && isFinite(jh.eta));
});

test("TV-ADV-03: ISO 21747 經驗百分位數法無分佈能力指標", () => {
  // 均勻分佈 U(70, 130)，規格 60 ~ 140
  const vals = [];
  for (let i = 0; i <= 1000; i++) {
    vals.push(70 + (60 * i) / 1000);
  }

  const iso = core.fitIsoPercentile(vals, 60, 140);
  assert.equal(iso.valid, true);
  assert.equal(iso.method, "ISO-Percentile");
  assert.ok(Math.abs(iso.x50 - 100) < 1.0, `中位數應接近 100，實際 ${iso.x50}`);
  assert.ok(isFinite(iso.ppk) && iso.ppk > 0, `Ppk 應為有限正數，實際 ${iso.ppk}`);
  assert.equal(iso.ppmObs, 0, "無超規點，實測 PPM 應為 0");
});

test("TV-ADV-04: 停線時間差分首片標記與體積衰退分析", () => {
  const baseT = Date.parse("2026-10-18T08:00:00Z");
  const rows = [];
  // 板 1, 2, 3: 連續生產（間隔 1 分鐘）
  for (let b = 1; b <= 3; b++) {
    const t = baseT + (b - 1) * 60000;
    for (let p = 1; p <= 10; p++) {
      rows.push({ board: `B0${b}`, pad: `P${p}`, ts: t, volume: 100 + (p % 3) });
    }
  }
  // 板 4: 停線 35 分鐘後的首片，體積顯著衰退
  const tPause = baseT + 2 * 60000 + 35 * 60000;
  for (let p = 1; p <= 10; p++) {
    rows.push({ board: "B04", pad: `P${p}`, ts: tPause, volume: 85 + (p % 3) });
  }

  const pd = core.analyzePauseDecay(rows, 15);
  assert.equal(pd.hasPause, true);
  assert.equal(pd.events.length, 1);
  assert.equal(pd.events[0].prevBoard, "B03");
  assert.equal(pd.events[0].postBoard, "B04");
  assert.equal(pd.events[0].pauseDurationMin, 35);
  assert.ok(pd.avgVolumeDropPct > 10, `體積衰退百分比應 > 10%，實際 ${pd.avgVolumeDropPct}%`);
  assert.ok(pd.safeDwellLimitMin <= 15, "安全靜置時間應縮減");
});

test("TV-ADV-05: 空間自相關 Moran's I 與局部 LISA 聚類檢驗", () => {
  // 生成 10x10 格點，在 (2..4, 2..4) 注入高錫量熱區
  const pts = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      let val = 100 + (r + c) * 0.05;
      if (r >= 2 && r <= 4 && c >= 2 && c <= 4) {
        val += 30; // 注入熱區
      }
      pts.push({ pad: `P_${r}_${c}`, x: c * 2, y: r * 2, val });
    }
  }

  const sa = core.calcMoranAndLISA(pts, 6);
  assert.equal(sa.valid, true);
  assert.ok(sa.moranI > 0.3, `全局 Moran's I 應顯著為正，實際 ${sa.moranI}`);
  assert.equal(sa.isSignificant, true);
  assert.ok(sa.counts.HH >= 8, `局部熱區 HH 應檢出至少 8 處，實際 ${sa.counts.HH}`);
});

test("TV-ADV-05b: Moran's I 在 i.i.d. 資料上誤報回到名目（舊版 √(1/(nk)) 近似使 Z 標準差 1.56、Z>2.58 誤報 6.2%）", () => {
  // 範例焊墊座標（116 個），各焊墊值 i.i.d. 常態：不應有空間結構
  const pads = getTemplatePads();
  const nrm = makeNormal(mulberry32(20261023));
  const T = 400, zs = [];
  let sig = 0;
  for (let t = 0; t < T; t++) {
    const sa = core.calcMoranAndLISA(pads.map(p => ({ pad: p.pad, x: p.x, y: p.y, val: nrm() })), 6);
    zs.push(sa.zScore);
    if (sa.isSignificant) sig++;
  }
  const m = zs.reduce((a, b) => a + b, 0) / T;
  const sdZ = Math.sqrt(zs.reduce((a, b) => a + (b - m) ** 2, 0) / (T - 1));
  assert.ok(sdZ > 0.85 && sdZ < 1.15, `虛無假設下 Z 標準差應約為 1，實際 ${sdZ.toFixed(3)}`);
  assert.ok(sig / T <= 0.02, `i.i.d. 資料顯著率應接近名目 0.5%，實際 ${sig}/${T}`);
});

test("TV-ADV-05c: Moran 置換檢定以固定種子計算，同資料同結果", () => {
  const pts = [];
  for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) pts.push({ pad: `P_${r}_${c}`, x: c * 2, y: r * 2, val: r + ((r * 7 + c * 13) % 5) });
  const a = core.calcMoranAndLISA(pts, 6), b = core.calcMoranAndLISA(pts, 6);
  assert.ok(a.zScore > 2.58, `測試資料應有明顯梯度，實際 Z=${a.zScore}`);
  assert.equal(a.pPerm, b.pPerm);
  assert.ok(a.pPerm > 0 && a.pPerm < 0.005);
  assert.equal(a.isSignificant, true);
});

test("TV-ADV-06: 印刷機閉環補償阻尼濾波與 Clamp 上限防護", () => {
  const rows = [];
  // 3 片板皆有系統性 X = +35µm 嚴重偏移（超規）
  for (let b = 1; b <= 3; b++) {
    for (let p = 1; p <= 10; p++) {
      rows.push({ board: `B0${b}`, pad: `P${p}`, offx: 35.0, offy: -5.0 });
    }
  }

  const corr = core.calcPrinterCorrection(rows, 3, 0.6);
  assert.equal(corr.valid, true);
  assert.equal(corr.actionRecommended, "APPLY_ON_NEXT_BOARD");
  assert.equal(corr.observedOffset.x, 35);
  // 阻尼計算 -0.6 * 35 = -21，但受 Clamp 上限限制不得超過 -20µm
  assert.equal(corr.correction.offsetX_um, -20.0, "X 補償應被限制在 -20µm");
  // Y 補償 -0.6 * (-5) = +3.0µm
  assert.equal(corr.correction.offsetY_um, 3.0);
});

test("進階整合測試：buildRows 解析形貌欄位並整合至 analyze 與 detectIssues", () => {
  const csv = [
    "Board,Pad,Volume,Height,Area,OffsetX,OffsetY,BridgeGap,BridgeMargin,Peaking,Coplanarity,Coverage,Slump",
    "B01,P1,100,120,100,0,0,25,18,42,15,95,12",
    "B01,P2,98,118,99,0,0,22,15,40,16,92,10",
    "B01,P3,99,121,101,0,0,20,14,39,18,94,11",
    "B01,P4,102,122,100,0,0,28,20,38,15,96,15"
  ].join("\n");

  const tab = core.csvTable(csv);
  const map = core.autoMap(tab.head);
  assert.ok(map.bridgemargin != null, "應自動對應 bridgemargin");
  assert.ok(map.peaking != null, "應自動對應 peaking");

  const built = core.buildRows(tab, map);
  const rows = built.rows;
  assert.equal(rows.length, 4);
  assert.equal(rows[0].bridgemargin, 18);
  assert.equal(rows[0].peaking, 42);

  const st = baseState(core, { rows });
  const A = core.analyze(st);
  assert.ok(A.printerCorr != null, "analyze 應產出 printerCorr");

  const issues = core.detectIssues(st);
  const bridgeIssue = issues.find(x => x.cat === "形貌缺陷" && x.rule_id.includes("BridgeMargin"));
  assert.ok(bridgeIssue != null, "應偵測出橋接餘裕不足問題卡");
  assert.equal(bridgeIssue.lv, "ng");

  const peakingIssue = issues.find(x => x.cat === "形貌缺陷" && x.rule_id.includes("Peaking"));
  assert.ok(peakingIssue != null, "應偵測出拉尖超標問題卡");
  assert.equal(peakingIssue.lv, "warn");
});
