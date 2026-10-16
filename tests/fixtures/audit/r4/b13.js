const {c,baseState}=require('../r3/ld.js');
const rows=c.sampleData();
const cand=new Set(['U2-A1','U2-A3','U2-A4','U2-B2','U2-C1','U2-C3','U2-C6','U2-D1','U2-D2','U2-D4','U2-D6','U2-E1','U2-E5','U2-E6']);
function go(rs,l){const st=baseState(c,{rows:rs,metrics:["volume","height","area","offx","offy"],metric:'volume',group:'ALL',chart:'xbars',specSrc:'custom'});const L=c.detectIssues(st);console.log(l,(L.issues||L).filter(i=>i.cat==='單板異常').map(i=>i.title))}
go(rows.filter(r=>!(r.board==='B13'&&cand.has(r.pad))),'joint removal (volume rows of 14 pads dropped entirely)');
go(rows.map(r=>(r.board==='B13'&&cand.has(r.pad))?{...r,volume:null}:r),'joint removal volume only');
const u2=rows.filter(r=>r.board==='B13'&&r.group==='U2 BGA');console.log('B13 U2 pads',u2.length);
