// Disposable loopback HTTP startup smoke for GPT Codex Flow local launcher.
// Test credential is generated at runtime; no user secrets or public tunnel.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import {makeProjectRootsManifest} from '../dist/projectRootsFile.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const launcher=path.join(sourceRoot,'scripts','gcf-cli.mjs');
const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gcf-http-loopback-')));
const a=path.join(temp,'Git-A');
const b=path.join(temp,'Git-B');
const manifest=path.join(temp,'projects.json');
async function freePort(){
 return await new Promise((resolve,reject)=>{
  const server=net.createServer();
  server.once('error',reject);
  server.listen(0,'127.0.0.1',()=>{
    const address=server.address();
    server.close(()=>resolve(address.port));
  });
 });
}
let child;
try {
  for(const root of [a,b]){
    await fs.mkdir(root);
    const r=spawnSync('git',['init','-q'],{cwd:root,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
  }
  await fs.writeFile(manifest,JSON.stringify(makeProjectRootsManifest([a,b]))+'\n');
  // Test that authenticated localhost HTTP exposes inbox text just like stdio.
  const noteId='inbox_3cc65cf6-2abe-41f3-a87d-60ea1b0ef901';
  const taskId='task_3cc65cf6-2abe-41f3-a87d-60ea1b0ef902';
  const request='Review this local HTTP handoff. No model execution.';
  const inboxPath=path.join(b,'.ai-bridge','task-inbox');
  await fs.mkdir(inboxPath,{recursive:true,mode:0o700});
  await fs.writeFile(path.join(inboxPath,noteId+'.json'),JSON.stringify({
    schema_version:1,id:noteId,task_id:taskId,
    from:'codex_lead',to:'chatgpt_lead',title:'Loopback review',request,
    created_at:'2026-10-17T12:00:00.000Z',state:'pending'
  })+'\n',{mode:0o600});
  const port=await freePort();
  const ephemeral=randomBytes(32).toString('hex');
  const env={...process.env,CODEXBRIDGE_HTTP_TOKEN:ephemeral,
    CODEXBRIDGE_ALLOW_HOME:'1',CODEXBRIDGE_ALLOWED_ROOTS:temp,
    NO_COLOR:'1'};
  const command=[launcher,'start','--manifest',manifest,
    '--transport','http','--port',String(port)];
  child=spawn(process.execPath,command,{
    cwd:temp,env,stdio:['ignore','ignore','pipe'],shell:false
  });
  let errors='';
  child.stderr.on('data',chunk=>{errors=(errors+String(chunk)).slice(-1700);});
  let healthy=false;
  for(let attempts=0;attempts<45;attempts++){
    if(child.exitCode!==null)break;
    await new Promise(done=>setTimeout(done,140));
    try{
      const response=await fetch('http://127.0.0.1:'+port+'/healthz',{
        headers:{Authorization:'Bearer '+ephemeral},
        signal:AbortSignal.timeout(650)
      });
      if(response.ok){healthy=true;break;}
    }catch{}
  }
  assert.equal(healthy,true,'local HTTP listener never became ready: '+errors);
  const unauthorized=await fetch('http://127.0.0.1:'+port+'/mcp',{
    signal:AbortSignal.timeout(1500)
  });
  assert.ok([400,401,403,405,406].includes(unauthorized.status),
    'unauthenticated MCP request must not succeed: '+unauthorized.status);
  const mcpClient=new Client({name:'gcf-local-http-auth-integration',version:'1.0.0'},{capabilities:{}});
  try{
    const transport=new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+port+'/mcp'),{
      requestInit:{headers:{Authorization:'Bearer '+ephemeral}}
    });
    await mcpClient.connect(transport);
    const projects=(await mcpClient.callTool({name:'list_projects',arguments:{}})).structuredContent;
    assert.deepEqual(projects.projects.map(x=>x.root),[a,b]);
    const found=(await mcpClient.callTool({name:'find_project',arguments:{name:'Git-B'}})).structuredContent;
    assert.equal(found.status,'unique');
    const picked=(await mcpClient.callTool({name:'select_project',arguments:{project_id:found.matches[0].project_id}})).structuredContent;
    assert.equal(picked.root,b);
    const listResponse=await mcpClient.callTool({name:'task_inbox_list',arguments:{workspace_id:picked.workspace_id,to:'chatgpt_lead'}});
    assert.equal(Boolean(listResponse.isError),false);
    assert.equal(listResponse.structuredContent.count,1);
    assert.equal(listResponse.structuredContent.entries[0].id,noteId);
    const listText=listResponse.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
    assert.ok(listText.includes(noteId),'HTTP MCP text must expose inbox note ID');
    assert.ok(!listText.includes(request),'HTTP list must not expose note body');
    const readResponse=await mcpClient.callTool({name:'task_inbox_read',arguments:{workspace_id:picked.workspace_id,message_id:noteId}});
    assert.equal(Boolean(readResponse.isError),false);
    const readText=readResponse.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
    assert.ok(readText.includes(JSON.stringify(request)),'HTTP MCP text must expose JSON-encoded note body');
    assert.equal(readResponse.structuredContent.message.request,request);
    const refusedPost=await mcpClient.callTool({name:'task_inbox_post',arguments:{
      workspace_id:picked.workspace_id,task_id:taskId,from:'codex_lead',to:'chatgpt_lead',
      title:'Forbidden',request:'Must not post',user_confirmed:true
    }});
    assert.equal(refusedPost.isError,true,'HTTP read-only client cannot post notes');
    const denied=await mcpClient.callTool({name:'write',arguments:{workspace_id:picked.workspace_id,path:'http-should-not-write.txt',content:'blocked'}});
    assert.equal(denied.isError,true,'HTTP default must deny write');
    const foreign=await mcpClient.callTool({name:'open_workspace',arguments:{root:temp,include_tree:false,include_skills:false}});
    assert.equal(foreign.isError,true,'HTTP must not authorize arbitrary parent root');
    console.log('PASS: authenticated HTTP MCP protocol list/find/select works; write and broad parent denied');
    console.log('PASS: authenticated loopback HTTP inbox list/read text-only interoperates and note post is refused');
  }finally{await mcpClient.close();}
  console.log('PASS: local HTTP listener ready on loopback and unauthenticated MCP request rejected');
}finally{
  if(child){
    child.kill('SIGTERM');
    await new Promise(resolve=>{
      if(child.exitCode!==null || child.signalCode!==null) return resolve();
      const timeout=setTimeout(()=>{child.kill('SIGKILL');resolve();},1400);
      child.once('exit',()=>{clearTimeout(timeout);resolve();});
    });
  }
  await fs.rm(temp,{recursive:true,force:true});
}
