// Internal Native Codex subprocess supervisor. No model execution is reachable
// from this module unless an owner-gated local runner explicitly calls it.
import {spawn} from 'node:child_process';

export function executeBoundedNativeProcess({
  binary, args, root, plan, env, timeoutMs=180_000, graceMs=3000,
  maxOutput=2400, abortSignal
}) {
  if(typeof binary!=='string'||!binary||!Array.isArray(args)||
     typeof root!=='string'||!root||typeof plan!=='string'||
     Buffer.byteLength(plan,'utf8')>32_000||
     !Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>180_000||
     !Number.isInteger(graceMs)||graceMs<1||graceMs>10_000)
    throw new Error('Invalid bounded Native subprocess parameters.');
  if(abortSignal?.aborted)
    throw new Error('Native subprocess aborted before launch.');
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{
      cwd:root,env,shell:false,detached:process.platform!=='win32',
      stdio:['pipe','pipe','pipe']
    });
    let stdout='',stderr='',done=false,stopReason=null,killTimer=null;
    const kill=(signal)=>{
      if(!child.pid)return;
      try {
        if(process.platform!=='win32')process.kill(-child.pid,signal);
        else child.kill(signal);
      } catch {/* Process already gone. */}
    };
    const stop=(reason)=>{
      if(stopReason||done)return;
      stopReason=reason;
      kill('SIGTERM');
      killTimer=setTimeout(()=>kill('SIGKILL'),graceMs);
    };
    const onSigint=()=>stop('SIGINT');
    const onSigterm=()=>stop('SIGTERM');
    const onAbort=()=>stop('ABORT');
    process.on('SIGINT',onSigint);
    process.on('SIGTERM',onSigterm);
    abortSignal?.addEventListener('abort',onAbort,{once:true});
    const timer=setTimeout(()=>stop('TIMEOUT'),timeoutMs);
    const finish=(error,code,signal)=>{
      if(done)return;
      done=true;
      clearTimeout(timer);
      // A completed leader may leave background descendants with closed pipes.
      // Fence the owned process group before reporting completion.
      if(process.platform!=='win32')kill('SIGKILL');
      if(killTimer)clearTimeout(killTimer);
      process.off('SIGINT',onSigint);
      process.off('SIGTERM',onSigterm);
      abortSignal?.removeEventListener('abort',onAbort);
      if(error)return reject(error);
      resolve({
        exit_code:code,timed_out:stopReason==='TIMEOUT',
        interrupted:stopReason==='SIGINT'||stopReason==='SIGTERM',
        termination_reason:stopReason,
        exit_signal:signal??null,
        stdout_excerpt:stdout,stderr_excerpt:stderr
      });
    };
    child.on('error',error=>finish(error,null,null));
    child.stdout?.on('data',data=>{stdout=(stdout+String(data)).slice(-maxOutput);});
    child.stderr?.on('data',data=>{stderr=(stderr+String(data)).slice(-maxOutput);});
    child.on('close',(code,signal)=>finish(null,code,signal));
    child.stdin?.on('error',()=>{/* Early exit / EPIPE is reported via close. */});
    child.stdin?.end(plan);
    if(abortSignal?.aborted)onAbort();
  });
}
