const fs=require('fs');const {c,baseState}=require('../r3/ld.js');
function run(t,label){const R=c.parseCSV(t.replace('元件群組','封裝'));const st=baseState(c,{rows:R.rows,metrics:R.metrics,metric:'volume',group:'ALL',chart:'xbars',specSrc:'custom'});
 st.specs.volume={lsl:70,usl:130,tgt:100};
 const L=c.detectIssues(st);console.log('--',label,R.rows.length);(L.issues||L).forEach(i=>console.log(' ',i.lv,i.cat,i.title));}
let t=fs.readFileSync('audit3/testdata/TEST-第三輪-02_lone_extreme.csv','utf8');
run(t,'lone (U1-2=55)');
const lines=t.split('\n');
const rm=lines.filter(l=>!l.startsWith('B07,U1-2,'));run(rm.join('\n'),'removed U1-2');
// two extremes
const two=lines.map(l=>l.startsWith('B07,U1-3,')?l.replace(/^(B07,U1-3,U1 QFP,)[0-9.]+/,'$155.0'):l);run(two.join('\n'),'two extremes U1-2,U1-3');
run(two.filter(l=>!l.startsWith('B07,U1-2,')).join('\n'),'two, remove U1-2 only');
