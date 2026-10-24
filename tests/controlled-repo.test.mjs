import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Repo } from '../lib/repo.mjs';
import { handleRequest } from '../cloudflare/worker.mjs';
import { issueToken, COOKIE } from '../lib/auth-handler.mjs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../cloudflare/migrations/0002_free_plan_schema.sql', import.meta.url), 'utf8'));
  db.exec(fs.readFileSync(new URL('../cloudflare/migrations/0007_controlled_coordinate_import.sql', import.meta.url), 'utf8'));
  const wrap = (sql, args = []) => ({
    bind(...values) { return wrap(sql, values); },
    first() { return db.prepare(sql).get(...args) || null; },
    all() { return { results: db.prepare(sql).all(...args) }; },
    run() { const result = db.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; },
  });
  return {
    prepare: sql => wrap(sql),
    batch(stmts) { db.exec('BEGIN'); try { const result = stmts.map(s => s.run()); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; } },
    raw: db,
  };
}
function bucket() {
  const objects = new Map();
  return { objects, put: async (key, value) => { objects.set(key, value); },
    get: async key => objects.has(key) ? { arrayBuffer: async () => objects.get(key) } : null,
    delete: async key => { objects.delete(key); } };
}
const id = n => `record_${String(n).padStart(15, '0')}`;
const place = (n, side = 'TOP', sha = String(n)) => ({ id: id(n), kind: 'place', part: 'P', rev: 'V5', side,
  sides: side === 'BOTH' ? ['TOP', 'BOT'] : [side], unit: 'mm', factor: 1, formatVersion: 1,
  validationSource: 'server_verified', lifecycle: 'active', sha256: sha, user: 'admin@example.com', bytes: 10, created: n });
const spi = (n, sha, workOrder, measuredDate = '') => ({ id: id(n), kind: 'spi', part: 'P', rev: 'V5', side: 'TOP',
  placeId: id(1), workOrder, measuredDate, validationSource: 'server_verified', lifecycle: 'active',
  sha256: sha, user: 'user@example.com', bytes: 10, created: n });

test('migration and version occupancy preserve original R2 file on conflict', async () => {
  const db = database(), r2 = bucket(), repo = new Repo(db, r2);
  const first = await repo.createRecord(place(1), new Uint8Array([1]));
  assert.equal(first.record.id, id(1));
  assert.equal((await repo.coordinateScope('P', 'V5', 'TOP')).id, id(1));
  const exact = await repo.createRecord(place(2, 'TOP', '1'), new Uint8Array([2]));
  assert.equal(exact.existing, id(1));
  assert.equal(exact.status, 200);
  const conflict = await repo.createRecord(place(3), new Uint8Array([3]));
  assert.equal(conflict.status, 409);
  assert.equal(r2.objects.has(`records/${id(3)}`), false);
  assert.equal((await repo.getRecord(id(3))), null);
});

test('並行上傳同版座標只建立一份受控內容，衝突檔不留 R2 物件', async () => {
  const db = database(), r2 = bucket(), repo = new Repo(db, r2);
  const results = await Promise.all([
    repo.createRecord(place(41, 'BOTH', 'a'), new Uint8Array([41])),
    repo.createRecord(place(42, 'TOP', 'b'), new Uint8Array([42])),
  ]);
  assert.deepEqual(results.map(x => x.status || 201).sort(), [201, 409]);
  const winners = [id(41), id(42)].filter(x => r2.objects.has(`records/${x}`));
  assert.equal(winners.length, 1);
  assert.equal((await repo.coordinateScope('P', 'V5', 'TOP')).id, winners[0]);
});

test('座標庫超過 100 份仍可用游標讀取，不以首頁判定不存在', async () => {
  const repo = new Repo(database(), bucket());
  for (let n = 1; n <= 102; n++) await repo.createRecord({ ...place(n), rev: `V${n}` }, new Uint8Array([n]));
  const first = await repo.getPlacementsForPart('P', 'TOP', '', null, null, 100);
  assert.equal(first.placements.length, 100);
  assert.ok(first.next);
  const [created, cursorId] = first.next.split(',');
  const second = await repo.getPlacementsForPart('P', 'TOP', '', +created, cursorId, 100);
  assert.equal(second.placements.length, 2);
  assert.equal(second.next, null);
  assert.ok(second.placements.some(row => row.rev === 'V1'));
});

