// 上線前檢查：依 validate-production-release 的七大類，改寫為適用單頁 HTML 工具的版本
// 用法：node tools/release-check.js [--json]
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const read = (f) => (fs.existsSync(path.join(ROOT, f)) ? fs.readFileSync(path.join(ROOT, f), "utf8") : null);
const html = read("spi-spc.html") || "";
const out = {};
const put = (k, status, messages) => (out[k] = { status, messages });

// 1. 版本與封裝
{
  const m = [], ver = (html.match(/id="appVer">([^<]+)</) || [])[1], built = (html.match(/id="appBuilt">([^<]+)</) || [])[1];
  let st = "pass";
  if (!ver) { st = "fail"; m.push("FACT: 主頁找不到版本號 #appVer"); }
  else if (!/^v\d+\.\d+\.\d+$/.test(ver)) { st = "fail"; m.push(`FACT: 版本號 ${ver} 不是語意化版本 vMAJOR.MINOR.PATCH`); }
  else m.push(`FACT: 主頁版本 ${ver}`);
  if (!built || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(built)) { st = "fail"; m.push(`FACT: 更新時間「${built}」不是 YYYY-MM-DD HH:MM:SS`); }
  else m.push(`FACT: 主頁更新時間 ${built}`);
  const hard = (html.match(/版本：v\d+|系統版本：v\d+/g) || []);
  if (hard.length) { st = st === "fail" ? st : "warn"; m.push(`FACT: 報告中仍有 ${hard.length} 處寫死的版本字串，應改讀主頁版本`); }
  put("version", st, m);
}
// 2. 更新紀錄
{
  const cl = read("CHANGELOG.md"), ver = ((html.match(/id="appVer">v([^<]+)</) || [])[1]) || "";
  if (!cl) put("changelog", "fail", ["FACT: 找不到 CHANGELOG.md"]);
  else {
    const top = (cl.match(/^## (v[^\s]+)\s*—\s*(\S+)/m) || []);
    const ok = top[1] === "v" + ver, dated = /^\d{4}-\d{2}-\d{2}/.test(top[2] || "");
    put("changelog", ok && dated ? "pass" : "warn", [`FACT: 最新條目 ${top[1] || "無"}（${top[2] || "無日期"}）`, ok ? "FACT: 與主頁版本一致" : `FACT: 與主頁版本 v${ver} 不一致`]);
  }
}
// 3. 除錯殘留
{
  const pats = { "console 輸出": /console\.(log|debug|warn|error)\(/g, debugger: /\bdebugger\s*;/g, "alert()": /\balert\(/g, "TODO/FIXME": /\b(TODO|FIXME|HACK|XXX)\b/g, "本機位址": /localhost|127\.0\.0\.1|0\.0\.0\.0/g };
  // 判斷是否有後端的那一行（HAS_API）刻意列出本機位址，供本機測試分享功能，不算殘留
  const scan = html.split("\n").filter((l) => !/const HAS_API=/.test(l)).join("\n");
  const m = Object.entries(pats).map(([k, re]) => [k, (scan.match(re) || []).length]).filter(([, n]) => n);
  put("debug", m.length ? (m.some(([k]) => k === "debugger") ? "fail" : "warn") : "pass", m.length ? m.map(([k, n]) => `FACT: ${k} ${n} 處`) : ["FACT: 無 console 輸出、debugger、alert、TODO、本機位址"]);
}
// 4. 文件
{
  const rd = read("README.md");
  if (!rd) put("docs", "fail", ["FACT: 找不到 README.md"]);
  else {
    const secs = ["快速開始|Getting Started|Install|安裝", "使用|Usage", "設定|Configuration"].filter((p) => new RegExp(`^##\\s*(${p})`, "m").test(rd));
    put("docs", /^# /m.test(rd) && secs.length >= 2 ? "pass" : "warn", [`FACT: README 標題${/^# /m.test(rd) ? "存在" : "缺少"}，含 ${secs.length} 個必要段落（快速開始／使用／設定）`]);
  }
}
// 5. 相依與環境
{
  const m = [];
  let st = "pass";
  // 外部網址與本站 vendor/ 檔案都需在路徑或檔名中標明版本
  const urls = [...html.matchAll(/<script src="([^"]+)"/g), ...html.matchAll(/loadScript\("([^"]+)"\)/g)].map((x) => x[1]);
  for (const u of urls) { const pinned = /\/\d+\.\d+\.\d+\/|@\d+\.\d+\.\d+|\/r\d+\/|-\d+\.\d+\.\d+[.-]|-r\d+[.-]/.test(u); if (!pinned) { st = "fail"; } m.push(`FACT: ${pinned ? "已鎖版" : "未鎖版"} ${u}`); }
  const pkg = read("package.json");
  if (pkg) { const d = { ...(JSON.parse(pkg).devDependencies || {}), ...(JSON.parse(pkg).dependencies || {}) };
    const loose = Object.entries(d).filter(([, v]) => /[\^~*]|latest/.test(v)); if (loose.length) { st = "warn"; m.push(`FACT: package.json 未鎖版：${loose.map((x) => x.join("@")).join("、")}`); } else m.push("FACT: package.json 相依皆鎖定版本"); }
  if (/three\.js\/r128/.test(html)) m.push("INFERENCE: three.js r128 為較舊版本（2021），功能足夠且穩定；升級需重新驗證 3D 頁");

  // 檢查 wrangler.jsonc 的 ratelimits 是否符合 9.5 / L-14 規範 (C-2)
  const w = read("wrangler.jsonc");
  if (w) {
    try {
      const cfg = JSON.parse(w);
      const rl = cfg.ratelimits;
      if (!Array.isArray(rl) || rl.length !== 1) {
        st = "fail";
        m.push(`FACT: wrangler.jsonc 的 ratelimits 必須恰好一個 binding (目前: ${rl ? rl.length : 0})`);
      } else {
        const item = rl[0];
        if (item.name !== "LOGIN_LIMIT") {
          st = "fail";
          m.push(`FACT: ratelimits 名稱必須為 LOGIN_LIMIT (目前: ${item.name})`);
        }
        if (!item.namespace_id || !/^\d+$/.test(String(item.namespace_id))) {
          st = "fail";
          m.push(`FACT: ratelimits namespace_id 必須為正整數字串 (目前: ${item.namespace_id})`);
        }
        if (!item.simple || item.simple.limit !== 10 || item.simple.period !== 60) {
          st = "fail";
          m.push(`FACT: ratelimits simple 設定必須為 { limit: 10, period: 60 }`);
        } else {
          m.push("FACT: wrangler.jsonc LOGIN_LIMIT 設定正確 (10 reqs/60s)");
        }
      }
    } catch (e) {
      st = "fail";
      m.push(`FACT: wrangler.jsonc 解析失敗: ${e.message}`);
    }
  }
  put("deps", st, m);
}
// 6. 測試
{
  const files = fs.existsSync(path.join(ROOT, "tests")) ? fs.readdirSync(path.join(ROOT, "tests")).filter((f) => /\.test\.m?js$/.test(f)) : [];
  if (!files.length) put("tests", "fail", ["FACT: 沒有 tests/*.test.js"]);
  else {
    try {
      const r = execSync("node --test tests/*.test.js tests/*.test.mjs", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const pass = (r.match(/^(?:#|ℹ) pass (\d+)/m) || [])[1], skip = (r.match(/^(?:#|ℹ) skipped (\d+)/m) || [])[1];
      put("tests", +skip ? "warn" : "pass", [`FACT: ${files.length} 個測試檔，通過 ${pass} 項${+skip ? `，略過 ${skip} 項` : ""}`]);
    } catch (e) { const s = String(e.stdout || ""); put("tests", "fail", [`FACT: 測試失敗 ${(s.match(/^# fail (\d+)/m) || [])[1] || "?"} 項`, ...s.split("\n").filter((l) => /^not ok/.test(l)).slice(0, 5).map((l) => "FACT: " + l)]); }
  }
}
// 7. 機密與 API 金鑰
{
  const pats = [/sk-ant-[A-Za-z0-9_-]{10,}/, /\bsk-[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/, /(API_KEY|_TOKEN|_SECRET)\s*[:=]\s*["'][^"']{8,}/, /x-api-key/i, /api\.anthropic\.com/];
  // 掃描所有會部署的追蹤檔案（排除第三方函式庫、相依套件鎖定檔與二進位測試檔）
  let files = [];
  try { files = execSync("git ls-files --cached --others --exclude-standard", { cwd: ROOT, encoding: "utf8" }).split("\n").filter((f) => f && !/^(vendor|node_modules)\/|package-lock\.json$|^tools\/release-check\.js$|^tests\/fixtures\/|\.(xlsx|woff2|png|jpg|pdf)$/.test(f)); /* 本檔含比對樣式本身，略過 */ } catch { files = ["spi-spc.html"]; }
  const hits = [];
  for (const f of files) { let t = ""; try { t = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; } for (const re of pats) if (re.test(t)) hits.push(`${f}：${re}`); }
  // 密碼雜湊也不應寫進儲存庫
  for (const f of files) { let t = ""; try { t = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; } if (/^tests\//.test(f)) continue;
    if (/pbkdf2-sha256\$\d+\$[A-Za-z0-9+/=]{16,}\$[0-9a-f]{64}/i.test(t)) hits.push(`${f}：密碼雜湊（PBKDF2）`);
    if (/pepper-hmac-sha256\$\d+\$[0-9a-f]{64}/i.test(t)) hits.push(`${f}：密碼雜湊（PEPPER-HMAC）`);
    // 舊式 SHA-256 紀錄：設定名稱之後（可跨行）出現 64 位十六進位，或任何「"名稱": "64 位十六進位"」的對應（帳號不限 email、含陣列格式的 sha256 欄位）
    if (/["']?(AUTH_PASS_SHA256|AUTH_USERS)["']?\s*[=:][\s\S]{0,400}?\b[0-9a-f]{64}\b/i.test(t) || /["'][^"'\n]{1,120}["']\s*:\s*["'][0-9a-f]{64}["']/i.test(t)) hits.push(`${f}：密碼雜湊（SHA-256）`); }
  put("secrets", hits.length ? "fail" : "pass", hits.length ? hits.map((h) => `INFERENCE: 疑似機密 ${h}`) : [`FACT: 已掃描 ${files.length} 個追蹤與待加入的原始碼檔案，未發現硬編碼 API 金鑰或密碼雜湊；Netlify／Cloudflare AI Gateway 的金鑰由執行環境提供`]);
}
// 附加：表單控制項無障礙名稱
{
  const body = html.split("<script")[0];
  const ctr = [...body.matchAll(/<(input|select|textarea)\b([^>]*)>/g)];
  const labels = new Set([...body.matchAll(/<label for="([^"]+)"/g)].map((x) => x[1]));
  const bad = ctr.filter(([, , a]) => { const id = (a.match(/id="([^"]+)"/) || [])[1]; return !/aria-label/.test(a) && !/type="(radio|checkbox|file)"/.test(a) && !(id && labels.has(id)); }).map(([, , a]) => (a.match(/id="([^"]+)"/) || [])[1] || a.trim());
  put("a11y", bad.length ? "warn" : "pass", bad.length ? [`FACT: ${bad.length} 個控制項缺少標籤：${bad.join("、")}`] : [`FACT: ${ctr.length} 個靜態控制項皆有標籤或包在 label 內`]);
}

const overall = Object.values(out).some((x) => x.status === "fail") ? "BLOCKED" : Object.values(out).some((x) => x.status === "warn") ? "NEEDS REVIEW" : "READY";
if (process.argv.includes("--json")) console.log(JSON.stringify({ overall, checks: out }, null, 2));
else { console.log(`Overall: ${overall}`); for (const [k, v] of Object.entries(out)) console.log(`[${v.status.toUpperCase()}] ${k}\n  ${v.messages.join("\n  ")}`); }
process.exit(overall === "BLOCKED" ? 1 : 0);
