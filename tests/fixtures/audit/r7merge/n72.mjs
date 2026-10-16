import {createRequire} from 'module';const require=createRequire(import.meta.url);const fs=require('fs');
const {loadCore}=require('/workspace/spc/full/B/tests/_load.js');const c=loadCore();
for(const f of ['TEST-第七輪-01_greekmu.csv','TEST-第七輪-02_refdes.csv','TEST-第七輪-03_mm.csv']){
 const txt=fs.readFileSync('/workspace/spc/audit7/'+f,'utf8');
 const P=c.parseCSV(txt);const R=P.rows;
 const pads=new Set(R.map(r=>r.pad)).size, grid=R.filter(r=>r.gridPos).length;
 console.log('==',f,'rows',R.length,'pads',pads,'gridPos',grid,'keys',Object.keys(R[0]).join(','));
 const boards=[...new Set(R.map(r=>r.board))];
 const al=boards.map(b=>({b,a:c.alignFit(R.filter(r=>r.board===b))})).filter(x=>x.a);
 const top=al.map(x=>({b:x.b,ex:+(x.a.ex*1000).toFixed(0),ey:+(x.a.ey*1000).toFixed(0),strEdge:+x.a.strEdge.toFixed(1)})).sort((p,q)=>q.strEdge-p.strEdge).slice(0,4);
 console.log('alignFit on rows (all gridPos='+(grid===R.length)+')',JSON.stringify(top));
 try{const st={...c.S};}catch(e){}
}
