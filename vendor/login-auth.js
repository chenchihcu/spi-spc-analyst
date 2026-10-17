/* vendor/login-auth.js: 瀏覽器端 PBKDF2 慢速雜湊演算法 (D-60 ③, R8-8) */
"use strict";

(function () {
  const enc = new TextEncoder();
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const toB64Url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  /** 依規範計算慢速雜湊：d = PBKDF2-SHA256(密碼, salt="spi-spc-analyst/v1-<ITER>/" + 小寫帳號, iter=ITER, 32 bytes) */
  async function deriveD(user, pass, iter) {
    const normUser = String(user || "").trim().toLowerCase();
    const normPass = String(pass || "").normalize("NFC");
    const saltStr = `spi-spc-analyst/v1-${iter}/${normUser}`;
    const salt = enc.encode(saltStr);
    const key = await crypto.subtle.importKey("raw", enc.encode(normPass), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
    return toB64Url(new Uint8Array(bits));
  }

  window.SPI_AUTH_LOGIN = { deriveD };

  document.addEventListener("DOMContentLoaded", () => {
    const form = document.querySelector("form#loginForm");
    if (!form) return;
    const btn = form.querySelector("button[type=submit]");
    const userInput = form.querySelector("input[name=user]");
    const passInput = form.querySelector("input[name=pass]");
    const errBox = document.querySelector("#loginMsg");
    const iter = +form.dataset.iter || 600000;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const user = userInput.value.trim();
      const pass = passInput.value;
      if (!user || !pass) {
        if (errBox) errBox.textContent = "請輸入帳號與密碼";
        return;
      }
      if (btn) {
        btn.disabled = true;
        btn.textContent = "驗證中…";
      }
      if (errBox) errBox.textContent = "";

      try {
        const d = await deriveD(user, pass, iter);
        const next = form.dataset.next || "/";
        const resp = await fetch("/__login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user, d, next }),
        });
        const res = await resp.json().catch(() => ({}));
        if (resp.ok && res.ok) {
          location.replace(res.next || next);
          return;
        }
        const errMap = {
          login_db_unavailable: "登入資料庫暫時無法連線或尚未完成結構更新 (login_db_unavailable)，請稍後再試",
          login_limiter_missing: "伺服器缺少登入限流設定 (login_limiter_missing)，請通知管理員",
          login_limiter_error: "登入限流服務異常 (login_limiter_error)，請稍後再試",
        };
        if (errBox) errBox.textContent = res.message || errMap[res.error] || res.error || "帳號或密碼不正確";
      } catch (err) {
        if (errBox) errBox.textContent = "登入處理發生錯誤：" + (err.message || err);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "登入";
        }
      }
    });
  });
})();
