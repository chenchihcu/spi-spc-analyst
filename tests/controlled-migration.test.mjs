import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const sql = name => readFileSync(new URL(`../cloudflare/migrations/${name}`, import.meta.url), 'utf8');

test('0007 rehearses against a populated pre-migration copy without changing legacy identity or audit', () => {
  const db = new DatabaseSync(':memory:');
  for (const name of ['0002_free_plan_schema.sql', '0003_v110.sql', '0004_shares_sha256.sql',
    '0005_record_catalog_enhancement.sql', '0006_placement_and_snapshot.sql']) db.exec(sql(name));
  db.prepare(`INSERT INTO records(id,kind,part,rev,lot,side,place_id,name,user,created,bytes,gz_bytes,sha256,meta)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('old-place', 'place', 'P', 'V5', '', 'TOP', '', 'p.csv', 'owner', 1, 11, 11, 'hash-p', '{"unit":"mm"}');
  db.prepare(`INSERT INTO records(id,kind,part,rev,lot,side,place_id,name,user,created,bytes,gz_bytes,sha256,meta)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('old-spi', 'spi', 'P', 'V5', 'LOT', 'TOP', 'old-place', 's.csv', 'owner', 2, 13, 13, 'hash-s', '{"qualitySnapshot":{"n":20}}');
  db.prepare(`INSERT INTO audit_log(at,by,action,target_type,target_id,detail) VALUES (?,?,?,?,?,?)`)
    .run(3, 'owner', 'create', 'record', 'old-spi', '{"source":"legacy"}');
  const before = db.prepare('SELECT id,kind,part,rev,lot,side,place_id,name,user,created,bytes,gz_bytes,sha256,meta FROM records ORDER BY id').all();
  const audit = db.prepare('SELECT seq,at,by,action,target_type,target_id,detail FROM audit_log').all();
  db.exec(sql('0007_controlled_coordinate_import.sql'));
  assert.deepEqual(db.prepare('SELECT id,kind,part,rev,lot,side,place_id,name,user,created,bytes,gz_bytes,sha256,meta FROM records ORDER BY id').all(), before);
  assert.deepEqual(db.prepare('SELECT seq,at,by,action,target_type,target_id,detail FROM audit_log').all(), audit);
  assert.deepEqual(db.prepare('SELECT id,lifecycle,validation_source,work_order,measured_date,supersedes_id FROM records ORDER BY id').all().map(row => ({ ...row })), [
    { id: 'old-place', lifecycle: 'legacy', validation_source: 'legacy', work_order: '', measured_date: '', supersedes_id: '' },
    { id: 'old-spi', lifecycle: 'legacy', validation_source: 'legacy', work_order: '', measured_date: '', supersedes_id: '' },
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM coordinate_scopes').get().n, 0);
  db.close();
});
