const {loadCore,baseState}=require('/workspace/spc/full/B/tests/_load.js');const c=loadCore();const fs=require('fs');
for(const f of ['/workspace/spc/audit3/testdata/TEST-第三輪-PHME_small.csv','/workspace/spc/r7merge/TEST-第七輪-PHME_NG.csv','/tmp/ngok.csv']){
 const text=fs.readFileSync(f,'utf8');const tab=c.csvTable(text);const m=c.autoMap(tab.head);const R=c.buildRows(tab,m,c.guessOpts(tab.head,m),5);const rows=R.rows||R;
 const st=baseState(c,{rows,metrics:["volume","height","area","offx","offy"],metric:'volume',group:'ALL',chart:'xbars',specSrc:'machine'});
 const ms=c.machineSpecs(rows,st);
 console.log('\n==',f.split('/').pop(),'rows',rows.length,'boards',new Set(rows.map(r=>r.board)).size,'groups',[...new Set(rows.map(r=>r.group))].join('|'),'mNG',rows.filter(r=>r.mNG).length,'okN',ms.n);
 console.log('window vol',JSON.stringify(ms.specs.volume),'area',JSON.stringify(ms.specs.area),'groups',ms.groups&&Object.keys(ms.groups));
 st.specs=ms.specs;st.specsG=ms.groups;
 const cls=rows.map(r=>({r,k:c.classify(r,st.specs,st)}));
 for(const x of cls.filter(x=>x.r.result!=null&&x.r.mNG))console.log(' NG',x.r.board,x.r.pad,x.r.result,'vol',x.r.volume,'->',x.k.join(','));
 const sysCs=c.DEF_SPECS;const sys=r=>c.specClassify(r,sysCs,st).length>0;
 const rs=rows;const tt=rs.filter(r=>r.mNG&&sys(r)).length,tf=rs.filter(r=>r.mNG&&!sys(r)).length,ft=rs.filter(r=>!r.mNG&&sys(r)).length,ff=rs.length-tt-tf-ft;
 console.log(' vs DEF_SPECS: machineNG&sysNG',tt,'machineNG&sysOK',tf,'machineOK&sysNG',ft,'agree%',((tt+ff)/rs.length*100).toFixed(2));
}
