import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {parseWorkerArguments,runLocalWorker,workerControl} from './gcf-local-auto-worker.mjs';
assert.equal(parseWorkerArguments(['--worktree','/tmp/project','--mode','auto','--once']).mode,'auto');
for(const args of [['--worktree','relative'],['--worktree','/tmp/x','--mode','full'],['--worktree','/tmp/x','--interval-ms','100']])
  assert.throws(()=>parseWorkerArguments(args));
const base=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-worker-test-'));
const root=path.join(base,'repo'),bin=path.join(base,'bin');
const originalHome=process.env.HOME;
process.env.HOME=path.join(base,'home');
await fs.mkdir(process.env.HOME,{mode:0o700});
const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
try{
 await fs.mkdir(path.join(root,'.ai-bridge'),{recursive:true});
 await fs.mkdir(path.join(root,'src')); await fs.mkdir(bin);
 await fs.writeFile(path.join(root,'.gitignore'),'.ai-bridge/\n');
 await fs.writeFile(path.join(root,'src/file.txt'),'start\n');
 git('init','-q');git('add','.');git('-c','user.name=Test','-c','user.email=x@example.invalid','commit','-qm','baseline');
 const id='transfer_'+randomUUID(), task='task_'+randomUUID();
 const taskData={schema_version:1,task_id:task,status:'in_progress',goal:'Edit file',
   target_paths:['src/file.txt'],plan_steps:['Modify file'],created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
 await fs.writeFile(path.join(root,'.ai-bridge/current-task.json'),JSON.stringify(taskData));
 await fs.writeFile(path.join(root,'.ai-bridge/transfer-control.json'),JSON.stringify({
   id,task_id:task,from:'chatgpt_lead',to:'codex_lead',state:'accepted',
   git_head:git('rev-parse','HEAD'),git_status_sha256:createHash('sha256').update('\0\0').digest('hex'),
   created_at:new Date().toISOString(),expires_at:new Date(Date.now()+300000).toISOString(),
   handoff:{goal:taskData.goal,target_paths:taskData.target_paths,plan:taskData.plan_steps}}));
 await fs.writeFile(path.join(bin,'codex'),'#!/bin/sh\ncat >/dev/null\nprintf "done\\n" > src/file.txt\nexit 0\n',{mode:0o755});
 const old=process.env.PATH;
 process.env.PATH=bin+path.delimiter+old;
 try{
  const first=await runLocalWorker({worktree:root,mode:'auto',once:true});
  assert.equal(first.processed,1);
  const status=JSON.parse(await fs.readFile(first.history,'utf8'));
  assert.equal(status.results[id].status,'returned',JSON.stringify(status));
  assert.ok((await fs.readdir(path.join(root,'.ai-bridge/task-inbox'))).some(x=>x.endsWith('.json')));
  const second=await runLocalWorker({worktree:root,mode:'auto',once:true});
  assert.equal(second.processed,0,'duplicate dispatch prohibited');
  const workerStatus=await workerControl({worktree:root,action:'status'});
  assert.equal(workerStatus.worker_lock_present,false);
  assert.equal(workerStatus.records,1);
  const stop=await workerControl({worktree:root,action:'stop'});
  assert.equal(stop.stop_requested,false);
  const stateDir=path.dirname(first.history),lock=path.join(stateDir,'worker.lock');
  // A previously claimed job survives restart; no automatic retry after crash.
  const claimed='transfer_'+randomUUID();
  const transferFile=path.join(root,'.ai-bridge/transfer-control.json');
  const transfer=JSON.parse(await fs.readFile(transferFile,'utf8'));
  git('checkout','--','src/file.txt');
  transfer.id=claimed;
  await fs.writeFile(transferFile,JSON.stringify(transfer));
  const prior=JSON.parse(await fs.readFile(first.history,'utf8'));
  prior.results[claimed]={status:'claimed',started_at:new Date().toISOString()};
  await fs.writeFile(first.history,JSON.stringify(prior));
  assert.equal((await runLocalWorker({worktree:root,mode:'auto',once:true})).processed,0);
  // Supervised mode never dispatches accepted transfers or claims them.
  transfer.id='transfer_'+randomUUID();
  await fs.writeFile(transferFile,JSON.stringify(transfer));
  const supervisedEvents=[];
  assert.equal((await runLocalWorker({worktree:root,once:true,onEvent:e=>supervisedEvents.push(e)})).processed,0);
  assert.equal(supervisedEvents[0].event,'awaiting_manual_approval');
  // Expired task is durably blocked once, never retried.
  transfer.expires_at=new Date(Date.now()-1).toISOString();
  await fs.writeFile(transferFile,JSON.stringify(transfer));
  assert.equal((await runLocalWorker({worktree:root,mode:'auto',once:true})).processed,1);
  assert.equal((await workerControl({worktree:root,action:'status'})).results[transfer.id].status,'blocked');
  assert.equal((await runLocalWorker({worktree:root,mode:'auto',once:true})).processed,0);
  transfer.expires_at=new Date(Date.now()+300000).toISOString();
  // Stop cancels the current process group. Another worker cannot acquire its lock.
  transfer.id='transfer_'+randomUUID();
  await fs.writeFile(transferFile,JSON.stringify(transfer));
  const marker=path.join(base,'child-started');
  await fs.writeFile(path.join(bin,'codex'),'#!/bin/sh\ncat >/dev/null\ntouch "'+marker+'"\nsleep 30\n',{mode:0o755});
  const active=runLocalWorker({worktree:root,mode:'auto',model:'fixture-model',effort:'high'});
  const started=Date.now();
  while(!await fs.access(marker).then(()=>true,()=>false)){
    assert.ok(Date.now()-started<10000,'fake child must start');
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  await assert.rejects(runLocalWorker({worktree:root,mode:'auto',once:true}),{code:'EEXIST'});
  const activeStatus=await workerControl({worktree:root,action:'status'});
  assert.equal(activeStatus.worker_lock_present,true);
  assert.equal(activeStatus.running_verified,false);
  assert.equal(activeStatus.active_transfer_id,transfer.id);
  assert.equal(activeStatus.results[transfer.id].requested_model,'fixture-model');
  assert.equal(activeStatus.results[transfer.id].requested_reasoning_effort,'high');
  await assert.rejects(workerControl({worktree:root,action:'recover'}),/PID exists/);
  assert.equal((await workerControl({worktree:root,action:'stop'})).stop_requested,true);
  await active;
  assert.ok(Date.now()-started<10000,'stop must interrupt child rather than wait 30 seconds');
  assert.equal((await workerControl({worktree:root,action:'status'})).results[transfer.id].status,'cancelled');
  const cancelledResult=(await workerControl({worktree:root,action:'status'})).results[transfer.id];
  assert.match(cancelledResult.return_message_id,/^inbox_/,'cancelled process returns an incomplete receipt');
  const cancelledNote=JSON.parse(await fs.readFile(path.join(root,'.ai-bridge/task-inbox',cancelledResult.return_message_id+'.json'),'utf8'));
  assert.match(cancelledNote.request,/INCOMPLETE/);
  // An explicit owner recovery archives only a lock whose recorded PID is gone.
  const deadLock={schema_version:1,pid:2147483647,key:randomUUID(),active_job:null,started_at:new Date().toISOString()};
  await fs.writeFile(lock,JSON.stringify({...deadLock,active_job:transfer.id}),{mode:0o600});
  await assert.rejects(workerControl({worktree:root,action:'recover'}),/surviving descendants/);
  assert.equal((await workerControl({worktree:root,action:'status'})).interrupted_job_requires_review,true);
  await fs.writeFile(lock,JSON.stringify(deadLock),{mode:0o600});
  await assert.rejects(runLocalWorker({worktree:root,once:true}),{code:'EEXIST'});
  const outsideControl=path.join(base,'outside-control-sentinel');
  await fs.writeFile(outsideControl,'must remain unchanged',{mode:0o600});
  await fs.link(outsideControl,path.join(stateDir,'stop-requested'));
  await workerControl({worktree:root,action:'stop'});
  assert.equal(await fs.readFile(outsideControl,'utf8'),'must remain unchanged',
    'stop publication must replace, never truncate a linked file');
  assert.equal((await workerControl({worktree:root,action:'recover'})).recovered,true);
  assert.equal(JSON.parse(await fs.readFile(path.join(stateDir,'recovered-'+deadLock.key+'.json'),'utf8')).key,deadLock.key);
  assert.equal((await runLocalWorker({worktree:root,mode:'auto',once:true})).processed,0);
  // Record symlinks and owner-state parent symlinks fail closed.
  const transferBackup=transferFile+'.fixture-backup';
  await fs.rename(transferFile,transferBackup);await fs.symlink(transferBackup,transferFile);
  await assert.rejects(runLocalWorker({worktree:root,mode:'auto',once:true}),/Unsafe transfer/);
  await fs.unlink(transferFile);await fs.rename(transferBackup,transferFile);
  const stateBase=path.join(process.env.HOME,'.codexbridge'),backup=stateBase+'.fixture-backup';
  await fs.rename(stateBase,backup);await fs.symlink(backup,stateBase);
  await assert.rejects(runLocalWorker({worktree:root,mode:'auto',once:true}),/owner-only real directory/);
  await fs.unlink(stateBase);await fs.rename(backup,stateBase);
  console.log('PASS: supervised refusal, expired-task replay, concurrent fence, live cancellation, stale recovery, preferences and symlink defenses');

 } finally {process.env.PATH=old}
 console.log('PASS: owner-local Auto daemon processed accepted transfer once with fake Codex and durable MCP result; replay suppressed');
}finally{if(originalHome===undefined)delete process.env.HOME;else process.env.HOME=originalHome;await fs.rm(base,{recursive:true,force:true})}
