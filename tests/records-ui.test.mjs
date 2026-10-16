// 資料庫介面測試（純雲端模式：透過 /api/records 與 Cloudflare D1 + R2 互動）
// 必填檢查 → 存入後建立回合（回合帶批號／料號／指紋）→ 資料庫頁列出、驗證、下載原始檔 → 從資料庫開啟 → 重複檔 → 刪除與稽核紀錄
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const { JSDOM } = (() => { try { return require("jsdom"); } catch { return {}; } })();
const fs = require("fs");
const { HTML, withIdb } = require("./_load.js");
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function page(saved, serverStateOverride) {
  const html = fs.readFileSync(HTML, "utf8").replace(/<script src=[^>]+><\/script>/g, "");
  const errs = [];
  const server = serverStateOverride || {
    user: "a@x.tw",
    records: [],
    files: new Map(),
    audit: [],
  };
  let auditSeq = 0;
  const blobMap = new Map();

  const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://example.test/", beforeParse(w) {
    w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, k) => (k === "measureText" ? () => ({ width: 1 }) : t[k] ?? (() => {})), set: (t, k, v) => ((t[k] = v), true) });
    Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { let e = this; while (e) { if (e.hidden) return null; e = e.parentElement; } return w.document.body; } });
    w.Element.prototype.scrollIntoView = () => {}; w.matchMedia = () => ({ matches: false, addEventListener() {} }); w.ResizeObserver = class { observe() {} }; w.scrollTo = () => {};
    w.Chart = class { constructor() {} destroy() {} static register() {} };

    // 捕捉瀏覽器下載：URL.createObjectURL + HTMLAnchorElement.click
    w.URL.createObjectURL = (blob) => {
      const u = "blob:test/" + Math.random();
      blobMap.set(u, blob);
      return u;
    };
    w.URL.revokeObjectURL = (u) => { blobMap.delete(u); };
    w.HTMLAnchorElement.prototype.click = function () {
      if (this.download && saved) {
        saved.push({ filename: this.download, data: blobMap.get(this.href) || this.href });
        return;
      }
    };

    // Mock 雲端 API（模擬 Cloudflare D1 + R2）
    w.fetch = async (url, opts = {}) => {
      const u = new URL(url, "https://example.test/");
      const pathname = u.pathname;
      if (pathname === "/__me") {
        return Response.json({ user: server.user });
      }
      if (pathname === "/api/records") {
        const method = (opts.method || "GET").toUpperCase();
        if (method === "GET") {
          const id = u.searchParams.get("id");
          if (id && u.searchParams.get("meta") === "1") {
            const r = server.records.find((x) => x.id === id);
            if (!r) return Response.json({ error: "找不到這筆紀錄" }, { status: 404 });
            return Response.json({ record: r });
          }
          if (id) {
            const r = server.records.find((x) => x.id === id);
            if (!r || !server.files.has(id)) return Response.json({ error: "找不到原始檔案" }, { status: 404 });
            return new Response(server.files.get(id), {
              headers: {
                "Content-Type": "application/gzip",
                "X-Rec-Sha256": r.sha256,
                "X-Raw-Bytes": String(r.bytes),
              },
            });
          }
          if (u.searchParams.get("audit") === "1") {
            return Response.json({ entries: [...server.audit].reverse() });
          }
          return Response.json({ records: [...server.records], me: server.user });
        }
        if (method === "POST") {
          const headers = opts.headers || {};
          let meta = {};
          try {
            meta = JSON.parse(decodeURIComponent(headers["X-Rec-Meta"] || headers["x-rec-meta"] || ""));
          } catch {}
          const rawBytes = +(headers["X-Raw-Bytes"] || headers["x-raw-bytes"] || 0);
          const rawSha = headers["X-Raw-SHA256"] || headers["x-raw-sha256"] || "";
          const dup = server.records.find((r) =>
            r.kind === meta.kind &&
            r.part === meta.part &&
            (r.rev || "") === (meta.rev || "") &&
            (r.lot || "") === (meta.lot || "") &&
            (r.side || "") === (meta.side || "") &&
            (r.vendor || "") === (meta.vendor || "") &&
            (r.placeId || r.place_id || "") === (meta.placeId || "") &&
            r.sha256 === rawSha
          );
          if (dup) {
            return Response.json({ error: "這個檔案已經存過（相同內容與相同回溯欄位）", existing: dup.id }, { status: 409 });
          }
          const id = "REC" + Math.random().toString(36).slice(2, 12);
          const body = opts.body;
          if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
            server.files.set(id, new Uint8Array(body));
          } else {
            server.files.set(id, new Uint8Array(0));
          }
          const rec = {
            ...meta,
            id,
            bytes: rawBytes,
            sha256: rawSha,
            user: server.user,
            created: Date.now(),
          };
          server.records.unshift(rec);
          server.audit.push({
            seq: ++auditSeq,
            at: rec.created,
            by: server.user,
            action: "create",
            target_id: id,
            kind: rec.kind,
            lot: rec.lot || "",
            part: rec.part,
            rev: rec.rev || "",
            name: rec.name,
            sha256: rec.sha256,
            bytes: rec.bytes,
          });
          return Response.json({ record: rec });
        }
        if (method === "DELETE") {
          const id = u.searchParams.get("id");
          const idx = server.records.findIndex((x) => x.id === id);
          if (idx < 0) return Response.json({ error: "找不到這筆紀錄" }, { status: 404 });
          const rec = server.records[idx];
          if (rec.user !== server.user) return Response.json({ error: "只有上傳者可以刪除" }, { status: 403 });
          server.records.splice(idx, 1);
          server.files.delete(id);
          server.audit.push({
            seq: ++auditSeq,
            at: Date.now(),
            by: server.user,
            action: "delete",
            target_id: id,
            kind: rec.kind,
            lot: rec.lot || "",
            part: rec.part,
            rev: rec.rev || "",
            name: rec.name,
            sha256: rec.sha256,
            bytes: rec.bytes,
          });
          return Response.json({ ok: true });
        }
      }
      return new Response("Not found", { status: 404 });
    };

    Object.assign(w, { Response, DecompressionStream, CompressionStream, Blob });
    withIdb(w);
    w.SPI_TEST_HOOK = {};
    w.addEventListener("error", (e) => errs.push(e.message));
  } });
  return { dom, errs, server };
}
const CSV = "Board,Pad,Component,Volume,Height,Area\n" + Array.from({ length: 60 }, (_, i) => `B${Math.floor(i / 6) + 1},P${i % 6},U1,${100 + (i % 5)},120,100`).join("\n");
async function until(fn, n = 150) { for (let i = 0; i < n; i++) { if (fn()) return true; await tick(20); } return false; }
async function pickFile(dom, name, text) {
  const w = dom.window, inp = w.document.querySelector("#fileIn");
  Object.defineProperty(inp, "files", { configurable: true, value: [new w.File([Buffer.from(text)], name)] });
  inp.dispatchEvent(new w.Event("change"));
  await until(() => !w.document.querySelector("#mapBox").hidden || w.document.querySelector("#parseErr").textContent);
}

