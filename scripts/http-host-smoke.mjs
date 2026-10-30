import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {request} from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {isAllowedTokenlessHost} from '../dist/httpOriginPolicy.js';

for (const host of ['localhost:8787','127.0.0.1:8787','[::1]:8787'])
  assert.equal(isAllowedTokenlessHost(host,8787),true);
for (const host of [undefined,'','evil.example:8787','localhost.evil.example:8787',
  'localhost:8788','localhost','127.1:8787','2130706433:8787','localhost:08787',
  'user@localhost:8787','localhost:8787/',' localhost:8787','localhost:8787,evil'])
  assert.equal(isAllowedTokenlessHost(host,8787),false,String(host));
assert.equal(isAllowedTokenlessHost('localhost',80),true);
assert.equal(isAllowedTokenlessHost('localhost:0',0),false);

const fixture=await mkdtemp(path.join(os.tmpdir(),'gcf-host-policy-'));
const listener=net.createServer();
await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve)});
const port=listener.address().port;
await new Promise(resolve=>listener.close(resolve));
const env={...process.env,GCF_ROOT:fixture,GCF_ALLOWED_ROOTS:fixture,
  GCF_HOST:'127.0.0.1',HOST:'127.0.0.1',GCF_PORT:String(port),
  GCF_ALLOW_NO_HTTP_TOKEN:'1',GCF_REQUIRE_HTTP_TOKEN:'0',
  GCF_HTTP_AUTH_MODE:'legacy',GCF_WRITE_MODE:'off',GCF_BASH_MODE:'off'};
for(const key of ['GCF_HTTP_TOKEN','CODEBASE_BRIDGE_HTTP_TOKEN','GCF_PROJECT_ROOTS_FILE',
  'GCF_TUNNEL_MODE','GCF_HTTP_ALLOWED_ORIGINS']) delete env[key];
const child=spawn(process.execPath,['dist/http.js'],{env,stdio:'ignore'});
const closed=new Promise(resolve=>child.once('exit',resolve));
function get(target,host,extra={}) {
  return new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path:target,setHost:false,
      headers:{...(host===undefined?{}:{Host:host}),...extra}},res=>{
      res.resume();res.once('end',()=>resolve(res.statusCode));
    });
    req.once('error',reject);req.setTimeout(3000,()=>req.destroy(Error('request timeout')));req.end();
  });
}
try {
  let ready=false;
  for(let n=0;n<80;n++) {
    try { if(await get('/healthz',`127.0.0.1:${port}`)===200) {ready=true;break;} } catch {}
    if(child.exitCode!==null)throw Error('HTTP fixture exited early');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(ready,true,'HTTP fixture readiness');
  for(const target of ['/','/healthz','/favicon.ico','/admin/profile','/mcp']) {
    for(const host of [undefined,`evil.example:${port}`,`localhost.evil.example:${port}`,`localhost:${port+1}`])
      assert.ok((host===undefined?[400,403]:[403]).includes(await get(target,host,{'X-Forwarded-Host':`localhost:${port}`})),target+' '+String(host));
  }
  for(const host of [`localhost:${port}`,`127.0.0.1:${port}`,`[::1]:${port}`])
    assert.equal(await get('/healthz',host),200);
  assert.equal(await get('/healthz',`localhost:${port}`,{Origin:'https://evil.example'}),403);
  console.log('PASS: tokenless HTTP denies missing/rebinding/wrong-port Host across Admin/MCP routes; forwarded Host cannot bypass; exact loopback and Origin protections pass');
} finally {
  child.kill('SIGTERM');await closed;
  await rm(fixture,{recursive:true,force:true});
}
