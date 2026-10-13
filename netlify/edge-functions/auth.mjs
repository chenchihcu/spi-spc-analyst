// 全站登入保護（帳號＋密碼）：所有頁面與 /api/analyze 都需先登入。
// 未登入：頁面請求顯示登入頁，API 請求回 401。
// /__login（GET 顯示表單、POST 驗證）、/__logout 由此處理。
import { APP_VERSION, APP_BUILT } from "../../lib/version.mjs";
import { getStore } from "@netlify/blobs";
import { COOKIE, SESSION_SECONDS, LOCK, configured, authenticate, issueToken, verifyToken, readCookie, safeNext, norm, lockedFor, recordFail, clearFails } from "../../lib/auth-core.mjs";

const env = () => ({
  AUTH_USERS: Netlify.env.get("AUTH_USERS"),
  AUTH_USER: Netlify.env.get("AUTH_USER"),
  AUTH_PASS_SHA256: Netlify.env.get("AUTH_PASS_SHA256"),
  AUTH_SECRET: Netlify.env.get("AUTH_SECRET"),
});

let lockStore;
function store() {
  if (lockStore === undefined) { try { lockStore = getStore({ name: "spi-auth-lock", consistency: "strong" }); } catch { lockStore = null; } }
  return lockStore;
}

export default async (req, context) => handle(req, env(), (r) => context.next(r), { store: store(), ip: context.ip });

// 安全標頭：登入頁與錯誤頁也套用（靜態檔案的標頭在 netlify.toml）
export const SEC = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
};

