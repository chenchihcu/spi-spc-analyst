const {loadCore,baseState}=require('/workspace/spc/full/B/tests/_load.js');const c=loadCore();
const fs=require('fs');
for(const f of ['TEST-第三輪-01_groups.csv','TEST-第三輪-02_lone_extreme.csv']){
 const text=fs.readFileSync('/workspace/spc/audit3/testdata/'+f,'utf8');
 const tab=c.csvTable(text);const map=c.autoMap(tab.head);
 for(const mode of ['auto','mapped']){
  const m={...map};if(mode==='mapped')m.pkg=tab.head.indexOf('元件群組');
  const R=c.buildRows(tab,m,c.guessOpts(tab.head,m),5);const rows=R.rows||R;
  const st=baseState(c,{rows,metrics:R.metrics||["volume","height","area","offx","offy"],metric:'volume',group:'ALL',chart:'xbars',specSrc:'custom'});
  st.specs=st.specs||{};
  const A=c.analyze(st);
  const groups=[...new Set(rows.map(r=>r.group))];
  console.log('\n==',f,mode,'map.pkg=',map.pkg,'groups',groups.join('|'));
  console.log('spec',A.sp,'sigmaW',A.sigmaW, 'cap', JSON.stringify({cp:A.cap.cp,cpk:A.cap.cpk,pp:A.cap.pp,ppk:A.cap.ppk,sw:A.cap.sw,so:A.cap.so,mu:A.cap.mu}));
  const L=(x=>x.issues||x)(c.detectIssues(st));
  for(const i of L)console.log(' ',i.lv,i.cat,'|',i.title,'|',(i.facts||[]).join(' / ').slice(0,300));
 }
}
