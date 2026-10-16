const puppeteer=require('puppeteer-core');
(async()=>{
 const b=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
 const p=await b.newPage();await p.setViewport({width:1440,height:900});
 const errs=[];p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://127.0.0.1:8766/spi-spc.html',{waitUntil:'networkidle0',timeout:60000});
 await new Promise(r=>setTimeout(r,2000));
 await p.evaluate(()=>{document.querySelector('.tab[data-tab="sim3d"]').click()});
 await new Promise(r=>setTimeout(r,4000));
 const st=await p.evaluate(()=>({canv:[...document.querySelectorAll('#view3d canvas')].map(c=>[c.width,c.height])}));
 console.log('state',JSON.stringify(st));
 
 // measure what beforePrint produces
 const r=await p.evaluate(()=>{dispatchEvent(new Event('beforeprint'));const img=document.querySelector('.print3d');if(!img)return{img:false};return{img:true,complete:img.complete,nw:img.naturalWidth,len:img.src.length}});
 console.log('direct beforePrint',JSON.stringify(r));
 // is the dataURL blank? draw into 2d canvas and sample
 const blank=await p.evaluate(async()=>{const img=document.querySelector('.print3d');await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const x=c.getContext('2d');x.drawImage(img,0,0);const d=x.getImageData(0,0,c.width,c.height).data;let set=new Set();for(let i=0;i<d.length;i+=4*997)set.add(d[i]+','+d[i+1]+','+d[i+2]+','+d[i+3]);return{unique:set.size,sample:[...set].slice(0,5)}});
 console.log('img content',JSON.stringify(blank));
 const afterPrintx=await p.evaluate(()=>{dispatchEvent(new Event('afterprint'));return document.querySelectorAll('.print3d').length});
 await p.pdf({path:'/workspace/spc/r6merge/print3d-test.pdf',format:'A4'});
 console.log('errs',errs.slice(0,5));
 await b.close();
})();
