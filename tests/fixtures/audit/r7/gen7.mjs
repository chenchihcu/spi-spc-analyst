// Independent re-implementation of spec v1.5 §6.1 gen-stable from text only
import {createRequire} from 'module';const require=createRequire(import.meta.url);
const {loadCore}=require('/workspace/spc/full/B/tests/_load.js');const c=loadCore();
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
export function gen7(seed,NB,SHIFT){
  const U=mulberry32(seed);let keep=null;
  const N=()=>{ if(keep!==null){const k=keep;keep=null;return k}
    let a=U(); while(a===0)a=U(); const b=U(); const r=Math.sqrt(-2*Math.log(a)); keep=r*Math.sin(2*Math.PI*b); return r*Math.cos(2*Math.PI*b)};
  const tpl=c.sampleData({variant:"A"}).filter(r=>r.board==="B01").map(r=>({pad:r.pad,comp:r.comp,group:r.group,x:r.x,y:r.y,w:r.w,d:r.d,shape:r.shape}));
  const rows=[];
  for(let b=1;b<=NB;b++){const eh=1*N(),ea=1*N(),ex=2*N(),ey=2*N();const sh=b>NB-8?SHIFT:0;
    for(const p of tpl){const nh=N();const h=120+eh+3.5*nh;const na=N();const a=100+ea+sh+4*na;const nv=N();const v=h/120*a*(1+0.025*nv);
      const nx=N();const ox=ex+10*nx;const ny=N();const oy=ey+10*ny;
      rows.push({...p,board:"B"+String(b).padStart(2,"0"),stroke:b%2?"前":"後",height:+h.toFixed(1),area:+a.toFixed(1),volume:+v.toFixed(1),offx:+ox.toFixed(1),offy:+oy.toFixed(1)})}}
  return rows}
export function toCSV(rows){const H="板號,元件位號,焊墊,元件群組,x,y,padl,padw,刮刀方向,高度,面積,體積,offsetx,offsety";
  return [H,...rows.map(r=>[r.board,r.comp,r.pad,r.group,r.x,r.y,r.w,r.d,r.stroke,r.height,r.area,r.volume,r.offx,r.offy].join(","))].join("\n")}
