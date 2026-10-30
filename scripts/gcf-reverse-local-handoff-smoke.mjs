// Offline no-API, two-connection Codex → ChatGPT handoff on approved Git roots.
// Separate local MCP SDK clients represent client ROLES, not real AI identities.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {makeProjectRootsManifest} from '../dist/projectRootsFile.js';
import {fileURLToPath} from 'node:url';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cli=path.join(repo,'scripts','gcf-cli.mjs');
const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gcf-reverse-handoff-')));
const a=path.join(temporary,'Project A');
const b=path.join(temporary,'Project B');
const foreign=path.join(temporary,'Outside');
const manifest=path.join(temporary,'approved','projects.json');
const clients=[];
async function fixture(root){
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.gitignore'),'.ai-bridge/\n');
  await fs.writeFile(path.join(root,'src.txt'),path.basename(root)+'\n');
  await fs.mkdir(path.join(root,'src'),{recursive:true});
  await fs.mkdir(path.join(root,'test'),{recursive:true});
  await fs.writeFile(path.join(root,'src/message.mjs'),"export const message = () => 'before';\n");
  await fs.writeFile(path.join(root,'test/message.test.mjs'),"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {message} from '../src/message.mjs';\ntest('reverse recipient implements fix',()=>assert.equal(message(),'after'));\n");
  const git=(...args)=>{
    const result=spawnSync('git',args,{cwd:root,encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr);
  };
  git('init','-q');git('add','.gitignore','src.txt','src/message.mjs','test/message.test.mjs');
  git('-c','user.name=GCF Test','-c','user.email=fixture@example.invalid',
      'commit','-q','-m','fixture');
}
async function connect(name,write='handoff'){
  const client=new Client({name,version:'1.0.0'},{capabilities:{}});
  await client.connect(new StdioClientTransport({
    command:process.execPath,
    args:[cli,'start','--manifest',manifest,'--transport','stdio','--write',write,'--bash','off'],
    cwd:repo,
    env:{...process.env,GCF_ALLOWED_ROOTS:foreign,
      CODEBASE_BRIDGE_ALLOWED_ROOTS:foreign,GCF_ALLOW_HOME:'1',GCF_ROOT:foreign}
  }));
  clients.push(client);
  return client;
}
function result(v,label){
  assert.equal(Boolean(v.isError),false,label+': '+JSON.stringify(v));
  return v.structuredContent;
}
function call(c,name,args={}){
  return c.callTool({name,arguments:args});
}
try{
  await Promise.all([fixture(a),fixture(b),fixture(foreign)]);
  await fs.mkdir(path.dirname(manifest),{recursive:true,mode:0o700});
  await fs.writeFile(manifest,JSON.stringify(makeProjectRootsManifest([a,b]))+'\n',{mode:0o600});
  const prior=await fs.readFile(manifest,'utf8');
  const codex=await connect('fixture-codex-lead');
  const chatgpt=await connect('fixture-chatgpt-lead');
  const list=result(await call(codex,'list_projects'),'codex roots');
  assert.deepEqual(list.projects.map(item=>item.root),[a,b]);
  assert.equal(list.requires_selection,true);
  const projectB=list.projects.find(item=>item.root===b);
  const id=projectB.project_id;
  assert.ok((await call(codex,'task_resume')).isError,
    'multi-root calls cannot select an implicit project');
  const codexSelected=result(await call(codex,'select_project',{project_id:id}),'codex select');
  assert.equal(codexSelected.root,b);
  const chatSelected=result(await call(chatgpt,'select_project',{project_id:id}),'chatgpt select');
  assert.equal(chatSelected.root,b);
  assert.equal(chatSelected.workspace_id,codexSelected.workspace_id);
  const task=result(await call(codex,'task_plan',{
    workspace_id:id,goal:'Implement code change after Codex to ChatGPT handoff',
    target_paths:['src/message.mjs'],plan_steps:['Inspect existing bug','Edit implementation','Run Node unit test','Return evidence to Codex']
  }),'codex task');
  assert.match(task.task_id,/^task_/);
  const requested=result(await call(codex,'request_transfer',{
    workspace_id:id,task_id:task.task_id,from:'codex_lead',to:'chatgpt_lead',
    user_confirmed:true
  }),'request reverse transfer');
  const transferId=requested.transfer.id;
  assert.equal(requested.transfer.state,'requested');
  assert.ok((await call(chatgpt,'accept_transfer',{
    workspace_id:id,transfer_id:transferId,recipient:'chatgpt_lead',user_confirmed:false
  })).isError,'unconfirmed acceptance must fail');
  // Simulate a fresh ChatGPT process after a chat-window switch.
  await chatgpt.close();
  // Workspace-write is granted by the explicitly configured MCP client, NOT by Transfer Control.
  const resumed=await connect('fixture-fresh-chatgpt','workspace');
  assert.ok((await call(resumed,'task_resume')).isError,
    'a new connection must explicitly re-select with multiple roots');
  result(await call(resumed,'select_project',{project_id:id}),'new chat re-selection');
  const resume=result(await call(resumed,'task_resume',{workspace_id:id}),'task resume');
  assert.equal(resume.task_id,task.task_id);
  const status=result(await call(resumed,'transfer_status',{workspace_id:id}),'transfer status');
  assert.equal(status.transfer.id,transferId);
  const received=result(await call(resumed,'accept_transfer',{
    workspace_id:id,transfer_id:transferId,recipient:'chatgpt_lead',user_confirmed:true
  }),'reverse accept');
  assert.equal(received.transfer.state,'accepted');
  const unit=(root)=>spawnSync(process.execPath,['--test','test/message.test.mjs'],{
    cwd:root,encoding:'utf8',timeout:12000
  });
  assert.equal(unit(b).status,1,'reverse coding fixture starts red');
  const edited=result(await call(resumed,'edit',{workspace_id:id,
    path:'src/message.mjs',old_text:"'before'",new_text:"'after'"
  }),'fresh client edits source after reverse handoff');
  assert.ok(edited,'edit returned structured result');
  assert.equal(unit(b).status,0,'reverse recipient actually changed implementation and test passes');
  assert.equal(unit(a).status,1,'different approved project remained unchanged');
  const posted=result(await call(resumed,'task_inbox_post',{workspace_id:id,
    task_id:task.task_id,from:'chatgpt_lead',to:'codex_lead',
    title:'Reverse transfer coding result for review',
    request:'Changed src/message.mjs (before → after); node --test test/message.test.mjs passed in Project B. SDK clients simulate roles, do not attest model identities.',
    user_confirmed:true
  }),'ChatGPT-like recipient posts correlated task receipt');
  const receivedByCodex=result(await call(codex,'task_inbox_read',{workspace_id:id,message_id:posted.message.id}),'original Codex-like client reads code result');
  assert.equal(receivedByCodex.message.task_id,task.task_id);
  assert.equal(receivedByCodex.message.to,'codex_lead');
  const note=result(await call(resumed,'project_summary',{workspace_id:id}),'project summary');
  assert.equal(note.active_task.task_id,task.task_id);
  const forbidden=await call(codex,'write',{
    workspace_id:id,path:'src.txt',content:'should never happen\n'
  });
  assert.equal(forbidden.isError,true,'handoff-only cannot edit source');
  assert.equal((await call(codex,'bash',{workspace_id:id,command:'pwd'})).isError,true,
    'Bash must be disabled');
  const out=await call(codex,'open_workspace',{root:foreign,include_tree:false,include_skills:false});
  assert.equal(out.isError,true,'unapproved root must be denied');
  assert.equal(await fs.readFile(path.join(a,'src.txt'),'utf8'),'Project A\n');
  assert.equal(await fs.readFile(path.join(b,'src.txt'),'utf8'),'Project B\n');
  assert.equal(await fs.readFile(manifest,'utf8'),prior);
  console.log('PASS: Codex-like local MCP client → persisted handoff → fresh ChatGPT-like local MCP client');
  console.log('PASS: fresh ChatGPT-role client used authenticated owner-allowed workspace MCP edit to implement JavaScript change, then native Node unit test passed and Codex-role client read Inbox result');
  console.log('PASS: owner project selection, task recovery, acceptance guard, note-only mode, no Bash, no unauthorized root');
  console.log('LIMIT: SDK role fixture only, NOT a real ChatGPT consumer UI/cross-model takeover, genuine Codex agent, or independently authenticated model identity');
}finally{
  await Promise.allSettled(clients.map(client=>client.close()));
  await fs.rm(temporary,{recursive:true,force:true});
}
