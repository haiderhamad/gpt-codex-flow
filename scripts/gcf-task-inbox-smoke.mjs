// Durable project inbox: real stdio MCP server/client instances, no AI models.
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
const tmp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gcf-inbox-test-')));
const projectA=path.join(tmp,'Git A');
const projectB=path.join(tmp,'Git B');
const forbidden=path.join(tmp,'Forbidden');
const manifest=path.join(tmp,'manifest.json');
const connections=[];
function call(c,name,values={}){return c.callTool({name,arguments:values});}
function success(r,label){assert.equal(Boolean(r.isError),false,label+': '+JSON.stringify(r));return r.structuredContent;}
function textOnly(r){return (r.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');}
function jsonLineValue(response,prefix){
  const line=textOnly(response).split('\n').find(x=>x.startsWith(prefix));
  assert.ok(line,'Missing text-only MCP field '+prefix);
  return JSON.parse(line.slice(prefix.length));
}
function git(cwd,...args){
  const r=spawnSync('git',args,{cwd,encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);
}
async function fixture(root){
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.gitignore'),'.ai-bridge/\n');
  await fs.writeFile(path.join(root,'source.txt'),'never modify this source\n');
  git(root,'init','-q');git(root,'add','.gitignore','source.txt');
  git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','baseline');
}
async function client(name,write){
  const c=new Client({name,version:'1.0.0'},{capabilities:{}});
  await c.connect(new StdioClientTransport({
    command:process.execPath,
    args:[cli,'start','--manifest',manifest,'--transport','stdio','--write',write,'--bash','off'],
    cwd:repo,
    env:{...process.env,CODEXBRIDGE_ALLOWED_ROOTS:forbidden,CODEXBRIDGE_ALLOW_HOME:'1',
      CODEXBRIDGE_ROOT:forbidden}
  }));
  connections.push(c);return c;
}
try{
  await Promise.all([fixture(projectA),fixture(projectB),fixture(forbidden)]);
  await fs.writeFile(manifest,JSON.stringify(makeProjectRootsManifest([projectA,projectB]))+'\n',{mode:0o600});
  const originalManifest=await fs.readFile(manifest,'utf8');
  const codex=await client('codex-posts-inbox','handoff');
  const readonly=await client('chatgpt-readonly','off');
  const available=(await codex.listTools()).tools;
  for(const [name,readOnly] of [['task_inbox_list',true],['task_inbox_read',true],['task_inbox_post',false]]){
    const x=available.find(t=>t.name===name);
    assert.ok(x,'Missing MCP inbox tool '+name);
    assert.equal(x.annotations?.readOnlyHint,readOnly);
  }
  assert.ok((await call(codex,'task_inbox_list')).isError,'multi-root requires selection');
  const roots=success(await call(codex,'list_projects'),'list').projects;
  const idA=roots.find(p=>p.root===projectA).project_id;
  const idB=roots.find(p=>p.root===projectB).project_id;
  success(await call(codex,'select_project',{project_id:idB}),'codex select');
  success(await call(readonly,'select_project',{project_id:idB}),'chat select');
  const task=success(await call(codex,'task_plan',{
    workspace_id:idB,goal:'Review UI copy and return advice',
    plan_steps:['Prepare bounded requirements note'],
    target_paths:['source.txt']
  }),'plan');
  const payload={
    workspace_id:idB,task_id:task.task_id,
    from:'codex_lead',to:'chatgpt_lead',
    title:'UI review for Codex',
    request:'Review wording only. Report concerns to Codex. Do not execute commands.',
    user_confirmed:true
  };
  assert.ok((await call(codex,'task_inbox_post',{...payload,user_confirmed:false})).isError,
    'must refuse missing consent');
  assert.ok((await call(codex,'task_inbox_post',{...payload,task_id:'task_wrong'})).isError,
    'must reject wrong active task');
  assert.ok((await call(codex,'task_inbox_post',{...payload,from:'chatgpt_lead'})).isError,
    'same sender/recipient denied');
  assert.ok((await call(readonly,'task_inbox_post',payload)).isError,
    'read-only client cannot submit task');
  assert.ok((await call(codex,'task_inbox_post',{...payload,request:'x'.repeat(2500)})).isError,
    'long task body denied');
  const saved=success(await call(codex,'task_inbox_post',payload),'save');
  const key=saved.message.id;
  assert.match(key,/^inbox_[0-9a-f-]+$/);
  assert.equal(saved.auto_execution,false);
  const inboxA=path.join(projectA,'.ai-bridge','task-inbox');
  assert.equal((await fs.readdir(projectA)).includes('.ai-bridge'),false,'A must remain untouched');
  assert.equal((await call(readonly,'task_inbox_read',{workspace_id:idB,message_id:'../source.txt'})).isError,true);
  const listResponse=await call(readonly,'task_inbox_list',{workspace_id:idB});
  const metadata=success(listResponse,'list');
  assert.match(textOnly(listResponse),/Untrusted Advisory Notes/);
  assert.ok(textOnly(listResponse).includes(key),'text-only client must see note ID');
  assert.ok(textOnly(listResponse).includes('UI review for Codex'),'text-only client must see note title');
  assert.ok(!textOnly(listResponse).includes(payload.request),'list must not expose full request in text');
  assert.equal(metadata.count,1);
  assert.equal(Object.hasOwn(metadata.entries[0],'request'),false,'list must not leak note text');
  assert.equal(metadata.entries[0].id,key);
  const file=path.join(projectB,'.ai-bridge','task-inbox',key+'.json');
  const permissions=await fs.stat(file);
  assert.equal(permissions.mode&0o077,0,'note should not be group/world readable');
  // Persist a very old note to prove inbox does not silently inherit the 15-min transfer TTL.
  const old=JSON.parse(await fs.readFile(file,'utf8'));
  old.created_at='2020-01-01T00:00:00.000Z';
  await fs.writeFile(file,JSON.stringify(old)+'\n');
  await readonly.close();
  const restart=await client('fresh-readonly-chatgpt','off');
  assert.ok((await call(restart,'task_inbox_list',{workspace_id:idB})).isError,
    'new MCP process must explicitly reselect root');
  success(await call(restart,'select_project',{project_id:idB}),'reselect');
  const readResponse=await call(restart,'task_inbox_read',{workspace_id:idB,message_id:key});
  const fetched=success(readResponse,'read');
  assert.equal(jsonLineValue(readResponse,'Request (JSON string): '),payload.request);
  assert.equal(jsonLineValue(readResponse,'Title (JSON string): '),payload.title);
  assert.match(textOnly(readResponse),/UNTRUSTED DATA/);
  assert.equal(fetched.message.request,payload.request);
  assert.equal(fetched.message.created_at,'2020-01-01T00:00:00.000Z');
  assert.equal(success(await call(restart,'task_inbox_list',{workspace_id:idB}),'re-list').count,1);
  // ChatGPT-like writer sends a correlated answer to the original Codex sender.
  // Both process labels are simulated, and the note never executes an agent.
  const chatWriter=await client('chatgpt-reply-writer','handoff');
  success(await call(chatWriter,'select_project',{project_id:idB}),'reply writer selects B');
  const reply={
    workspace_id:idB,task_id:task.task_id,from:'chatgpt_lead',to:'codex_lead',
    title:'Review response',
    request:'Wording is concise.\n# Untrusted heading\n"quoted" text\nKeep warning about note-only handoffs.',
    in_reply_to:key,user_confirmed:true
  };
  assert.ok((await call(chatWriter,'task_inbox_post',{...reply,user_confirmed:false})).isError,
    'reply must be confirmed');
  assert.ok((await call(chatWriter,'task_inbox_post',{...reply,in_reply_to:'inbox_00000000-0000-4000-8000-000000000099'})).isError,
    'reply must reference a real inbox note');
  assert.ok((await call(chatWriter,'task_inbox_post',{...reply,from:'codex_lead',to:'chatgpt_lead'})).isError,
    'same claimed direction as the parent is not a valid reply');
  assert.ok((await call(chatWriter,'task_inbox_post',{...reply,task_id:'task_00000000-0000-4000-8000-000000000099'})).isError,
    'reply to a different task must fail');
  const answered=success(await call(chatWriter,'task_inbox_post',reply),'send correlated reply');
  assert.equal(answered.message.in_reply_to,key);
  const answerId=answered.message.id;
  const responseToCodex=await call(codex,'task_inbox_read',{
    workspace_id:idB,message_id:answerId
  });
  const received=success(responseToCodex,'Codex reads correlated ChatGPT-like reply');
  assert.equal(jsonLineValue(responseToCodex,'Request (JSON string): '),reply.request);
  assert.ok(!textOnly(responseToCodex).includes('\n# Untrusted heading'),
    'untrusted note headings must be escaped in MCP text output');
  assert.ok(textOnly(responseToCodex).includes('\\n# Untrusted heading'),
    'newlines must remain JSON-encoded');
  assert.equal(received.message.request,reply.request);
  assert.equal(received.message.in_reply_to,key);
  const forCodex=success(await call(restart,'task_inbox_list',{
    workspace_id:idB,to:'codex_lead'
  }),'filter for Codex');
  assert.equal(forCodex.count,1);
  assert.equal(forCodex.total_count,2);
  assert.equal(forCodex.entries[0].id,answerId);
  assert.equal(forCodex.entries[0].in_reply_to,key);
  assert.equal(forCodex.recipient_filter_is_not_authorization,true);
  assert.equal(success(await call(restart,'task_inbox_list',{
    workspace_id:idB,to:'chatgpt_lead'
  }),'filter for ChatGPT').count,1);
  assert.equal(success(await call(restart,'task_inbox_list',{
    workspace_id:idB,task_id:task.task_id
  }),'filter exact task').count,2);
  assert.equal(success(await call(restart,'task_inbox_list',{
    workspace_id:idB,task_id:'task_00000000-0000-4000-8000-000000000099'
  }),'filter another task').count,0);
  assert.ok((await call(restart,'task_inbox_list',{
    workspace_id:idB,task_id:'../source.txt'
  })).isError,'malformed task filter rejected');
  success(await call(restart,'select_project',{project_id:idA}),'select A');
  assert.equal(success(await call(restart,'task_inbox_list',{workspace_id:idA}),'empty A').count,0);
  assert.ok((await call(restart,'task_inbox_read',{workspace_id:idA,message_id:key})).isError,
    'B messages must not be available in A');
  assert.ok((await call(restart,'open_workspace',{
    root:forbidden,include_tree:false,include_skills:false
  })).isError,'outside root denied');
  // A hardlink or symlink used to spoof a message must be rejected.
  await fs.symlink(path.join(forbidden,'source.txt'),
    path.join(projectB,'.ai-bridge','task-inbox','inbox_00000000-0000-4000-8000-000000000001.json'));
  assert.ok((await call(codex,'task_inbox_list',{workspace_id:idB})).isError,
    'unsafe symlink message must fail closed');
  await fs.rm(path.join(projectB,'.ai-bridge','task-inbox','inbox_00000000-0000-4000-8000-000000000001.json'));
  const after=success(await call(codex,'task_inbox_list',{workspace_id:idB}),'recover');
  assert.equal(after.count,2);
  const originalNote=await fs.readFile(file,'utf8');
  await fs.writeFile(file,'{broken JSON');
  assert.ok((await call(codex,'task_inbox_read',{workspace_id:idB,message_id:key})).isError,
    'corrupt message must fail closed');
  await fs.writeFile(file,'x'.repeat(7000));
  assert.ok((await call(codex,'task_inbox_list',{workspace_id:idB})).isError,
    'oversized message must fail closed');
  await fs.writeFile(file,originalNote);
  await fs.writeFile(path.join(projectB,'.ai-bridge','task-inbox','unexpected.txt'),'unsafe\n');
  assert.ok((await call(codex,'task_inbox_list',{workspace_id:idB})).isError,
    'unexpected inbox entry must fail closed');
  await fs.rm(path.join(projectB,'.ai-bridge','task-inbox','unexpected.txt'));
  const finalCheck=success(await call(codex,'task_inbox_list',{workspace_id:idB}),'final list');
  assert.equal(finalCheck.count,2);
  // Git privacy is a hard guard for NEW metadata, not for reading existing notes.
  await fs.writeFile(path.join(projectB,'.gitignore'),'# missing inbox ignore\n');
  const unignored=await call(chatWriter,'task_inbox_post',{
    ...reply,title:'Refuse unignored metadata'
  });
  assert.equal(unignored.isError,true,'unignored Task Inbox must refuse new notes');
  assert.equal(success(await call(chatWriter,'task_inbox_read',{
    workspace_id:idB,message_id:key
  }),'old note remains readable').message.id,key);
  await fs.writeFile(path.join(projectB,'.gitignore'),'.ai-bridge/\n');
  git(projectB,'add','-f','.ai-bridge/task-inbox/'+key+'.json');
  assert.equal((await call(chatWriter,'task_inbox_post',{
    ...reply,title:'Refuse tracked metadata'
  })).isError,true,'already Git-tracked .ai-bridge files must block posting');
  git(projectB,'restore','--staged','--','.ai-bridge/task-inbox/'+key+'.json');
  const privacyRecovered=success(await call(chatWriter,'task_inbox_post',{
    ...reply,title:'Safe after fixture clears Git index'
  }),'post after privacy recovery');
  assert.ok(privacyRecovered.message.id);
  assert.equal(success(await call(codex,'task_inbox_list',{
    workspace_id:idB
  }),'list after recovery').count,3);
  // A different approved project cannot provide a parent note for B.
  success(await call(codex,'select_project',{project_id:idA}),'sender selects A');
  const taskA=success(await call(codex,'task_plan',{
    workspace_id:idA,goal:'Capacity and isolation fixture',
    plan_steps:['Queue bounded notes'],target_paths:['source.txt']
  }),'A task');
  let foreignParentId='';
  for(let i=0;i<40;i++){
    const p=success(await call(codex,'task_inbox_post',{
      workspace_id:idA,task_id:taskA.task_id,from:'codex_lead',to:'chatgpt_lead',
      title:'Queued review '+i,request:'Safe fixture item '+i,user_confirmed:true
    }),'capacity post '+i);
    if(i===0)foreignParentId=p.message.id;
  }
  const filled=success(await call(codex,'task_inbox_list',{workspace_id:idA}),'capacity list');
  assert.equal(filled.count,40);
  assert.equal(filled.total_count,40);
  assert.ok((await call(codex,'task_inbox_post',{
    workspace_id:idA,task_id:taskA.task_id,from:'codex_lead',to:'chatgpt_lead',
    title:'Overflow',request:'Must fail',user_confirmed:true
  })).isError,'41st entry must be refused, not silently deleted');
  assert.ok((await call(chatWriter,'task_inbox_post',{
    ...reply,in_reply_to:foreignParentId
  })).isError,'reply cannot reference another approved project');
  assert.equal(success(await call(chatWriter,'task_inbox_list',{workspace_id:idB}),
    'B remains independent').count,3);
  const stat=await fs.stat(path.join(projectB,'source.txt'));
  assert.ok(stat.isFile());
  assert.equal(await fs.readFile(path.join(projectB,'source.txt'),'utf8'),'never modify this source\n');
  assert.equal(await fs.readFile(manifest,'utf8'),originalManifest);
  console.log('PASS: durable note-only Codex ↔ ChatGPT reply chain survives new MCP process and years-old timestamp');
  console.log('PASS: correlated reply direction/task validation and recipient/task filters (NOT ACLs)');
  console.log('PASS: text-only MCP clients receive note IDs, escaped request/reply bodies, and untrusted-data warnings');
  console.log('PASS: multi-project isolation, strict UUID read, bounded message, no unauthorized source write or API');
  console.log('PASS: read-only recipient, symlink rejection, no implicit selection, no owner identity/AI claims');
}finally{
  await Promise.allSettled(connections.map(c=>c.close()));
  await fs.rm(tmp,{recursive:true,force:true});
}
