import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import { handleRequest } from '../cloudflare/worker.mjs';
import { issueToken, COOKIE } from '../lib/auth-handler.mjs';

const AUTH_PEPPER = 'p'.repeat(40);
const AUTH_SECRET = 's'.repeat(40);
const rawPass = 'local-test-pass';
const d = pbkdf2Sync(rawPass, 'local@example.com', 600000, 32, 'sha256').toString('hex');
const hmac = createHmac('sha256', AUTH_PEPPER).update(d).digest('hex');
const userHash = `pepper-hmac-sha256$600000$${hmac}`;

const credentials = {
  AUTH_USERS: JSON.stringify({ 'local@example.com': userHash }),
  AUTH_PEPPER,
  AUTH_SECRET,
  AUTH_KDF_ITER: '600000',
};

const mockDb = () => ({
  prepare: () => ({
    bind: () => ({
      all: async () => ({ results: [] }),
      first: async () => null,
      run: async () => ({ success: true }),
    }),
  }),
});

const mockBlobs = () => ({
  get: async () => null,
  put: async () => {},
  delete: async () => {},
});

const env = {
  ...credentials,
  DB: mockDb(),
  BLOBS: mockBlobs(),
  ASSETS: { fetch: async (req) => new Response(req.url.includes('/vendor/') ? 'font' : '<h1>SPI·SPC</h1>', { headers: { 'Content-Type': 'text/html' } }) },
};
const request = (path, headers) => new Request('https://spi.example.test' + path, { headers });

test('Cloudflare Worker protects page and API but serves public vendor assets', async () => {
  const page = await handleRequest(request('/'), env);
  assert.equal(page.status, 303);
  assert.equal(page.headers.get('location'), '/__login?next=%2F');

  const loginPage = await handleRequest(request('/__login?next=%2F'), env);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /登入/);

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
  assert.equal((await handleRequest(request('/'), { ...env, AUTH_PEPPER: '' })).status, 503);
});

test('Cloudflare Worker serves only selected assets to an authenticated user', async () => {
  const token = await issueToken(env, 'local@example.com', Math.floor(Date.now() / 1000));
  const headers = { cookie: `${COOKIE}=${token}` };
  const page = await handleRequest(request('/spi-spc.html', headers), env);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), '<h1>SPI·SPC</h1>');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await handleRequest(request('/lib/auth-core.mjs', headers), env)).status, 404);
  assert.equal((await handleRequest(request('/tests/cloudflare.test.mjs', headers), env)).status, 404);
});

