#!/usr/bin/env node
// CF-SPI-001: export a read-only Netlify snapshot, then import/verify it in D1 + private R2.
// Source objects are never changed. Keep the export outside the repository: it contains production data.
import { getStore, listStores } from '@netlify/blobs';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { metadataMatches, sql, utf8Chunks } from './migration-sql.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const STORES = ['spi-records', 'spi-share', 'spi-maint', 'spi-auth-lock'];
const BUCKET = 'spi-spc-record';
const DB = 'spi-spc';
const sha = (data) => createHash('sha256').update(data).digest('hex');
const kindFor = (store, key) => {
  if (store === 'spi-share' || (store === 'spi-records' && key.startsWith('f/'))) return 'binary';
  if (store === 'spi-records' && (key === 'index.json' || key.startsWith('log/'))) return 'json';
  if ((store === 'spi-maint' || store === 'spi-auth-lock') && key) return 'json';
  throw new Error(`Unclassified source object: ${store}/${key}`);
};
const die = (message) => { throw new Error(message); };
const wrangler = (args) => {
  const r = spawnSync(process.execPath, [WRANGLER, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) die(`Wrangler ${args.slice(0, 3).join(' ')} failed: ${r.error?.message || r.stderr || r.stdout}`);
  return r.stdout;
};
const queryRow = (store, key, remote) => {
  const command = `SELECT kind,body,metadata,etag FROM objects WHERE store=${sql(store)} AND key=${sql(key)}`;
  const output = wrangler(['d1', 'execute', DB, remote ? '--remote' : '--local', '--json', '--command', command]);
  const parsed = JSON.parse(output.slice(output.indexOf('[')));
  return parsed?.[0]?.results?.[0] || null;
};

async function exportSnapshot(dir) {
  const siteID = process.env.NETLIFY_SITE_ID, token = process.env.NETLIFY_AUTH_TOKEN;
  if (!siteID || !token) die('NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN are required for read-only export');
  try { await access(join(dir, 'manifest.json')); die('Export already exists; use a new empty directory'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const names = new Set((await listStores({ siteID, token })).stores);
  if (!names.has('spi-records')) die('Source spi-records store is missing; refusing partial inventory');
  await mkdir(join(dir, 'objects'), { recursive: true });
  const entries = [];
  for (const name of STORES) {
    if (!names.has(name)) continue;
    const store = getStore({ name, siteID, token, consistency: 'strong' });
    for await (const page of store.list({ paginate: true })) for (const { key } of page.blobs) {
      const kind = kindFor(name, key);
      const hit = await store.getWithMetadata(key, { type: 'arrayBuffer' });
      if (!hit?.data) die(`Source disappeared during export: ${name}/${key}`);
      const bytes = Buffer.from(hit.data), filename = `objects/${String(entries.length + 1).padStart(6, '0')}.bin`;
      if (kind === 'json') JSON.parse(bytes.toString('utf8'));
      await writeFile(join(dir, filename), bytes, { flag: 'wx' });
      entries.push({ store: name, key, kind, filename, bytes: bytes.length, sha256: sha(bytes), metadata: hit.metadata ?? null });
    }
  }
  // Validate that each indexed raw record is present and matches its uncompressed source hash.
  const index = entries.find((e) => e.store === 'spi-records' && e.key === 'index.json');
  if (!index) die('Source records index.json is missing');
  const records = JSON.parse(await readFile(join(dir, index.filename), 'utf8'));
  if (!Array.isArray(records)) die('Source records index is not an array');
  for (const rec of records) {
    const file = entries.find((e) => e.store === 'spi-records' && e.key === `f/${rec.id}`);
    if (!file) die(`Indexed record file missing: ${rec.id}`);
    const raw = gunzipSync(await readFile(join(dir, file.filename)));
    if (raw.length !== rec.bytes || sha(raw) !== rec.sha256) die(`Indexed record hash mismatch: ${rec.id}`);
  }
  const manifest = { format: 'CF-SPI-001/v1', sourceSiteID: siteID, exportedAt: new Date().toISOString(), records: records.length, entries };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ phase: 'export', stores: Object.fromEntries(STORES.map((s) => [s, entries.filter((e) => e.store === s).length])), records: records.length, directory: dir }));
}

async function validateSnapshot(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'CF-SPI-001/v1' || !Array.isArray(manifest.entries)) die('Unsupported manifest');
  const seen = new Set();
  for (const entry of manifest.entries) {
    if (!STORES.includes(entry.store) || kindFor(entry.store, entry.key) !== entry.kind || !/^objects\/\d{6}\.bin$/.test(entry.filename)) die('Invalid manifest entry');
    const identity = `${entry.store}\0${entry.key}`;
    if (seen.has(identity)) die(`Duplicate source object: ${entry.store}/${entry.key}`);
    seen.add(identity);
    const bytes = await readFile(join(dir, entry.filename));
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) die(`Snapshot checksum mismatch: ${entry.store}/${entry.key}`);
    if (entry.kind === 'json') JSON.parse(bytes.toString('utf8'));
  }
  return manifest;
}

