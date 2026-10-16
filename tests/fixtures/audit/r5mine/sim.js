// 穩定製程模擬：B 現行 detectIssues + Nelson（每個判定項目 X̄）+ 各種整體判定方案的誤報率
const {loadCore,baseState}=require('/workspace/spc/full/B/tests/_load.js');const c=loadCore();
const NB=+process.argv[2]||25, N=+process.argv[3]||300, SB=+(process.argv[4]||1.0);
const base=c.sampleData({variant:"A"}).filter(r=>r.board==="B01");
function mul(seed){let a=seed>>>0;return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function gen(seed){const r=mul(seed),g=()=>{let u=0,v=0;while(!u)u=r();v=r();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v)};const rows=[];
 for(let b=1;b<=NB;b++){const bh=g()*SB,ba=g()*SB,bx=g()*SB*2,by=g()*SB*2;
  for(const p of base){const hMu=120,aMu=100;
   const h=hMu+bh+g()*3.5,a=aMu+ba+g()*4.0,vol=(h/120)*a*(1+g()*0.025);
   rows.push({...p,board:"B"+String(b).padStart(2,"0"),stroke:b%2?"前":"後",height:+h.toFixed(1),area:+a.toFixed(1),volume:+vol.toFixed(1),offx:+(bx+g()*10).toFixed(1),offy:+(by+g()*10).toFixed(1)})}}
 return rows}
const MS=["volume","hpct","area","offx","offy"];
const tally={};const inc=(k,v=1)=>tally[k]=(tally[k]||0)+v;const cats={};
for(let s=1;s<=N;s++){const rows=gen(s*7919+NB);
 const st=baseState(c,{rows,metrics:["volume","height","area","offx","offy"],metric:"volume",group:"ALL",chart:"xbars",specSrc:"custom"});
 const F=c.detectIssues(st);const L=F.issues||F;
 const ng=L.some(i=>i.lv==="ng"),warn=L.some(i=>i.lv==="warn");
 L.filter(i=>i.lv!=="info").forEach(i=>{cats[i.lv+" "+i.cat]=(cats[i.lv+" "+i.cat]||0)+1});
 let worst=9,r1=false,r1oos=false,r28=false,r28multi=false,r1fw=false,maxz=0;const zfw=Math.abs(qn(0.05/(2*MS.length*NB)));
 for(const k of MS){const A=c.analyze({...st,metric:k});
  const gs=A.cap&&(A.cap.groups&&A.cap.groups.length?A.cap.groups:[A.cap]);if(gs)for(const x of gs)if(isFinite(x.cpk))worst=Math.min(worst,x.cpk);
  const R=A.nelX.rules.filter(x=>x.idx.length&&x.id!==7);const ids=R.map(x=>x.id);
  const z=A.xs.pts.map(p=>Math.abs(p.z));const mz=Math.max(...z);maxz=Math.max(maxz,mz);
  if(ids.includes(1)){r1=true;const cpk=A.cap?A.cap.cpk:9;const oos=A.rows.some(r=>r[k]<A.sp.lsl||r[k]>A.sp.usl);if(oos||cpk<1.33)r1oos=true;if(mz>zfw)r1fw=true}
  const o=ids.filter(i=>i!==1);if(o.length)r28=true;if(new Set(o).size>=2)r28multi=true}
 const capNg=worst<1.0,capW=worst<1.33;
 const v13= ng||capNg||r1?"異常":(warn||capW||r28)?"警示":"正常";
 const vNew= ng||capNg||r1oos?"異常":(warn||capW||r1fw)?"警示":"正常";   // 本 spec 設計：規則 1 需超規/Cpk<1.33 或族系校正門檻；規則 2–8 只作資訊
 const vR5 = ng||capNg||r1oos?"異常":(warn||capW||r1||r28multi)?"警示":"正常"; // 複查者方案
 const vBonly= ng||capNg?"異常":(warn||capW)?"警示":"正常";
 inc("v13_"+v13);inc("vNew_"+vNew);inc("vR5_"+vR5);inc("vB_"+vBonly);if(r1)inc("anyR1");if(r28)inc("anyR28");if(r28multi)inc("r28multi");if(r1fw)inc("r1fw");if(worst<1.33)inc("cpk<1.33");
}
function qn(p){// inverse normal (Acklam)
 const a=[-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924],b=[-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857],cc=[-0.00778489400243029,-0.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878],d=[0.00778469570904146,0.32246712907004,2.445134137143,3.75440866190742];
 const q=Math.sqrt(-2*Math.log(p));return (((((cc[0]*q+cc[1])*q+cc[2])*q+cc[3])*q+cc[4])*q+cc[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)}
console.log(JSON.stringify({NB,N,SB,zfw:Math.abs(qn(0.05/(2*5*NB))).toFixed(3),rate:Object.fromEntries(Object.entries(tally).sort().map(([k,v])=>[k,+(v/N).toFixed(3)])),cats}));
