/** Regression: retired browser Admin is unavailable; MCP diagnostic API is intact. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
const root=await mkdtemp(path.join(os.tmpdir(),'gcf-retired-admin-'));
const netServer=net.createServer();
await new Promise(resolve=>netServer.listen(0,'127.0.0.1',resolve));
const port=netServer.address().port;
await new Promise(resolve=>netServer.close(resolve));
const env={...process.env,CODEXBRIDGE_ROOT:root,CODEXBRIDGE_ALLOWED_ROOTS:root,CODEXBRIDGE_HOST:'127.0.0.1',CODEXBRIDGE_PORT:String(port),CODEXBRIDGE_ALLOW_NO_HTTP_TOKEN:'1',CODEXBRIDGE_WRITE_MODE:'off',CODEXBRIDGE_BASH_MODE:'off'};
delete env.CODEXBRIDGE_HTTP_TOKEN;delete env.CODEBASE_BRIDGE_HTTP_TOKEN;
const child=spawn(process.execPath,['dist/http.js'],{cwd:process.cwd(),env,stdio:'ignore'});
const origin='http://127.0.0.1:'+port;
try{
  let ready=false;
  for(let i=0;i<85;i++){try{if((await fetch(origin+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,'MCP HTTP service must start');
  for(const route of ['/','/setup']){
    const response=await fetch(origin+route);
    assert.equal(response.status,410,'old Admin is retired: '+route);
    assert.match((await response.json()).error,/Control Center/);
  }
  const profile=await fetch(origin+'/admin/profile');
  assert.equal(profile.status,200,'existing diagnostics stay available');
  const favicon=await fetch(origin+'/favicon.ico');
  assert.equal(favicon.status,200,'logo favicon preserved');
  assert.match(favicon.headers.get('content-type'),/svg/);
  const unauthorized=await fetch(origin+'/owner/status');
  assert.equal(unauthorized.status,403,'owner routes cannot be served through MCP');
  console.log('PASS retired Admin routes; MCP HTTP health, diagnostic API, favicon and owner isolation preserved');
}finally{child.kill('SIGTERM');await rm(root,{recursive:true,force:true});}
