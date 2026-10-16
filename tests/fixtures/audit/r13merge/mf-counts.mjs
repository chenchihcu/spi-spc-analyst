// spec v1.12 round-13 merge: Miniflare local D1 row-count check (npm i miniflare; node <file>). Prints meta.rows_read / rows_written per statement.
import { Miniflare } from "miniflare";
const mf = new Miniflare({ modules:true, script:"export default {fetch(){return new Response('x')}}", d1Databases:{DB:"db1"} });
const db = await mf.getD1Database("DB");
const run = async (label, sql, ...b) => { const r = await db.prepare(sql).bind(...b).run(); console.log(label.padEnd(28), "rows_read", r.meta.rows_read, "rows_written", r.meta.rows_written, "res", JSON.stringify(r.results).slice(0,80)); return r; };
await db.exec("CREATE TABLE auth_attempts (id INTEGER PRIMARY KEY, key_u TEXT NOT NULL, key_ip TEXT NOT NULL, at INTEGER NOT NULL)");
await db.exec("CREATE INDEX auth_attempts_u ON auth_attempts(key_u, at)");
await db.exec("CREATE INDEX auth_attempts_ip ON auth_attempts(key_ip, at)");
const SEL = `SELECT 'u' AS k, at FROM (SELECT at FROM auth_attempts WHERE key_u = ?1 AND at > ?3 - 1800000 ORDER BY at DESC LIMIT 5)
 UNION ALL SELECT 'ip', at FROM (SELECT at FROM auth_attempts WHERE key_ip = ?2 AND at > ?3 - 1800000 ORDER BY at DESC LIMIT 5)`;
const INS = `INSERT INTO auth_attempts (key_u, key_ip, at) SELECT ?1, ?2, ?3
 WHERE (SELECT COUNT(*) = 5 AND MAX(at) - MIN(at) < 900000 AND MAX(at) > ?3 - 900000 FROM (SELECT at FROM auth_attempts WHERE key_u = ?1 AND at > ?3 - 1800000 ORDER BY at DESC LIMIT 5)) = 0
   AND (SELECT COUNT(*) = 5 AND MAX(at) - MIN(at) < 900000 AND MAX(at) > ?3 - 900000 FROM (SELECT at FROM auth_attempts WHERE key_ip = ?2 AND at > ?3 - 1800000 ORDER BY at DESC LIMIT 5)) = 0
 RETURNING id`;
// background noise: 200 rows for other keys
for (let i=0;i<200;i++) await db.prepare("INSERT INTO auth_attempts(key_u,key_ip,at) VALUES(?,?,?)").bind("bu"+i,"bip"+(i%40),10_000_000+i).run();
let now = 10_000_000;
await run("SELECT empty keys", SEL, "u0","ipA",now);
for (let i=1;i<=5;i++){ await run("INSERT #"+i, INS, "u"+i,"ipA",now+i*1000); }
await run("SELECT ipA locked (newU)", SEL, "uNew","ipA",now+6000);
await run("INSERT fails (locked)", INS, "uNew","ipA",now+6000);
// u key with 5 rows too
for (let i=1;i<=7;i++) await db.prepare("INSERT INTO auth_attempts(key_u,key_ip,at) VALUES(?,?,?)").bind("uX","ipZ"+i,now+i).run();
await run("SELECT uX 7 rows ipB 0", SEL, "uX","ipB",now+10000);
await run("DELETE success uX", "DELETE FROM auth_attempts WHERE key_u = ?1", "uX");
await run("cron DELETE", "DELETE FROM auth_attempts WHERE at < ?", now+100);
const c = await db.prepare("SELECT COUNT(*) n FROM auth_attempts").first(); console.log("left", c);
// records list
await db.exec("CREATE TABLE records(id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT '', created INTEGER, name TEXT)");
await db.exec("CREATE INDEX r_k ON records(kind, created DESC, id DESC)");
const stmts=[]; for (let i=0;i<3000;i++) stmts.push(db.prepare("INSERT INTO records VALUES(?,?,?,?)").bind("id"+String(i).padStart(5,"0"),"meas",1000+i,"n"+i));
await db.batch(stmts);
await run("list page1", "SELECT id,created FROM records WHERE kind=? ORDER BY created DESC, id DESC LIMIT 51","meas");
await run("list page2", "SELECT id,created FROM records WHERE kind=? AND (created,id)<(?,?) ORDER BY created DESC, id DESC LIMIT 51","meas",3949,"id02949");
await run("list page1 select *", "SELECT * FROM records WHERE kind=? ORDER BY created DESC, id DESC LIMIT 51","meas");
await mf.dispose();
