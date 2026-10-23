import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ownerNativeHandoff } from './gcf-native-transfer-run.mjs';

const temp=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-owner-transfer-'));
const root=path.join(temp,'repo'),bin=path.join(temp,'bin');
const sentinel=path.join(temp,'WOULD_HAVE_EXECUTED');
const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
const transfer_id='transfer_'+randomUUID();
const task_id='task_'+randomUUID();
const now=new Date().toISOString();
const expiry=new Date(Date.now()+600000).toISOString();
const task={
  schema_version:1,task_id,status:'in_progress',goal:'Update message file',
  target_paths:['src/message.txt'],plan_steps:['Change the message string only'],
  created_at:now,updated_at:now
};
const transfer={
  id:transfer_id,task_id,from:'chatgpt_lead',to:'codex_lead',state:'accepted',
  git_head:null,git_status_sha256:createHash('sha256').update('\0\0').digest('hex'),
  created_at:now,expires_at:expiry,
  handoff:{goal:task.goal,target_paths:task.target_paths,plan:task.plan_steps}
};
try {
  await fs.mkdir(path.join(root,'.ai-bridge'),{recursive:true});
  await fs.mkdir(path.join(root,'src'),{recursive:true});
  await fs.mkdir(bin);
  await fs.writeFile(path.join(root,'.gitignore'),'.ai-bridge/\n');
  await fs.writeFile(path.join(root,'src/message.txt'),'before\n');
  git('init','-q');git('add','.');
  git('-c','user.name=GCF Test','-c','user.email=test@example.invalid','commit','-q','-m','baseline');
  transfer.git_head=git('rev-parse','HEAD');
  await fs.writeFile(path.join(root,'.ai-bridge/current-task.json'),JSON.stringify(task));
  await fs.writeFile(path.join(root,'.ai-bridge/transfer-control.json'),JSON.stringify(transfer));
  await fs.writeFile(path.join(bin,'codex'),'#!/bin/sh\ntouch "'+sentinel+'"\nexit 55\n',{mode:0o755});
  const fsmonitor=path.join(temp,'fsmonitor.sh'),monitorMarker=path.join(temp,'monitor-ran');
  await fs.writeFile(fsmonitor,'#!/bin/sh\ntouch "'+monitorMarker+'"\nexit 3\n',{mode:0o755});
  git('config','core.fsmonitor',fsmonitor);
  const preview=await ownerNativeHandoff({worktree:root,searchPath:bin});
  await assert.rejects(fs.access(monitorMarker),{code:'ENOENT'});
  git('-c','core.fsmonitor=false','config','--unset','core.fsmonitor');
  assert.equal(preview.status,'READY_FOR_OWNER_REVIEW');
  assert.equal(preview.codex_invoked,false);
  assert.equal(preview.owner_action_required,true);
  assert.equal(preview.broker_authorized,false);
  assert.equal(preview.model_request_verified,false);
  assert.equal(preview.command_argv.at(-1),'-');
  for(const flag of ['--ignore-user-config','--ephemeral'])assert.ok(preview.command_argv.includes(flag));
  assert.ok(!preview.command_argv.includes('--ignore-rules'),'retain execution policy rules');
  assert.ok(preview.command_argv.includes('sandbox_workspace_write.network_access=false'));
  assert.deepEqual(preview.allowed_paths,['src/message.txt']);
  assert.match(preview.pinned_executable_sha256,/^[a-f0-9]{64}$/);
  await assert.rejects(fs.access(sentinel),{code:'ENOENT'});
  const configured=await ownerNativeHandoff({
    worktree:root,searchPath:bin,model:'gpt-5.3-codex',effort:'high'
  });
  assert.ok(configured.command_argv.includes('gpt-5.3-codex'));
  assert.ok(configured.command_argv.includes('model_reasoning_effort="high"'));
  assert.equal(configured.requested_reasoning_effort,'high');
  assert.equal(configured.model_request_verified,false);
  const fullPreview=await ownerNativeHandoff({worktree:root,searchPath:bin,fullAccess:true});
  assert.ok(fullPreview.command_argv.includes('danger-full-access'));
  assert.equal(fullPreview.full_access_requested,true);
  assert.equal(fullPreview.codex_invoked,false);
  for(const invalid of [
    {model:'codex;touch /tmp/x'},
    {model:'--danger'},
    {effort:'unlimited'},
    {effort:'LOW'}
  ])await assert.rejects(ownerNativeHandoff({worktree:root,searchPath:bin,...invalid}));
  await assert.rejects(ownerNativeHandoff({worktree:root,searchPath:bin,run:true}),/interactive terminal/);
  await assert.rejects(ownerNativeHandoff({worktree:root,searchPath:bin,run:true,fullAccess:true}),/interactive terminal/);
  await assert.rejects(ownerNativeHandoff({worktree:root,searchPath:bin,run:true,ownerAutoOnce:true,fullAccess:true}),/Full Access requires explicit/);
  const cli=spawnSync(process.execPath,['scripts/gcf-native-transfer-run.mjs','--worktree',root,'--run'],{
    cwd:process.cwd(),env:{...process.env,PATH:bin+path.delimiter+(process.env.PATH??'')},
    encoding:'utf8',timeout:10000
  });
  assert.equal(cli.status,2);
  assert.match(cli.stderr,/interactive terminal/);
  await assert.rejects(fs.access(sentinel),{code:'ENOENT'});
  // Explicitly owner-started single-transfer auto mode is NOT a remote MCP grant.
  // A disposable fake Codex process verifies the actual bounded subprocess,
  // scoped Git postflight and return note; no subscription-backed model.
  const missingId=spawnSync(process.execPath,[
    'scripts/gcf-native-transfer-run.mjs','--worktree',root,
    '--run','--return-to-inbox','--owner-auto-once'
  ],{cwd:process.cwd(),env:{...process.env,PATH:bin+path.delimiter+(process.env.PATH??'')},encoding:'utf8',timeout:10000});
  assert.equal(missingId.status,2);
  assert.match(missingId.stderr,/requires.*transfer-id/);
  const wrongId=spawnSync(process.execPath,[
    'scripts/gcf-native-transfer-run.mjs','--worktree',root,
    '--run','--return-to-inbox','--owner-auto-once',
    '--transfer-id','transfer_'+randomUUID()
  ],{cwd:process.cwd(),env:{...process.env,PATH:bin+path.delimiter+(process.env.PATH??'')},encoding:'utf8',timeout:10000});
  assert.equal(wrongId.status,2);
  assert.match(wrongId.stderr,/transfer ID mismatch/);
  await assert.rejects(fs.access(sentinel),{code:'ENOENT'});
  await fs.writeFile(path.join(bin,'codex'),
    '#!/bin/sh\ncat >/dev/null\nprintf "after\\n" > src/message.txt\nexit 0\n',{mode:0o755});
  const auto=spawnSync(process.execPath,[
    'scripts/gcf-native-transfer-run.mjs','--worktree',root,
    '--run','--return-to-inbox','--owner-auto-once',
    '--transfer-id',transfer_id,'--effort','high'
  ],{cwd:process.cwd(),env:{...process.env,PATH:bin+path.delimiter+(process.env.PATH??'')},
    encoding:'utf8',timeout:30000});
  assert.equal(auto.status,0,auto.stderr+'\n'+auto.stdout.slice(-2000));
  assert.match(auto.stdout,/"return_note_posted": true/);
  const inbox=await fs.readdir(path.join(root,'.ai-bridge/task-inbox'));
  assert.equal(inbox.filter(x=>x.endsWith('.json')).length,1);
  const returned=JSON.parse(await fs.readFile(path.join(root,'.ai-bridge/task-inbox',inbox[0]),'utf8'));
  assert.equal(returned.task_id,task_id);
  assert.equal(returned.to,'chatgpt_lead');
  assert.match(returned.request,/Tests run: NO/);
  // Restore a clean baseline so the remaining denial cases are independent.
  git('checkout','--','src/message.txt');
  await fs.writeFile(path.join(bin,'codex'),'#!/bin/sh\ntouch "'+sentinel+'"\nexit 55\n',{mode:0o755});
  transfer.state='requested';
  await fs.writeFile(path.join(root,'.ai-bridge/transfer-control.json'),JSON.stringify(transfer));
  await assert.rejects(ownerNativeHandoff({worktree:root,searchPath:bin}),/Accepted/);
  transfer.state='accepted';
  transfer.expires_at=new Date(Date.now()-1).toISOString();
  await fs.writeFile(path.join(root,'.ai-bridge/transfer-control.json'),JSON.stringify(transfer));
  await assert.rejects(ownerNativeHandoff({worktree:root,searchPath:bin}),/expired/);
  transfer.expires_at=new Date(Date.now()+600000).toISOString();
  await fs.writeFile(path.join(root,'.ai-bridge/transfer-control.json'),JSON.stringify(transfer));
  await fs.writeFile(path.join(root,'src/message.txt'),'changed before approval\n');
  await assert.rejects(ownerNativeHandoff({worktree:root,searchPath:bin}),/clean disposable worktree/);
  await assert.rejects(fs.access(sentinel),{code:'ENOENT'});
  console.log('PASS: accepted clean handoff preview pins real executable without launching a model');
  console.log('PASS: bounded model/effort preferences, non-TTY execution, requested/expired/dirty and injection denied');
}finally{
  await fs.rm(temp,{recursive:true,force:true});
}
