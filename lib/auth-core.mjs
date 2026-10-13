// 網站登入核心（帳號＋密碼）：驗證帳密、簽發與檢查登入憑證 cookie。
// 純 Web Crypto 實作，可在 Netlify Edge（Deno）與 Node 測試中執行。
//
// 帳密不寫在程式碼（儲存庫是公開的）：由 Netlify 環境變數提供
//   AUTH_USERS         多個帳號（JSON）：{"a@x.com":"<SHA-256>","b@x.com":"<SHA-256>"}
//                      或 [{"user":"a@x.com","sha256":"<SHA-256>"}]；用 tools/hash-password.mjs 產生
//   AUTH_USER          （相容舊設定）單一帳號
//   AUTH_PASS_SHA256   （相容舊設定）單一帳號密碼的 SHA-256（十六進位），不存明文
//   AUTH_SECRET        簽章 cookie 用的隨機字串（至少 32 字元）
// 兩種帳號設定可同時存在；沒有任何有效帳號或密鑰太短時一律拒絕（fail closed）。

export const COOKIE = "spi_auth";
export const SESSION_SECONDS = 12 * 60 * 60;

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const HEX64 = /^[0-9a-f]{64}$/i;

export async function sha256Hex(text) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

// 長度相同時逐字比較，不因第一個不同字元提早結束
export function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const norm = (u) => String(u || "").trim().toLowerCase();

/** 所有有效帳號：Map<帳號(小寫), 密碼 SHA-256(小寫)>；格式錯誤的項目略過 */
export function users(env) {
  const m = new Map();
  const add = (u, h) => { if (norm(u) && HEX64.test(String(h || ""))) m.set(norm(u), String(h).toLowerCase()); };
  if (env.AUTH_USERS) {
    try {
      const v = JSON.parse(env.AUTH_USERS);
      if (Array.isArray(v)) v.forEach((x) => x && add(x.user, x.sha256));
      else if (v && typeof v === "object") Object.entries(v).forEach(([u, h]) => add(u, h));
    } catch { /* 格式錯誤：視為沒有設定 */ }
  }
  add(env.AUTH_USER, env.AUTH_PASS_SHA256);
  return m;
}

export function configured(env) {
  return users(env).size > 0 && (env.AUTH_SECRET || "").length >= 32;
}

/** 驗證帳密；正確時回傳帳號（小寫），否則 null。帳號不存在時仍計算雜湊，回應時間不洩漏帳號是否存在 */
export async function authenticate(env, user, pass) {
  if (!configured(env)) return null;
  const u = norm(user), want = users(env).get(u);
  const got = await sha256Hex(String(pass || ""));
  const ok = safeEqual(got, want || "0".repeat(64)) && Boolean(want) && Boolean(pass);
  return ok ? u : null;
}

/** 相容舊介面：回傳 true／false */
export async function checkCredentials(env, user, pass) {
  return Boolean(await authenticate(env, user, pass));
}

const b64u = (s) => btoa(String.fromCharCode(...enc.encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

// 簽章綁定：帳號、到期時間、該帳號密碼雜湊的前 16 碼（改密碼或刪帳號，舊的登入即失效）
const signMsg = (u, exp, h) => `${u}|${exp}|${h.slice(0, 16)}`;

/** 簽發登入憑證：<到期時間>.<帳號 base64url>.<簽章> */
export async function issueToken(env, user, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof user === "number") { nowSec = user; user = undefined; } // 相容舊呼叫 issueToken(env, now)
  const u = norm(user ?? [...users(env).keys()][0]), h = users(env).get(u);
  if (!h) throw new Error("帳號不存在");
  const exp = nowSec + SESSION_SECONDS;
  return `${exp}.${b64u(u)}.${await hmacHex(env.AUTH_SECRET, signMsg(u, exp, h))}`;
}

/** 驗證登入憑證；有效時回傳帳號（小寫），否則 null */
export async function verifyToken(env, token, nowSec = Math.floor(Date.now() / 1000)) {
  if (!configured(env) || typeof token !== "string") return null;
  const m = token.match(/^(\d{10})\.([A-Za-z0-9_-]{1,200})\.([0-9a-f]{64})$/);
  if (!m || +m[1] < nowSec) return null;
  let u;
  try { u = norm(unb64u(m[2])); } catch { return null; }
  const h = users(env).get(u);
  if (!h) return null;
  return safeEqual(m[3], await hmacHex(env.AUTH_SECRET, signMsg(u, m[1], h))) ? u : null;
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

/** 只允許站內相對路徑作為登入後的返回位置，避免被導向其他網站 */
export function safeNext(next) {
  return typeof next === "string" && /^\/(?!\/)[^\s\\]*$/.test(next) && !next.startsWith("/__") ? next : "/";
}

// ---------- 登入失敗鎖定：同一帳號或同一來源 IP，15 分鐘內失敗 5 次，鎖定 15 分鐘 ----------
export const LOCK = { maxFails: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 };

const lockKey = async (k) => "l-" + (await sha256Hex(k)).slice(0, 32);

/** 回傳仍在鎖定中的剩餘毫秒（0＝未鎖定）。store 失效時不阻擋登入（仍有密碼與延遲保護） */
export async function lockedFor(store, keys, now = Date.now()) {
  if (!store) return 0;
  let left = 0;
  for (const k of keys) {
    try {
      const v = await store.get(await lockKey(k), { type: "json" });
      if (v && v.until > now) left = Math.max(left, v.until - now);
    } catch { /* 忽略 */ }
  }
  return left;
}

export async function recordFail(store, keys, now = Date.now()) {
  if (!store) return;
  for (const k of keys) {
    try {
      const key = await lockKey(k), v = (await store.get(key, { type: "json" })) || {};
      const fails = (v.fails || []).filter((t) => now - t < LOCK.windowMs).concat(now);
      await store.setJSON(key, fails.length >= LOCK.maxFails ? { fails: [], until: now + LOCK.lockMs } : { fails, until: v.until || 0 });
    } catch { /* 忽略 */ }
  }
}

export async function clearFails(store, keys) {
  if (!store) return;
  for (const k of keys) { try { await store.delete(await lockKey(k)); } catch { /* 忽略 */ } }
}