test("JS 版 SHA-256（瀏覽器不支援內建時使用）與標準結果相同", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom } = page([]);
  await tick(50);
  const w = dom.window;
  for (const s of ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "中文批號 L2410", "x".repeat(100000)]) {
    const hex = w.eval(`SPI_TEST_HOOK.sha256js(new TextEncoder().encode(${JSON.stringify(s)}))`);
    assert.equal(hex, createHash("sha256").update(s).digest("hex"), `長度 ${s.length}`);
  }
});

test("批號、料號必填；存入後才建立回合，回合帶來源資訊；資料庫頁可列出、驗證、下載原始檔（內容不變）", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const saved = [], { dom, errs } = page(saved);
  await tick(50);
  const w = dom.window, d = w.document, $ = (s) => d.querySelector(s);
  $("[data-tab=data]").click();
  await pickFile(dom, "批次A_TOP.csv", CSV);
  assert.equal($("#recRow").hidden, false);
  $("#inLot").value = ""; $("#inPart").value = "";
  $("#btnApply").click(); await tick(50);
  assert.match($("#recNote").textContent, /請填寫批號與產品料號/);
  assert.equal(w.eval("S.runs.length"), 2, "未填不建立回合");
  $("#inLot").value = "L2410-01"; $("#inPart").value = "301-000100124";
  $("#btnApply").click();
  assert.ok(await until(() => w.eval("S.runs.length") === 3), "存入後建立回合");
  const src = JSON.parse(w.eval("JSON.stringify(SPI_TEST_HOOK.curRun().info.src)"));
  assert.equal(src.lot, "L2410-01"); assert.equal(src.part, "301-000100124"); assert.equal(src.store, "cloud"); assert.equal(src.user, "a@x.tw");
  assert.equal(src.sha256, createHash("sha256").update(CSV).digest("hex"), "指紋為原始檔的 SHA-256");
  assert.match(w.eval("SPI_TEST_HOOK.reportMd()"), /批號 L2410-01｜產品料號 301-000100124/, "報告帶批號與料號");
  // 資料庫頁
  $("[data-tab=data]").click(); $('.subtab[data-sub="records"]').click();
  assert.ok(await until(() => /L2410-01/.test($("#recSpi").textContent)));
  assert.match($("#recMode").textContent, /雲端資料庫/);
  $('#recSpi [data-ract="ver"]').click();
  assert.ok(await until(() => /與上傳時相同/.test($("#recSpi").textContent)), "驗證通過");
  $('#recSpi [data-ract="dl"]').click();
  assert.ok(await until(() => saved.length === 1));
  const txt = typeof saved[0].data?.text === "function" ? await saved[0].data.text() : String(saved[0].data);
  assert.equal(txt, CSV, "下載的原始檔與上傳完全相同");
  // 回合清單顯示批號
  $('.subtab[data-sub="runs"]').click();
  assert.match($("#runTbl").textContent, /L2410-01/);
  assert.deepEqual(errs, []);
});

