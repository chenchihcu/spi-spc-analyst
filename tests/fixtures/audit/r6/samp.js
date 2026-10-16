const {loadCore,baseState}=require('/workspace/spc/full/B/tests/_load.js');const c=loadCore();
const rows=c.sampleData({variant:"A"});const st=baseState(c,{rows,metrics:["volume","height","area","offx","offy"],metric:"volume",group:"ALL",chart:"xbars",specSrc:"custom"});
for(const k of ["volume","hpct","area","offx","offy"]){const A=c.analyze({...st,metric:k});const byG={};for(const x of A.rows){if(x[k]==null)continue;(byG[x.group]=byG[x.group]||[]).push(x)}
 for(const g in byG){const v=byG[g].map(x=>x[k]).sort((a,b)=>a-b),m=v.length,med=m%2?v[m>>1]:(v[m/2-1]+v[m/2])/2,ad=v.map(x=>Math.abs(x-med)).sort((a,b)=>a-b),mad=m%2?ad[m>>1]:(ad[m/2-1]+ad[m/2])/2;let res=1/0;for(let j=1;j<m;j++){const d=v[j]-v[j-1];if(d>1e-9&&d<res)res=d}
  const sg=Math.max(1.4826*mad,res/Math.sqrt(12)),sp=A.sp,eff=Math.max(.1*(sp.usl-sp.lsl),3*res);let oos=0,zonly=[],zsmall=0;
  for(const x of byG[g]){const y=x[k],z=(y-med)/sg,o=y<sp.lsl||y>sp.usl;if(o)oos++;else if(Math.abs(z)>=5){if(Math.abs(y-med)>=eff)zonly.push(`${x.board}/${x.pad}=${y}(z${z.toFixed(2)})`);else zsmall++}}
  console.log(k,g,"n",m,"med",med,"sig",sg.toFixed(3),"OOS",oos,"zOnlyCand",zonly.join(" "),"z>=5 but below effect floor",zsmall)}}
