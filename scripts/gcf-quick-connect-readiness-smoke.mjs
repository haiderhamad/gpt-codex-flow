import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chatgptQuickConnectReadiness} from '../dist/gcfQuickConnectReadiness.js';
import {startControlCenter} from '../dist/gcfControlCenter.js';

const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gcf-quick-readiness-')));
const folder=path.join(dir,'project');
const manifest=path.join(dir,'projects.json');
fs.mkdirSync(folder);
fs.writeFileSync(manifest,JSON.stringify({version:1,roots:[folder]})+'\n');
const ok=chatgptQuickConnectReadiness(manifest,process.cwd(),()=>true);
assert.equal(ok.transport,'cloudflare-quick');
assert.equal(ok.manualStartOnly,false);
assert.equal(ok.authenticationRequired,true);
assert.equal(ok.canConnect,true);
assert.equal(ok.externalConnectionStarted,false);
assert.equal(ok.clientConnectionVerified,false);
assert.equal(ok.checks.find(x=>x.key==='token').ready,true);
assert.equal(chatgptQuickConnectReadiness(manifest,process.cwd(),()=>false).checks.find(x=>x.key==='server').ready,true);
const app=await startControlCenter({manifest,sourceRoot:process.cwd()});
const base=app.origin;
const post=(url,body,headers={})=>fetch(base+url,{method:'POST',headers:{origin:base,'content-type':'application/json',...headers},body:JSON.stringify(body)});
try{
  assert.equal((await post('/owner/connections',{action:'check',client:'chatgpt'})).status,401);
  let response=await post('/owner/session',{code:app.bootstrapCode});
  assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie').split(';')[0];
  response=await fetch(base+'/',{headers:{cookie}});
  const html=await response.text();
  const csrf=html.match(/const csrf="([a-f0-9]{64})"/)?.[1];
  assert.ok(csrf);
  assert.equal((await post('/owner/connections',{action:'check',client:'chatgpt'},{cookie})).status,403);
  response=await post('/owner/connections',{action:'check',client:'chatgpt'},{cookie,'x-gcf-csrf':csrf});
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.chatgpt.canConnect,chatgptQuickConnectReadiness(manifest,process.cwd()).canConnect);
  assert.equal(result.chatgpt.externalConnectionStarted,false);
  assert.equal((await post('/owner/connections',{action:'connect',client:'chatgpt'},{cookie,'x-gcf-csrf':csrf})).status,400);
  assert.equal((await fetch(base+'/owner/connections',{headers:{authorization:'Bearer remote-key'}})).status,401);
  console.log('PASS ChatGPT Quick Connect readiness and owner-only security: no tunnel, no OAuth assertion, no remote grants.');
}finally{
  await new Promise(resolve=>app.server.close(resolve));
  fs.rmSync(dir,{recursive:true,force:true});
}