test("重複檔沿用既有紀錄；從資料庫開啟時批號料號帶入且不可改、不重複存；只有上傳者可刪，刪除留稽核紀錄", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom, errs, server } = page([]);
  await tick(50);
  const w = dom.window, d = w.document, $ = (s) => d.querySelector(s);
  $("[data-tab=data]").click();
  for (let k = 0; k < 2; k++) {
    await pickFile(dom, "a.csv", CSV);
    $("#inLot").value = "L1"; $("#inPart").value = "P1"; $("#btnApply").click();
    assert.ok(await until(() => w.eval("S.runs.length") === 3 + k));
  }
  const recs = await w.eval("SPI_TEST_HOOK.RecDB.list()");
  assert.equal(recs.length, 1, "相同檔案＋相同批號只存一筆");
  assert.equal(w.eval("S.runs[2].info.src.id"), w.eval("S.runs[3].info.src.id"), "兩個回合連到同一筆紀錄");
  // 從資料庫開啟
  $("[data-tab=data]").click(); $('.subtab[data-sub="records"]').click();
  assert.ok(await until(() => d.querySelector('#recSpi [data-ract="open"]')));
  $('#recSpi [data-ract="open"]').click();
  assert.ok(await until(() => !$("#mapBox").hidden && $("#inLot").value === "L1"));
  assert.equal($("#inLot").readOnly, true); assert.equal($("#inPart").readOnly, true);
  assert.match($("#recNote").textContent, /不會重複存檔/);
  $("#btnApply").click();
  assert.ok(await until(() => w.eval("S.runs.length") === 5));
  assert.equal((await w.eval("SPI_TEST_HOOK.RecDB.list()")).length, 1, "開啟後套用不新增紀錄");
  // 別人上傳的紀錄不顯示刪除鈕
  server.records.push({ ...server.records[0], id: "OTHERxxxxxxxxxxxxxxxxx", user: "b@x.tw", lot: "L9" });
  $("[data-tab=data]").click(); $('.subtab[data-sub="records"]').click(); $("#recReload").click();
  assert.ok(await until(() => /L9/.test($("#recSpi").textContent)));
  const rowOf = (lot) => [...d.querySelectorAll("#recSpi tbody tr")].find((tr) => tr.textContent.includes(lot));
  assert.equal(rowOf("L9").querySelector('[data-ract="del"]'), null, "別人的紀錄沒有刪除鈕");
  // 自己的：按兩次才刪
  rowOf("L1").querySelector('[data-ract="del"]').click();
  assert.ok(await until(() => /確定刪除？/.test(rowOf("L1").textContent)));
  rowOf("L1").querySelector('[data-ract="del"]').click();
  assert.ok(await until(() => !rowOf("L1")), "已刪除");
  $("#recAuditBox").open = true; $("#recAuditBox").dispatchEvent(new w.Event("toggle"));
  assert.ok(await until(() => /刪除/.test($("#recAudit").textContent)));
  const audit = $("#recAudit").textContent;
  assert.match(audit, /新增/); assert.match(audit, /L1/);
  assert.deepEqual(errs, []);
});

