import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {previewNativeTransfer} from './gcf-native-transfer-preview.mjs';
import {reviewOwnerHandoff} from './gcf-native-transfer-owner-review.mjs';
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-transfer-native-'));
const root=path.join(tmp,'repo'), bin=path.join(tmp,'bin');
let client;
const git=(...args)=>{const p=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(p.status,0,p.stderr);return p.stdout.trim();};
try{
 await fs.mkdir(path.join(root,'.ai-bridge'),{recursive:true});
 await fs.mkdir(bin);
 await fs.writeFile(path.join(root,'.gitignore'),'.ai-bridge/\n');
 await fs.writeFile(path.join(root,'a.txt'),'baseline\n');
 git('init','-q');git('add','.');git('-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','-q','-m','baseline');
 await fs.writeFile(path.join(bin,'codex'),'#!/bin/sh\nexit 99\n',{mode:0o755});
 const taskId='task_'+randomUUID(),id='transfer_'+randomUUID();
 const now=new Date().toISOString();
 const task={schema_version:1,task_id:taskId,status:'in_progress',goal:'Change a.txt',
   target_paths:['a.txt'],plan_steps:['Review then change a.txt'],created_at:now,updated_at:now};
 const transfer={id,task_id:taskId,from:'chatgpt_lead',to:'codex_lead',state:'accepted',git_head:git('rev-parse','HEAD'),
  git_status_sha256:createHash('sha256').update('\0\0').digest('hex'),created_at:new Date().toISOString(),
  expires_at:new Date(Date.now()+600000).toISOString(),handoff:{goal:'Change a.txt',target_paths:['a.txt'],plan:['Review then change a.txt']}};
 const save=async()=>{await fs.writeFile(path.join(root,'.ai-bridge/current-task.json'),JSON.stringify(task));await fs.writeFile(path.join(root,'.ai-bridge/transfer-control.json'),JSON.stringify(transfer));};
 await save();
 const x=await previewNativeTransfer({worktree:root,searchPath:bin});
 assert.equal(x.status,'READY_FOR_OWNER_REVIEW');assert.equal(x.preview_only,true);assert.equal(x.agent_started,false);
 assert.deepEqual(x.allowed_paths,['a.txt']);assert.equal(x.owner_action_required,true);
 assert.equal(Object.hasOwn(x,'_local_plan'),false);
 const ownerPreview=await previewNativeTransfer({worktree:root,searchPath:bin,includeLocalPlan:true});
 assert.match(ownerPreview._local_plan,/Only modify allowed paths/);
 assert.equal(createHash('sha256').update(ownerPreview._local_plan).digest('hex'),ownerPreview.plan_sha256);
 assert.equal(ownerPreview._local_codex_binary,path.join(bin,'codex'));
 assert.equal(ownerPreview.model_called,false);
 const review=await reviewOwnerHandoff({worktree:root,searchPath:bin});
 assert.equal(review.native_execution_performed,false);
 assert.equal(review.local_codex_detected,true);
 assert.equal(review.plan_for_owner_review,ownerPreview._local_plan);
 assert.equal(JSON.stringify(review).includes('_local_codex_binary'),false);
 // Real MCP request/accept round trip in a disposable clean Git fixture.
 // The confirmation flags below model test consent, NOT verified human identity.
 await fs.rm(path.join(root,'.ai-bridge/transfer-control.json'));
 client = new Client({name:'gcf-accepted-transfer-integration-fixture',version:'1.0.0'},{capabilities:{}});
 await client.connect(new StdioClientTransport({
   command:process.execPath,
   args:['dist/stdio.js','--root',root,'--allow-root',root,
     '--tool-mode','standard','--write','workspace','--bash','off'],
   cwd:process.cwd(),
   env:{...process.env,CODEXBRIDGE_ROOT:root,CODEXBRIDGE_ALLOWED_ROOTS:root}
 }));
 const request=await client.callTool({name:'request_transfer',
   arguments:{task_id:taskId,from:'chatgpt_lead',to:'codex_lead',user_confirmed:true}});
 assert.equal(Boolean(request.isError),false,JSON.stringify(request));
 const actualId=request.structuredContent.transfer.id;
 const accept=await client.callTool({name:'accept_transfer',
   arguments:{transfer_id:actualId,recipient:'codex_lead',user_confirmed:true}});
 assert.equal(Boolean(accept.isError),false,JSON.stringify(accept));
 assert.equal(accept.structuredContent.transfer.state,'accepted');
 const integrated=await reviewOwnerHandoff({worktree:root,searchPath:bin});
 assert.equal(integrated.transfer_id,actualId);
 assert.equal(integrated.git_snapshot_matches_transfer,true);
 assert.equal(integrated.native_execution_performed,false);
 await client.close();client=undefined;
 console.log('PASS: real MCP request + accept to read-only Native owner review in disposable clean Git fixture');
 // Restore standalone negative-case fixture after genuine MCP transfer.
 await save();
 transfer.state='requested';await save();await assert.rejects(previewNativeTransfer({worktree:root,searchPath:bin}),/Accepted/);
 transfer.state='accepted';transfer.handoff.target_paths=['../outside'];await save();await assert.rejects(previewNativeTransfer({worktree:root,searchPath:bin}),/safe owned file/);
 transfer.handoff.target_paths=['a.txt'];transfer.expires_at=new Date(Date.now()-1000).toISOString();await save();
 await assert.rejects(previewNativeTransfer({worktree:root,searchPath:bin}),/expired/);
 transfer.expires_at=new Date(Date.now()+600000).toISOString();await save();
 transfer.git_status_sha256='0'.repeat(64);await save();
 await assert.rejects(previewNativeTransfer({worktree:root,searchPath:bin}),/mismatched transfer Git snapshot/);
 transfer.git_status_sha256=createHash('sha256').update('\0\0').digest('hex');await save();
 transfer.handoff.plan=['silently different task'];await save();
 await assert.rejects(previewNativeTransfer({worktree:root,searchPath:bin}),/differs from active task/);
 transfer.handoff.plan=['Review then change a.txt'];await save();
 await fs.appendFile(path.join(root,'a.txt'),'dirty\n');
 await assert.rejects(previewNativeTransfer({worktree:root,searchPath:bin}),/clean disposable/);
 console.log('PASS: accepted Codex transfer has read-only preview, missing consent cannot execute');
 console.log('PASS: requested, traversal, expiry and dirty worktree refused');
}finally{if(client)await client.close();await fs.rm(tmp,{recursive:true,force:true});}
