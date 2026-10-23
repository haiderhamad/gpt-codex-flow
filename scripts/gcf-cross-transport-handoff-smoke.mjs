// M17: cross-transport MCP fixture with NO model API; disposable Git roots only.
// Names simulate client roles: not actual authenticated Codex or ChatGPT agents.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {makeProjectRootsManifest} from '../dist/projectRootsFile.js';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cli=path.join(repo,'scripts','gcf-cli.mjs');
const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gcf-cross-transport-')));
const approvedA=path.join(temp,'Approved A');
const approvedB=path.join(temp,'Approved B');
const excluded=path.join(temp,'Excluded C');
const manifest=path.join(temp,'owner-roots.json');
const token=randomBytes(32).toString('hex');
const clients=[];
let httpChild;
let serverErrors='';
const call=(client,name,args={})=>client.callTool({name,arguments:args});
function ok(response,label){
  assert.equal(Boolean(response.isError),false,label+': '+JSON.stringify(response));
  return response.structuredContent;
}
const textOf=response=>(response.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
async function setupGit(root){
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'data.txt'),'source unchanged\n');
  await fs.writeFile(path.join(root,'.gitignore'),'.ai-bridge/\n');
  for(const args of [
    ['init','-q'],['add','data.txt','.gitignore'],
    ['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','fixture']
  ]){
    const r=spawnSync('git',args,{cwd:root,encoding:'utf8',timeout:10000});
    assert.equal(r.status,0,'git failed: '+r.stderr);
  }
}
async function getPort(){
  return new Promise((resolve,reject)=>{
    const listener=net.createServer();
    listener.once('error',reject);
    listener.listen(0,'127.0.0.1',()=>{
      const addr=listener.address();
      listener.close(()=>resolve(addr.port));
    });
  });
}
async function startHttp(port){
  httpChild=spawn(process.execPath,[cli,'start','--transport','http','--port',String(port),
    '--manifest',manifest,'--write','handoff','--bash','off'],{
      cwd:repo,shell:false,stdio:['ignore','ignore','pipe'],
      env:{...process.env,CODEXBRIDGE_HTTP_TOKEN:token,CODEXBRIDGE_ROOT:excluded,
        CODEXBRIDGE_ALLOWED_ROOTS:excluded,CODEBASE_BRIDGE_ALLOWED_ROOTS:excluded,
        CODEXBRIDGE_ALLOW_HOME:'1'}
    });
  httpChild.stderr.on('data',chunk=>{serverErrors=(serverErrors+String(chunk)).slice(-1600);});
  let healthy=false;
  for(let i=0;i<45;i++){
    if(httpChild.exitCode!==null)break;
    await new Promise(resolve=>setTimeout(resolve,140));
    try{
      const response=await fetch('http://127.0.0.1:'+port+'/healthz',{
        headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(700)
      });
      if(response.ok){healthy=true;break;}
    }catch{}
  }
  assert.equal(healthy,true,'HTTP start failed: '+serverErrors);
}
async function stopHttp(){
  const child=httpChild;
  httpChild=undefined;
  if(!child || child.exitCode!==null || child.signalCode!==null)return;
  child.kill('SIGTERM');
  await new Promise(resolve=>{
    const timeout=setTimeout(()=>{child.kill('SIGKILL');resolve();},1500);
    child.once('exit',()=>{clearTimeout(timeout);resolve();});
  });
}
async function connectHttp(port,name){
  const client=new Client({name,version:'1.0.0'},{capabilities:{}});
  const transport=new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+port+'/mcp'),{
    requestInit:{headers:{Authorization:'Bearer '+token}}
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}
async function connectStdio(){
  const client=new Client({name:'codex-role-stdio-fixture',version:'1.0.0'},{capabilities:{}});
  await client.connect(new StdioClientTransport({
    command:process.execPath,args:[cli,'start','--transport','stdio','--manifest',manifest,
      '--write','handoff','--bash','off'],
    cwd:repo,
    env:{...process.env,CODEXBRIDGE_ROOT:excluded,
      CODEXBRIDGE_ALLOWED_ROOTS:excluded,CODEBASE_BRIDGE_ALLOWED_ROOTS:excluded,
      CODEXBRIDGE_ALLOW_HOME:'1'}
  }));
  clients.push(client);
  return client;
}
try{
  await Promise.all([setupGit(approvedA),setupGit(approvedB),setupGit(excluded)]);
  await fs.writeFile(manifest,JSON.stringify(makeProjectRootsManifest([approvedA,approvedB]))+'\n',{mode:0o600});
  const manifestBefore=await fs.readFile(manifest,'utf8');
  const port=await getPort();
  await startHttp(port);
  const invalid=await fetch('http://127.0.0.1:'+port+'/mcp',{signal:AbortSignal.timeout(1500)});
  assert.ok([400,401,403,405,406].includes(invalid.status),'anonymous HTTP MCP denied');
  const wrong=await fetch('http://127.0.0.1:'+port+'/mcp',{
    headers:{Authorization:'Bearer wrong'},signal:AbortSignal.timeout(1500)
  });
  assert.ok([400,401,403,405,406].includes(wrong.status),'bad token denied');
  const stdio=await connectStdio();
  const http=await connectHttp(port,'chatgpt-role-http-fixture');
  const roots=ok(await call(stdio,'list_projects'),'stdio projects').projects;
  assert.deepEqual(roots.map(p=>p.root),[approvedA,approvedB]);
  assert.deepEqual(ok(await call(http,'list_projects'),'http projects').projects.map(p=>p.root),
    [approvedA,approvedB]);
  const idB=roots.find(p=>p.root===approvedB).project_id;
  const idA=roots.find(p=>p.root===approvedA).project_id;
  assert.ok((await call(http,'task_inbox_list')).isError,'explicit root selection required');
  ok(await call(stdio,'select_project',{project_id:idB}),'stdio selection');
  ok(await call(http,'select_project',{project_id:idB}),'http selection');
  const task=ok(await call(stdio,'task_plan',{
    workspace_id:idB,goal:'Cross-transport communication with no source changes',
    target_paths:['data.txt'],plan_steps:['Post','Reply','Review']
  }),'stdio task');
  assert.equal(ok(await call(http,'task_resume',{workspace_id:idB}),
    'HTTP recovered task').task_id,task.task_id);
  const request={workspace_id:idB,task_id:task.task_id,from:'codex_lead',to:'chatgpt_lead',
    title:'Cross transport request',request:'Review this note only. No model invoked.',user_confirmed:true};
  assert.ok((await call(stdio,'task_inbox_post',{...request,user_confirmed:false})).isError);
  const posted=ok(await call(stdio,'task_inbox_post',request),'STDIO post').message;
  const listed=await call(http,'task_inbox_list',{workspace_id:idB,to:'chatgpt_lead'});
  assert.equal(ok(listed,'HTTP lists STDIO post').entries[0].id,posted.id);
  assert.ok(textOf(listed).includes(posted.id),'HTTP text contains STDIO note ID');
  const body=await call(http,'task_inbox_read',{workspace_id:idB,message_id:posted.id});
  assert.equal(ok(body,'HTTP reads STDIO note').message.request,request.request);
  assert.ok(textOf(body).includes(JSON.stringify(request.request)),'HTTP text contains STDIO note body');
  const replyText='Received over HTTP.\nReturn through STDIO.';
  const replyArgs={workspace_id:idB,task_id:task.task_id,from:'chatgpt_lead',to:'codex_lead',
    title:'Cross transport reply',request:replyText,in_reply_to:posted.id,user_confirmed:true};
  assert.ok((await call(http,'task_inbox_post',{...replyArgs,in_reply_to:'inbox_wrong'})).isError);
  const reply=ok(await call(http,'task_inbox_post',replyArgs),'HTTP reply').message;
  assert.equal(reply.in_reply_to,posted.id);
  const returned=await call(stdio,'task_inbox_read',{workspace_id:idB,message_id:reply.id});
  assert.equal(ok(returned,'STDIO reads HTTP reply').message.request,replyText);
  assert.ok(textOf(returned).includes(JSON.stringify(replyText)),'STDIO text contains HTTP reply');
  assert.equal(ok(await call(stdio,'task_inbox_list',{
    workspace_id:idB,to:'codex_lead',task_id:task.task_id
  }),'STDIO filtered reply').entries[0].id,reply.id);
  await http.close();
  await stopHttp();
  await startHttp(port);
  const recovered=await connectHttp(port,'fresh-http-client-after-restart');
  assert.ok((await call(recovered,'task_inbox_list',{workspace_id:idB})).isError,
    'fresh HTTP session must explicitly choose a project');
  ok(await call(recovered,'select_project',{project_id:idB}),'HTTP reselect');
  assert.equal(ok(await call(recovered,'task_inbox_list',{
    workspace_id:idB
  }),'restart preserves inbox').count,2);
  assert.equal(ok(await call(recovered,'task_inbox_read',{
    workspace_id:idB,message_id:reply.id
  }),'restart preserves reply link').message.in_reply_to,posted.id);
  ok(await call(recovered,'select_project',{project_id:idA}),'HTTP select A');
  assert.equal(ok(await call(recovered,'task_inbox_list',{
    workspace_id:idA
  }),'empty A inbox').count,0);
  assert.ok((await call(recovered,'task_inbox_read',{
    workspace_id:idA,message_id:posted.id
  })).isError,'cross-root inbox access denied');
  assert.ok((await call(stdio,'write',{
    workspace_id:idB,path:'data.txt',content:'not authorized\n'
  })).isError,'STDIO handoff-only denies source write');
  assert.ok((await call(recovered,'bash',{
    workspace_id:idA,command:'pwd'
  })).isError,'HTTP Bash denied');
  assert.ok((await call(recovered,'open_workspace',{
    root:excluded,include_tree:false,include_skills:false
  })).isError,'unapproved root denied');
  for(const root of [approvedA,approvedB,excluded]){
    assert.equal(await fs.readFile(path.join(root,'data.txt'),'utf8'),'source unchanged\n');
  }
  assert.equal(await fs.readFile(manifest,'utf8'),manifestBefore);
  console.log('PASS: actual MCP STDIO post -> authenticated loopback HTTP read/reply -> STDIO read');
  console.log('PASS: independent HTTP subprocess restart preserves shared inbox and task');
  console.log('PASS: bad/absent tokens, source writes, Bash and unapproved root refused');
  console.log('LIMIT: simulated client roles; no real ChatGPT/Codex apps or models used');
}finally{
  await Promise.allSettled(clients.map(c=>c.close()));
  await stopHttp();
  await fs.rm(temp,{recursive:true,force:true});
}
