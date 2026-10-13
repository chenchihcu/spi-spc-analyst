// 網站登入核心（帳號＋密碼）：驗證帳密、簽發與檢查登入憑證 cookie。
// 純 Web Crypto 實作，可在 Netlify Edge（Deno）與 Node 測試中執行。
//
// 帳密不寫在程式碼（儲存庫是公開的）：由 Netlify 環境變數提供
//   AUTH_USER          允許登入的帳號（email，不分大小寫）
//   AUTH_PASS_SHA256   密碼的 SHA-256（十六進位），不存明文
//   AUTH_SECRET        簽章 cookie 用的隨機字串
// 任一變數缺少時一律拒絕（fail closed），不會因設定遺漏而讓網站變公開。

export const COOKIE = "spi_auth";
export const SESSION_SECONDS = 12 * 60 * 60;

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

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

export function configured(env) {
  return Boolean(env.AUTH_USER && /^[0-9a-f]{64}$/i.test(env.AUTH_PASS_SHA256 || "") && (env.AUTH_SECRET || "").length >= 32);
}

const norm = (u) => String(u || "").trim().toLowerCase();

/** 檢查帳號與密碼；兩者都對才回傳 true */
export async function checkCredentials(env, user, pass) {
  if (!configured(env)) return false;
  const okUser = safeEqual(norm(user), norm(env.AUTH_USER));
  const okPass = safeEqual(await sha256Hex(String(pass || "")), env.AUTH_PASS_SHA256.toLowerCase());
  return okUser && okPass;
}

/** 簽發登入憑證：<到期時間>.<簽章>；簽章綁定帳號與到期時間 */
export async function issueToken(env, nowSec = Math.floor(Date.now() / 1000)) {
  const exp = nowSec + SESSION_SECONDS;
  return `${exp}.${await hmacHex(env.AUTH_SECRET, `${norm(env.AUTH_USER)}|${exp}`)}`;
}

/** 驗證登入憑證：格式、簽章、未過期 */
export async function verifyToken(env, token, nowSec = Math.floor(Date.now() / 1000)) {
  if (!configured(env) || typeof token !== "string") return false;
  const m = token.match(/^(\d{10})\.([0-9a-f]{64})$/);
  if (!m || +m[1] < nowSec) return false;
  return safeEqual(m[2], await hmacHex(env.AUTH_SECRET, `${norm(env.AUTH_USER)}|${m[1]}`));
}

export function readCookie(header, name = COOKIE) {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** 只允許站內相對路徑作為登入後的返回位置，避免被導向其他網站 */
export function safeNext(next) {
  return typeof next === "string" && /^\/(?!\/)[^\s\\]*$/.test(next) && !next.startsWith("/__") ? next : "/";
}
