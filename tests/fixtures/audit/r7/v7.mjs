// Verdict per spec 6.1 (same logic as r6/sim6b.js) + record out-of-spec D-30 candidates & Poisson severity; compare rows vs CSV routes
import {gen7,toCSV} from './gen7.mjs';import {createRequire} from 'module';const require=createRequire(import.meta.url);
const {loadCore,baseState}=require('/workspace/spc/full/B/tests/_load.js');const c=loadCore();
const NB=+process.argv[2],S0=+process.argv[3],S1=+process.argv[4],SHIFT=+process.argv[5]||0,ROUTE=process.argv[6]||"rows";
const MS=["volume","hpct","area","offx","offy"];
function invPhi(p){const a=[-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924],b=[-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857],cc=[-0.00778489400243029,-0.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878],d=[0.00778469570904146,0.32246712907004,2.445134137143,3.75440866190742];const q=Math.sqrt(-2*Math.log(p));return -(((((cc[0]*q+cc[1])*q+cc[2])*q+cc[3])*q+cc[4])*q+cc[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)}
const zfw=invPhi(0.05/(2*MS.length*NB));
function poisSF(lam,k){let s=0,t=Math.exp(-lam);for(let i=0;i<k;i++){s+=t;t*=lam/(i+1)}return 1-s}
function rowsFor(s){const g=gen7(s,NB,SHIFT);if(ROUTE==="rows")return g;
  const tab=c.csvTable(toCSV(g));const map=c.autoMap(tab.head);map.pkg=tab.head.indexOf("元件群組"); // simulate D-40
  if(ROUTE==="csvcomp")map.comp=tab.head.indexOf("元件位號");
  return c.buildRows(tab,map,c.guessOpts(tab.head,map)).rows}
let out="",oosSeeds=[],cnt={};
for(let s=S0;s<=S1;s++){const rows=rowsFor(s);
 const st=baseState(c,{rows,metrics:["volume","height","area","offx","offy"],metric:"volume",group:"ALL",chart:"xbars",specSrc:"custom"});
 const L=(x=>x.issues||x)(c.detectIssues(st));
 let ng=L.some(i=>i.lv==="ng"),warn=L.some(i=>i.lv==="warn");
 let worst={cpk:9},r1ng=false,r1w=false,iso=0,isoOOS=0,isoOOSsev=0,adW=false;
 for(const k of MS){const A=c.analyze({...st,metric:k});const gs=A.cap.groups&&A.cap.groups.length?A.cap.groups:[A.cap];
  let wm=9,wg=null;for(const g of gs)if(isFinite(g.cpk)&&g.cpk<wm){wm=g.cpk;wg=g.g}if(wm<worst.cpk)worst={cpk:wm,k,g:wg};
  const pts=A.xs.pts;for(const r of A.nelX.rules.filter(r=>r.idx.length&&r.id!==7)){if(r.id!==1)continue;
   for(const i of r.idx){const b=pts[i].lab;const oos=A.rows.some(x=>x.board===b&&(x[k]<A.sp.lsl||x[k]>A.sp.usl));if(oos||wm<1.33)r1ng=true;else if(Math.abs(pts[i].z)>=zfw)r1w=true}}
  const byG={};for(const x of A.rows){if(x[k]==null)continue;(byG[x.group]=byG[x.group]||[]).push(x[k])}
  for(const g in byG){const v=byG[g].slice().sort((a,b)=>a-b);if(v.length<10)continue;const n=v.length;const med=n%2?v[n>>1]:(v[n/2-1]+v[n/2])/2;
   const ad=v.map(x=>Math.abs(x-med)).sort((a,b)=>a-b);const mad=n%2?ad[n>>1]:(ad[n/2-1]+ad[n/2])/2;
   let res=Infinity;for(let j=1;j<n;j++){const d=v[j]-v[j-1];if(d>1e-9&&d<res)res=d}
   const sg=Math.max(1.4826*mad,res/Math.sqrt(12));const sp=A.sp;const eff=Math.max(0.1*(sp.usl-sp.lsl),3*res);
   let k_oos=0;for(const x of v){const o=x<sp.lsl||x>sp.usl;if(o){k_oos++;isoOOS++}if(o||(Math.abs(x-med)/sg>=5&&Math.abs(x-med)>=eff))iso++}
   if(k_oos){const lam=n*(c.Phi((sp.lsl-med)/sg)+1-c.Phi((sp.usl-med)/sg));if(poisSF(lam,k_oos)<0.01)isoOOSsev++}}}
 if(worst.cpk>=1.0&&worst.cpk<1.67){const A=c.analyze({...st,metric:worst.k});const v=A.rows.filter(x=>x.group===worst.g).map(x=>x[worst.k]);const ad=c.andersonDarling(v);const p=ad&&(ad.p!=null?ad.p:ad.pv);if(p<0.05)adW=true}
 const ver=(ng||worst.cpk<1||r1ng)?"異":(warn||worst.cpk<1.33||r1w||adW||iso>0)?"警":"正";
 const ver15=(ng||worst.cpk<1||r1ng||isoOOSsev>0)?"異":ver; // with R6-5 Poisson severe
 out+=ver; if(isoOOS)oosSeeds.push([s,isoOOS,isoOOSsev,ver,ver15]);
 const groups=new Set(rows.map(r=>r.group)).size; cnt.groups=groups;
}
console.log(JSON.stringify({NB,SHIFT,ROUTE,S0,S1,out,counts:[...out].reduce((m,ch)=>(m[ch]=(m[ch]||0)+1,m),{}),oosSeeds,groups:cnt.groups}));