async function importSnapshot(dir, remote, apply) {
  const manifest = await validateSnapshot(dir);
  if (!apply) {
    console.log(JSON.stringify({ phase: 'plan', target: remote ? 'remote' : 'local', objects: manifest.entries.length, records: manifest.records, bytes: manifest.entries.reduce((n, e) => n + e.bytes, 0) }));
    return;
  }
  for (const entry of manifest.entries) {
    const bytes = await readFile(join(dir, entry.filename));
    const existing = queryRow(entry.store, entry.key, remote);
    const importTag = `import:${entry.sha256}`;
    const sameMetadata = (row) => metadataMatches(row.metadata, entry.metadata, entry.store, entry.key);
    const resumable = entry.kind === 'json' && existing?.kind === 'pending' && existing.etag === importTag && sameMetadata(existing);
    if (existing && !resumable) {
      if (existing.kind !== entry.kind || !sameMetadata(existing)) die(`Destination collision: ${entry.store}/${entry.key}`);
      if (entry.kind === 'json' && existing.body !== bytes.toString('utf8')) die(`Destination body differs: ${entry.store}/${entry.key}`);
    } else {
      if (entry.kind === 'json') {
        // Pending rows are hidden from the Worker. A repeated import restarts an
        // interrupted write only when its source checksum still matches.
        const identity = `store=${sql(entry.store)} AND key=${sql(entry.key)} AND kind='pending' AND etag=${sql(importTag)}`;
        if (!resumable) {
          const command = `INSERT OR IGNORE INTO objects(store,key,kind,body,metadata,etag) VALUES (${sql(entry.store)},${sql(entry.key)},'pending','',${sql(JSON.stringify(entry.metadata))},${sql(importTag)})`;
          wrangler(['d1', 'execute', DB, remote ? '--remote' : '--local', '--command', command]);
          const reserved = queryRow(entry.store, entry.key, remote);
          if (reserved?.kind !== 'pending' || reserved.etag !== importTag || !sameMetadata(reserved)) die(`Destination collision: ${entry.store}/${entry.key}`);
        }
        wrangler(['d1', 'execute', DB, remote ? '--remote' : '--local', '--command', `UPDATE objects SET body='' WHERE ${identity}`]);
        for (const chunk of utf8Chunks(bytes.toString('utf8'))) {
          wrangler(['d1', 'execute', DB, remote ? '--remote' : '--local', '--command', `UPDATE objects SET body=body||${sql(chunk)} WHERE ${identity}`]);
        }
        const assembled = queryRow(entry.store, entry.key, remote);
        if (assembled?.body !== bytes.toString('utf8')) die(`Destination body differs: ${entry.store}/${entry.key}`);
        wrangler(['d1', 'execute', DB, remote ? '--remote' : '--local', '--command', `UPDATE objects SET kind='json',etag=${sql(randomUUID())} WHERE ${identity}`]);
      } else {
        wrangler(['r2', 'object', 'put', `${BUCKET}/${entry.store}/${entry.key}`, remote ? '--remote' : '--local', '--file', join(dir, entry.filename)]);
        const command = `INSERT OR IGNORE INTO objects(store,key,kind,body,metadata,etag) VALUES (${sql(entry.store)},${sql(entry.key)},${sql(entry.kind)},NULL,${sql(JSON.stringify(entry.metadata))},${sql(randomUUID())})`;
        wrangler(['d1', 'execute', DB, remote ? '--remote' : '--local', '--command', command]);
      }
    }
    const row = queryRow(entry.store, entry.key, remote);
    if (!row || row.kind !== entry.kind || !sameMetadata(row) || (entry.kind === 'json' && row.body !== bytes.toString('utf8'))) die(`Destination D1 verify failed: ${entry.store}/${entry.key}`);
    if (entry.kind === 'binary') {
      const verifyPath = join(dir, 'verified', entry.filename);
      await mkdir(dirname(verifyPath), { recursive: true });
      wrangler(['r2', 'object', 'get', `${BUCKET}/${entry.store}/${entry.key}`, remote ? '--remote' : '--local', '--file', verifyPath]);
      if (sha(await readFile(verifyPath)) !== entry.sha256) die(`Destination R2 hash mismatch: ${entry.store}/${entry.key}`);
    }
    console.log(`verified ${entry.store}/${entry.key} sha256=${entry.sha256}`);
  }
  console.log(JSON.stringify({ phase: 'import-and-verify', target: remote ? 'remote' : 'local', verifiedObjects: manifest.entries.length, verifiedRecords: manifest.records }));
}

const [phase, folder, ...flags] = process.argv.slice(2);
if (!['export', 'import'].includes(phase) || !folder) die('Usage: node tools/migrate-netlify-blobs.mjs export|import ABSOLUTE_DIRECTORY [--remote|--local] [--apply]');
const dir = resolve(folder);
if (phase === 'export') await exportSnapshot(dir);
else await importSnapshot(dir, flags.includes('--remote'), flags.includes('--apply'));
