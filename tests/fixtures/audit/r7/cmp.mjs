import {gen7,toCSV} from './gen7.mjs';import {createRequire} from 'module';const require=createRequire(import.meta.url);
// extract reference gen() from r6/sim6.js
const fs=require('fs');const src=fs.readFileSync('/workspace/spc/r6/sim6.js','utf8');
const {loadCore}=require('/workspace/spc/full/B/tests/_load.js');const c=loadCore();
const gsrc=src.split('\n').filter(l=>/^function mulberry32|^function gen|^ const rows|^  for\(const p|^   const r=|^   if\(STROKE/.test(l)).join('\n');
function mkRef(NB,SHIFT){const STROKE=true;const pads=c.sampleData({variant:"A"}).filter(r=>r.board==="B01").map(({board,stroke,height,area,volume,offx,offy,hpct,...p})=>p);
  return new Function('NB','SHIFT','STROKE','pads',gsrc+'\nreturn gen;')(NB,SHIFT,STROKE,pads)}
let diff=0,tot=0;
for(const [NB,SH] of [[25,0],[50,0],[25,3],[50,3]]){const ref=mkRef(NB,SH);
 for(let s=1;s<=200;s++){const A=gen7(s,NB,SH),B=ref(s);tot++;
  const ka=JSON.stringify(A.map(r=>Object.keys(r).sort().map(k=>[k,r[k]])));const kb=JSON.stringify(B.map(r=>Object.keys(r).sort().map(k=>[k,r[k]])));if(ka!==kb){diff++;if(diff<3)console.log("diff",NB,SH,s)}}}
console.log({tot,diff});
// CSV round trip with current B parser (pre D-40) and with group alias simulated
const rows=gen7(1,25,0);const csv=toCSV(rows);fs.writeFileSync('/workspace/spc/r7/stable-25-seed1.csv',csv);
const P=c.parseCSV(csv);const r0=P.rows[0];console.log("imported keys",Object.keys(r0),r0);
console.log("template row",rows[0]);
const bga=P.rows.find(r=>r.pad==="U2-A1");console.log("BGA imported shape",bga.shape,"group",bga.group,"comp",bga.comp);
