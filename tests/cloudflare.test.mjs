import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handleRequest } from '../cloudflare/worker.mjs';
import { issueToken, COOKIE } from '../lib/auth-core.mjs';

const credentials = {
  AUTH_USER: 'local@example.com',
  AUTH_PASS_SHA256: createHash('sha256').update('local-test-pass').digest('hex'),
  AUTH_SECRET: 'x'.repeat(40),
};
const env = {
  ...credentials,
  DB: {}, BLOBS: {},
  ASSETS: { fetch: async (req) => new Response(req.url.includes('/vendor/') ? 'font' : '<h1>SPI·SPC</h1>', { headers: { 'Content-Type': 'text/html' } }) },
};
const request = (path, headers) => new Request('https://spi.example.test' + path, { headers });

test('Cloudflare Worker protects page and API but serves public vendor assets', async () => {
  const page = await handleRequest(request('/'), env);
  assert.equal(page.status, 401);
  assert.match(await page.text(), /登入/);
  const api = await handleRequest(request('/api/records'), env);
  assert.equal(api.status, 401);
  const vendor = await handleRequest(request('/vendor/font.woff2'), env);
  assert.equal(vendor.status, 200);
  assert.equal(await vendor.text(), 'font');
  assert.equal(vendor.headers.get('x-frame-options'), 'DENY');
});

test('Cloudflare Worker fails closed without storage or valid login configuration', async () => {
  assert.equal((await handleRequest(request('/'), { ...env, DB: null })).status, 503);
  assert.equal((await handleRequest(request('/'), { ...env, AUTH_SECRET: '' })).status, 503);
});

test('Cloudflare Worker serves only selected assets to an authenticated user', async () => {
  const token = await issueToken(credentials, 'local@example.com', Math.floor(Date.now() / 1000));
  const headers = { cookie: `${COOKIE}=${token}` };
  const page = await handleRequest(request('/spi-spc.html', headers), env);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), '<h1>SPI·SPC</h1>');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await handleRequest(request('/lib/auth-core.mjs', headers), env)).status, 404);
  assert.equal((await handleRequest(request('/tests/cloudflare.test.mjs', headers), env)).status, 404);
});
