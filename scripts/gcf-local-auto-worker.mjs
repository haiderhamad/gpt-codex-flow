#!/usr/bin/env node
// GPT Codex Flow: owner-launched local per-project queue worker.
// No remote MCP executable API, no automatic privilege escalation, no shell.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {ownerNativeHandoff} from './gcf-native-transfer-run.mjs';

const UUID=/^transfer_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const modes=['supervised','auto'];
export function parseWorkerArguments(argv){
  let worktree,mode='supervised',intervalMs=3000,once=false,model,effort='auto',action='run';
  for(let i=0;i<argv.length;i++){
    const a=argv[i];
    if(a==='--worktree'&&!worktree&&argv[i+1])worktree=argv[++i];
    else if(a==='--mode'&&argv[i+1])mode=argv[++i];
    else if(a==='--interval-ms'&&argv[i+1])intervalMs=Number(argv[++i]);
    else if(a==='--once'&&!once)once=true;
    else if(a==='--status'&&action==='run')action='status';
    else if(a==='--stop'&&action==='run')action='stop';
    else if(a==='--recover-stale-lock'&&action==='run')action='recover';
    else if(a==='--model'&&!model&&argv[i+1])model=argv[++i];
    else if(a==='--effort'&&argv[i+1])effort=argv[++i];
    else throw Error('Unknown worker option: '+a);
  }
  if(!path.isAbsolute(worktree??'')||!modes.includes(mode)||
     !Number.isInteger(intervalMs)||intervalMs<1000||intervalMs>60000||
     !['auto','low','medium','high','xhigh'].includes(effort)||
     (model&&!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(model)))
    throw Error('Invalid local worker policy; use exact absolute root and bounded parameters.');
  if(action!=='run'&&(once||model||mode!=='supervised'||effort!=='auto'))
    throw Error('Status/stop/recovery accept only --worktree.');
  return {worktree,mode,intervalMs,once,model,effort,action};
}
async function candidate(root){
  const filename=path.join(root,'.ai-bridge','transfer-control.json');
  let stat;
  try{stat=await fs.lstat(filename);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>30000)throw Error('Unsafe transfer record.');
  const t=JSON.parse(await fs.readFile(filename,'utf8'));
  if(t?.state!=='accepted'||t?.from!=='chatgpt_lead'||t?.to!=='codex_lead'||!UUID.test(t.id??''))return null;
  return t;
}
// Local state is a coordination ledger, never an authenticated grant. A malicious
// same-UID process remains outside this v1 threat boundary.
async function privateDirectory(directory, create=false){
  if(create)await fs.mkdir(directory,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  const st=await fs.lstat(directory);
  if(!st.isDirectory()||st.isSymbolicLink()||
     (process.getuid && st.uid!==process.getuid())||(st.mode&0o077))
    throw Error('Worker state must be an owner-only real directory.');
}
async function stateDirectory(root,create=false){
  const home=await fs.realpath(os.homedir());
  let directory=home;
  for(const part of ['.gcf','gcf-auto-workers',createHash('sha256').update(root).digest('hex')]){
    directory=path.join(directory,part);await privateDirectory(directory,create);
  }
  return directory;
}
async function readPrivate(filename,max=100000){
  // O_NOFOLLOW closes the final-component symlink race. Parent directories are
  // owner-only and checked separately; this does not attest against same-UID code.
  const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const st=await handle.stat();
    if(!st.isFile()||st.nlink!==1||st.size>max||(st.mode&0o077)||
       (process.getuid&&st.uid!==process.getuid()))throw Error('Unsafe worker state file.');
    return JSON.parse(await handle.readFile('utf8'));
  }finally{await handle.close();}
}
async function readHistory(filename){
  try{
    const state=await readPrivate(filename);
    if(state.schema_version!==1||!state.results||Array.isArray(state.results)||
       typeof state.results!=='object'||Object.keys(state.results).some(id=>!UUID.test(id)))
      throw Error('Unrecognized worker history.');
    return state;
  }catch(e){if(e.code==='ENOENT')return {schema_version:1,results:{}};throw e;}
}
async function lockRecord(filename){
  const lock=await readPrivate(filename,2000);
  if(lock.schema_version!==1||!Number.isSafeInteger(lock.pid)||lock.pid<1||
     typeof lock.key!=='string'||!/^[0-9a-f-]{36}$/.test(lock.key))throw Error('Invalid worker lock; inspect locally.');
  return lock;
}
async function matchesLock(filename,key){
  try{return (await lockRecord(filename)).key===key;}catch(e){if(e.code==='ENOENT')return false;throw e;}
}
async function withCoordinationLock(directory,operation){
  // Serialize lock creation and stale recovery. An interrupted coordination
  // operation deliberately fails closed and needs owner inspection.
  const filename=path.join(directory,'control.lock');
  const handle=await fs.open(filename,'wx',0o600);
  try{return await operation();}finally{await handle.close();await fs.unlink(filename);}
}
export async function runLocalWorker({worktree,mode='supervised',once=false,intervalMs=3000,model,effort='auto',
  onEvent=()=>{},stopSignal}={}){
  const args=parseWorkerArguments(['--worktree',worktree,'--mode',mode,'--interval-ms',String(intervalMs),
    ...(once?['--once']:[]),...(model?['--model',model]:[]),'--effort',effort]);
  const root=await fs.realpath(args.worktree);
  if(root===path.parse(root).root)throw Error('Filesystem root not an allowed project.');
  const rootStat=await fs.stat(root);
  const dir=path.join(root,'.ai-bridge');
  const st=await fs.lstat(dir);
  if(!st.isDirectory()||st.isSymbolicLink())throw Error('Invalid project task directory.');
  const stateDir=await stateDirectory(root,true);
  const lock=path.join(stateDir,'worker.lock'),stopFile=path.join(stateDir,'stop-requested');
  const history=path.join(stateDir,'history.json'),key=randomUUID();
  const handle=await withCoordinationLock(stateDir,async()=>{
    const file=await fs.open(lock,'wx',0o600);
    try{await file.writeFile(JSON.stringify({schema_version:1,pid:process.pid,key,active_job:null,started_at:new Date().toISOString()}));await file.sync();return file;}
    catch(e){await file.close();throw e;}
  });
  const controller=new AbortController();
  let controlTimer,total=0;
  const stop=()=>controller.abort();
  stopSignal?.addEventListener('abort',stop,{once:true});
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  if(stopSignal?.aborted)stop();
  try{
    const state=await readHistory(history);
    const setActiveJob=async(transferId)=>{
      const observed=await lockRecord(lock);
      if(observed.key!==key)throw Error('Worker lock changed before dispatch.');
      const temporary=lock+'.'+key+'.tmp';
      const file=await fs.open(temporary,'wx',0o600);
      try{await file.writeFile(JSON.stringify({...observed,active_job:transferId}));await file.sync();}
      finally{await file.close();}
      try{await fs.rename(temporary,lock);}finally{await fs.rm(temporary,{force:true});}
    };
    const record=async()=>{
      const data=JSON.stringify(state,null,2)+'\n';
      if(Buffer.byteLength(data)>95000)throw Error('Worker history capacity reached; retain ledger for replay protection.');
      const temp=history+'.'+key+'.tmp';
      const file=await fs.open(temp,'wx',0o600);
      try{await file.writeFile(data);await file.sync();}finally{await file.close();}
      await fs.rename(temp,history);
    };
    const checkControl=async()=>{
      if(!await matchesLock(lock,key))throw Error('Worker lock changed.');
      const current=await fs.stat(root);
      if(current.dev!==rootStat.dev||current.ino!==rootStat.ino||await fs.realpath(dir)!==dir)
        throw Error('Approved project path changed.');
      try{const request=await readPrivate(stopFile,2000);if(request.key===key)stop();}
      catch(e){if(e.code!=='ENOENT')throw e;}
    };
    // A stop request cancels the active bounded process group, not just the loop.
    let controlError;
    controlTimer=setInterval(()=>checkControl().catch(e=>{controlError=e;stop();}),200);
    do{
      await checkControl();
      if(controller.signal.aborted)break;
      const t=await candidate(root);
      if(t&&!Object.hasOwn(state.results,t.id)){
        if(mode==='supervised')onEvent({event:'awaiting_manual_approval',transfer_id:t.id});
        else{
          if(Object.keys(state.results).length>=250)throw Error('Worker history capacity reached; replay ledger retained.');
          const started=new Date().toISOString(),jobId='job_'+randomUUID();
          // Persist an indeterminate-child fence before dispatch. A dead worker
          // PID does not prove that its detached child descendants have exited.
          await setActiveJob(t.id);
          state.results[t.id]={status:'claimed',job_id:jobId,started_at:started,
            requested_model:model??null,requested_reasoning_effort:effort};
          await record();onEvent({event:'claimed',transfer_id:t.id,job_id:jobId});
          try{
            const result=await ownerNativeHandoff({worktree:root,model,effort,run:true,returnToInbox:true,
              ownerAutoOnce:true,expectedTransferId:t.id,abortSignal:controller.signal});
            Object.assign(state.results[t.id],{status:result.termination_reason==='ABORT'?'cancelled':result.status==='BLOCKED_POSTFLIGHT_OR_EXECUTION'?'blocked':result.return_note_posted?'returned':'review_required',
              finished_at:new Date().toISOString(),task_id:result.task_id,
              postflight_passed:result.postflight_passed===true,result_status:result.status,
              changed_paths:result.changed_paths,exit_code:result.exit_code,
              return_message_id:result.return_note?.message_id??null,
              termination_reason:result.termination_reason});
            onEvent({event:'completed',transfer_id:t.id,status:state.results[t.id].status});
          }catch{
            // Avoid persisting untrusted task text, child output or secrets.
            Object.assign(state.results[t.id],{status:controller.signal.aborted?'cancelled':'blocked',
              finished_at:new Date().toISOString(),reason:'Execution or return validation refused; inspect Git and local task.'});
            onEvent({event:state.results[t.id].status,transfer_id:t.id});
          }
          await record();await setActiveJob(null);total++;
        }
      }
      if(once||controller.signal.aborted)break;
      await new Promise(resolve=>{const timer=setTimeout(done,intervalMs);
        function done(){clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();}
        controller.signal.addEventListener('abort',done,{once:true});if(controller.signal.aborted)done();});
    }while(!controller.signal.aborted);
    if(controlError)throw controlError;
    return {mode,processed:total,history};
  }finally{
    clearInterval(controlTimer);stopSignal?.removeEventListener('abort',stop);
    process.off('SIGINT',stop);process.off('SIGTERM',stop);await handle.close();
    if(await matchesLock(lock,key)){
      await fs.unlink(lock);
      try{const request=await readPrivate(stopFile,2000);if(request.key===key)await fs.unlink(stopFile);}
      catch(e){if(e.code!=='ENOENT')throw e;}
    }
  }
}
export async function workerControl({worktree,action}){
  if(!['status','stop','recover'].includes(action)||!path.isAbsolute(worktree??''))throw Error('Invalid local control');
  const root=await fs.realpath(worktree);
  let directory;
  try{directory=await stateDirectory(root);}catch(e){if(e.code==='ENOENT')return {root,action,worker_lock_present:false,stop_requested:false,records:0};throw e;}
  const lock=path.join(directory,'worker.lock'),history=path.join(directory,'history.json');
  let observed;
  try{observed=await lockRecord(lock);}catch(e){if(e.code!=='ENOENT')throw e;}
  const state=await readHistory(history),results=state.results;
  let pidPresent=false;
  if(observed){try{process.kill(observed.pid,0);pidPresent=true;}catch(e){if(e.code!=='ESRCH')throw e;}}
  if(action==='recover'&&observed)await withCoordinationLock(directory,async()=>{
    if(pidPresent)throw Error('Recorded PID exists; refusing stale-lock recovery. Stop and inspect locally.');
    if(!Object.hasOwn(observed,'active_job')||observed.active_job!==null)
      throw Error('Interrupted or legacy job may have surviving descendants; inspect and stop them locally before recovery.');
    if(!await matchesLock(lock,observed.key))throw Error('Lock changed during recovery.');
    // Atomic rename fences concurrent recovery attempts and retains crash evidence.
    await fs.rename(lock,path.join(directory,'recovered-'+observed.key+'.json'));
  });
  if(action==='stop'&&observed){
    const filename=path.join(directory,'stop-requested');
    const temporary=filename+'.'+randomUUID()+'.tmp';
    const handle=await fs.open(temporary,'wx',0o600);
    try{await handle.writeFile(JSON.stringify({key:observed.key}));await handle.sync();}
    finally{await handle.close();}
    try{await fs.rename(temporary,filename);}finally{await fs.rm(temporary,{force:true});}
  }
  return {root,action,worker_lock_present:!!observed&&action!=='recover',recorded_pid_present:pidPresent,
    active_transfer_id:observed?.active_job??null,
    interrupted_job_requires_review:!!observed&&!pidPresent&&observed.active_job!==null,
    running_verified:false,records:Object.keys(results).length,results,
    status_counts:Object.values(results).reduce((counts,value)=>{
      const status=String(value?.status??'unknown');counts[status]=(counts[status]??0)+1;return counts;
    },{}),...(action==='stop'?{stop_requested:!!observed}:{}),
    ...(action==='recover'?{recovered:!!observed}:{}),
    note:'PID presence is not authenticated identity. Claimed jobs never auto-retry; review Git before a new transfer.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const params=parseWorkerArguments(process.argv.slice(2));
    const work=params.action==='run'?runLocalWorker({...params,onEvent:v=>process.stdout.write(JSON.stringify(v)+'\n')}):workerControl(params);
    work.then(v=>process.stdout.write(JSON.stringify(v)+'\n')).catch(()=>{process.stderr.write('GCF_AUTO_WORKER_REFUSED: inspect project policy and private worker state.\n');process.exitCode=2;});
  }catch{process.stderr.write('GCF_AUTO_WORKER_REFUSED: invalid local worker options.\n');process.exitCode=2;}
}
