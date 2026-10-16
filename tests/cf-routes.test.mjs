import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 測試所有前端呼叫的同源路徑皆在 Worker route 或靜態資產白名單內 (D-48, D-59)
test('前端 API 路由與同源請求皆在 Worker 路由或靜態資產清單內', () => {
  const html = readFileSync('spi-spc.html', 'utf8');
  const workerSrc = readFileSync('cloudflare/worker.mjs', 'utf8');

  // 抓取 /api/* 呼叫
  const apiCalls = [...html.matchAll(/\/api\/[a-zA-Z0-9_\-]+/g)].map((m) => m[0]);
  const uniqueApis = [...new Set(apiCalls)];

  for (const api of uniqueApis) {
    assert.ok(
      workerSrc.includes(`'${api}'`) || workerSrc.includes(`"${api}"`),
      `Worker route 必須支援前端呼叫的 API: ${api}`
    );
  }

  // 檢查 vendor 靜態檔案路徑
  const vendorCalls = [...html.matchAll(/\/vendor\/[a-zA-Z0-9_\.\-]+/g)].map((m) => m[0]);
  const uniqueVendors = [...new Set(vendorCalls)];
  const actualVendors = readdirSync('vendor');

  for (const v of uniqueVendors) {
    const filename = v.replace('/vendor/', '');
    assert.ok(
      actualVendors.includes(filename),
      `vendor/ 目錄必須存在前端參照的檔案: ${filename}`
    );
  }
});
