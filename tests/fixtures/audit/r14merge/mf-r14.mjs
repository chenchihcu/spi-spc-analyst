// spec v1.13 round-14 merge: Miniflare local D1 checks (npm i miniflare; node <file>).
// (1) R14-1: full-import vs clearing rows_written for the B4 ③ example (5,000 records, 6,000 migrated log rows, 200 shares).
// (2)/(3) R14-2: audit page list (mixed targets; all targets live) (audit_log LEFT JOIN records, ORDER BY seq DESC, keyset seq<?) rows_read and EXPLAIN QUERY PLAN.
import { Miniflare } from "miniflare";
const mf = new Miniflare({ modules:true, script:"export default {fetch(){return new Response('x')}}", d1Databases:{DB:"r14m"} });
const db = await mf.getD1Database("DB");
const schema = [
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
 "CREATE INDEX shares_exp ON shares(exp)",
];
for (const s of schema) await db.exec(s);
const sumW = rs => rs.reduce((a,r)=>a+r.meta.rows_written,0);
const batched = async stmts => { let w=0; for (let i=0;i<stmts.length;i+=500) w += sumW(await db.batch(stmts.slice(i,i+500))); return w; };
const pad = (p,i,n=22) => (p+String(i)).padStart(n,"0").slice(-n);

// ---------- (1) R14-1
const R=5000, L=6000, S=200;
const wR = await batched(Array.from({length:R},(_,i)=>db.prepare("INSERT INTO records(id,kind,lot,created,sha256,name,user) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING").bind(pad("r",i),"meas","L"+i,1000+i,"h"+i,"n","u")));
const wL = await batched(Array.from({length:L},(_,i)=>db.prepare("INSERT INTO audit_log(at,by,action,target_type,target_id,src_key) VALUES(?,?,?,?,?,?) ON CONFLICT(src_key) WHERE src_key IS NOT NULL DO NOTHING").bind(1000+i,"u","create","record",pad("r",i%R),"log/"+i)));
const wS = await batched(Array.from({length:S},(_,i)=>db.prepare("INSERT INTO shares(id,user,name,created,exp) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING").bind("s"+i,"u","n",i,i+1e9)));
const imp = wR+wL+wS;
console.log(`(1) import rows_written: records ${wR} (${wR/R}/row), audit_log ${wL} (${wL/L}/row), shares ${wS} (${wS/S}/row), total ${imp}`);
const dR = (await db.prepare("DELETE FROM records").run()).meta;
const dL = (await db.prepare("DELETE FROM audit_log").run()).meta;
const dS = (await db.prepare("DELETE FROM shares").run()).meta;
const clrMeasured = dR.rows_written+dL.rows_written+dS.rows_written;
const clrConservative = R*5 + L*4 + S*4;
console.log(`(1) clear (DELETE all) measured rows_written: records ${dR.rows_written}, audit_log ${dL.rows_written}, shares ${dS.rows_written}, total ${clrMeasured}; changes ${dR.changes+dL.changes+dS.changes}`);
console.log(`(1) quota estimate (DELETE at INSERT per-row counts 5/4/4): clear ${clrConservative}; clear+import ${clrConservative+imp} (> 80,000 -> must choose (ii): ${clrConservative+imp>80000})`);
console.log(`(1) local-count estimate (DELETE 1/row): clear+import ${clrMeasured+imp} (would wrongly allow (i): ${clrMeasured+imp<=80000})`);

// ---------- (2) R14-2  audit page: 3,000 records, 600 audit rows (record targets, some deleted; share targets)
await batched(Array.from({length:3000},(_,i)=>db.prepare("INSERT INTO records(id,kind,lot,created,sha256) VALUES(?,?,?,?,?)").bind(pad("r",i),"meas","L"+i,1000+i,"h"+i)));
await batched(Array.from({length:600},(_,i)=>{
  const share = i%7===0, gone = i%11===0;
  const tid = share ? "s"+i : (gone ? pad("x",i) : pad("r",(i*5)%3000));
  return db.prepare("INSERT INTO audit_log(at,by,action,target_type,target_id) VALUES(?,?,?,?,?)").bind(2000+Math.floor(i/3),"u",share?"share_create":"create",share?"share":"record",tid);
}));
const PAGE=50, LIM=PAGE+1, CAP=2*(PAGE+2);
const AQ = (w) => `SELECT a.seq,a.at,a.by,a.action,a.target_type,a.target_id,a.detail, r.id AS live FROM audit_log a LEFT JOIN records r ON r.id=a.target_id ${w} ORDER BY a.seq DESC LIMIT ${LIM}`;
const plan = async (sql,...b)=> (await db.prepare("EXPLAIN QUERY PLAN "+sql).bind(...b).all()).results.map(x=>x.detail);
async function pages(tag){
  let cursor=null, page=0, worst=0, ok=true;
  while (true) {
    page++;
    const sql = cursor===null ? AQ("") : AQ("WHERE a.seq<?");
    const b = cursor===null ? [] : [cursor];
    const r = await db.prepare(sql).bind(...b).all();
    const more = r.results.length>PAGE, rows = r.results.slice(0,PAGE);
    worst = Math.max(worst, r.meta.rows_read); if (r.meta.rows_read > CAP) ok=false;
    if (page<=2 || !more) console.log(`${tag} audit page ${page}: rows_read ${r.meta.rows_read} (cap ${CAP}), returned ${rows.length}, plan ${JSON.stringify(await plan(sql,...b))}`);
    if (!more) break;
    cursor = rows[rows.length-1].seq;
  }
  console.log(`${tag} pages ${page}, worst rows_read ${worst}, all <= ${CAP}: ${ok}`);
}
await pages("(2) mixed targets:");
// (3) worst case: every target still exists in records
await db.exec("DELETE FROM audit_log");
await batched(Array.from({length:600},(_,i)=>db.prepare("INSERT INTO audit_log(at,by,action,target_type,target_id) VALUES(?,?,?,?,?)").bind(3000+i,"u","create","record",pad("r",(i*5)%3000))));
await pages("(3) all targets live:");
await mf.dispose();
