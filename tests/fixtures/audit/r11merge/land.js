const puppeteer=require('/workspace/spc/pp/node_modules/puppeteer-core');
(async()=>{
 const b=await puppeteer.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
 for (const [w,h] of [[932,430],[430,932]]) {
 const p=await b.newPage();await p.setViewport({width:w,height:h,deviceScaleFactor:3,isMobile:true,hasTouch:true});
 await p.goto('http://127.0.0.1:8766/_r11_fixed.html',{waitUntil:'networkidle0',timeout:60000});
 await new Promise(r=>setTimeout(r,2500));
 const m=await p.evaluate(()=>{const q=s=>document.querySelector(s);const R=e=>e?Math.round(e.getBoundingClientRect().height):null;
  const card=q('details.iss-card>summary, .iss-card');
  return {iw:innerWidth,ih:innerHeight,coarse:matchMedia('(pointer:coarse)').matches,sw:document.documentElement.scrollWidth,
  stickyPos:getComputedStyle(q('.sticky')).position,sticky:R(q('.sticky')),rail:R(q('.rail')),tabs:R(q('.tabs')),header:R(q('header.top')),
  firstCardTop:card?Math.round(card.getBoundingClientRect().top):null}});
 await p.evaluate(()=>{const t=document.querySelector('.tab[data-tab="sim3d"]');t&&t.click()});
 await new Promise(r=>setTimeout(r,2500));
 const v=await p.evaluate(()=>{const e=document.querySelector('#view3d, .view3d');return e?{h:Math.round(e.getBoundingClientRect().height),minH:getComputedStyle(e).minHeight}:null});
 console.log(w+'x'+h,JSON.stringify(m),'view3d',JSON.stringify(v));
 await p.screenshot({path:`/workspace/spc/r11merge/land-${w}x${h}.png`});
 await p.close();}
 await b.close();
})();
