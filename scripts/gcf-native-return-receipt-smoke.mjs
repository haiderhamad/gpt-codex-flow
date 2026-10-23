import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {composeOwnerReturnReceipt,publishOwnerReturnReceipt,composeOwnerFailureReceipt,publishOwnerFailureReceipt} from './gcf-native-return-receipt.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const task_id='task_'+randomUUID(),transfer_id='transfer_'+randomUUID();
const proof={status:'CODEX_PROCESS_EXITED_REVIEW_REQUIRED',codex_invoked:true,
 postflight_passed:true,exit_code:0,timed_out:false,termination_reason:null,
 tests_run:false,merged:false,task_id,transfer_id,plan_sha256:'a'.repeat(64),
 allowed_paths:['src/message.txt'],changed_paths:['src/message.txt']};
const note=composeOwnerReturnReceipt(proof);
assert.equal(note.task_id,task_id);
assert.equal(note.to,'chatgpt_lead');
assert.match(note.request,/Tests run: NO/);
for(const overrides of [
 {status:'BLOCKED_POSTFLIGHT_OR_EXECUTION'},
 {codex_invoked:false},{postflight_passed:false},{exit_code:1},
 {changed_paths:['src/other.txt']},{tests_run:true},{merged:true}
])assert.throws(()=>composeOwnerReturnReceipt({...proof,...overrides}),/postflight/);
assert.throws(()=>composeOwnerReturnReceipt(proof,{inReplyTo:'bad'}),/parent/);

const base=await mkdtemp(join(tmpdir(),'gcf-native-result-'));
const root=join(base,'repo'),bridge=join(root,'.ai-bridge');
const git=(...args)=>{
 const r=spawnSync('git',args,{cwd:root,encoding:'utf8',timeout:10000});
 assert.equal(r.status,0,r.stderr);return r.stdout.trim();
};
try {
 await mkdir(join(root,'src'),{recursive:true});
 await mkdir(bridge,{recursive:true});
 await writeFile(join(root,'.gitignore'),'.ai-bridge/\n');
 await writeFile(join(root,'src/message.txt'),'after\n');
 git('init','-q');git('add','.');
 git('-c','user.name=GCF Test','-c','user.email=test@example.invalid','commit','-q','-m','init');
 const task={schema_version:1,task_id,status:'in_progress',goal:'Review returned result',
  target_paths:['src/message.txt'],plan_steps:['Review diff'],
  created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
 await writeFile(join(bridge,'current-task.json'),JSON.stringify(task));
 const posted=await publishOwnerReturnReceipt({worktree:root,result:proof});
 assert.equal(posted.posted,true);
 assert.equal(posted.model_identity_verified,false);
 const body=JSON.parse(await readFile(join(bridge,'task-inbox',posted.message_id+'.json'),'utf8'));
 assert.equal(body.to,'chatgpt_lead');
 assert.equal(body.task_id,task_id);
 assert.match(body.request,/postflight: PASS/);
 assert.equal(body.in_reply_to,undefined);
 await assert.rejects(publishOwnerReturnReceipt({worktree:root,result:{...proof,postflight_passed:false}}),/postflight/);
 const failed={...proof,status:'BLOCKED_POSTFLIGHT_OR_EXECUTION',exit_code:null,
  termination_reason:'ABORT',postflight_passed:false,postflight_reasons:['NO_SOURCE_CHANGE']};
 assert.match(composeOwnerFailureReceipt(failed).request,/INCOMPLETE/);
 assert.throws(()=>composeOwnerFailureReceipt({...failed,postflight_reasons:['unsafe\ncontent']}),/bounded failed/);
 assert.throws(()=>composeOwnerFailureReceipt({...proof,status:'BLOCKED_POSTFLIGHT_OR_EXECUTION',postflight_reasons:[]}),/bounded failed/);
 const cancelled=await publishOwnerFailureReceipt({worktree:root,result:failed});
 const fresh=new Client({name:'fresh-failed-result-reader',version:'1.0.0'},{capabilities:{}});
 try {
  await fresh.connect(new StdioClientTransport({command:process.execPath,args:['dist/stdio.js',
   '--root',root,'--allow-root',root,'--write','off','--bash','off'],cwd:process.cwd()}));
  const projects=await fresh.callTool({name:'list_projects',arguments:{}});
  const project=projects.structuredContent.projects[0];
  await fresh.callTool({name:'select_project',arguments:{project_id:project.project_id}});
  const recovered=await fresh.callTool({name:'task_inbox_list',arguments:{workspace_id:project.project_id,to:'chatgpt_lead'}});
  assert.equal(recovered.isError,undefined);
  assert.ok(JSON.stringify(recovered).includes(cancelled.message_id));
  const recoveredBody=await fresh.callTool({name:'task_inbox_read',arguments:{workspace_id:project.project_id,message_id:cancelled.message_id}});
  assert.equal(recoveredBody.isError,undefined);
  assert.match(JSON.stringify(recoveredBody),/INCOMPLETE/);
 } finally {await fresh.close();}
 console.log('PASS: distinct cancelled/failure receipt survives a fresh read-only MCP session without success or child-output claims');
 console.log('PASS: postflight-gated owner return note uses real MCP Task Inbox; no model or shell invoked');
 console.log('PASS: invalid results cannot be posted; recipient role remains advisory');
} finally {await rm(base,{recursive:true,force:true});}
