#!/usr/bin/env node
// 產生登入帳號設定（AUTH_USERS）：輸入帳號與密碼（密碼輸入兩次、不顯示），輸出 pepper-hmac-sha256$<ITER>$<hex> 格式。
// 符合規格書 D-60 ③, R8-8, R8-9 規範
import { createInterface } from "node:readline";
import crypto from "node:crypto";

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const toB64Url = (bytes) => Buffer.from(bytes).toString("base64url");

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

export async function deriveClientD(user, pass, iter = 600000) {
  const normUser = String(user || "").trim().toLowerCase();
  const normPass = String(pass || "").normalize("NFC");
  const saltStr = `spi-spc-analyst/v1-${iter}/${normUser}`;
  const salt = enc.encode(saltStr);
  const key = await crypto.subtle.importKey("raw", enc.encode(normPass), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return toB64Url(new Uint8Array(bits));
}

export async function hashPasswordRecord(d, pepper, iter = 600000) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(d));
  return `pepper-hmac-sha256$${iter}$${hex(sig)}`;
}

async function main() {
  const pepper = process.env.AUTH_PEPPER || await ask("AUTH_PEPPER 金鑰（至少 32 字元）：", true);
  if (!pepper || pepper.length < 32) {
    console.error("AUTH_PEPPER 必須至少 32 字元");
    process.exit(1);
  }
  const iter = +(process.env.AUTH_KDF_ITER || 600000);

  let current = {};
  if (process.argv[2]) {
    try {
      current = JSON.parse(process.argv[2]);
    } catch {
      console.error("現有 AUTH_USERS 不是有效的 JSON");
      process.exit(1);
    }
  }

  const user = String(await ask("帳號（email）：")).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(user)) {
    console.error("帳號格式不正確");
    process.exit(1);
  }

  const p1 = await ask("密碼（至少 12 字元）：", true);
  const p2 = await ask("再輸入一次密碼：", true);
  if (!p1 || p1 !== p2) {
    console.error("兩次密碼不一致或為空，未產生設定");
    process.exit(1);
  }
  if (p1.length < 12) {
    console.error("密碼少於 12 個字元，請加長以維護安全");
    process.exit(1);
  }

  const d = await deriveClientD(user, p1, iter);
  const rec = await hashPasswordRecord(d, pepper, iter);
  current[user] = rec;

  console.log("\n請將下列 JSON 內容透過 wrangler secret put AUTH_USERS 寫入 Cloudflare Secret：\n");
  console.log(JSON.stringify(current));
  rl.close();
}

if (process.argv[1] && process.argv[1].endsWith("hash-password.mjs")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
