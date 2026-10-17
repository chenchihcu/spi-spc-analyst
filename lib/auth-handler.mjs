// lib/auth-handler.mjs: 整合 Cloudflare Workers 免費方案配額的登入與身分驗證處理模組
// 實作規範：D-35, D-36, D-59, D-60 ③, R8-8, R8-9
import { APP_VERSION, APP_BUILT } from "./version.mjs";
import { SEC } from "./security-headers.mjs";
import { Repo } from "./repo.mjs";

export const COOKIE = "spi_auth";
export const SESSION_SECONDS = 12 * 60 * 60;

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export function safeEqual(a, b) {
  a = String(a || "");
  b = String(b || "");
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export const norm = (u) => String(u || "").trim().toLowerCase();

export function safeNext(next) {
  return typeof next === "string" && /^\/(?!\/)[^\s\\]*$/.test(next) && !next.startsWith("/__") ? next : "/";
}

/** 簽章用密碼標記：取 pepper-hmac-sha256$<iter>$<hex> 雜湊的前 16 碼 */
function credTag(cred) {
  const parts = String(cred || "").split("$");
  const h = parts[2] || parts[0];
  return h.slice(0, 16).toLowerCase();
}

/** 解析 AUTH_USERS JSON：回傳 Map<帳號, pepper-hmac-sha256$<iter>$<hex>> */
export function users(env) {
  const m = new Map();
  if (!env || !env.AUTH_USERS) return m;
  try {
    const v = JSON.parse(env.AUTH_USERS);
    const targetIter = String(env.AUTH_KDF_ITER || 600000);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [u, h] of Object.entries(v)) {
        const strH = String(h || "").trim();
        const parts = strH.split("$");
        if (parts[0] === "pepper-hmac-sha256" && parts[1] === targetIter && /^[0-9a-f]{64}$/i.test(parts[2])) {
          m.set(norm(u), strH);
        }
      }
    }
  } catch {}
  return m;
}

export function configured(env) {
  if (!env || !env.AUTH_SECRET || env.AUTH_SECRET.length < 32) return false;
  if (!env.AUTH_PEPPER || env.AUTH_PEPPER.length < 32) return false;
  return users(env).size > 0;
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return hex(sig);
}

