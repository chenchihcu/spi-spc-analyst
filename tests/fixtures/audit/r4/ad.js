const fs=require('fs');const {c,baseState}=require('../r3/ld.js');
function run(rows,label,metrics){const st=baseState(c,{rows,metrics,metric:'volume',group:'ALL',chart:'xbars',specSrc:'custom'});st.specs.volume={lsl:70,usl:130,tgt:100};const A=c.analyze(st);
console.log(label,'ad',JSON.stringify(A.ad||A.norm||null).slice(0,200),'cpk',A.cap&&A.cap.cpk,'nelX rules',(A.nelX||A.nel).rules.filter(r=>r.idx.length).map(r=>r.id+':'+r.idx.join(',')));
 return A}
const R=c.parseCSV(fs.readFileSync('audit3/testdata/TEST-第三輪-01_groups.csv','utf8').replace('元件群組','封裝'));
const A=run(R.rows,'TV19',R.metrics);console.log(Object.keys(A).join(' '));
const R2=c.parseCSV(fs.readFileSync('audit1/testdata/synthetic_test01.csv','utf8').replace('元件群組','封裝'));run(R2.rows,'TV17',R2.metrics);
run(c.sampleData(),'sample',["volume","height","area","offx","offy"]);
