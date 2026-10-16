const {loadCore,baseState}=require('/workspace/spc/full/B/tests/_load.js');const c=loadCore();
const rows=c.sampleData();const st=baseState(c,{rows,metrics:["volume","height","area","offx","offy"],metric:"volume",group:"ALL",chart:"xbars",specSrc:"custom"});
const A=c.analyze(st);const g=A.cap.groups.find(x=>x.g==="U2 BGA");console.log("cap U2",g.cpk,g.ppk);
const L=(x=>x.issues||x)(c.detectIssues(st));L.filter(i=>i.cat==="系統性能力").forEach(i=>console.log(i.lv,i.title,i.facts[0]));
console.log(L.length, L.map(i=>i.lv+":"+i.cat+":"+i.title).join("\n"));