test("座標檔：未填料號與版本不能上傳；存入後可在資料庫設為目前座標檔；料號與量測不同時提醒", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom } = page([]);
  await tick(50);
  const w = dom.window, d = w.document, $ = (s) => d.querySelector(s);
  const sv = $("#selVendor"); sv.value = "lirong"; sv.dispatchEvent(new w.Event("change"));
  const PL = "RefDes,X,Y,PartType,Layer\nC1,10,20,C0402,TOP\n";
  const up = async (name) => { const inp = $("#placeIn"); Object.defineProperty(inp, "files", { configurable: true, value: [new w.File([Buffer.from(PL)], name)] }); inp.dispatchEvent(new w.Event("change")); await tick(300); };
  $("#placePart").value = ""; $("#placeRev").value = "";
  await up("p.csv");
  assert.match($("#placeState").textContent, /請先填寫座標檔的產品料號與版本/);
  assert.equal((await w.eval("SPI_TEST_HOOK.RecDB.list()")).length, 0);
  $("#placePart").value = "X3000"; $("#placeRev").value = "V5";
  await up("p.csv");
  assert.match($("#placeState").textContent, /料號 X3000 版本 V5 .*已存入資料庫/);
  const list = await w.eval("SPI_TEST_HOOK.RecDB.list()");
  assert.equal(list.length, 1); assert.equal(list[0].kind, "place"); assert.equal(list[0].comps, 1);
  // 料號不同的提醒（量測檔用通用格式）
  $("[data-tab=data]").click(); sv.value = "generic"; sv.dispatchEvent(new w.Event("change"));
  await pickFile(dom, "m_TOP.csv", CSV.replace("Board,Pad,Component,Volume,Height,Area", "Board,Pad,Component,Volume,Height,Area"));
  $("#inPart").value = "OTHER"; $("#inPart").dispatchEvent(new w.Event("input"));
  assert.match($("#recNote").textContent, /座標檔料號為 X3000，與量測料號不同/);
  // 移除後再從資料庫設為目前座標檔
  $("#placeClear").click();
  assert.match($("#placeState").textContent, /未載入/);
  $('.subtab[data-sub="records"]').click();
  assert.ok(await until(() => d.querySelector('#recPlace [data-ract="use"]')));
  $('#recPlace [data-ract="use"]').click();
  assert.ok(await until(() => /料號 X3000 版本 V5/.test($("#placeState").textContent)));
  assert.ok(await until(() => /目前使用/.test($("#recPlace").textContent)));
});

test("從資料庫開啟當時沒用座標檔的立榮紀錄：不套用目前載入的座標檔；有用座標檔的紀錄會帶回原座標檔", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom, errs } = page([]);
  await tick(50);
  const w = dom.window, d = w.document, $ = (s) => d.querySelector(s);
  const head = ["Component ID", "Height(%)1", "Volume(%)1", "Area(%)1", "PAD ID", "Result1", "Height(%)2", "Volume(%)2", "Area(%)2", "Result2"].join(",");
  const WIDE = head + "\nC1_1,100,101,99,1,PASS,102,103,98,PASS\nC1_1,100,101,99,2,PASS,102,103,98,PASS\n";
  const sv = $("#selVendor"); sv.value = "lirong"; sv.dispatchEvent(new w.Event("change"));
  $("[data-tab=data]").click();
  await pickFile(dom, "W_TOP.csv", WIDE);
  assert.match($("#mapPrev").textContent, /未載入座標檔/);
  $("#inLot").value = "LW"; $("#inPart").value = "PW"; $("#btnApply").click();
  assert.ok(await until(() => w.eval("S.runs.length") === 3));
  // 之後載入座標檔，再從資料庫開啟舊紀錄
  $("#placePart").value = "PW"; $("#placeRev").value = "V1";
  const inp = $("#placeIn"); Object.defineProperty(inp, "files", { configurable: true, value: [new w.File([Buffer.from("RefDes,X,Y,PartType,Layer\nC1,10,20,C0402,TOP\n")], "pl.csv")] }); inp.dispatchEvent(new w.Event("change"));
  assert.ok(await until(() => /已存入資料庫/.test($("#placeState").textContent)));
  $("[data-tab=data]").click(); $('.subtab[data-sub="records"]').click();
  assert.ok(await until(() => d.querySelector('#recSpi [data-ract="open"]')));
  $('#recSpi [data-ract="open"]').click();
  assert.ok(await until(() => !$("#mapBox").hidden && $("#inLot").value === "LW"));
  assert.match($("#mapPrev").textContent, /未載入座標檔/, "不套用之後才載入的座標檔");
  assert.match($("#toast").textContent, /當時沒有使用座標檔/);
  // 用座標檔再匯入一次（另存一筆，因為座標檔不同），再開啟它會帶回該座標檔
  $("#btnApply").click(); assert.ok(await until(() => w.eval("S.runs.length") === 4));
  await pickFile(dom, "W_TOP.csv", WIDE);
  assert.match($("#mapPrev").textContent, /座標檔對應 1\/1/);
  $("#inLot").value = "LW"; $("#inPart").value = "PW"; $("#btnApply").click();
  assert.ok(await until(() => w.eval("S.runs.length") === 5));
  const recs = (await w.eval("SPI_TEST_HOOK.RecDB.list()")).filter((r) => r.kind === "spi");
  assert.equal(recs.length, 2, "座標檔不同 → 另存一筆，不沿用舊紀錄");
  assert.ok(recs.some((r) => r.placeId) && recs.some((r) => !r.placeId));
  $("#placeClear").click();
  $("[data-tab=data]").click(); $('.subtab[data-sub="records"]').click(); $("#recReload").click();
  assert.ok(await until(() => d.querySelectorAll('#recSpi [data-ract="open"]').length === 2));
  const withPl = recs.find((r) => r.placeId);
  [...d.querySelectorAll('#recSpi [data-ract="open"]')].find((b) => b.dataset.id === withPl.id).click();
  assert.ok(await until(() => !$("#mapBox").hidden && /座標檔對應 1\/1/.test($("#mapPrev").textContent)), "帶回當時的座標檔");
  assert.deepEqual(errs, []);
});

