// Round 6 independent re-simulation of spec v1.4 §6.1 verdict (own generator + own verdict code; B core only for analyze/detectIssues)
const {loadCore,baseState}=require('/workspace/spc/full/B/tests/_load.js');const c=loadCore();
const NB=+process.argv[2]||25, S0=+process.argv[3]||1, S1=+process.argv[4]||200, SHIFT=+(process.argv[5]||0), STROKE=process.argv[6]!=="nostroke";
const pads=c.sampleData({variant:"A"}).filter(r=>r.board==="B01").map(({board,stroke,height,area,volume,offx,offy,hpct,...p})=>p);
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function gen(seed){const u=mulberry32(seed);let spare=null;const n=()=>{if(spare!==null){const s=spare;spare=null;return s}let a,b;do{a=u()}while(a===0);b=u();const r=Math.sqrt(-2*Math.log(a));spare=r*Math.sin(2*Math.PI*b);return r*Math.cos(2*Math.PI*b)};
 const rows=[];for(let b=1;b<=NB;b++){const eh=n()*1,ea=n()*1,ex=n()*2,ey=n()*2;const sh=b>NB-8?SHIFT:0;
  for(const p of pads){const h=120+eh+3.5*n(),a=100+ea+sh+4*n(),v=h/120*a*(1+0.025*n());
   const r={...p,board:"B"+String(b).padStart(2,"0"),height:+h.toFixed(1),area:+a.toFixed(1),volume:+v.toFixed(1),offx:+(ex+10*n()).toFixed(1),offy:+(ey+10*n()).toFixed(1)};
   if(STROKE)r.stroke=b%2?"前":"後";else delete r.stroke;rows.push(r)}}return rows}
function invPhi(p){const a=[-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924],b=[-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857],cc=[-0.00778489400243029,-0.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878],d=[0.00778469570904146,0.32246712907004,2.445134137143,3.75440866190742];const q=Math.sqrt(-2*Math.log(p));return -(((((cc[0]*q+cc[1])*q+cc[2])*q+cc[3])*q+cc[4])*q+cc[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)}
const MS=["volume","hpct","area","offx","offy"];const zfw=invPhi(0.05/(2*MS.length*NB));
const T={};const inc=k=>T[k]=(T[k]||0)+1;const catsW={};let N=0;const seedRes=[];
for(let s=S0;s<=S1;s++){N++;const rows=gen(s);
 const st=baseState(c,{rows,metrics:["volume","height","area","offx","offy"],metric:"volume",group:"ALL",chart:"xbars",specSrc:"custom"});
 const L=(x=>x.issues||x)(c.detectIssues(st));
 // D-61: stroke card without direction field -> info
 const lv=i=>(i.cat==="刮刀方向"&&!STROKE)?"info":i.lv;
 let ng=L.some(i=>lv(i)==="ng"),warn=L.some(i=>lv(i)==="warn");L.filter(i=>lv(i)!=="info").forEach(i=>{catsW[i.lv+" "+i.cat]=(catsW[i.lv+" "+i.cat]||0)+1});
 let worst={cpk:9},r1ng=false,r1w=false,r1any=false,r28=false,iso=0,adW=false;const capByM={};
 for(const k of MS){const A=c.analyze({...st,metric:k});const gs=A.cap.groups&&A.cap.groups.length?A.cap.groups:[A.cap];
  let wm=9,wg=null;for(const g of gs)if(isFinite(g.cpk)&&g.cpk<wm){wm=g.cpk;wg=g.g}capByM[k]=wm;if(wm<worst.cpk)worst={cpk:wm,k,g:wg};
  const pts=A.xs.pts;const R=A.nelX.rules.filter(r=>r.idx.length&&r.id!==7);
  for(const r of R){if(r.id!==1){r28=true;continue}r1any=true;
   for(const i of r.idx){const b=pts[i].lab;const oos=A.rows.some(x=>x.board===b&&(x[k]<A.sp.lsl||x[k]>A.sp.usl));
    if(oos||wm<1.33)r1ng=true;else if(Math.abs(pts[i].z)>=zfw)r1w=true}}
  // D-30 candidate screen (upper bound: ignores (a)(b)(c) exclusions)
  const byG={};for(const x of A.rows){if(x[k]==null)continue;(byG[x.group]=byG[x.group]||[]).push(x[k])}
  for(const g in byG){const v=byG[g].slice().sort((a,b)=>a-b);if(v.length<10)continue;const med=v[v.length>>1]*(v.length%2)+((v.length%2)?0:(v[v.length/2-1]+v[v.length/2])/2);
   const ad=v.map(x=>Math.abs(x-med)).sort((a,b)=>a-b);const mad=ad.length%2?ad[ad.length>>1]:(ad[ad.length/2-1]+ad[ad.length/2])/2;
   let res=Infinity;for(let j=1;j<v.length;j++){const d=v[j]-v[j-1];if(d>1e-9&&d<res)res=d}
   const sg=Math.max(1.4826*mad,res/Math.sqrt(12));const sp=A.sp;const eff=Math.max(0.1*(sp.usl-sp.lsl),3*res);
   for(const x of v){if(x<sp.lsl||x>sp.usl||(Math.abs(x-med)/sg>=5&&Math.abs(x-med)>=eff))iso++}}}
 // AD clause within worst group
 if(worst.cpk>=1.0&&worst.cpk<1.67){const A=c.analyze({...st,metric:worst.k});const v=A.rows.filter(x=>x.group===worst.g).map(x=>x[worst.k]);const ad=c.andersonDarling(v);const p=ad&&(ad.p!=null?ad.p:ad.pv);if(p<0.05)adW=true;inc("cpk<1.67")}
 const capNg=worst.cpk<1.0,capW=worst.cpk<1.33;
 const v14= (ng||capNg||r1ng)?"異常":(warn||capW||r1w||adW||iso>0)?"警示":"正常";
 inc("v14_"+v14);if(r1any)inc("anyR1");if(r1w)inc("r1_fw_warn");if(r1ng)inc("r1_corrob_ng");if(r28)inc("anyR28");if(iso)inc("iso_candidates>0");if(adW)inc("ad_warn");
 if(ng)inc("B_ng");if(warn)inc("B_warn");seedRes.push(v14[0]);
}
require("fs").writeFileSync(`/workspace/spc/r6merge/perseed_${NB}_${S0}_${S1}_${SHIFT}.txt`,seedRes.join(""));console.log(JSON.stringify({NB,seeds:[S0,S1],SHIFT,STROKE,zfw:+zfw.toFixed(3),N,rate:Object.fromEntries(Object.entries(T).sort().map(([k,v])=>[k,+(v/N).toFixed(4)])),catsW,seed1:seedRes[0]}));
