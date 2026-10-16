const fs=require('fs'),vm=require('vm');const html=fs.readFileSync('/workspace/spc/full/B/spi-spc.html','utf8');const core=html.match(/<script id="core">([\s\S]*?)<\/script>/)[1]+';module.exports.__i={winsor,detrend,wipeScan,welch};';const sb={module:{exports:{}},Math,Date,JSON,console};vm.runInNewContext(core,sb);const c=sb.module.exports.__i;
function mul(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const rnd=mul(12345);let sp=null;const n01=()=>{if(sp!=null){const v=sp;sp=null;return v}let a;do a=rnd();while(a===0);const b=rnd(),r=Math.sqrt(-2*Math.log(a));sp=r*Math.sin(2*Math.PI*b);return r*Math.cos(2*Math.PI*b)};
const aB=0.05/3/4;
for(const NB of [25,50]){let w5=0,w05=0,wB=0,s05=0,sB=0;const K=20000;
for(let it=0;it<K;it++){const raw=Array.from({length:NB},n01);const bm=c.winsor(raw);
 const rw=c.detrend(bm,5),WS=c.wipeScan(rw,5);if(WS){if(WS.p<0.05)w05++;if(WS.p<aB)wB++;if(WS.p<aB/5)w5++}
 const rs=c.detrend(bm,4),t=c.welch(rs.filter((_,i)=>i%2===0),rs.filter((_,i)=>i%2===1));if(t.p<0.05)s05++;if(t.p<aB)sB++}
console.log(NB,"wipe p<aB/5",(w5/K).toFixed(4),'wipe p<.05',(w05/K).toFixed(4),'p<aB',(wB/K).toFixed(4),'| stroke p<.05',(s05/K).toFixed(4),'p<aB',(sB/K).toFixed(4),'aB',aB.toFixed(5))}