/** 與執行環境無關的處理邏輯（測試直接呼叫）；opts.store＝鎖定紀錄（可注入記憶體版本），opts.ip＝來源 IP */
export async function handle(req, E, next, opts = {}) {
  const url = new URL(req.url);
  const noStore = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...SEC };
  const now = opts.now ?? Date.now();

  if (!configured(E)) return new Response("網站登入尚未設定（缺少 AUTH_USERS 或 AUTH_USER／AUTH_PASS_SHA256，以及 AUTH_SECRET 環境變數），暫停對外服務。", { status: 503, headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } });

  if (url.pathname === "/__logout") return new Response(null, { status: 303, headers: { ...noStore, Location: "/__login", "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });

  if (url.pathname === "/__login") {
    if (req.method === "POST") {
      const fd = await req.formData().catch(() => null);
      const user = fd?.get("user"), pass = fd?.get("pass"), nextPath = safeNext(fd?.get("next"));
      const keys = ["u:" + norm(user), ...(opts.ip ? ["ip:" + opts.ip] : [])];
      const left = await lockedFor(opts.store, keys, now);
      if (left > 0) {
        console.log(`login locked user=${norm(user) || "-"}`);
        return loginPage(nextPath, `嘗試次數過多，已暫時鎖定。請 ${Math.ceil(left / 60000)} 分鐘後再試。`, String(user || ""), 429);
      }
      const who = fd ? await authenticate(E, user, pass) : null;
      if (who) {
        await clearFails(opts.store, ["u:" + who]);
        const token = await issueToken(E, who, Math.floor(now / 1000));
        console.log(`login ok user=${who}`);
        return new Response(null, { status: 303, headers: { ...noStore, Location: nextPath, "Set-Cookie": `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax` } });
      }
      await recordFail(opts.store, keys, now);
      console.log(`login failed user=${norm(user) || "-"}`);
      if (!opts.noDelay) await new Promise((r) => setTimeout(r, 900)); // 減緩暴力嘗試
      return loginPage(nextPath, `帳號或密碼不正確，請再試一次。連續失敗 ${LOCK.maxFails} 次會鎖定 ${LOCK.lockMs / 60000} 分鐘。`, String(user || ""), 401);
    }
    return loginPage(safeNext(url.searchParams.get("next")));
  }

  const who = await verifyToken(E, readCookie(req.headers.get("cookie")), Math.floor(now / 1000));
  if (who) {
    if (url.pathname === "/__me") return Response.json({ user: who }, { headers: noStore });
    // 後端函式可從 x-spi-user 得知是誰呼叫（一律覆寫，用戶端無法偽造）
    if (url.pathname.startsWith("/api/")) {
      const h = new Headers(req.headers);
      h.set("x-spi-user", who);
      return next(new Request(req, { headers: h }));
    }
    return next();
  }
  if (url.pathname === "/__me") return Response.json({ error: "請先登入" }, { status: 401, headers: noStore });

  if (url.pathname.startsWith("/api/")) return Response.json({ error: "請先登入" }, { status: 401, headers: noStore });
  return loginPage(url.pathname + url.search, "", "", 401);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 錫膏焊墊陣列：方形＝QFP／被動元件、圓形＝BGA；其中一顆標成異常（紅色），象徵系統抓出的問題
function padArt() {
  const rows = [];
  for (let r = 0; r < 6; r++) {
    const cells = [];
    for (let c = 0; c < 8; c++) {
      const round = r >= 2 && r <= 4 && c >= 2 && c <= 5;
      const bad = r === 3 && c === 4;
      cells.push(`<span class="pad${round ? " r" : ""}${bad ? " bad" : ""}"${bad ? ' aria-hidden="true"' : ""}></span>`);
    }
    rows.push(cells.join(""));
  }
  return rows.join("");
}

function loginPage(nextPath, error = "", user = "", status = 200) {
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>SPI·SPC 分析台 · 登入</title><meta name="robots" content="noindex">
<style>
@font-face{font-family:"Barlow Condensed";font-weight:600;font-display:swap;src:url(/vendor/fonts/barlow-condensed-latin-600-normal.woff2) format("woff2")}
@font-face{font-family:"IBM Plex Mono";font-weight:400;font-display:swap;src:url(/vendor/fonts/ibm-plex-mono-latin-400-normal.woff2) format("woff2")}
/* 與分析台同一套色票：防焊漆中性色＋銅色強調；左側品牌區固定深色 */
:root{--bg:#F2F4F0;--surface:#FFFFFF;--ink:#18201B;--muted:#58625B;--line:#D2D8D1;--accent:#A3521D;--on-accent:#FFFFFF;--ng:#B83A2C;--ng-soft:#F7DDD9;--warn:#A86E12;
  --brand-bg:#18201B;--brand-ink:#E4E9E4;--brand-muted:#98A39B;--brand-accent:#F2C6A5;--paste:#DB8A50;--paste-dim:#3A2516;--paste-bad:#EC6F60;
  --f-display:"Barlow Condensed","Microsoft JhengHei","PingFang TC",system-ui,sans-serif;--f-body:"Microsoft JhengHei","PingFang TC","Noto Sans TC",system-ui,sans-serif;--f-mono:"IBM Plex Mono",ui-monospace,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0F1311;--surface:#171C19;--ink:#E4E9E4;--muted:#98A39B;--line:#2D3731;--accent:#DB8A50;--on-accent:#14100C;--ng:#EC6F60;--ng-soft:#41201B;--warn:#E3AE50;--brand-bg:#0A0D0B;color-scheme:dark}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 var(--f-body);display:grid;place-items:center;padding:24px 16px}
.shell{width:min(860px,100%);display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.brand{background:var(--brand-bg);color:var(--brand-ink);padding:36px 32px;display:flex;flex-direction:column;justify-content:space-between;gap:28px}
.brand h1{margin:0;font:600 40px/1 var(--f-display);letter-spacing:.02em;color:var(--brand-accent)}
.brand .sub{margin:8px 0 0;color:var(--brand-muted);font-size:13px;letter-spacing:.06em}
.art{display:grid;grid-template-columns:repeat(8,1fr);gap:8px;max-width:300px}
.pad{aspect-ratio:1.6;border-radius:2px;background:var(--paste)}
.pad.r{aspect-ratio:1;border-radius:50%}
.pad:nth-child(7n+3){background:var(--paste-dim)}
.pad.bad{background:var(--paste-bad);box-shadow:0 0 0 3px rgba(236,111,96,.25);animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{50%{box-shadow:0 0 0 6px rgba(236,111,96,.12)}}
.legend{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--brand-muted)}
.legend i{width:10px;height:10px;border-radius:50%;background:var(--paste-bad);flex:none}
.ver{font:12px var(--f-mono);color:var(--brand-muted)}
form{padding:40px 36px;display:grid;gap:16px;align-content:center}
form h2{margin:0;font-size:22px;font-weight:700}
form .hint{margin:-8px 0 4px;color:var(--muted);font-size:13px}
label{display:grid;gap:6px;font-size:13px;color:var(--muted)}
.field{position:relative;display:flex}
input{width:100%;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;min-height:44px}
input[type=password],input.pw{padding-right:72px;font-family:var(--f-mono);letter-spacing:.08em}
input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.toggle{position:absolute;right:6px;top:50%;transform:translateY(-50%);font:inherit;font-size:12px;color:var(--muted);background:none;border:1px solid transparent;border-radius:6px;padding:4px 8px;cursor:pointer}
.toggle:hover{border-color:var(--line);color:var(--ink)}
.caps{font-size:12px;color:var(--warn);margin:-2px 0 0}
.err{display:flex;gap:8px;align-items:flex-start;background:var(--ng-soft);color:var(--ng);border-radius:8px;padding:10px 12px;font-size:13px}
.submit{font:inherit;font-weight:500;cursor:pointer;border:none;border-radius:8px;min-height:46px;background:var(--accent);color:var(--on-accent);margin-top:4px}
.submit[aria-busy=true]{opacity:.75;cursor:progress}
.foot{font-size:12px;color:var(--muted);margin:0}
@media (max-width:720px){.shell{grid-template-columns:1fr}.brand{padding:24px;gap:18px}.brand h1{font-size:32px}.art{max-width:220px;gap:6px}form{padding:28px 24px}}
@media (prefers-reduced-motion:reduce){.pad.bad{animation:none}}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
</style></head><body>
<main class="shell">
  <section class="brand" aria-label="SPI·SPC 分析台">
    <div><h1>SPI·SPC 分析台</h1><p class="sub">錫膏印刷檢測 · 統計製程問題偵測</p></div>
    <div><div class="art" aria-hidden="true">${padArt()}</div>
      <p class="legend" style="margin:14px 0 0"><i aria-hidden="true"></i>從數千顆焊墊的統計資料中，把異常抓出來</p></div>
    <p class="ver" style="margin:0">${esc(APP_VERSION)} · 更新 ${esc(APP_BUILT)}</p>
  </section>
  <form method="post" action="/__login" id="f" novalidate>
    <div><h2>登入</h2></div>
    <p class="hint">請使用授權帳號登入，登入後 12 小時內免重新輸入。</p>
    ${error ? `<div class="err" role="alert" id="err">${esc(error)}</div>` : ""}
    <label for="user">帳號<input id="user" name="user" type="email" inputmode="email" autocomplete="username" required placeholder="name@company.com" value="${esc(user)}"${error ? "" : " autofocus"}></label>
    <label for="pass">密碼
      <span class="field"><input id="pass" name="pass" type="password" class="pw" autocomplete="current-password" required${error ? " autofocus" : ""}>
      <button type="button" class="toggle" id="tg" aria-controls="pass" aria-pressed="false">顯示</button></span>
    </label>
    <p class="caps" id="caps" hidden>Caps Lock 已開啟</p>
    <input type="hidden" name="next" value="${esc(nextPath)}">
    <button type="submit" class="submit" id="go">登入</button>
    <p class="foot">只有授權人員可以使用。資料在您的瀏覽器中分析；只有在您建立分享連結時，該回合資料才會上傳到本網站。</p>
  </form>
</main>
<script>
(function(){var f=document.getElementById("f"),u=document.getElementById("user"),p=document.getElementById("pass"),t=document.getElementById("tg"),c=document.getElementById("caps"),g=document.getElementById("go");
t.addEventListener("click",function(){var show=p.type==="password";p.type=show?"text":"password";t.textContent=show?"隱藏":"顯示";t.setAttribute("aria-pressed",show);p.focus()});
function caps(e){if(e.getModifierState)c.hidden=!e.getModifierState("CapsLock")}
p.addEventListener("keydown",caps);p.addEventListener("keyup",caps);p.addEventListener("blur",function(){c.hidden=true});
f.addEventListener("submit",function(e){if(!u.value.trim()){e.preventDefault();u.focus();return}if(!p.value){e.preventDefault();p.focus();return}
  if(g.getAttribute("aria-busy")==="true"){e.preventDefault();return}g.setAttribute("aria-busy","true");g.textContent="登入中…"});
if(document.getElementById("err"))p.select();})();
</script>
</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...SEC } });
}

// 公開的第三方函式庫與字型（vendor/）不含任何資料，不經登入檢查，減少邊緣函式呼叫
export const config = { path: "/*", excludedPath: ["/vendor/*"] };
