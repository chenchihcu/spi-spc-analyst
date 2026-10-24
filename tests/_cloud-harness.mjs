import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { handleRequest } from '../cloudflare/worker.mjs';
import { issueToken, COOKIE } from '../lib/auth-handler.mjs';

const ORIGIN = 'https://example.test';
const USER = 'admin@example.test';

export async function createCloudHarness() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../cloudflare/migrations/0002_free_plan_schema.sql', import.meta.url), 'utf8'));
  db.exec(fs.readFileSync(new URL('../cloudflare/migrations/0007_controlled_coordinate_import.sql', import.meta.url), 'utf8'));
  const wrap = (sql, args = []) => ({
    bind(...values) { return wrap(sql, values); },
    first() { return db.prepare(sql).get(...args) || null; },
    all() { return { results: db.prepare(sql).all(...args) }; },
    run() { const result = db.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; },
  });
  const DB = { prepare: sql => wrap(sql), batch(stmts) {
    db.exec('BEGIN');
    try { const result = stmts.map(stmt => stmt.run()); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
  const objects = new Map();
  const BLOBS = { put: async (key, value) => { objects.set(key, value); },
    get: async key => objects.has(key) ? {
      body: objects.get(key),
      arrayBuffer: async () => objects.get(key),
    } : null,
    delete: async key => { objects.delete(key); } };
  const env = { DB, BLOBS, ASSETS: { fetch: async () => new Response('ok') },
    AUTH_USERS: JSON.stringify({ [USER]: `pepper-hmac-sha256$600000$${'a'.repeat(64)}` }),
    AUTH_PEPPER: 'p'.repeat(40), AUTH_SECRET: 's'.repeat(40), AUTH_KDF_ITER: '600000',
    INITIAL_ADMIN_USER: USER };
  const cookie = `${COOKIE}=${await issueToken(env, USER)}`;
  const fetch = (input, options = {}) => {
    const url = new URL(String(input), ORIGIN);
    const headers = new Headers(options.headers);
    headers.set('cookie', cookie);
    if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) headers.set('origin', ORIGIN);
    return handleRequest(new Request(url, { ...options, headers }), env);
  };
  const upload = async (meta, source) => {
    const raw = Buffer.from(source);
    const response = await fetch('/api/records', { method: 'POST', headers: {
      'content-type': 'application/gzip', 'x-rec-meta': encodeURIComponent(JSON.stringify(meta)),
      'x-raw-bytes': String(raw.length), 'x-raw-sha256': createHash('sha256').update(raw).digest('hex'),
    }, body: gzipSync(raw) });
    if (!response.ok) throw new Error(`fixture upload ${response.status}: ${await response.text()}`);
    return (await response.json()).record;
  };
  return { fetch, upload, db, objects, close: () => db.close() };
}

export function installBrowserCloud(window, harness) {
  window.fetch = harness.fetch;
  window.Blob = Blob;
  window.Response = Response;
  window.Request = Request;
  window.Headers = Headers;
  window.CompressionStream = CompressionStream;
  window.DecompressionStream = DecompressionStream;
  window.TextEncoder = class extends TextEncoder {
    encode(input) { return new window.Uint8Array(super.encode(input)); }
  };
}