test('measurement fingerprint ignores work-order changes; related different file can be reviewed and corrected once', async () => {
  const db = database(), repo = new Repo(db, bucket());
  await repo.createRecord(place(1), new Uint8Array([1]));
  const a = await repo.createRecord(spi(10, 'sha-a', 'WO-1'), new Uint8Array([10]));
  assert.equal(a.record.lifecycle, 'active');
  assert.equal((await repo.measurementFingerprint('P', 'V5', 'TOP', 'sha-a')).id, id(10));
  const related = await repo.relatedMeasurements('P', 'V5', 'TOP', 'WO-1', '');
  assert.deepEqual(related.map(r => r.id), [id(10)]);
  const concurrentDecision = await repo.createRecord(spi(13, 'sha-d', 'WO-1'), new Uint8Array([13]));
  assert.equal(concurrentDecision.record.lifecycle, 'pending_review', '寫入時重新判斷相關紀錄');
  const replacement = { ...spi(11, 'sha-b', 'WO-1'), lifecycle: 'pending_review' };
  await repo.createRecord(replacement, new Uint8Array([11]));
  assert.equal((await repo.judgeMeasurement(id(11), 'correct', id(10), 'admin@example.com')).ok, true);
  assert.equal((await repo.getRecord(id(10))).lifecycle, 'superseded');
  assert.equal((await repo.getRecord(id(11))).lifecycle, 'active');
  assert.equal((await repo.deleteRecord(id(10), 'admin@example.com')).status, 409);
  const another = { ...spi(12, 'sha-c', 'WO-1'), lifecycle: 'pending_review' };
  await repo.createRecord(another, new Uint8Array([12]));
  assert.equal((await repo.judgeMeasurement(id(12), 'correct', id(10), 'admin@example.com')).status, 409);
  assert.equal((await repo.getRecord(id(12))).lifecycle, 'pending_review');
});

test('archive retains coordinate scope and raw file for history while excluding new selection', async () => {
  const db = database(), r2 = bucket(), repo = new Repo(db, r2);
  await repo.createRecord(place(1, 'BOTH'), new Uint8Array([1]));
  assert.equal((await repo.coordinateScope('P', 'V5', 'BOT')).id, id(1));
  assert.equal((await repo.archivePlacement(id(1), 'admin@example.com')).ok, true);
  assert.equal((await repo.getPlacementsForPart('P', 'TOP', 'V5')).placements.length, 0);
  assert.equal((await repo.coordinateScope('P', 'V5', 'TOP')).id, id(1));
  assert.equal(r2.objects.has(`records/${id(1)}`), true);
});

test('管理角色只初始化一次，撤權後立即失效，最後一位可登入管理者不可撤銷', async () => {
  const db = database(), repo = new Repo(db, bucket());
  await repo.bootstrapAdmin('admin@example.com', true, 100);
  assert.equal(await repo.isAdmin('admin@example.com'), true);
  assert.equal((await repo.setAdminRole('admin@example.com', false, 'admin@example.com', ['admin@example.com', 'other@example.com'])).status, 409);
  assert.equal((await repo.setAdminRole('other@example.com', true, 'admin@example.com', ['admin@example.com', 'other@example.com'])).ok, true);
  assert.equal((await repo.setAdminRole('admin@example.com', false, 'other@example.com', ['admin@example.com', 'other@example.com'])).ok, true);
  assert.equal(await repo.isAdmin('admin@example.com'), false);
  await repo.bootstrapAdmin('admin@example.com', true, 200);
  assert.equal(await repo.isAdmin('admin@example.com'), false);
  assert.equal(await repo.isAdmin('other@example.com'), true);
});

