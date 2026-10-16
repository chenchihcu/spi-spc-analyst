// spec v1.14 round-15 merge: Miniflare local D1 checks (npm i miniflare; node <file>).
// (1) R15-1: audit page status decided by the row alone (detail.done for migrated rows; migrate_exclude/delete rows labelled on themselves);
//     the fixed audit SQL (9.4 L-6 exception 4) is unchanged -> rows_read per page still <= 2*(50+2) = 104.
// (2) R15-2: expected share set E computed from the full share key list (shares.json) that every export writes, also with --since.
// (3) R15-3: share excluded after import -> tool deletes the shares row + writes exclude:share in one batch, then deletes the R2 object;
//     C5 gate "stale live shares" = 0; target_id holds the full 22-char share id (a 6-char prefix would misclassify self-created shares).
import { Miniflare } from "miniflare";
const mf = new Miniflare({ modules:true, script:"export default {fetch(){return new Response('x')}}", d1Databases:{DB:"r15m"} });
const db = await mf.getD1Database("DB");
for (const s of [
 "CREATE TABLE records(id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT '', part TEXT NOT NULL DEFAULT '', rev TEXT NOT NULL DEFAULT '', lot TEXT NOT NULL DEFAULT '', side TEXT NOT NULL DEFAULT '', vendor TEXT NOT NULL DEFAULT '', place_id TEXT NOT NULL DEFAULT '', name TEXT, user TEXT, created INTEGER, bytes INTEGER, gz_bytes INTEGER, sha256 TEXT NOT NULL DEFAULT '', meta TEXT)",
 "CREATE UNIQUE INDEX records_same ON records(kind, part, rev, lot, side, vendor, place_id, sha256)",
 "CREATE INDEX records_list ON records(kind, created DESC, id DESC)",
 "CREATE INDEX records_sha ON records(sha256)",
 "CREATE TABLE audit_log(seq INTEGER PRIMARY KEY, at INTEGER, by TEXT, action TEXT, target_type TEXT, target_id TEXT, detail TEXT, src_key TEXT)",
 "CREATE INDEX audit_log_at ON audit_log(at DESC)",
 "CREATE INDEX audit_log_target ON audit_log(target_id)",
 "CREATE UNIQUE INDEX audit_log_src ON audit_log(src_key) WHERE src_key IS NOT NULL",
 "CREATE TABLE shares(id TEXT PRIMARY KEY, user TEXT, name TEXT, created INTEGER, exp INTEGER, bytes INTEGER, revoked_at INTEGER, revoked_by TEXT)",
 "CREATE INDEX shares_user ON shares(user, created DESC)",
 "CREATE INDEX shares_exp ON shares(exp)"]) await db.exec(s);
const pad=(p,i,n=22)=>(p+String(i)).padStart(n,"0").slice(-n);
const run=async st=>{let w=0;for(let i=0;i<st.length;i+=500){for(const r of await db.batch(st.slice(i,i+500)))w+=r.meta.rows_written;}return w;};

// ---------- (1) R15-1
const st=[]; let at=0;
for(let i=0;i<3000;i++) st.push(db.prepare("INSERT INTO records(id,kind,lot,created,sha256) VALUES(?,?,?,?,?)").bind(pad("r",i),"meas","L"+i,i,"h"+i));
const ins=(by,action,tt,tid,detail,src)=>db.prepare("INSERT INTO audit_log(at,by,action,target_type,target_id,detail,src_key) VALUES(?,?,?,?,?,?,?)").bind(at++,by,action,tt,tid,detail,src);
// migrated log rows: done flag computed by the tool from the old site's auditStatus, stored in detail
for(let i=0;i<300;i++) st.push(ins("u","create","record",pad("x",i),JSON.stringify({lot:"D"+i,done:true}),"log/c"+i));        // later deleted
for(let i=0;i<300;i++) st.push(ins("u","delete","record",pad("x",i),JSON.stringify({lot:"D"+i,done:true}),"log/d"+i));
for(let i=0;i<20;i++)  st.push(ins("u","create","record",pad("y",i),JSON.stringify({lot:"F"+i,done:false}),"log/f"+i));      // never completed on old site
for(let i=0;i<30;i++)  st.push(ins("u","create","record",pad("z",i),JSON.stringify({lot:"TEST-"+i,done:true}),"log/z"+i));   // excluded at migration
for(let i=0;i<30;i++)  st.push(ins("migration","migrate_exclude","record",pad("z",i),JSON.stringify({opt:"--exclude-lot-prefix TEST-",lot:"TEST-"+i}),"exclude:record:"+pad("z",i)));
// App rows (src_key NULL; written in the same batch as the action, always complete)
for(let i=0;i<300;i++) st.push(ins("u","create","record",pad("r",i),JSON.stringify({lot:"L"+i}),null));
for(let i=0;i<40;i++)  st.push(ins("u","share_create","share",pad("s",i),JSON.stringify({name:"n"}),null));
await run(st);
// single-row status (no other row consulted)
function status(row){
  const d = row.detail ? JSON.parse(row.detail) : {};
  if (d.done === false) return "incomplete";          // only migrated rows can carry done:false
  if (row.action === "migrate_exclude") return "excluded-at-migration";
  if (row.action === "delete") return "deleted";
  if (row.target_type === "record" && row.live === null) return "target-gone (neutral)";
  return "ok";
}
const PAGE=50, CAP=2*(PAGE+2);
const AQ=w=>`SELECT a.seq,a.at,a.by,a.action,a.target_type,a.target_id,a.detail, r.id AS live FROM audit_log a LEFT JOIN records r ON r.id=a.target_id ${w} ORDER BY a.seq DESC LIMIT ${PAGE+1}`;
let cursor=null,page=0,worst=0,tally={},extra=0;
while(true){
  page++;
  const r = cursor===null ? await db.prepare(AQ("")).all() : await db.prepare(AQ("WHERE a.seq<?")).bind(cursor).all();
  worst=Math.max(worst,r.meta.rows_read);
  const rows=r.results.slice(0,PAGE);
  for(const x of rows){const s=status(x);tally[s]=(tally[s]||0)+1;}
  if(r.results.length<=PAGE)break; cursor=rows[rows.length-1].seq;
}
console.log(`(1) audit rows ${await db.prepare("SELECT COUNT(*) n FROM audit_log").first("n")}, pages ${page}, worst rows_read ${worst} (cap ${CAP}), all <= cap: ${worst<=CAP}, extra queries: ${extra}`);
console.log(`(1) status tally (single row only): ${JSON.stringify(tally)}`);
const pg=await db.prepare(AQ("WHERE a.seq<?")).bind(301).all();
console.log(`(1) page of 'create' rows of later-deleted records: rows_read ${pg.meta.rows_read}, statuses ${JSON.stringify([...new Set(pg.results.slice(0,PAGE).map(status))])}`);

