import { configured, purgeLockRecords } from '../lib/auth-core.mjs';
import { handle as handleAuth, SEC } from '../netlify/edge-functions/auth.mjs';
import { handleRecords } from '../lib/records-core.mjs';
import { handleShare } from '../netlify/functions/share.mjs';
import { purgeExpired } from '../netlify/functions/share-cleanup.mjs';
import { createStore } from './storage.mjs';
import { handleAnalyze } from './ai.mjs';

const plain = (message, status) => new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
const secure = (response, path = '') => {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries(SEC)) h.set(k, v);
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (path.startsWith('/vendor/')) h.set('Cache-Control', 'public, max-age=604800');
  else if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
};

async function route(req, env) {
  const url = new URL(req.url), path = url.pathname;
  if (path === '/api/records') return handleRecords(req, createStore(env, 'spi-records'));
  if (path === '/api/share') return handleShare(req, createStore(env, 'spi-share'));
  if (path === '/api/analyze') return handleAnalyze(req, env);
  if (path.startsWith('/api/')) return Response.json({ error: '找不到 API' }, { status: 404 });
  if (path === '/' || path === '/spi-spc.html' || path === '/index.html') {
    const assetUrl = new URL('/', url);
    return env.ASSETS.fetch(new Request(assetUrl, req));
  }
  if (path.startsWith('/vendor/')) return env.ASSETS.fetch(req);
  return plain('Not found', 404);
}

export async function handleRequest(req, env) {
  const path = new URL(req.url).pathname;
  if (!env.ASSETS || !env.DB || !env.BLOBS) return secure(plain('網站儲存與部署尚未設定，暫停對外服務。', 503), path);
  if (path.startsWith('/vendor/')) return secure(await route(req, env), path);
  if (!configured(env)) return secure(plain('網站登入尚未設定，暫停對外服務。', 503), path);
  try {
    const response = await handleAuth(req, env, (nextReq = req) => route(nextReq, env), {
      store: createStore(env, 'spi-auth-lock'),
      ip: req.headers.get('CF-Connecting-IP') || '',
    });
    return secure(response, path);
  } catch (e) {
    console.error('Cloudflare Worker request failed', e);
    return secure(plain('服務暫時無法使用，請稍後再試。', 503), path);
  }
}

export default {
  fetch: handleRequest,
  async scheduled(_event, env) {
    if (!env.DB || !env.BLOBS) return;
    const shares = createStore(env, 'spi-share'), maint = createStore(env, 'spi-maint');
    const prev = await maint.get('share-cleanup', { type: 'json' }).catch(() => null);
    const { state } = await purgeExpired(shares, Date.now(), 15_000, Date.now, prev);
    await maint.setJSON('share-cleanup', state);
    await purgeLockRecords(createStore(env, 'spi-auth-lock'), Date.now(), 8_000);
  },
};
