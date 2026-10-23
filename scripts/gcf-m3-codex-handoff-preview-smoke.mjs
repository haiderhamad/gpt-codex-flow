import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {previewOwnerCodexHandoff} from '../dist/gcfNativeHandoffBridge.js';
import {startControlCenter} from '../dist/gcfControlCenter.js';
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gcf-m3-safe-')));
const project=path.join(root,'project'),manifest=path.join(root,'owner','projects.json');
fs.mkdirSync(project);fs.mkdirSync(path.dirname(manifest));fs.writeFileSync(manifest,JSON.stringify({version:1,roots:[project]}));
try{
 await assert.rejects(previewOwnerCodexHandoff(manifest,root,process.cwd()),/Project not approved/);
 await assert.rejects(previewOwnerCodexHandoff(manifest,project,process.cwd()),/Start and accept/);
 const app=await startControlCenter({manifest,sourceRoot:process.cwd()});
 const post=(body,headers={})=>fetch(app.origin+'/owner/workflow/codex-preview',{method:'POST',headers:{origin:app.origin,'content-type':'application/json',...headers},body:JSON.stringify(body)});
 try {
   assert.equal((await post({project})).status,401);
   const open=await fetch(app.origin+'/owner/session',{method:'POST',headers:{origin:app.origin,'content-type':'application/json'},body:JSON.stringify({code:app.bootstrapCode})});
   const cookie=open.headers.get('set-cookie').split(';')[0];
   const html=await (await fetch(app.origin+'/',{headers:{cookie}})).text();
   const csrf=html.match(/const csrf="([a-f0-9]{64})"/)?.[1];assert.ok(csrf);
   assert.equal((await post({project},{cookie})).status,403);
   const result=await post({project},{cookie,'x-gcf-csrf':csrf});
   assert.equal(result.status,400);
   assert.match((await result.json()).error,/Start and accept/);
   const bad=await post({project,run:true},{cookie,'x-gcf-csrf':csrf});
   assert.equal(bad.status,400);
 } finally {await new Promise(resolve=>app.server.close(resolve));}
 console.log('PASS M3 owner session/CSRF, no accepted transfer denies, unapproved project denies, browser cannot run Codex.');
}finally{fs.rmSync(root,{recursive:true,force:true});}
