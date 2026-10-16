const {c,baseState}=require('../r3/ld.js');
const rows=c.sampleData();
const st=baseState(c,{rows,metrics:["volume","height","area","offx","offy"],metric:'volume',group:'ALL',chart:'xbars',specSrc:'custom'});
const F=c.detectIssues(st);const L=F.issues||F;
L.forEach(i=>console.log(i.id,i.lv,i.cat,'|',i.title,'|',JSON.stringify(i.sig)));
const sp=st.specs.volume;console.log('spec',sp);
const med=a=>{a=[...a].sort((x,y)=>x-y);const n=a.length;return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2};
const groups=[...new Set(rows.map(r=>r.group))];
const out=[];
for(const g of groups){const v=rows.filter(r=>r.group===g&&r.volume!=null);const m=med(v.map(r=>r.volume));const mad=med(v.map(r=>Math.abs(r.volume-m)));
 v.forEach(r=>{const z=(r.volume-m)/(1.4826*mad);const oos=r.volume<sp.lsl||r.volume>sp.usl;if(oos||Math.abs(z)>=5)out.push([r.board,g,r.pad,r.volume,z.toFixed(2),oos])});
 console.log('grp',g,v.length,m,mad)}
console.log(out.length);out.forEach(o=>console.log(o.join(' ')));
