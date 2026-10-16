const {loadCore,baseState}=require('/workspace/spc/full/B/tests/_load.js');const c=loadCore();const fs=require('fs');
for(const f of ['TEST-第七輪-02_refdes.csv','TEST-第七輪-03_mm.csv']){
 const text=fs.readFileSync('/workspace/spc/audit7/'+f,'utf8');const tab=c.csvTable(text);
 for(const mode of ['auto','comp→pad mapped']){
  const m={...c.autoMap(tab.head)};m.pkg=tab.head.indexOf('元件群組');if(mode!=='auto'&&f.includes('02'))m.pad=tab.head.indexOf('元件位號');
  const R=c.buildRows(tab,m,c.guessOpts(tab.head,m),5);const rows=R.rows||R;
  const st=baseState(c,{rows,metrics:R.metrics||["volume","height","area","offx","offy"],metric:'volume',group:'ALL',chart:'xbars',specSrc:'custom'});
  const L=(x=>x.issues||x)(c.detectIssues(st));
  console.log('\n==',f,mode,'pads',new Set(rows.map(r=>r.pad)).size,'groups',[...new Set(rows.map(r=>r.group))].join('|'));
  for(const i of L)console.log(' ',i.lv,'|',i.title,'|',(i.facts||[]).join(' / ').slice(0,200));
 }}
