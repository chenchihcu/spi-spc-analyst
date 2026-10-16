import { configured, handle as handleAuth } from '../lib/auth-handler.mjs';
import { SEC } from '../lib/security-headers.mjs';
import { Repo } from '../lib/repo.mjs';
import { checkMeta, MAX_GZ, MAX_RAW } from '../lib/records-core.mjs';
import { handleAnalyze } from './ai.mjs';
import { handleShare } from '../lib/share-core.mjs';

const plain = (message, status) => new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
const json = (obj, status = 200) => Response.json(obj, { status, headers: { 'Cache-Control': 'no-store' } });

const secure = (response, path = '') => {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries(SEC)) h.set(k, v);
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (path.startsWith('/vendor/')) h.set('Cache-Control', 'public, max-age=604800');
  else if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
};

async function handleRecordsApi(req, repo, user) {
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const id = url.searchParams.get('id');
    // 單筆 metadata
    if (id && url.searchParams.get('meta') === '1') {
      const rec = await repo.getRecord(id);
      if (!rec) return json({ error: '找不到這筆紀錄' }, 404);
      return json({ record: rec });
    }
    // 單筆原始檔下載 (回傳 gzip 串流)
    if (id) {
      const rec = await repo.getRecord(id);
      if (!rec) return json({ error: '找不到這筆紀錄' }, 404);
      const file = await repo.getRecordFile(id);
      if (!file) return json({ error: '找不到原始檔案' }, 404);
      return new Response(file.body, {
        headers: {
          'Content-Type': 'application/gzip',
          'Cache-Control': 'no-store',
          'X-Rec-Sha256': rec.sha256,
          'X-Raw-Bytes': String(rec.bytes),
        },
      });
    }

    // 稽核紀錄
    if (url.searchParams.get('audit') === '1') {
      const entries = await repo.listAuditLog(100);
      return json({ entries });
    }

    // 關鍵字搜尋
    const q = url.searchParams.get('q');
    if (q) {
      const results = await repo.searchRecords(q, 50);
      return json({ records: results, me: user, meta: { rows_read: results.length } });
    }

    // 分頁列表
    const cursor = url.searchParams.get('cursor');
    let cursorCreated = null, cursorId = null;
    if (cursor) {
      const parts = cursor.split(',');
      if (parts.length === 2 && !isNaN(+parts[0])) {
        cursorCreated = +parts[0];
        cursorId = parts[1];
      }
    }
    const kind = url.searchParams.get('kind') || 'spi';
    const limit = +url.searchParams.get('limit') || 50;
    const { records, next } = await repo.listRecords({ kind, cursorCreated, cursorId, limit });
    return json({ records, next, me: user });
  }

  if (req.method === 'POST') {
    let m;
    try {
      m = JSON.parse(decodeURIComponent(req.headers.get('x-rec-meta') || ''));
    } catch {
      return json({ error: '紀錄欄位格式不正確' }, 400);
    }
    const chk = checkMeta(m);
    if (chk.error) return json({ error: chk.error }, 400);

    const len = +req.headers.get('content-length') || 0;
    if (len > MAX_GZ) return json({ error: `檔案壓縮後 ${(len / 1048576).toFixed(1)} MB，超過上限 4 MB` }, 413);

    const rawBytes = +req.headers.get('x-raw-bytes') || 0;
    if (rawBytes > MAX_RAW) return json({ error: '解壓後原始大小超過上限 100 MB' }, 413);

    const clientSha = req.headers.get('x-raw-sha256') || '';
    if (!clientSha) return json({ error: '缺少 X-Raw-SHA256 驗證標頭' }, 400);

    const bodyBuf = new Uint8Array(await req.arrayBuffer());
    if (bodyBuf.length > MAX_GZ) return json({ error: '檔案壓縮後超過上限 4 MB' }, 413);
    if (bodyBuf.length < 20 || bodyBuf[0] !== 0x1f || bodyBuf[1] !== 0x8b) {
      return json({ error: '資料格式不正確（需為 gzip 壓縮）' }, 400);
    }

    const rec = {
      id: randomBytes(16).toString('base64url'),
      ...chk.meta,
      bytes: rawBytes || bodyBuf.length,
      gz_bytes: bodyBuf.length,
      sha256: clientSha,
      user,
      created: Date.now(),
    };

    const res = await repo.createRecord(rec, bodyBuf);
    if (res.error) return json(res, res.status || 500);
    return json(res, 201);
  }

  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id') || '';
    const res = await repo.deleteRecord(id, user);
    if (res.error) return json(res, res.status || 500);
    return json({ deleted: id });
  }

  return json({ error: '原始量測紀錄與座標檔不能修改；只能新增或刪除' }, 405);
}

async function route(req, env) {
  const url = new URL(req.url), path = url.pathname;
  const repo = new Repo(env.DB, env.BLOBS);
  const user = req.headers.get('x-spi-user') || '';

  if (path === '/api/records') return handleRecordsApi(req, repo, user);
  if (path === '/api/share') return handleShare(req, repo, user, env);
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
    const repo = new Repo(env.DB, env.BLOBS);
    const response = await handleAuth(req, env, (nextReq = req) => route(nextReq, env), {
      repo,
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
    const now = Date.now();
    // 依 L-7: 每次刪除 <= 40 筆過期分享
    const expiredShares = await env.DB.prepare(`SELECT id FROM shares WHERE exp < ? LIMIT 40`).bind(now).all();
    if (expiredShares.results?.length) {
      for (const s of expiredShares.results) {
        try { await env.BLOBS.delete(`shares/${s.id}`); } catch {}
      }
      const ids = expiredShares.results.map((x) => x.id);
      const placeholders = ids.map(() => '?').join(',');
      await env.DB.prepare(`DELETE FROM shares WHERE id IN (${placeholders})`).bind(...ids).run();
    }

    // 清除 30 分鐘前登入嘗試紀錄並累計刪除計數 (D-59, L-7)
    const thirtyMinsAgo = now - 30 * 60_000;
    const oldAttempts = await env.DB.prepare(`SELECT COUNT(*) as count FROM auth_attempts WHERE at < ?`).bind(thirtyMinsAgo).first();
    const delCount = oldAttempts?.count || 0;
    if (delCount > 0) {
      await env.DB.prepare(`DELETE FROM auth_attempts WHERE at < ?`).bind(thirtyMinsAgo).run();
      const todayStr = new Date(now).toISOString().slice(0, 10);
      const statKey = `auth_del_${todayStr}`;
      await env.DB.prepare(`
        INSERT INTO stats (key, value, updated) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = value + excluded.value, updated = excluded.updated
      `).bind(statKey, delCount, now).run();

      // 檢查是否超過 20000 列進入節流模式
      const totalDel = await env.DB.prepare(`SELECT value FROM stats WHERE key = ?`).bind(statKey).first();
      const currentRows = await env.DB.prepare(`SELECT COUNT(*) as count FROM auth_attempts`).first();
      const estimatedWritten = ((totalDel?.value || 0) + (currentRows?.count || 0)) * 4;
      const authMode = estimatedWritten >= 20000 ? 1 : 0;
      await env.DB.prepare(`
        INSERT INTO stats (key, value, updated) VALUES ('auth_mode', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated
      `).bind(authMode, now).run();
    }
  },
};
