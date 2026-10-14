// 網站登入核心（帳號＋密碼）：驗證帳密、簽發與檢查登入憑證 cookie。
// 純 Web Crypto 實作，可在 Netlify Edge（Deno）與 Node 測試中執行。
//
// 帳密不寫在程式碼（儲存庫是公開的）：由 Netlify 環境變數提供
//   AUTH_USERS         多個帳號（JSON）：{"a@x.com":"<密碼紀錄>",...}，密碼紀錄為 pbkdf2-sha256$… 或舊式 SHA-256
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
// 建議格式：pbkdf2-sha256$<次數>$<鹽 base64>$<雜湊十六進位>（加鹽、慢速，外洩時難以暴力破解）；
// 相容舊格式：純 SHA-256 十六進位。tools/hash-password.mjs 產生新格式。
const PBKDF2_RE = /^pbkdf2-sha256\$(\d{4,7})\$([A-Za-z0-9+/=]{16,64})\$([0-9a-f]{64})$/i;
export const PBKDF2_ITER = 100_000; // 邊緣函式每次請求 CPU 上限約 50 ms，10 萬次約 20 ms
const PBKDF2_MIN = 10_000, PBKDF2_MAX = 1_000_000;
/** 密碼紀錄格式檢查：PBKDF2 需次數在合理範圍、鹽可解碼且至少 8 位元組；不合格者視為未設定（不會讓登入出現 500） */
function validCred(h) {
  if (HEX64.test(h)) return true;
  const m = h.match(PBKDF2_RE);
  if (!m || +m[1] < PBKDF2_MIN || +m[1] > PBKDF2_MAX) return false;
  try { return atob(m[2]).length >= 8; } catch { return false; }
}

export async function pbkdf2Hex(pass, saltB64, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveBits"]);
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}

/** 產生新格式的密碼紀錄（每個帳號各自的隨機鹽） */
export async function makeCred(pass, iter = PBKDF2_ITER) {
  const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  return `pbkdf2-sha256$${iter}$${salt}$${await pbkdf2Hex(pass, salt, iter)}`;
}

/** 依紀錄格式計算輸入密碼的雜湊，並回傳應比對的值 */
async function credMatch(cred, pass) {
  const m = String(cred).match(PBKDF2_RE);
  if (m) return safeEqual(await pbkdf2Hex(pass, m[2], +m[1]), m[3].toLowerCase());
  // 舊式 SHA-256 紀錄也做同樣份量的 PBKDF2 運算，回應時間不洩漏帳號是否存在或用哪種格式
  await pbkdf2Hex(pass, "AAAAAAAAAAAAAAAAAAAAAA==", PBKDF2_ITER);
  return safeEqual(await sha256Hex(pass), String(cred).toLowerCase());
}
// 簽章用的「密碼標記」：取雜湊部分前 16 碼（改密碼即改變，舊登入失效）
const credTag = (cred) => { const m = String(cred).match(PBKDF2_RE); return (m ? m[3] : String(cred)).toLowerCase().slice(0, 16); };
const DUMMY = `pbkdf2-sha256$${PBKDF2_ITER}$AAAAAAAAAAAAAAAAAAAAAA==$${"0".repeat(64)}`;

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
  const add = (u, h) => { h = String(h || "").trim(); if (norm(u) && validCred(h)) m.set(norm(u), HEX64.test(h) ? h.toLowerCase() : h); };
  add(env.AUTH_USER, env.AUTH_PASS_SHA256); // 舊設定先放，AUTH_USERS 中同名帳號會覆寫（以新設定為準）
  if (env.AUTH_USERS) {
    try {
      const v = JSON.parse(env.AUTH_USERS);
      if (Array.isArray(v)) v.forEach((x) => x && add(x.user, x.sha256));
      else if (v && typeof v === "object") Object.entries(v).forEach(([u, h]) => add(u, h));
    } catch { /* 格式錯誤：視為沒有設定 */ }
  }
  return m;
}

export function configured(env) {
  return users(env).size > 0 && (env.AUTH_SECRET || "").length >= 32;
}

/** 驗證帳密；正確時回傳帳號（小寫），否則 null。帳號不存在時仍計算雜湊，回應時間不洩漏帳號是否存在 */
export async function authenticate(env, user, pass) {
  if (!configured(env)) return null;
  const u = norm(user), want = users(env).get(u);
  const match = await credMatch(want || DUMMY, String(pass || ""));
  const ok = match && Boolean(want) && Boolean(pass);
  return ok ? u : null;
}

/** 相容舊介面：回傳 true／false */
export async function checkCredentials(env, user, pass) {
  return Boolean(await authenticate(env, user, pass));
}

