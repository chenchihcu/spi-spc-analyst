const {loadCore,baseState}=require('/workspace/spc/full/B/tests/_load.js');const c=loadCore();
const src=require('fs').readFileSync('sim6.js','utf8');
const NB=+process.argv[2]||25;
const pads=c.sampleData({variant:"A"}).filter(r=>r.board==="B01").map(({board,stroke,height,area,volume,offx,offy,hpct,...p})=>p);
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function gen(seed){const u=mulberry32(seed);let spare=null;const n=()=>{if(spare!==null){const s=spare;spare=null;return s}let a,b;do{a=u()}while(a===0);b=u();const r=Math.sqrt(-2*Math.log(a));spare=r*Math.sin(2*Math.PI*b);return r*Math.cos(2*Math.PI*b)};
 const rows=[];for(let b=1;b<=NB;b++){const eh=n()*1,ea=n()*1,ex=n()*2,ey=n()*2;
  for(const p of pads){const h=120+eh+3.5*n(),a=100+ea+4*n(),v=h/120*a*(1+0.025*n());
   rows.push({...p,board:"B"+String(b).padStart(2,"0"),stroke:b%2?"前":"後",height:+h.toFixed(1),area:+a.toFixed(1),volume:+v.toFixed(1),offx:+(ex+10*n()).toFixed(1),offy:+(ey+10*n()).toFixed(1)})}}return rows}
const MS=["volume","hpct","area","offx","offy"];const out=[];
for(let s=1;s<=200;s++){const rows=gen(s);const st=baseState(c,{rows,metrics:["volume","height","area","offx","offy"],metric:"volume",group:"ALL",chart:"xbars",specSrc:"custom"});
 for(const k of MS){const A=c.analyze({...st,metric:k});const byG={};for(const x of A.rows){if(x[k]==null)continue;(byG[x.group]=byG[x.group]||[]).push(x)}
  for(const g in byG){const v=byG[g].map(x=>x[k]).sort((a,b)=>a-b);const m=v.length;const med=m%2?v[m>>1]:(v[m/2-1]+v[m/2])/2;const ad=v.map(x=>Math.abs(x-med)).sort((a,b)=>a-b);const mad=m%2?ad[m>>1]:(ad[m/2-1]+ad[m/2])/2;
   let res=Infinity;for(let j=1;j<m;j++){const d=v[j]-v[j-1];if(d>1e-9&&d<res)res=d}const sg=Math.max(1.4826*mad,res/Math.sqrt(12));const sp=A.sp;
   for(const x of byG[g]){const y=x[k],z=(y-med)/sg;const oos=y<sp.lsl||y>sp.usl;if(oos||Math.abs(z)>=5&&Math.abs(y-med)>=Math.max(.1*(sp.usl-sp.lsl),3*res))out.push({s,k,g,b:x.board,pad:x.pad,y,z:+z.toFixed(2),oos,lsl:sp.lsl,usl:sp.usl,n:m})}}}}
console.log(JSON.stringify(out));