// ---------- (2) R15-2  (stub of the two export modes)
const T_B4=1000, T_C3=2000, NOW=2100, EXP=1e9;
const site=[{id:pad("S",1),created:500,exp:EXP},{id:pad("S",2),created:600,exp:EXP},{id:pad("S",3),created:1500,exp:EXP}];
const sinceObjects=site.filter(s=>s.created>T_B4);           // --since downloads only new share objects
const sharesJson=site.map(s=>({id:s.id,created:s.created,exp:s.exp,user:"u",bytes:1})); // every export also lists all keys + metadata
const E_old=new Set(sinceObjects.filter(s=>s.exp>T_C3).map(s=>s.id));
const E=new Set(sharesJson.filter(s=>s.exp>T_C3).map(s=>s.id));
console.log(`(2) E from --since objects only: {${[...E_old].map(x=>x.slice(-2))}} ; E from shares.json: {${[...E].map(x=>x.slice(-2))}}`);

// ---------- (3) R15-3
const sh=(id,created)=>db.prepare("INSERT INTO shares(id,user,name,created,exp) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING").bind(id,"u","n",created,EXP);
await db.exec("DELETE FROM shares");
const A=pad("A",1), CF=pad("C",1), X=pad("X",1), ST=pad("T",1);   // A in E; CF created on Cloudflare; X excluded after import; ST imported, gone from last export
await run([sh(A,10),sh(X,11),sh(ST,12),sh(CF,1500)]);
await run([ins("tester","share_create","share",CF,JSON.stringify({name:"TEST"}),null)]);
// tool: X newly hit by --exclude-share -> one batch: delete shares row + exclude:share row (then delete the R2 object)
const wx=await run([db.prepare("DELETE FROM shares WHERE id=?").bind(X), ins("migration","migrate_exclude","share",X,JSON.stringify({opt:"--exclude-share "+X.slice(0,6)}),"exclude:share:"+X.slice(0,6))]);
console.log(`(3) exclude-after-import batch rows_written (local count): ${wx} (DELETE shares 1 + audit_log migration row 4; quota estimate 4 + 4 = 8)`);
const E3=new Set([A]);
const gateSQL="SELECT s.id FROM shares s WHERE s.revoked_at IS NULL AND s.exp > ? AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.target_id = s.id AND a.action = 'share_create' AND a.src_key IS NULL)";
const g1=await db.prepare(gateSQL).bind(NOW).all();
const stale1=g1.results.map(r=>r.id).filter(id=>!E3.has(id));
const cls=id=>E3.has(id)?"pass (in E)":(id===CF?"Cloudflare self-created":"stale live -> owner revokes");
const live=(await db.prepare("SELECT id FROM shares ORDER BY id").all()).results.map(r=>r.id);
console.log(`(3) shares rows: ${live.map(id=>id.slice(-2)+"="+cls(id)).join("; ")}; X present: ${live.includes(X)}`);
console.log(`(3) C5 gate stale live shares before owner revoke: ${stale1.length} (gate query rows_read ${g1.meta.rows_read})`);
await db.prepare("UPDATE shares SET revoked_at=?, revoked_by=? WHERE id=?").bind(NOW,"owner",ST).run();
const g2=await db.prepare(gateSQL).bind(NOW).all();
console.log(`(3) C5 gate after owner revokes ${ST.slice(-2)}: ${g2.results.map(r=>r.id).filter(id=>!E3.has(id)).length}`);
// if target_id held only the 6-char prefix, the self-created share would be misclassified as stale
await db.prepare("UPDATE audit_log SET target_id=? WHERE action='share_create' AND target_id=?").bind(CF.slice(0,6),CF).run();
const g3=await db.prepare(gateSQL).bind(NOW).all();
console.log(`(3) with 6-char target_id the gate would report ${g3.results.map(r=>r.id).filter(id=>!E3.has(id)).length} stale (self-created misclassified)`);
await mf.dispose();
