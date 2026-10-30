/** Real local MCP + owner API, fake Cloudflare executable. No external tunnel. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCloudflareLauncher,CLOUD_ACCESS_MODES} from '../dist/gcfCloudflareLauncher.js';
import {startControlCenter} from '../dist/gcfControlCenter.js';

assert.deepEqual(CLOUD_ACCESS_MODES,{read:{write:'handoff',bash:'off'},edit:{write:'workspace',bash:'off'},test:{write:'workspace',bash:'safe'},full:{write:'workspace',bash:'full'}});
const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gcf-cloud-oneclick-')));
const a=path.join(dir,'Project A'),b=path.join(dir,'Project B');
fs.mkdirSync(a);fs.mkdirSync(b);
const fake=path.join(dir,'cloudflared-mock');
const report=path.join(dir,'local-port.txt');
fs.writeFileSync(fake,[
'#!/usr/bin/env node',
"const fs=require('node:fs');",
"const local=new URL(process.argv.at(-1));",
`fs.writeFileSync(${JSON.stringify(report)},local.port);`,
"process.stderr.write('https://qa-fixture.trycloudflare.com\\n');",
"setInterval(()=>{},5000);"
].join('\n'));
fs.chmodSync(fake,0o700);
const manifest=path.join(dir,'projects.json');
fs.writeFileSync(manifest,JSON.stringify({version:1,roots:[a,b]})+'\n');
let approve=false, approvals=0;
const cloud=createCloudflareLauncher(process.cwd(),{cloudflaredPath:fake});
const owner=await startControlCenter({manifest,sourceRoot:process.cwd(),cloudLauncher:cloud,approveChange:async()=>{approvals++;return approve;}});
const request=(route,body,headers={})=>fetch(owner.origin+route,{method:'POST',headers:{origin:owner.origin,'content-type':'application/json',...headers},body:JSON.stringify(body)});
try{
  assert.equal((await request('/owner/cloudflare',{action:'start',projects:[a],access:'read',fullAccessConfirmed:false})).status,401);
  let response=await request('/owner/session',{code:owner.bootstrapCode});
  assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie').split(';')[0];
  const html=await(await fetch(owner.origin+'/',{headers:{cookie}})).text();
  const csrf=html.match(/const csrf="([a-f0-9]{64})"/)?.[1];assert.ok(csrf);
  const auth={cookie,'x-gcf-csrf':csrf};
  assert.equal((await request('/owner/cloudflare',{action:'start',projects:[a],access:'read',fullAccessConfirmed:false},{cookie})).status,403);
  assert.equal((await request('/owner/cloudflare',{action:'start',projects:[dir],access:'read',fullAccessConfirmed:false},auth)).status,400);
  assert.equal((await request('/owner/cloudflare',{action:'start',projects:[a],access:'full',fullAccessConfirmed:true},auth)).status,400);
  assert.equal(approvals,0,'Invalid requests never prompt owner or start external processes.');
  response=await request('/owner/cloudflare',{action:'start',projects:[a],access:'read',fullAccessConfirmed:false},auth);
  assert.equal(response.status,200);
  assert.equal((await response.json()).cancelled,true,'macOS denial must not start a tunnel');
  assert.equal(cloud.status().state,'stopped');
  approve=true;
  response=await request('/owner/cloudflare',{action:'start',projects:[a],access:'read',fullAccessConfirmed:false},auth);
  assert.equal(response.status,200,response.status===200?'':`Cloudflare fixture rejected: ${JSON.stringify(await response.clone().json()).slice(0,400)}`);
  const result=(await response.json()).cloudflare;
  assert.equal(result.state,'tunnel_ready');assert.equal(result.access,'read');assert.equal(result.project,a);assert.deepEqual(result.projects,[a]);
  assert.ok(result.serverUrl.startsWith('https://qa-fixture.trycloudflare.com/mcp?'));
  assert.equal(new URL(result.serverUrl).searchParams.get('gcf_token')?.length,64);
  assert.equal((await request('/owner/cloudflare',{action:'start',projects:[b],access:'edit',fullAccessConfirmed:false},auth)).status,400,'stop before switching');
  const port=Number(fs.readFileSync(report,'utf8'));
  assert.ok(Number.isInteger(port)&&port>0);
  const url='http://127.0.0.1:'+port;
  assert.equal((await fetch(url+'/healthz')).status,401);
  const token=new URL(result.serverUrl).searchParams.get('gcf_token');
  response=await fetch(url+'/healthz',{headers:{Authorization:'Bearer '+token}});
  assert.equal(response.status,200,'real local MCP requires its token');
  const config=await(await fetch(url+'/admin/profile',{headers:{Authorization:'Bearer '+token}})).json();
  assert.ok(!JSON.stringify(config).includes(b),'second project excluded from remote scope');
  const health=await(await fetch(url+'/healthz',{headers:{Authorization:'Bearer '+token}})).json();
  assert.deepEqual(health.allowedRoots,[a],'one project only when one selected');
  assert.equal(health.writeMode,'handoff');assert.equal(health.bashMode,'off');
  response=await request('/owner/cloudflare',{action:'stop'},auth);
  assert.equal(response.status,200);
  assert.equal((await response.json()).cloudflare.state,'stopped');
  assert.equal(cloud.status().serverUrl,undefined,'secret cleared from state on disconnect');
  let networkClosed=false;
  for(let i=0;i<25;i++){
    try{await fetch(url+'/healthz',{signal:AbortSignal.timeout(300)});}catch{networkClosed=true;break;}
    await new Promise(resolve=>setTimeout(resolve,80));
  }
  assert.equal(networkClosed,true,'Disconnect must terminate real local HTTP process');
  // Multi-project session: both explicitly selected roots and one shared access level.
  response=await request('/owner/cloudflare',{action:'start',projects:[a,b],access:'edit',fullAccessConfirmed:false},auth);
  assert.equal(response.status,200);
  const multi=(await response.json()).cloudflare;
  assert.deepEqual(multi.projects,[a,b]);assert.equal(multi.access,'edit');
  const multiPort=Number(fs.readFileSync(report,'utf8'));
  const multiUrl='http://127.0.0.1:'+multiPort;
  const multiToken=new URL(multi.serverUrl).searchParams.get('gcf_token');
  assert.notEqual(multiToken,token,'reconnect rotates bearer token');
  const multiHealth=await(await fetch(multiUrl+'/healthz',{headers:{Authorization:'Bearer '+multiToken}})).json();
  assert.deepEqual(multiHealth.allowedRoots,[a,b]);assert.equal(multiHealth.writeMode,'workspace');assert.equal(multiHealth.bashMode,'off');
  response=await request('/owner/cloudflare',{action:'stop'},auth);
  assert.equal(response.status,200);assert.equal(cloud.status().serverUrl,undefined);
  assert.equal((await request('/owner/cloudflare',{action:'stop',project:a},auth)).status,400);
  console.log('PASS owner-local Cloudflare one-click (fake tunnel): auth + CSRF + consent, scoped real MCP, token, no double start, stop, cleared secret.');
}finally{
  await cloud.stop();
  await new Promise(done=>owner.server.close(done));
  fs.rmSync(dir,{recursive:true,force:true});
}