test("開啟紀錄失敗後，下一次手動匯入不會沿用該紀錄；連結的座標檔已刪除時仍可開啟（不套用座標檔）", { skip: !JSDOM && "未安裝 jsdom" }, async () => {
  const { dom, errs } = page([]);
  await tick(50);
  const w = dom.window, d = w.document, $ = (s) => d.querySelector(s);
  const H = "SPI_TEST_HOOK";
  // 一筆內容損壞的 .xlsx 紀錄：開啟時讀檔失敗
  await w.eval(`${H}.RecDB.create({kind:"spi",lot:"BAD",part:"P",name:"bad.xlsx"},new TextEncoder().encode("not a zip at all, broken"))`);
  $("[data-tab=data]").click(); $('.subtab[data-sub="records"]').click();
  assert.ok(await until(() => d.querySelector('#recSpi [data-ract="open"]')));
  $('#recSpi [data-ract="open"]').click();
  assert.ok(await until(() => /無法開啟/.test(($("#toast") || {}).textContent || "")));
  // 接著手動匯入：批號可填、會另存新紀錄
  await pickFile(dom, "ok.csv", CSV);
  assert.equal($("#inLot").readOnly, false, "沒有沿用失敗的紀錄");
  assert.equal($("#inLot").value, "");
  $("#inLot").value = "GOOD"; $("#inPart").value = "P"; $("#btnApply").click();
  assert.ok(await until(() => w.eval("S.runs.length") === 3));
  assert.equal(w.eval(`${H}.curRun().info.src.lot`), "GOOD");
  // 連結的座標檔被刪除後開啟立榮紀錄
  const sv = $("#selVendor"); sv.value = "lirong"; sv.dispatchEvent(new w.Event("change"));
  $("#placePart").value = "P"; $("#placeRev").value = "R1";
  const inp = $("#placeIn"); Object.defineProperty(inp, "files", { configurable: true, value: [new w.File([Buffer.from("RefDes,X,Y,PartType,Layer\nC1,10,20,C0402,TOP\n")], "pl.csv")] }); inp.dispatchEvent(new w.Event("change"));
  assert.ok(await until(() => /已存入資料庫/.test($("#placeState").textContent)));
  const WIDE = "Component ID,Height(%)1,Volume(%)1,Area(%)1,PAD ID,Result1,Height(%)2,Volume(%)2,Area(%)2,Result2\nC1_1,100,101,99,1,PASS,102,103,98,PASS\n";
  $("[data-tab=data]").click(); await pickFile(dom, "L_TOP.csv", WIDE);
  $("#inLot").value = "LP"; $("#btnApply").click();
  assert.ok(await until(() => w.eval("S.runs.length") === 4));
  const pid = w.eval(`${H}.curRun().info.src.placeId`);
  assert.ok(pid, "記錄了座標檔");
  await w.eval(`${H}.RecDB.del(${JSON.stringify(pid)})`);
  $("[data-tab=data]").click(); $('.subtab[data-sub="records"]').click();
  assert.ok(await until(() => [...d.querySelectorAll("#recSpi tbody tr")].some((tr) => tr.textContent.includes("LP"))));
  [...d.querySelectorAll("#recSpi tbody tr")].find((tr) => tr.textContent.includes("LP")).querySelector('[data-ract="open"]').click();
  assert.ok(await until(() => !$("#mapBox").hidden && $("#inLot").value === "LP"));
  assert.match($("#toast").textContent, /座標檔已從資料庫刪除或無法取回/);
  assert.match($("#mapPrev").textContent, /未載入座標檔/);
  assert.deepEqual(errs, []);
});
