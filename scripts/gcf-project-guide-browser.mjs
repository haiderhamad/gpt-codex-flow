import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {startControlCenter} from '../dist/gcfControlCenter.js';

const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gcf-project-guide-browser-')));
const a=path.join(root,'Project A'),b=path.join(root,'Project B');
fs.mkdirSync(a);fs.mkdirSync(b);
fs.writeFileSync(path.join(b,'README.md'),'# Existing Project B\\n');
const manifest=path.join(root,'settings','projects.json');
// Keep all Codex registration checks and writes inside this disposable fixture.
const bin=path.join(root,'bin');fs.mkdirSync(bin);
const fakeEntry=path.join(root,'codex-entry.json');
fs.writeFileSync(path.join(bin,'codex'),`#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2),file=${JSON.stringify(fakeEntry)};
if(args[0]!=='mcp')process.exit(3);
if(args[1]==='get'){if(!fs.existsSync(file))process.exit(1);process.stdout.write(fs.readFileSync(file));process.exit(0);}
if(args[1]==='add'){const sep=args.indexOf('--');if(sep!==3)process.exit(4);fs.writeFileSync(file,JSON.stringify({enabled:true,transport:{type:'stdio',command:args[sep+1],args:args.slice(sep+2)}}));process.exit(0);}
process.exit(5);
`,{mode:0o700});
fs.writeFileSync(path.join(bin,'cloudflared'),'#!/usr/bin/env node\nprocess.exit(0);\n',{mode:0o700});
const originalPath=process.env.PATH;
process.env.PATH=bin+path.delimiter+(originalPath??'');
const browser=['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Chromium.app/Contents/MacOS/Chromium'].find(fs.existsSync);
if(!browser||typeof WebSocket!=='function')throw Error('Chrome and Node WebSocket support are required for the browser acceptance test.');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gcf-guide-chrome-'));
const output=path.join(os.tmpdir(),'gcf-ui-audit');
fs.mkdirSync(output,{recursive:true});
const wait=ms=>new Promise(ok=>setTimeout(ok,ms));
let next=a,server,chrome,ws;
let cloudState={state:'stopped',message:'Not running'};
const cloudLauncher={status:()=>({...cloudState}),async start(projects,access){cloudState={state:'tunnel_ready',project:projects[0],projects,access,message:'Fake Cloudflare ready; ChatGPT not verified',serverUrl:'https://owner-fixture.trycloudflare.com/mcp?'+('gcf_'+'token')+'=placeholder'};return {...cloudState}},async stop(){cloudState={state:'stopped',message:'Stopped'};return {...cloudState}}};
const errors=[];
try {
  server=await startControlCenter({manifest,sourceRoot:process.cwd(),pickFolder:async()=>({cancelled:false,path:next}),approveChange:async()=>true,cloudLauncher});
  chrome=spawn(browser,['--headless=new','--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-gpu',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
  let port;
  for(let n=0;n<120;n++){const file=path.join(profile,'DevToolsActivePort');if(fs.existsSync(file)){port=Number(fs.readFileSync(file,'utf8').split('\n')[0]);break;}if(chrome.exitCode!==null)throw Error('Chrome exited before debugging started');await wait(100);}
  assert.ok(port,'Chrome debugging port');
  const tabs=await(await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((ok,no)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',no,{once:true})});
  let id=0;const pending=new Map();
  ws.addEventListener('message',({data})=>{
    const m=JSON.parse(data);
    if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);
    if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')errors.push(m.params.args.map(a=>a.value||a.description).join(' '));
    if(!m.id)return;
    const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);
    m.error?p.no(Error(JSON.stringify(m.error))):p.ok(m.result);
  });
  const send=(method,params={})=>new Promise((ok,no)=>{
    const mid=++id;const timer=setTimeout(()=>{pending.delete(mid);no(Error('CDP timeout '+method))},15000);
    pending.set(mid,{ok,no,timer});ws.send(JSON.stringify({id:mid,method,params}));
  });
  async function evaluate(expression){
    const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
    return r.result.value;
  }
  async function until(expression){
    for(let n=0;n<100;n++){if(await evaluate(expression))return;await wait(80);}
    throw Error('Browser condition timed out: '+expression);
  }
  async function key(value){
    const windowsVirtualKeyCode={Enter:13,Tab:9,Escape:27}[value];
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:value,code:value,windowsVirtualKeyCode,...(value==='Enter'?{text:'\r'}:{})});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:value,code:value,windowsVirtualKeyCode});
  }
  async function assertBrandReferences(){
    const proof=await evaluate(`(()=>{
      const ids=[...document.querySelectorAll('[id]')].map(el=>el.id);
      const logos=[...document.querySelectorAll('.brand-icon svg')];
      return {duplicates:ids.filter((id,index)=>ids.indexOf(id)!==index),logos:logos.map(svg=>{
        const paintRefs=[...svg.querySelectorAll('[fill]')].flatMap(el=>[...el.getAttribute('fill').matchAll(/url\\(#([^)]*)\\)/g)].map(match=>match[1]));
        const labelRefs=(svg.getAttribute('aria-labelledby')||'').split(/\\s+/).filter(Boolean);
        return {gradientCount:svg.querySelectorAll('linearGradient').length,paintRefs,
          paintsLocal:paintRefs.every(id=>{const target=document.getElementById(id);return target&&svg.contains(target)&&target.localName==='linearGradient'&&target.querySelector('stop')}),
          labelsLocal:labelRefs.length>0&&labelRefs.every(id=>{const target=document.getElementById(id);return target&&svg.contains(target)&&target.localName==='title'})};
      })};
    })()`);
    assert.deepEqual(proof.duplicates,[],'Mounted unlock/header logos and the page must have unique IDs');
    assert.equal(proof.logos.length,2,'Hidden unlock and workspace logos must both be mounted');
    for(const [index,logo] of proof.logos.entries()){
      assert.ok(logo.gradientCount>=2&&logo.paintRefs.length>=3,'Logo '+index+' must retain the C-mark gradient paths');
      assert.equal(logo.paintsLocal,true,'Logo '+index+' paint refs must resolve inside that same SVG');
      assert.equal(logo.labelsLocal,true,'Logo '+index+' title refs must resolve inside that same SVG');
    }
  }
  await send('Page.enable');await send('Runtime.enable');await send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await send('Page.navigate',{url:server.origin+'/'});
  await until(`document.readyState==='complete'&&!!document.getElementById('owner-code')`);
  await assertBrandReferences();
  await evaluate(`(()=>{document.getElementById('owner-code').value=${JSON.stringify(server.bootstrapCode)};document.getElementById('auth-form').requestSubmit(document.querySelector('#auth-form button[type=submit]'));return true})()`);
  try{await until(`document.getElementById('workspace')&&!document.getElementById('workspace').hidden`);}catch(e){console.error('Auth diagnostics:',await evaluate(`({url:location.href,authError:document.getElementById('auth-error')?.textContent,codeLength:document.getElementById('owner-code')?.value.length,workspaceHidden:document.getElementById('workspace')?.hidden})`),'runtime errors:',errors);throw e;}
  await assertBrandReferences();
  await until(`document.getElementById('lead-project').disabled&&document.getElementById('lead-help').textContent.includes('Add a folder')`);
  assert.equal(await evaluate(`document.getElementById('handoff-status-check').disabled`),true,'No task diagnostics without an approved project');
  // The skip link must remain above the sticky navigation and work by keyboard.
  await evaluate(`document.querySelector('.skip').focus()`);
  const skipProof=await evaluate(`(()=>{const el=document.querySelector('.skip'),box=el.getBoundingClientRect(),hit=document.elementFromPoint(box.x+8,box.y+8);return {visible:hit===el,active:document.activeElement.className,box:{x:box.x,y:box.y,w:box.width,h:box.height},hit:hit?.outerHTML.slice(0,200)}})()`);
  assert.equal(skipProof.visible,true,'Skip link must not be covered by navigation: '+JSON.stringify(skipProof));
  await key('Enter');
  assert.equal(await evaluate(`document.activeElement.id`),'main');
  await key('Tab');
  assert.equal(await evaluate(`document.activeElement.id`),'add-folder');
  await key('Enter');
  await until(`!document.getElementById('review').hidden`);
  await key('Escape');
  assert.equal(await evaluate(`document.getElementById('review').hidden&&document.activeElement.id==='add-folder'`),true,'Escape closes folder review and restores focus');
  for(const [which,p] of [['A',a],['B',b]]){
    next=p;
    await until(`!document.getElementById('review-save').disabled`);
    await evaluate(`document.getElementById('add-folder').click()`);
    try{await until(`!document.getElementById('review').hidden`);}catch(e){console.error('Picker diagnostic',await evaluate(`({message:document.getElementById('project-feedback').textContent,reviewHidden:document.getElementById('review').hidden})`),errors);throw e;}
    const historyVisible=await evaluate(`!document.getElementById('history-option').hidden`);
    assert.equal(historyVisible,which==='A','Only new folders offer a history bootstrap');
    await until(`!document.getElementById('review-save').disabled`);
    await evaluate(`document.getElementById('review-save').click()`);
    try{await until(`document.getElementById('project-count').textContent==='${which==='A'?'1 folder':'2 folders'}'`);}catch(e){console.error('Save diagnostic',which,await evaluate(`({count:document.getElementById('project-count').textContent,feedback:document.getElementById('project-feedback').textContent,error:document.getElementById('review-error').textContent,reviewHidden:document.getElementById('review').hidden})`),errors);throw e;}
  }
  await until(`!document.getElementById('connect-codex').disabled`);
  await evaluate(`document.getElementById('connect-codex').click()`);
  await until(`document.getElementById('connect-codex').hidden&&!document.getElementById('test-codex').hidden`);
  assert.ok(fs.existsSync(fakeEntry),'Codex registration saved only in fixture');
  await evaluate(`document.getElementById('test-codex').click()`);
  await until(`document.getElementById('codex-summary').textContent==='Local folder read passed'`);
  assert.match(await evaluate(`document.getElementById('client-state').textContent`),/not a live session/i);
  await evaluate(`(()=>{const select=document.getElementById('lead-mode');select.value='codex_lead';select.dispatchEvent(new Event('change'));document.getElementById('lead-save').click();return true})()`);
  await until(`document.getElementById('lead-feedback').textContent.includes('Lead saved')&&document.getElementById('lead-save').disabled`);
  assert.equal(await evaluate(`document.getElementById('codex-model-mode').value`),'default');
  assert.equal(await evaluate(`document.getElementById('codex-effort').value`),'auto');
  await evaluate(`(()=>{const mode=document.getElementById('codex-model-mode');mode.value='custom';mode.dispatchEvent(new Event('change'));const input=document.getElementById('codex-model-id');input.value='test-codex';input.dispatchEvent(new Event('input'));const effort=document.getElementById('codex-effort');effort.value='high';effort.dispatchEvent(new Event('change'));document.getElementById('codex-exec-save').click();return true})()`);
  await until(`document.getElementById('codex-exec-feedback').textContent.includes('Owner settings saved')&&document.getElementById('codex-exec-save').disabled`);
  assert.equal(await evaluate(`document.getElementById('codex-model-id').value`),'test-codex');
  assert.equal(await evaluate(`document.getElementById('codex-effort').value`),'high');
  await evaluate(`(()=>{const s=document.getElementById('lead-project');s.value=${JSON.stringify(b)};s.dispatchEvent(new Event('change'));return true})()`);
  assert.equal(await evaluate(`document.getElementById('codex-model-mode').value`),'default','Model preferences isolated per project');
  assert.equal(await evaluate(`document.getElementById('codex-effort').value`),'auto');
  await evaluate(`(()=>{const s=document.getElementById('lead-project');s.value=${JSON.stringify(a)};s.dispatchEvent(new Event('change'));return true})()`);
  assert.equal(await evaluate(`document.getElementById('codex-model-id').value`),'test-codex','Selected owner model restores on project switch');
  assert.ok(fs.existsSync(path.join(a,'docs','PROJECT_HISTORY.md')),'New project history must be initialized after owner approval');
  assert.equal(fs.existsSync(path.join(b,'docs','PROJECT_HISTORY.md')),false,'Existing project must not be modified');
  await evaluate(`document.querySelector('#chatgpt-project-guide > summary').click()`);
  await until(`document.getElementById('instructions-project').options.length===2`);
  async function copyFor(project,abs){
    await evaluate(`(()=>{const select=document.getElementById('instructions-project');select.value=${JSON.stringify(abs)};select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    await until(`document.getElementById('instructions-preview').value.includes(${JSON.stringify(abs)})&&!document.getElementById('instructions-copy').disabled`);
    const template=await evaluate(`document.getElementById('instructions-preview').value`);
    assert.ok(template.length<=1500,project+' template length');
    assert.match(template,/AGENTS.md/);assert.match(template,/shared_project_state/);
    assert.ok(template.includes(project),project+' name');
    assert.ok(!template.includes(project==='Project A'?'Project B':'Project A'),'No project context leakage');
    await evaluate(`(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async s=>{window.__gcfCopied=s}}});document.getElementById('instructions-copy').click();return true})()`);
    await until(`window.__gcfCopied===document.getElementById('instructions-preview').value`);
    assert.equal(await evaluate('window.__gcfCopied'),template);
    return template;
  }
  const aText=await copyFor('Project A',a);
  const bText=await copyFor('Project B',b);
  assert.notEqual(aText,bText);
  // Real Chrome click flow with injected fake tunnel; no external network created.
  await until(`!document.getElementById('connect-chatgpt').disabled`);
  await evaluate(`document.getElementById('connect-chatgpt').focus()`);
  await key('Enter');
  assert.equal(await evaluate(`document.getElementById('cloudflare-connection-setup').open`),true);
  assert.equal(await evaluate(`document.activeElement.type`),'checkbox','Connect ChatGPT moves keyboard focus to project selection');
  await evaluate(`(()=>{const s=document.getElementById('cloud-project');for(const box of s.querySelectorAll('input'))box.checked=box.value===${JSON.stringify(b)};s.dispatchEvent(new Event('change',{bubbles:true}));const a=document.getElementById('cloud-access');a.value='test';a.dispatchEvent(new Event('change'));document.getElementById('cloud-start').click();return true})()`);
  await until(`!document.getElementById('cloud-url-panel').hidden`);
  assert.equal(cloudState.access,'test');assert.equal(cloudState.project,b);
  await evaluate(`document.getElementById('cloud-url-copy').click()`);
  await until(`window.__gcfCopied&&document.getElementById('cloud-url').value.includes('[HIDDEN]')`);
  assert.equal(await evaluate('window.__gcfCopied'),cloudState.serverUrl,'Copy must include complete private link');
  assert.notEqual(await evaluate(`document.getElementById('cloud-url').value`),cloudState.serverUrl,'Screenshot must hide token');
  await evaluate(`(()=>{navigator.clipboard.writeText=async()=>{throw Error('Clipboard denied')};document.getElementById('cloud-url-copy').click();return true})()`);
  await until(`document.getElementById('cloud-live-feedback').textContent.includes('Retry Copy Connection URL')`);
  assert.ok(await evaluate(`document.getElementById('cloud-url').value.includes('[HIDDEN]')`),'Failed copy must never reveal the private URL');
  await evaluate(`document.getElementById('cloud-stop').click()`);
  await until(`document.getElementById('cloud-url-panel').hidden`);
  assert.equal(cloudState.state,'stopped');
  assert.equal(await evaluate(`document.getElementById('chatgpt-state').textContent`),'Cloudflare stopped','Stopped tunnel must not retain a stale ready label');
  assert.equal(await evaluate(`document.getElementById('client-state').textContent.includes('tunnel ready')`),false,'Stopped tunnel must not retain stale client readiness');
  const findings=[];
  for(const [size,width,height] of [['desktop',1440,900],['tablet',768,1024],['mobile',390,844]]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:size==='mobile'});
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await wait(160);
    const m=await evaluate(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,reduce:matchMedia('(prefers-reduced-motion: reduce)').matches,guideOpen:document.getElementById('chatgpt-project-guide').open})`);
    assert.equal(m.width,width);assert.ok(m.scrollWidth<=width+1,size+' horizontal overflow: '+m.scrollWidth);assert.equal(m.reduce,true);assert.equal(m.guideOpen,true);
    // Scroll spy must highlight the section actually visible, regardless of prior clicks.
    for(const section of ['connections','workflow','status','projects']){
      await evaluate(`(()=>{const target=document.getElementById('${section}');const header=document.querySelector('.rail');const top='${section}'==='projects'?0:window.scrollY+target.getBoundingClientRect().top-header.getBoundingClientRect().height-12;window.scrollTo({top:Math.max(0,top),behavior:'instant'});return true})()`);
      await until(`document.querySelector('.rail nav [aria-current="location"]')?.getAttribute('href')==='#${section}'`);
      if(section==='workflow'||section==='status'){const shot=await send('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(output,'control-center-'+section+'-'+size+'.png'),Buffer.from(shot.data,'base64'));}
    }
    // Capture the exact reported failure state: Connections visible, Connections highlighted.
    await evaluate(`(()=>{const target=document.getElementById('connections');const header=document.querySelector('.rail');window.scrollTo({top:window.scrollY+target.getBoundingClientRect().top-header.getBoundingClientRect().height-12,behavior:'instant'});return true})()`);
    await until(`document.querySelector('.rail nav [aria-current="location"]')?.getAttribute('href')==='#connections'`);
    const connectionShot=await send('Page.captureScreenshot',{format:'png',fromSurface:true});
    fs.writeFileSync(path.join(output,'control-center-connections-'+size+'.png'),Buffer.from(connectionShot.data,'base64'));
    await evaluate(`document.querySelector('.rail nav a[href="#connections"]').focus()`);
    await key('Enter');
    await until(`document.querySelector('.rail nav [aria-current="location"]')?.getAttribute('href')==='#connections'`);
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    assert.equal(await evaluate(`document.querySelector('.rail nav [aria-current="location"]')?.getAttribute('href')`),'#connections',size+' keyboard navigation remains current after scroll settles');
    assert.equal(await evaluate(`document.activeElement.id`),'connections',size+' keyboard navigation focuses the requested section');
    await evaluate(`window.scrollTo({top:0,behavior:'instant'})`);
    await until(`document.querySelector('.rail nav [aria-current="location"]')?.getAttribute('href')==='#projects'`);
    await evaluate(`document.activeElement?.blur()`);
    const shot=await send('Page.captureScreenshot',{format:'png',fromSurface:true});
    fs.writeFileSync(path.join(output,'control-center-'+size+'.png'),Buffer.from(shot.data,'base64'));
    findings.push({size,...m});
  }
  // Optional public-facing capture from this real browser fixture. Never use
  // a live user folder, connection URL or owner token in marketing screenshots.
  if(process.argv.includes('--export-landing-capture')){
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate(`(()=>{
      document.activeElement?.blur();
      document.querySelectorAll('details').forEach(el=>{el.open=false});
      const rewrites=${JSON.stringify([[a,'~/Projects/demo-app'],[b,'~/Projects/existing-project'],[root,'~/Projects'],[process.cwd(),'~/gpt-codex-flow']])};
      const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
      let node;while((node=walker.nextNode()))for(const [from,to] of rewrites)node.textContent=node.textContent.replaceAll(from,to);
      document.querySelectorAll('.project-card').forEach((card,index)=>{const name=['demo-app','existing-project'][index];card.querySelector('.project-info strong').textContent=name;card.querySelector('.path').textContent='~/Projects/'+name;card.querySelector('.path').removeAttribute('title');});
      document.getElementById('project-feedback').textContent='';
      document.querySelectorAll('input,textarea').forEach(el=>{if(el.type==='password')el.value='';else if(el.tagName==='TEXTAREA')el.value='';});
      document.getElementById('cloud-url-panel').hidden=true;
      document.getElementById('cloud-url').value='';
      window.scrollTo({top:0,behavior:'instant'});
      return true;
    })()`);
    await wait(140);
    const scrubbed=await evaluate(`document.body.innerText`);
    assert.ok(!scrubbed.includes(root)&&!scrubbed.includes(path.basename(root))&&!scrubbed.includes(process.cwd()),'public screenshot must not show local paths');
    assert.ok(!scrubbed.includes('gcf_token='),'public screenshot must not show token');
    const screenshot=await send('Page.captureScreenshot',{format:'png',fromSurface:true});
    const destination=path.join(process.cwd(),'docs','gcf-preview','screenshots','control-center-demo.png');
    fs.writeFileSync(destination,Buffer.from(screenshot.data,'base64'));
    console.log('Created sanitized Control Center fixture image: '+destination);
  }
  // A malformed manifest must produce visible attention feedback, not Ready.
  const validManifest=fs.readFileSync(manifest,'utf8');
  fs.writeFileSync(manifest,'invalid fixture manifest');
  await send('Page.navigate',{url:server.origin+'/'});
  await until(`document.getElementById('owner-state')?.textContent==='Needs attention'`);
  assert.match(await evaluate(`document.getElementById('status-error').textContent`),/invalid or unsafe/i);
  fs.writeFileSync(manifest,validManifest);
  await send('Page.navigate',{url:server.origin+'/'});
  await until(`document.getElementById('owner-state')?.textContent==='Ready'&&document.getElementById('lead-project').options.length===2`);
  // Expiry must retain an honest warning that the tunnel may still be running.
  await evaluate(`(()=>{document.querySelector('#cloudflare-connection-setup > summary').click();const box=document.querySelector('#cloud-project input');box.checked=true;box.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('cloud-start').click();return true})()`);
  await until(`!document.getElementById('cloud-url-panel').hidden`);
  await send('Network.clearBrowserCookies');
  await evaluate(`document.getElementById('cloud-stop').click()`);
  await until(`document.getElementById('cloud-live-feedback').textContent.includes('Disconnect was NOT performed')`);
  assert.equal(await evaluate(`document.getElementById('cloud-stop').disabled&&document.getElementById('cloud-start').disabled&&document.getElementById('cloud-url-panel').hidden`),true,'Session expiry must not re-enable Disconnect or show a private address');
  assert.equal(cloudState.state,'tunnel_ready','UI must not claim an expired-session disconnect succeeded');
  assert.deepEqual(errors,[],'Chrome console or JS errors');
  fs.writeFileSync(path.join(output,'control-center-result.json'),JSON.stringify({result:'PASS',tests:['Unique mounted logo IDs and local SVG gradient/title references','Native owner unlock','Empty workflow guidance','Keyboard skip link above sticky navigation','Keyboard folder review Escape and focus restoration','Isolated Codex registration and real read-only MCP check','Saved per-project lead','Clipboard denial keeps private URL masked','Invalid manifest attention state','Session expiry honest disconnect state','New/established project history choice','Project A vs Project B generated instructions','Copy button actual browser interaction','Cloudflare Start/Copy/Disconnect UI with injected fake tunnel','Chromium 1440/768/390 viewport checks','Scroll-tracking navigation Projects / Connections / Workflow / Status','Reduced motion','Console errors'],findings},null,2));
  console.log('PASS real Chrome owner Control Center: isolated Codex registration, local MCP read, keyboard/focus, A/B project templates, clipboard denial, lead save, invalid manifest, session expiry, 1440/768/390 viewports, reduced motion, no errors or overflow. Screenshots: '+output);
} finally {
  if(originalPath===undefined)delete process.env.PATH;else process.env.PATH=originalPath;
  try{ws?.close()}catch{}
  chrome?.kill('SIGTERM');
  if(server)await new Promise(ok=>server.server.close(ok));
  await wait(220);
  fs.rmSync(profile,{recursive:true,force:true});
  fs.rmSync(root,{recursive:true,force:true});
}
