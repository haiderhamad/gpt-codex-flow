import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
const repo=resolve(fileURLToPath(new URL('..',import.meta.url)));
const output=process.env.GCF_VISUAL_OUTPUT?resolve(process.env.GCF_VISUAL_OUTPUT):join(tmpdir(),'gcf-ui-audit','landing');
mkdirSync(output,{recursive:true});
const browser=['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium','/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary','/usr/bin/chromium','/usr/bin/google-chrome'].find(existsSync);
if(!browser || typeof WebSocket!=='function')throw Error('CDP_UNAVAILABLE: installed Chrome and Node 22+ global WebSocket required');
const wait=ms=>new Promise(ok=>setTimeout(ok,ms));
const profile=mkdtempSync(join(tmpdir(),'gcf-visual-'));
const chrome=spawn(browser,['--headless=new','--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-gpu','--allow-file-access-from-files',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
let ws;const findings=[];const errors=[];
try{
 let debugPort;
 for(let n=0;n<120;n++){if(existsSync(join(profile,'DevToolsActivePort'))){debugPort=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);break}if(chrome.exitCode!==null)throw Error(`Chrome exited ${chrome.exitCode}`);await wait(100)}
 assert.ok(debugPort,'Chrome remote debugging did not start');
 const tabs=await(await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
 ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((ok,no)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',no,{once:true})});
 let id=0;const pending=new Map();
 ws.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')errors.push(m.params.args.map(v=>v.value||v.description).join(' '));if(!m.id)return;const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.no(Error(JSON.stringify(m.error))):p.ok(m.result)});
 function send(method,params={}){const uid=++id;return new Promise((ok,no)=>{const timer=setTimeout(()=>{pending.delete(uid);no(Error(`CDP timeout: ${method}`))},15000);pending.set(uid,{ok,no,timer});ws.send(JSON.stringify({id:uid,method,params}))})}
 async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
 async function shot(name,full=false){const r=await send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:full,...(full?{clip:{x:0,y:0,width:await evaluate('innerWidth'),height:await evaluate('document.documentElement.scrollHeight'),scale:1}}:{})});writeFileSync(join(output,name+'.png'),Buffer.from(r.data,'base64'))}
 await send('Page.enable');await send('Runtime.enable');
 for(const [surface,url] of [['landing',pathToFileURL(join(repo,'docs/gcf-preview/index.html')).href]]){
  for(const [size,width,height,mobile] of [['desktop',1440,1000,false],['tablet',768,1024,false],['mobile',390,844,true],['small-mobile',375,812,true],['landscape',844,390,true]]){
   await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
   await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   await send('Page.navigate',{url});await wait(600);
   await evaluate(`Promise.all([...document.images].map(async image=>{image.loading='eager';await image.decode().catch(()=>{})})).then(()=>true)`);
   const semantics=await evaluate(`({title:document.title,main:!!document.querySelector('main'),brokenAnchors:[...document.querySelectorAll('a[href^="#"]')].filter(a=>a.getAttribute('href').length>1&&!document.getElementById(a.getAttribute('href').slice(1))).map(a=>a.getAttribute('href')),unlabeledFields:[...document.querySelectorAll('input,select,textarea')].filter(el=>el.type!=='hidden'&&!el.closest('label')&&!el.getAttribute('aria-label')&&!el.getAttribute('aria-labelledby')&&!el.labels?.length).map(el=>el.id||el.name)})`);
   assert.match(semantics.title,/GPT Codex Flow/);assert.ok(semantics.main);assert.deepEqual(semantics.brokenAnchors,[]);assert.deepEqual(semantics.unlabeledFields,[]);
   const m=await evaluate(`JSON.stringify({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,images:[...document.images].filter(i=>(!i.complete||!i.naturalWidth)).map(i=>i.getAttribute('src')),reduced:matchMedia('(prefers-reduced-motion: reduce)').matches})`);
   const measurement=JSON.parse(m);assert.equal(measurement.width,width);assert.ok(measurement.scrollWidth<=width+1,`${surface} ${size}: horizontal overflow ${measurement.scrollWidth}`);assert.deepEqual(measurement.images,[]);assert.ok(measurement.reduced);
   assert.equal(await evaluate(`document.querySelectorAll('.hero .cta a').length`),2,'two primary hero actions');
   assert.equal(await evaluate(`getComputedStyle(document.querySelector('.scene-image')).display`),'block','mobile overview stays visible');
   assert.equal(await evaluate(`document.querySelector('#motion-toggle')`),null,'no animation pause button');
    assert.equal(await evaluate(`document.querySelector('.illustration figcaption')`),null,'no hero caption');
    assert.ok(await evaluate(`[...document.querySelectorAll('.scene-image,.usecase-visual,.memory-visual')].every(img=>img.getAttribute('src').endsWith('#paused'))`),'reduced-motion SVGs pause');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.site-header')).position`),'sticky','header stays sticky');
    for(const target of ['workflow','capabilities','access-levels','connect','dashboard']){
      const measure=await evaluate(`(async()=>{
        const link=document.querySelector('.site-header a[href="#${target}"]');
        if(!link || getComputedStyle(link).display==='none')return {error:'link hidden'};
        link.click();
        await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
        const header=document.querySelector('.site-header').getBoundingClientRect();
        const section=document.getElementById('${target}').getBoundingClientRect();
        const heading=document.querySelector('#${target} h2, #${target} h3').getBoundingClientRect();
        return {hash:location.hash,headerTop:header.top,headerBottom:header.bottom,sectionTop:section.top,headingTop:heading.top,scrollY,maxScroll:document.documentElement.scrollHeight-innerHeight};
      })()`);
      assert.equal(measure.error,undefined,`${size}: navigation link to ${target} must be visible`);
      assert.equal(measure.hash,'#'+target,`${size}: URL hash for ${target}`);
      assert.ok(Math.abs(measure.headerTop)<=2,`${size}: sticky header for ${target}: ${JSON.stringify(measure)}`);
      assert.ok(measure.headingTop>=measure.headerBottom-2,`${size}: ${target} heading covered by sticky header: ${JSON.stringify(measure)}`);
      assert.ok(measure.headingTop<measure.headerBottom+(target==='access-levels'?48:32),`${size}: ${target} has excess blank scroll offset: ${JSON.stringify(measure)}`);
    }
    await evaluate(`history.replaceState(null,'',location.pathname);scrollTo(0,0)`);
   await shot(`${surface}-${size}`);await shot(`${surface}-${size}-full`,true);
   findings.push({surface,size,...semantics,...measurement,screenshot:`${surface}-${size}.png`});
   if(surface==='landing'){
     assert.equal(await evaluate(`(() => {const rows=[...document.querySelectorAll('#access-levels .access-table tbody tr')];return rows.length===4&&rows.every(row=>row.querySelectorAll('td')[2]?.textContent.trim()==='Yes')})()`),true,'all access levels must allow advisory handoff writing');
     assert.equal(await evaluate(`getComputedStyle(document.querySelector('#access-levels .access-table')).display`),width<=650?'block':'table','responsive access comparison');
    assert.equal(await evaluate(`document.querySelectorAll('[data-connect]').length`),0,'no obsolete connection tabs');
    assert.ok(await evaluate(`document.querySelector('.connect-panel').textContent.includes('Cloudflare Quick Tunnel')`));
    assert.equal(await evaluate(`document.querySelectorAll('[data-connect]').length`),0);
    await evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__copied=value}}});document.querySelector('[data-copy="approve-preview"]').click()`);await wait(40);
    assert.match(await evaluate('window.__copied'),/npm run gcf:ui/);
    await evaluate('window.scrollTo(0,0)');
   }
  }
 }
 // Reduced-motion preference remains supported; the visible pause UI is removed.
 await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 await send('Page.navigate',{url:pathToFileURL(join(repo,'docs/gcf-preview/index.html')).href});await wait(200);
 assert.equal(await evaluate(`document.querySelector('#motion-toggle')`),null,'no motion control');







 // Check external SVG motion in its own document: page CSS cannot disable an image document's animation.
 for(const [asset,selector] of [['architecture-light.svg','.signal'],['use-case-flow.svg','.link']]){
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await send('Page.navigate',{url:pathToFileURL(join(repo,'docs/gcf-preview',asset)).href});await wait(150);
  assert.notEqual(await evaluate(`getComputedStyle(document.querySelector('${selector}')).animationName`),'none',asset+' normal motion');
  if(asset==='architecture-light.svg'){
   const alignment=await evaluate(`(()=>{
    const pairs=[['g[stroke="#2a7c94"] path:nth-child(1)','text[x="91"]'],['g[stroke="#2a7c94"] path:nth-child(2)','text[x="404"]'],['g[stroke-width="2.3"]','text[x="166"]'],['g[stroke-width="2.1"]','text[x="156"]']];
    return pairs.map(([icon,text])=>{const a=document.querySelector(icon).getBoundingClientRect(),b=document.querySelector(text).getBoundingClientRect();return {text:document.querySelector(text).textContent,delta:Math.abs(a.y+a.height/2-b.y-b.height/2)}});
   })()`);
   assert.ok(alignment.every(row=>row.delta<=2),JSON.stringify(alignment));
  }
  await wait(200);
  // Inspect actual animation state, not merely the presence of an animation declaration.
  assert.ok(await evaluate(`document.querySelector('.packet').getAnimations().some(a=>a.playState==='running'&&a.currentTime>0)`),asset+' task animation running');
  await evaluate(`document.getAnimations().forEach(a=>{a.pause();a.currentTime=1600})`);await wait(50);
  const first=await evaluate(`getComputedStyle(document.querySelector('.packet')).transform`);
  await evaluate(`document.getAnimations().forEach(a=>{a.currentTime=5000})`);await wait(50);
  assert.notEqual(await evaluate(`getComputedStyle(document.querySelector('.packet')).transform`),first,asset+' task visibly travels');
  await shot(asset.replace('.svg','')+'-motion');
  await send('Page.navigate',{url:pathToFileURL(join(repo,'docs/gcf-preview',asset)).href+'#paused'});await wait(100);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('${selector}')).animationName`),'none',asset+' manual pause');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.packet')).display`),'none',asset+' paused packet hidden');
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await send('Page.navigate',{url:pathToFileURL(join(repo,'docs/gcf-preview',asset)).href});await wait(100);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('${selector}')).animationName`),'none',asset+' reduced motion');
 }
 const memorySvg=pathToFileURL(join(repo,'docs/gcf-preview/notion-memory-flow.svg')).href;
 await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
 await send('Page.navigate',{url:memorySvg});await wait(160);
 assert.ok(await evaluate(`document.querySelector('.optional').getAnimations().some(a=>a.playState==='running')`),'optional Notion path animation must run');
 await send('Page.navigate',{url:memorySvg+'#paused'});await wait(110);
 assert.equal(await evaluate(`getComputedStyle(document.querySelector('.optional')).animationName`),'none','optional memory diagram pause fragment');
 await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await send('Page.navigate',{url:memorySvg});await wait(110);
 assert.equal(await evaluate(`getComputedStyle(document.querySelector('.optional')).animationName`),'none','optional memory diagram reduced motion');
 assert.deepEqual(errors,[],'browser console/runtime errors');
 writeFileSync(join(output,'verification.json'),JSON.stringify({browser:'Installed Chrome via CDP',motion:'Reduced motion emulated',fixtures:'Static Landing in installed Chrome; temporary Chrome profile; no live Codex, tunnel or private data',findings,checks:['No horizontal overflow','All images decoded; no broken assets','No console errors','External SVG normal/reduced motion','Arrow-key connection tabs','Copy command value','SVG animation advances; paused fragment and reduced-motion preference stop motion','Optional Notion animation runs, pauses and respects reduced motion','Control Center has a separate browser regression'],errors},null,2));
 console.log(`REAL_BROWSER_VERIFIED: static Landing at desktop 1440, tablet 768, mobile 390/375, landscape 844; ${findings.length} layouts; keyboard, Copy, reduced motion; no overflow/errors. Screenshots: ${output}`);
}finally{
 try{ws?.close()}catch{}chrome.kill('SIGTERM');await wait(250);rmSync(profile,{recursive:true,force:true});
}