test('authenticated API enforces admin upload, server validation, unmatched confirmation and pending review', async () => {
  const db = database(), r2 = bucket();
  const env = { DB: db, BLOBS: r2, ASSETS: { fetch: async () => new Response('ok') },
    AUTH_USERS: JSON.stringify({ 'admin@example.com': `pepper-hmac-sha256$600000$${'a'.repeat(64)}`,
      'user@example.com': `pepper-hmac-sha256$600000$${'b'.repeat(64)}` }),
    AUTH_PEPPER: 'p'.repeat(40), AUTH_SECRET: 's'.repeat(40), AUTH_KDF_ITER: '600000',
    INITIAL_ADMIN_USER: 'admin@example.com' };
  const cookie = async user => `${COOKIE}=${await issueToken(env, user)}`;
  const upload = async (user, meta, source) => {
    const raw = Buffer.from(source), sha = createHash('sha256').update(raw).digest('hex');
    return handleRequest(new Request('https://spi.test/api/records', { method: 'POST', headers: {
      cookie: await cookie(user), origin: 'https://spi.test', 'content-type': 'application/gzip',
      'x-rec-meta': encodeURIComponent(JSON.stringify(meta)), 'x-raw-bytes': String(raw.length), 'x-raw-sha256': sha,
    }, body: gzipSync(raw) }), env);
  };
  const placeMeta = { kind: 'place', part: 'P', rev: 'V5', side: 'TOP', unit: 'mm', name: 'p.csv' };
  const placeCsv = 'RefDes,X,Y,Layer\nU1,1,2,L1-TOP\n';
  const nonAdminRoles = await handleRequest(new Request('https://spi.test/api/admin/users', {
    headers: { cookie: await cookie('user@example.com') },
  }), env);
  assert.equal(nonAdminRoles.status, 403);
  assert.equal((await upload('user@example.com', placeMeta, placeCsv)).status, 403);
  const created = await upload('admin@example.com', { ...placeMeta, comps: 999 }, placeCsv);
  assert.equal(created.status, 201);
  const placeRecord = (await created.json()).record;
  assert.equal(placeRecord.comps, 1, '伺服器解析值覆蓋不可信的上傳計數');
  const placeId = placeRecord.id;
  assert.equal((await upload('admin@example.com', placeMeta, placeCsv)).status, 200);
  const spiMeta = { kind: 'spi', part: 'P', rev: 'V5', side: 'TOP', placeId, workOrder: 'WO-1', name: 'm.csv' };
  assert.equal((await upload('user@example.com', { ...spiMeta, measuredDate: '2026-02-30' },
    'Component ID,PAD ID,Height(%)1\nU1_1,1,90\n')).status, 422);
  const spiCsv = 'Component ID,PAD ID,Height(%)1,Result1\nU1_1,1,88,PASS\nR1_1,1,90,PASS\n';
  const needsConfirm = await upload('user@example.com', spiMeta, spiCsv);
  assert.equal(needsConfirm.status, 422);
  assert.deepEqual((await needsConfirm.json()).missing, ['R1']);
  const accepted = await upload('user@example.com', { ...spiMeta, boards: 999, pads: 999, rows: 999,
    unmatchedConfirmed: true, unmatchedRefs: ['R1'] }, spiCsv);
  assert.equal(accepted.status, 201);
  const acceptedRecord = (await accepted.json()).record;
  assert.deepEqual([acceptedRecord.boards, acceptedRecord.pads, acceptedRecord.rows], [1, 2, 2]);
  const acceptedId = acceptedRecord.id;
  const same = await upload('user@example.com', { ...spiMeta, workOrder: 'WO-2', unmatchedConfirmed: true, unmatchedRefs: ['R1'] }, spiCsv);
  assert.equal(same.status, 409);
  assert.equal((await same.json()).existing, acceptedId);
  const related = await upload('user@example.com', { ...spiMeta, unmatchedConfirmed: true, unmatchedRefs: ['R1'] }, spiCsv.replace('90', '91'));
  assert.equal(related.status, 202);
  assert.equal((await related.json()).record.lifecycle, 'pending_review');
  const oldRaw = Buffer.from('RefDes,X,Y,Layer\nC1,1,2,L1-TOP\n');
  const old = { id: id(90), kind: 'place', part: 'unverified', rev: 'old', side: 'TOP', name: 'old.csv',
    sha256: createHash('sha256').update(oldRaw).digest('hex'), bytes: oldRaw.length, user: 'user@example.com' };
  await new Repo(db, r2).createRecord(old, gzipSync(oldRaw));
  const promote = await handleRequest(new Request('https://spi.test/api/records', { method: 'PATCH', headers: {
    cookie: await cookie('admin@example.com'), origin: 'https://spi.test', 'content-type': 'application/json',
  }, body: JSON.stringify({ action: 'register_legacy_place', id: old.id, part: 'P-OLD', rev: 'V1', side: 'TOP', unit: 'mm' }) }), env);
  assert.equal(promote.status, 201);
  assert.equal((await new Repo(db, r2).getRecord(old.id)).validation_source, 'legacy');
  assert.equal((await new Repo(db, r2).coordinateScope('P-OLD', 'V1', 'TOP')).validation_source, 'server_verified');
});