const b64u = (s) => btoa(String.fromCharCode(...enc.encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
const signMsg = (u, exp, h) => `${u}|${exp}|${credTag(h)}`;

export async function issueToken(env, user, nowSec = Math.floor(Date.now() / 1000)) {
  const u = norm(user);
  const h = users(env).get(u);
  if (!h) throw new Error("帳號不存在");
  const exp = nowSec + SESSION_SECONDS;
  const sig = await hmacHex(env.AUTH_SECRET, signMsg(u, exp, h));
  return `${exp}.${b64u(u)}.${sig}`;
}

export async function verifyToken(env, token, nowSec = Math.floor(Date.now() / 1000)) {
  if (!configured(env) || typeof token !== "string") return null;
  const m = token.match(/^(\d{10})\.([A-Za-z0-9_-]{1,200})\.([0-9a-f]{64})$/);
  if (!m || +m[1] < nowSec) return null;
  let u;
  try { u = norm(unb64u(m[2])); } catch { return null; }
  const h = users(env).get(u);
  if (!h) return null;
  const expected = await hmacHex(env.AUTH_SECRET, signMsg(u, m[1], h));
  return safeEqual(m[3], expected) ? u : null;
}

export function readCookie(header, name = COOKIE) {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

/** 依 15 分鐘 5 次失敗規則計算鎖定時刻 (毫秒) */
export function lockUntil(times) {
  const t = [...times].sort((a, b) => a - b);
  let until = 0;
  const windowMs = 15 * 60_000, lockMs = 15 * 60_000, maxFails = 5;
  for (let i = maxFails - 1; i < t.length; i++) {
    if (t[i] - t[i - maxFails + 1] < windowMs) {
      until = Math.max(until, t[i] + lockMs);
    }
  }
  return until;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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

export function loginPage(nextPath, iter = 600000, limiterMissing = false) {
  const limiterBanner = limiterMissing
    ? `<div class="err" role="alert" style="margin-bottom:12px;background:var(--ng-soft);color:var(--ng);padding:10px 12px;border-radius:8px;">登入暫停：伺服器缺少登入限流設定，請通知管理員</div>`
    : "";
  const submitAttr = limiterMissing ? " disabled" : "";
  const html = `<!doctype html><html lang="zh-Hant" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#F2F4F0" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0F1311" media="(prefers-color-scheme: dark)">
<title>SPI·SPC 分析台 · 登入</title><meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%23A3521D'/%3E%3Ctext x='8' y='12' font-size='10' font-weight='bold' fill='%23FFF' text-anchor='middle'%3ES%3C/text%3E%3C/svg%3E">
<style>
@font-face{font-family:"Barlow Condensed";font-weight:600;font-display:swap;src:url(/vendor/fonts/barlow-condensed-latin-600-normal.woff2) format("woff2")}
@font-face{font-family:"IBM Plex Mono";font-weight:400;font-display:swap;src:url(/vendor/fonts/ibm-plex-mono-latin-400-normal.woff2) format("woff2")}
:root{--bg:#F2F4F0;--surface:#FFFFFF;--ink:#18201B;--muted:#58625B;--line:#D2D8D1;--accent:#A3521D;--on-accent:#FFFFFF;--ng:#B83A2C;--ng-soft:#F7DDD9;--warn:#A86E12;
  --brand-bg:#E8ECE6;--brand-ink:#18201B;--brand-muted:#4A544D;--brand-accent:#6E3410;--paste:#C86D32;--paste-dim:#D2D8D1;--paste-bad:#B83A2C;
  --f-display:"Barlow Condensed","Microsoft JhengHei","PingFang TC",system-ui,sans-serif;--f-body:"Microsoft JhengHei","PingFang TC","Noto Sans TC",system-ui,sans-serif;--f-mono:"IBM Plex Mono",ui-monospace,monospace;color-scheme:light}
:root[data-theme="dark"]{--bg:#0F1311;--surface:#171C19;--ink:#E4E9E4;--muted:#98A39B;--line:#2D3731;--accent:#DB8A50;--on-accent:#14100C;--ng:#EC6F60;--ng-soft:#41201B;--warn:#E3AE50;--brand-bg:#0A0D0B;--brand-ink:#E4E9E4;--brand-muted:#98A39B;--brand-accent:#F2C6A5;--paste:#DB8A50;--paste-dim:#3A2516;--paste-bad:#EC6F60;color-scheme:dark}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 var(--f-body);display:grid;place-items:center;padding:24px 16px}
.shell{width:min(860px,100%);display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.brand{background:var(--brand-bg);color:var(--brand-ink);border-right:1px solid var(--line);padding:36px 32px;display:flex;flex-direction:column;justify-content:space-between;gap:28px}
.brand h1{margin:0;font:600 40px/1 var(--f-display);letter-spacing:.02em;color:var(--brand-accent)}
.brand .sub{margin:8px 0 0;color:var(--brand-muted);font-size:13px;letter-spacing:.06em}
.art{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:8px;max-width:300px}
.pad{aspect-ratio:1.6;min-width:0;border-radius:2px;background:var(--paste)}
.pad.r{aspect-ratio:1;border-radius:50%}
.pad:nth-child(7n+3){background:var(--paste-dim)}
.pad.bad{background:var(--paste-bad);box-shadow:0 0 0 3px rgba(184,58,44,.25);animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{50%{box-shadow:0 0 0 6px rgba(184,58,44,.12)}}
.legend{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--brand-muted)}
.legend i{width:10px;height:10px;border-radius:50%;background:var(--paste-bad);flex:none}
.ver{font:12px var(--f-mono);color:var(--brand-muted)}
form{padding:40px 36px;display:grid;gap:16px;align-content:center}
form h2{margin:0;font-size:22px;font-weight:700}
form .hint{margin:-8px 0 4px;color:var(--muted);font-size:13px}
label{display:grid;gap:6px;font-size:15px;color:var(--muted)}
.field{position:relative;display:flex}
input{width:100%;font:inherit;font-size:17px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;min-height:44px}
input[type=password],input.pw{padding-right:72px;font-family:var(--f-mono);letter-spacing:.08em}
input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.toggle{position:absolute;right:6px;top:50%;transform:translateY(-50%);font:inherit;font-size:13px;color:var(--muted);background:none;border:1px solid transparent;border-radius:6px;padding:6px 10px;min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.toggle:hover{border-color:var(--line);color:var(--ink)}
.caps{font-size:12px;color:var(--warn);margin:-2px 0 0}
.err{display:flex;gap:8px;align-items:flex-start;background:var(--ng-soft);color:var(--ng);border-radius:8px;padding:10px 12px;font-size:13px}
.submit{font:inherit;font-weight:500;cursor:pointer;border:none;border-radius:8px;min-height:46px;background:var(--accent);color:var(--on-accent);margin-top:4px}
.submit[disabled]{opacity:.75;cursor:not-allowed}
.foot{font-size:12px;color:var(--muted);margin:0}
@media (max-width:720px){body{place-items:start center;padding:12px 12px}.shell{grid-template-columns:1fr}.brand{border-right:none;border-bottom:1px solid var(--line);padding:12px 20px;gap:6px;max-height:160px;overflow:hidden}.brand h1{font-size:22px}.brand .sub{display:none}.art{max-width:116px;gap:3px}.legend{display:none}.ver{font-size:12px}form{padding:18px 20px;gap:12px}}
@media (prefers-reduced-motion:reduce){.pad.bad{animation:none}}
</style></head><body>
<main class="shell">
  <section class="brand" aria-label="SPI·SPC 分析台">
    <div><h1>SPI·SPC 分析台</h1><p class="sub">錫膏印刷檢測 · 統計製程問題偵測</p></div>
    <div><div class="art" aria-hidden="true">${padArt()}</div>
      <p class="legend" style="margin:14px 0 0"><i aria-hidden="true"></i>從數千顆焊墊的統計資料中，把異常抓出來</p></div>
    <p class="ver" style="margin:0">${esc(APP_VERSION)} · 更新 ${esc(APP_BUILT)}</p>
  </section>
  <form id="loginForm" data-iter="${iter}" data-next="${esc(nextPath)}" novalidate>
    <div><h2>登入</h2></div>
    <p class="hint">請使用授權帳號登入，登入後 12 小時內免重新輸入。</p>
    ${limiterBanner}
    <div class="err" role="alert" id="loginMsg" style="display:none"></div>
    <label for="user">帳號<input id="user" name="user" type="email" inputmode="email" autocomplete="username" required placeholder="name@company.com"></label>
    <label for="pass">密碼
      <span class="field"><input id="pass" name="pass" type="password" class="pw" autocomplete="current-password" required>
      <button type="button" class="toggle" id="tg" aria-controls="pass" aria-pressed="false">顯示</button></span>
    </label>
    <p class="caps" id="caps" hidden>Caps Lock 已開啟</p>
    <button type="submit" class="submit" id="go"${submitAttr}>登入</button>
    <p class="foot">只有授權人員可以使用。分析在您的瀏覽器中進行；匯入量測紀錄或座標檔時，原始檔會存入本網站的資料庫（供登入同事回溯），建立分享連結時該回合資料也會上傳到本網站。</p>
  </form>
</main>
<script src="/vendor/login-auth.js"></script>
<script>
(function(){
  var p=document.getElementById("pass"),t=document.getElementById("tg"),c=document.getElementById("caps");
  if(t)t.addEventListener("click",function(){var s=p.type==="password";p.type=s?"text":"password";t.textContent=s?"隱藏":"顯示";t.setAttribute("aria-pressed",s);p.focus()});
  function caps(e){if(e.getModifierState)c.hidden=!e.getModifierState("CapsLock")}
  if(p){p.addEventListener("keydown",caps);p.addEventListener("keyup",caps);p.addEventListener("blur",function(){c.hidden=true})};
  var msg=document.getElementById("loginMsg");
  var obs=new MutationObserver(function(){msg.style.display=msg.textContent.trim()?"flex":"none"});
  obs.observe(msg,{childList:true,characterData:true,subtree:true});
})();
</script>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...SEC },
  });
}

/** 核心處理控制器 */
export async function handle(req, env, next, opts = {}) {
  const url = new URL(req.url);
  const noStore = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...SEC };
  const now = opts.now ?? Date.now();
  const repo = opts.repo || (env.DB && env.BLOBS ? new Repo(env.DB, env.BLOBS) : null);

  if (!configured(env)) {
    return new Response("網站登入尚未設定（缺少 AUTH_USERS、AUTH_PEPPER 或 AUTH_SECRET 環境變數），暫停對外服務。", {
      status: 503,
      headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (url.pathname === "/__logout") {
    return new Response(null, {
      status: 303,
      headers: { ...noStore, Location: "/__login", "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` },
    });
  }

  // 檢查是否已登入
  const who = await verifyToken(env, readCookie(req.headers.get("cookie")), Math.floor(now / 1000));

  if (url.pathname === "/__login") {
    // 依 D-35: 已登入時 GET /__login 一律 303 導向 next
    if (req.method === "GET") {
      const nextPath = safeNext(url.searchParams.get("next"));
      if (who) {
        return new Response(null, { status: 303, headers: { ...noStore, Location: nextPath } });
      }
      const limiterMissing = !env.LOGIN_LIMIT || typeof env.LOGIN_LIMIT.limit !== "function";
      return loginPage(nextPath, +(env.AUTH_KDF_ITER || 600000), limiterMissing);
    }

    if (req.method === "POST") {
      // 依 D-60 ③: 收到含明文 pass 欄位一律回 400
      let body;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "無效的 JSON 請求" }, { status: 400, headers: noStore });
      }

      if (body && body.pass !== undefined) {
        return Response.json({ error: "不接受明文密碼，請使用標準登入頁" }, { status: 400, headers: noStore });
      }

      const user = norm(body?.user);
      const d = String(body?.d || "");
      const nextPath = safeNext(body?.next);

      if (!user || !d) {
        return Response.json({ error: "帳號與驗證資訊不可為空" }, { status: 400, headers: noStore });
      }

      // 9.5 第 0 步: 輸入檢查與限流 (不碰 D1，僅以 IP 鍵呼叫一次)
      if (!env.LOGIN_LIMIT || typeof env.LOGIN_LIMIT.limit !== "function") {
        return Response.json({ error: "login_limiter_missing" }, { status: 503, headers: noStore });
      }
      const clientIp = opts.ip || "";
      const ipKey = clientIp ? "ip:" + clientIp : "ip:unknown";
      try {
        const ipRes = await env.LOGIN_LIMIT.limit({ key: ipKey });
        if (!ipRes.success) {
          return Response.json(
            { error: "rate_limited", message: "系統忙碌，請 1 分鐘後再試" },
            { status: 429, headers: { ...noStore, "Retry-After": "60" } }
          );
        }
      } catch (err) {
        return Response.json({ error: "login_limiter_error" }, { status: 503, headers: noStore });
      }

      // HMAC 雜湊鍵值
      const uHash = await hmacHex(env.AUTH_SECRET, "u:" + user);
      const ipHash = await hmacHex(env.AUTH_SECRET, opts.ip ? "ip:" + opts.ip : "ip:none");

      const isLocked = (rows) => {
        if (rows.length < 5) return false;
        const times = rows.map((r) => r.at);
        const maxAt = Math.max(...times);
        const minAt = Math.min(...times);
        return maxAt - minAt < 900000 && maxAt > now - 900000;
      };

      // 9.5 第 1 步: 讀取 (1 句，讀 <= 10 列)
      let uRows = [];
      let ipRows = [];
      try {
        if (repo) {
          const attempts = await repo.getAuthAttempts(uHash, ipHash, now);
          uRows = attempts.filter((r) => r.k === "u");
          ipRows = attempts.filter((r) => r.k === "ip");
          const uLocked = isLocked(uRows);
          const ipLocked = isLocked(ipRows);

          if (uLocked || ipLocked) {
            const uUnlock = uLocked ? Math.max(...uRows.map((r) => r.at)) + 900000 : 0;
            const ipUnlock = ipLocked ? Math.max(...ipRows.map((r) => r.at)) + 900000 : 0;
            const unlockAt = Math.max(uUnlock, ipUnlock);
            const unlockTime = new Date(unlockAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
            return Response.json(
              {
                error: "locked",
                unlockAt,
                message: `嘗試次數過多，已暫時鎖定。請於 ${unlockTime} (UTC+8) 後再試。`,
              },
              { status: 429, headers: noStore }
            );
          }
        }
      } catch (err) {
        return Response.json({ error: "login_db_unavailable" }, { status: 503, headers: noStore });
      }

      // 9.5 第 2 步: 原子條件式 INSERT (1 句)
      try {
        if (repo) {
          const insertedId = await repo.insertAuthAttemptAtomic(uHash, ipHash, now);
          if (!insertedId) {
            // 競態被其他請求鎖上，重跑第 1 步取最新鎖定時刻
            const attempts = await repo.getAuthAttempts(uHash, ipHash, now);
            uRows = attempts.filter((r) => r.k === "u");
            ipRows = attempts.filter((r) => r.k === "ip");
            const uUnlock = isLocked(uRows) ? Math.max(...uRows.map((r) => r.at)) + 900000 : now + 900000;
            const ipUnlock = isLocked(ipRows) ? Math.max(...ipRows.map((r) => r.at)) + 900000 : now + 900000;
            const unlockAt = Math.max(uUnlock, ipUnlock);
            const unlockTime = new Date(unlockAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
            return Response.json(
              {
                error: "locked",
                unlockAt,
                message: `嘗試次數過多，已暫時鎖定。請於 ${unlockTime} (UTC+8) 後再試。`,
              },
              { status: 429, headers: noStore }
            );
          }
        }
      } catch (err) {
        return Response.json({ error: "login_db_unavailable" }, { status: 503, headers: noStore });
      }

      // 9.5 第 3 步: 驗證密碼 HMAC (常數時間)
      const actualCred = users(env).get(user);
      const iter = String(env.AUTH_KDF_ITER || 600000);
      const computedHmac = await hmacHex(env.AUTH_PEPPER, d);
      const expectedCred = actualCred || `pepper-hmac-sha256$${iter}$${"0".repeat(64)}`;
      const expectedHmac = (expectedCred.split("$")[2] || "").toLowerCase();
      const match = safeEqual(computedHmac, expectedHmac);
      const ok = match && Boolean(actualCred);

      // 9.5 第 4 步: 成功刪除帳號鍵，失敗計算剩餘次數
      if (ok) {
        try {
          if (repo) {
            await repo.clearAuthAttemptsForUser(uHash);
          }
        } catch (err) {
          return Response.json({ error: "login_db_unavailable" }, { status: 503, headers: noStore });
        }
        const token = await issueToken(env, user, Math.floor(now / 1000));
        return Response.json(
          { ok: true, user, next: nextPath },
          {
            status: 200,
            headers: {
              ...noStore,
              "Set-Cookie": `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
            },
          }
        );
      }

      // 失敗: 由第 1 步讀到的資料 + 1 算出 remaining
      const uCount = uRows.length + 1;
      const ipCount = ipRows.length + 1;
      const maxCount = Math.max(uCount, ipCount);
      const remaining = Math.max(0, 5 - maxCount);
      const unlockAt = remaining === 0 ? now + 900000 : undefined;
      const leftMsg = ` 此帳號或此網路位置在 15 分鐘內再失敗 ${remaining} 次，將暫停登入 15 分鐘。`;
      const failMsg = `帳號或密碼不正確。${leftMsg}`;

      return Response.json(
        {
          error: "bad_credentials",
          remaining,
          unlockAt,
          message: failMsg,
        },
        { status: 401, headers: noStore }
      );
    }

    return Response.json({ error: "不支援的請求方法" }, { status: 405, headers: noStore });
  }

  // 驗證一般請求
  if (who) {
    if (url.pathname === "/__me") {
      return Response.json({ user: who }, { headers: noStore });
    }
    if (url.pathname.startsWith("/api/")) {
      const h = new Headers(req.headers);
      h.set("x-spi-user", who);
      return next(new Request(req, { headers: h }));
    }
    return next();
  }

  // 未登入請求
  if (url.pathname === "/__me" || url.pathname.startsWith("/api/")) {
    return Response.json({ error: "請先登入" }, { status: 401, headers: noStore });
  }

  // 未登入頁面請求依 D-35: 303 導向 /__login?next=...
  const redirectNext = url.pathname + url.search;
  return new Response(null, {
    status: 303,
    headers: { ...noStore, Location: `/__login?next=${encodeURIComponent(redirectNext)}` },
  });
}
