const {loadCore,baseState}=require('/workspace/spc/full/B/tests/_load.js');const c=loadCore();const fs=require('fs');
const text=fs.readFileSync('/workspace/spc/audit8/TEST-第八輪-01_PHME_NG.csv','utf8');
const tab=c.csvTable(text);const m=c.autoMap(tab.head);const R=c.buildRows(tab,m,c.guessOpts(tab.head,m),5);const rows=R.rows||R;
const st=baseState(c,{rows,metrics:["volume","height","hpct","area","offx","offy"],metric:'hpct',group:'ALL',chart:'xbars',specSrc:'machine'});
st.step={on:false,zones:[{id:1,name:"BGA 減薄區",mode:"group",group:"C",x0:0,y0:0,x1:1,y1:1,t:100}]};
let ms=c.machineSpecs(rows,st);st.specs=ms.specs;st.specsG=ms.groups;
console.log('groups',[...new Set(rows.map(r=>r.group))],'specsG keys',ms.groups&&Object.keys(ms.groups),'nC',rows.filter(r=>r.group==='C').length);
console.log('hpct spec all',JSON.stringify(ms.specs.hpct),'height',JSON.stringify(ms.specs.height));
function rep(tag){const A=c.analyze(st);const cap=A.cap;const G=(cap&&cap.groups)||[];
 const cg=G.find?G.find(x=>x.g==='C'):null;
 console.log(tag,'worst',cap&&cap.worst,'cpk',cap&&cap.cpk.toFixed(4),'ppk',cap&&cap.ppk.toFixed(4));
 if(cg)console.log('  C: mu',cg.mu.toFixed(2),'lsl',cg.lsl,'usl',cg.usl,'cpk',cg.cpk.toFixed(4),'ppk',cg.ppk.toFixed(4),'ppmObs',cg.ppmObs);
 else console.log('  cap keys',cap&&Object.keys(cap));
 return A}
rep('OFF');
st.step.on=true;rep('ON (current: no machineSpecs rerun)');
ms=c.machineSpecs(rows,st);st.specs=ms.specs;st.specsG=ms.groups;console.log('rerun hpct spec',JSON.stringify(ms.specs.hpct));
rep('ON (machineSpecs rerun)');
function iss(tag){const A=c.analyze(st);const F=c.detectIssues(st,A);const L=(F.issues||F);console.log(tag,'issues',L.length, L.filter(x=>/高度%厚|hpct/.test(JSON.stringify(x.title||x.t||x))).map(x=>(x.lv||x.level)+' '+(x.title||x.t)).join(' | '))}
st.step.on=false;ms=c.machineSpecs(rows,st);st.specs=ms.specs;st.specsG=ms.groups;iss('OFF');
st.step.on=true;iss('ON-current');
ms=c.machineSpecs(rows,st);st.specs=ms.specs;st.specsG=ms.groups;iss('ON-rerun');
