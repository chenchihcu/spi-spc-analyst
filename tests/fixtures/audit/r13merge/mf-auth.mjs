// spec v1.12 round-13 merge: Miniflare local D1 row-count check (npm i miniflare; node <file>). Prints meta.rows_read / rows_written per statement.
import { Miniflare } from "miniflare";
const mf = new Miniflare({ modules:true, script:"export default {fetch(){return new Response('x')}}", d1Databases:{DB:"db4"} });
const db = await mf.getD1Database("DB");
await db.exec("CREATE TABLE auth_attempts (id INTEGER PRIMARY KEY, key_u TEXT NOT NULL, key_ip TEXT NOT NULL, at INTEGER NOT NULL)");
await db.exec("CREATE INDEX auth_attempts_u ON auth_attempts(key_u, at)");
await db.exec("CREATE INDEX auth_attempts_ip ON auth_attempts(key_ip, at)");
const SEL = `SELECT 'u' AS k, at FROM (SELECT at FROM auth_attempts WHERE key_u = ?1 AND at > ?3 - 1800000 ORDER BY at DESC LIMIT 5) UNION ALL SELECT 'ip', at FROM (SELECT at FROM auth_attempts WHERE key_ip = ?2 AND at > ?3 - 1800000 ORDER BY at DESC LIMIT 5)`;
const INS = `INSERT INTO auth_attempts (key_u, key_ip, at) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) = 5 AND MAX(at) - MIN(at) < 900000 AND MAX(at) > ?3 - 900000 FROM (SELECT at FROM auth_attempts WHERE key_u = ?1 AND at > ?3 - 1800000 ORDER BY at DESC LIMIT 5)) = 0 AND (SELECT COUNT(*) = 5 AND MAX(at) - MIN(at) < 900000 AND MAX(at) > ?3 - 900000 FROM (SELECT at FROM auth_attempts WHERE key_ip = ?2 AND at > ?3 - 1800000 ORDER BY at DESC LIMIT 5)) = 0 RETURNING id`;
const now = 100_000_000;
// 8 rows each for U and IP spread 4 min apart (not locked: 5 newest span 16 min)
for (let i=0;i<8;i++){ await db.prepare("INSERT INTO auth_attempts(key_u,key_ip,at) VALUES(?,?,?)").bind("U","other"+i, now-1_700_000+i*240_000).run();
                       await db.prepare("INSERT INTO auth_attempts(key_u,key_ip,at) VALUES(?,?,?)").bind("o"+i,"IP", now-1_700_000+i*240_000).run(); }
let r = await db.prepare(SEL).bind("U","IP",now).all(); console.log("SEL both>=5", r.meta.rows_read, r.results.length);
r = await db.prepare(INS).bind("U","IP",now).all(); console.log("INS both>=5", r.meta.rows_read, r.meta.rows_written, r.results);
r = await db.prepare("INSERT INTO auth_attempts(key_u,key_ip,at) VALUES(?,?,?) RETURNING id").bind("a","b",1).all(); console.log("plain insert", r.meta.rows_read, r.meta.rows_written);
r = await db.prepare("INSERT INTO auth_attempts(key_u,key_ip,at) VALUES(?,?,?)").bind("a","b",1).run(); console.log("plain insert no returning", r.meta.rows_read, r.meta.rows_written);
await mf.dispose();