const b64u = (s) => btoa(String.fromCharCode(...enc.encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

// 簽章綁定：帳號、到期時間、該帳號密碼雜湊的前 16 碼（改密碼或刪帳號，舊的登入即失效）
const signMsg = (u, exp, h) => `${u}|${exp}|${credTag(h)}`;

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
// 每次失敗寫成一筆獨立的紀錄（鍵名含時間與亂數），再以列出前綴的方式計數：
// 同時多筆失敗不會互相覆蓋（不是「讀出→加一→寫回」），平行嘗試無法繞過次數上限。
export const LOCK = { maxFails: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 };

const lockPrefix = async (k) => "l-" + (await sha256Hex(k)).slice(0, 32) + "/";
const rand = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function failTimes(store, prefix) {
  const { blobs = [] } = (await store.list({ prefix })) || {};
  return blobs.map((b) => ({ key: b.key, t: +b.key.slice(prefix.length).split("-")[0] })).filter((x) => Number.isFinite(x.t));
}

/** 由失敗時間計算鎖定到何時：任 5 次失敗落在 15 分鐘內，即自第 5 次起鎖定 15 分鐘 */
export function lockUntil(times) {
  const t = [...times].sort((a, b) => a - b);
  let until = 0;
  for (let i = LOCK.maxFails - 1; i < t.length; i++) if (t[i] - t[i - LOCK.maxFails + 1] < LOCK.windowMs) until = Math.max(until, t[i] + LOCK.lockMs);
  return until;
}

/** 回傳仍在鎖定中的剩餘毫秒（0＝未鎖定）。store 失效時不阻擋登入（仍有密碼與延遲保護） */
export async function lockedFor(store, keys, now = Date.now()) {
  if (!store) return 0;
  let left = 0;
  for (const k of keys) {
    try {
      const until = lockUntil((await failTimes(store, await lockPrefix(k))).map((x) => x.t));
      if (until > now) left = Math.max(left, until - now);
    } catch { /* 忽略 */ }
  }
  return left;
}

export async function recordFail(store, keys, now = Date.now()) {
  if (!store) return;
  const keep = LOCK.windowMs + LOCK.lockMs;
  for (const k of keys) {
    try {
      const prefix = await lockPrefix(k);
      await store.set(`${prefix}${now}-${rand()}`, "1");
      for (const x of await failTimes(store, prefix)) if (now - x.t > keep) await store.delete(x.key); // 清除過期紀錄
    } catch { /* 忽略 */ }
  }
}

/**
 * 先登記這次嘗試（獨立紀錄）再計數，然後才驗證密碼：
 * 同時送出的大量嘗試彼此都看得到對方的紀錄，超過上限者一律不驗證，杜絕「先檢查、後記錄」之間的空隙。
 * 回傳 { left: 仍需等待的毫秒（0＝可驗證）, ids: 這次登記的紀錄，登入成功時以 releaseAttempt 移除 }
 */
export async function reserveAttempt(store, keys, now = Date.now()) {
  const res = { left: 0, ids: [] };
  if (!store) return res;
  const keep = LOCK.windowMs + LOCK.lockMs;
  for (const k of keys) {
    try {
      const prefix = await lockPrefix(k), id = `${prefix}${now}-${rand()}`;
      await store.set(id, "1");
      res.ids.push(id);
      const all = await failTimes(store, prefix);
      const until = lockUntil(all.filter((x) => x.key !== id).map((x) => x.t));
      if (until > now) res.left = Math.max(res.left, until - now);
      for (const x of all) if (now - x.t > keep) await store.delete(x.key);
    } catch { /* 忽略：儲存失效時不阻擋登入（仍有密碼與延遲保護） */ }
  }
  // 已鎖定時不留下這次的登記：避免攻擊者換不同帳號名稱持續製造新紀錄（並行上限仍成立：被驗證的嘗試都會保留紀錄）
  if (res.left > 0) { for (const id of res.ids) { try { await store.delete(id); } catch { /* 忽略 */ } } res.ids = []; }
  return res;
}

/** 每日清除鎖定紀錄中已過期的項目（獨立於登入流程，確保紀錄不會無限累積）；回傳刪除筆數。
 *  鍵名為 l-<十六進位雜湊>/…：依第一個十六進位字元分 16 段、每天輪流起點；每頁都檢查時間預算。 */
export async function purgeLockRecords(store, now = Date.now(), budgetMs = 20_000, clock = Date.now) {
  const keep = LOCK.windowMs + LOCK.lockMs, t0 = clock(), hexs = "0123456789abcdef";
  const k = Math.floor(now / 86400_000) * 5 % 16, order = hexs.slice(k) + hexs.slice(0, k);
  let removed = 0;
  for (const c of order) {
    for await (const page of store.list({ prefix: "l-" + c, paginate: true })) {
      const old = (page.blobs || []).filter(({ key }) => { const t = +String(key).split("/")[1]?.split("-")[0]; return Number.isFinite(t) && now - t > keep; });
      for (let i = 0; i < old.length; i += 20) {
        await Promise.all(old.slice(i, i + 20).map((b) => store.delete(b.key).then(() => removed++).catch(() => {})));
        if (clock() - t0 > budgetMs) return removed;
      }
      if (clock() - t0 > budgetMs) return removed;
    }
  }
  return removed;
}

export async function releaseAttempt(store, ids) {
  if (!store) return;
  for (const id of ids) { try { await store.delete(id); } catch { /* 忽略 */ } }
}

export async function clearFails(store, keys) {
  if (!store) return;
  for (const k of keys) {
    try { const prefix = await lockPrefix(k); for (const x of await failTimes(store, prefix)) await store.delete(x.key); } catch { /* 忽略 */ }
  }
}
