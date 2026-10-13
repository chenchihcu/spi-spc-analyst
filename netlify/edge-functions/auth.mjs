// 全站登入保護（帳號＋密碼）：所有頁面與 /api/analyze 都需先登入。
// 未登入：頁面請求顯示登入頁，API 請求回 401。
// /__login（GET 顯示表單、POST 驗證）、/__logout 由此處理。
import { COOKIE, SESSION_SECONDS, configured, checkCredentials, issueToken, verifyToken, readCookie, safeNext } from "../../lib/auth-core.mjs";

const env = () => ({
  AUTH_USER: Netlify.env.get("AUTH_USER"),
  AUTH_PASS_SHA256: Netlify.env.get("AUTH_PASS_SHA256"),
  AUTH_SECRET: Netlify.env.get("AUTH_SECRET"),
});

export default async (req, context) => handle(req, env(), () => context.next());

/** 與執行環境無關的處理邏輯（測試直接呼叫） */
export async function handle(req, E, next) {
  const url = new URL(req.url);
  const noStore = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

  if (!configured(E)) return new Response("網站登入尚未設定（缺少 AUTH_USER／AUTH_PASS_SHA256／AUTH_SECRET 環境變數），暫停對外服務。", { status: 503, headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } });

  if (url.pathname === "/__logout") return new Response(null, { status: 303, headers: { ...noStore, Location: "/__login", "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });

  if (url.pathname === "/__login") {
    if (req.method === "POST") {
      const fd = await req.formData().catch(() => null);
      const user = fd?.get("user"), pass = fd?.get("pass"), nextPath = safeNext(fd?.get("next"));
      if (fd && (await checkCredentials(E, user, pass))) {
        const token = await issueToken(E);
        return new Response(null, { status: 303, headers: { ...noStore, Location: nextPath, "Set-Cookie": `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax` } });
      }
      await new Promise((r) => setTimeout(r, 900)); // 減緩暴力嘗試
      return loginPage(nextPath, "帳號或密碼錯誤", String(user || ""), 401);
    }
    return loginPage(safeNext(url.searchParams.get("next")));
  }

  if (await verifyToken(E, readCookie(req.headers.get("cookie")))) {
    return next();
  }

  if (url.pathname.startsWith("/api/")) return Response.json({ error: "請先登入" }, { status: 401, headers: noStore });
  return loginPage(url.pathname + url.search, "", "", 401);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function loginPage(nextPath, error = "", user = "", status = 200) {
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>SPI·SPC 分析台 · 登入</title><meta name="robots" content="noindex">
<style>
:root{--bg:#F2F4F0;--surface:#FFF;--ink:#18201B;--muted:#58625B;--line:#D2D8D1;--accent:#A3521D;--on:#FFF;--ng:#B83A2C;--ng-soft:#F7DDD9;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0F1311;--surface:#171C19;--ink:#E4E9E4;--muted:#98A39B;--line:#2D3731;--accent:#DB8A50;--on:#14100C;--ng:#EC6F60;--ng-soft:#41201B;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.6 "Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif;padding:24px 16px}
form{width:min(380px,100%);background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:28px 24px;display:grid;gap:14px}
h1{margin:0;font-size:22px}p{margin:0;color:var(--muted);font-size:13px}label{display:grid;gap:4px;font-size:13px;color:var(--muted)}
input{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:9px 11px;min-height:40px}
input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button{font:inherit;font-weight:500;cursor:pointer;border:none;border-radius:8px;min-height:42px;background:var(--accent);color:var(--on)}
.err{background:var(--ng-soft);color:var(--ng);border-radius:8px;padding:8px 10px;font-size:13px}
</style></head><body>
<form method="post" action="/__login">
<h1>SPI·SPC 分析台</h1><p>請登入後使用。</p>
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
<label for="user">帳號<input id="user" name="user" type="email" autocomplete="username" required value="${esc(user)}"></label>
<label for="pass">密碼<input id="pass" name="pass" type="password" autocomplete="current-password" required></label>
<input type="hidden" name="next" value="${esc(nextPath)}">
<button type="submit">登入</button>
</form></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "X-Frame-Options": "DENY" } });
}

export const config = { path: "/*" };
