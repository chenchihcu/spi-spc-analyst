#!/usr/bin/env node
// 產生登入帳號設定（AUTH_USERS）：輸入帳號與密碼（密碼輸入兩次、不顯示），輸出可貼到 Netlify 環境變數的 JSON。
// 用法：node tools/hash-password.mjs                 → 新增一個帳號
//       node tools/hash-password.mjs '<現有 AUTH_USERS JSON>'  → 在現有設定中新增或更新帳號
// 只輸出密碼的 SHA-256，不輸出明文；請勿把輸出結果提交到儲存庫。
import { createInterface } from "node:readline";
import { sha256Hex, norm } from "../lib/auth-core.mjs";

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
const lines = rl[Symbol.asyncIterator]();
let mute = false;
rl._writeToOutput = (s) => { if (!mute) process.stdout.write(s); };
async function ask(q, hidden = false) {
  process.stdout.write(q);
  mute = hidden;
  const { value = "" } = await lines.next();
  mute = false;
  if (hidden) process.stdout.write("\n");
  return value;
}

let current = {};
if (process.argv[2]) {
  try { const v = JSON.parse(process.argv[2]); current = Array.isArray(v) ? Object.fromEntries(v.map((x) => [x.user, x.sha256])) : v; }
  catch { console.error("現有 AUTH_USERS 不是有效的 JSON"); process.exit(1); }
}
const user = norm(await ask("帳號（email）："));
if (!/^[^\s@]+@[^\s@]+$/.test(user)) { console.error("帳號格式不正確"); rl.close(); process.exit(1); }
const p1 = await ask("密碼：", true), p2 = await ask("再輸入一次密碼：", true);
if (!p1 || p1 !== p2) { console.error("兩次密碼不一致或為空，未產生設定"); process.exit(1); }
if (p1.length < 8) console.warn("提醒：密碼少於 8 個字元，建議加長");
current[user] = await sha256Hex(p1);
console.log("\n請把下面這一行設為 Netlify 環境變數 AUTH_USERS 的值（不要勾選 secret，免費方案的邊緣函式讀不到 secret 變數）：\n");
console.log(JSON.stringify(current));
rl.close();
