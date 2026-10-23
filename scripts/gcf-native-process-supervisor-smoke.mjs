import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {executeBoundedNativeProcess} from './gcf-native-process-supervisor.mjs';

const binary=process.execPath,root=process.cwd();
const run=(script, extra={})=>executeBoundedNativeProcess({
 binary,args:['-e',script],root,plan:'fixture only',
 timeoutMs:1500,graceMs:100,maxOutput:300,
 env:{...process.env},...extra
});
const beforeSigint=process.listenerCount('SIGINT');
const beforeSigterm=process.listenerCount('SIGTERM');
const normal=await run("process.stdin.resume();process.stdin.on('end',()=>{console.log('test done');})");
assert.equal(normal.exit_code,0);
assert.equal(normal.timed_out,false);
assert.equal(normal.interrupted,false);
assert.match(normal.stdout_excerpt,/test done/);
assert.equal(normal.termination_reason,null);
console.log('PASS: normal local subprocess completion and bounded result');

const noisy=await run("process.stdout.write('z'.repeat(20000));");
assert.equal(noisy.exit_code,0);
assert.equal(noisy.stdout_excerpt.length,300);
console.log('PASS: subprocess output cannot exceed bounded excerpt');

const timeout=await run("process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",{
 timeoutMs:140,graceMs:100
});
assert.equal(timeout.timed_out,true);
assert.equal(timeout.termination_reason,'TIMEOUT');
assert.notEqual(timeout.exit_code,0);
console.log('PASS: timeout terminates a SIGTERM-resistant disposable child');

const controller=new AbortController();
const aborted=run("setInterval(()=>{},1000);",{abortSignal:controller.signal});
controller.abort();
const stopped=await aborted;
assert.equal(stopped.termination_reason,'ABORT');
assert.equal(stopped.timed_out,false);
assert.notEqual(stopped.exit_code,0);
console.log('PASS: aborted subprocess refuses to report successful completion');

const preAborted=new AbortController();
preAborted.abort();
assert.throws(()=>executeBoundedNativeProcess({
 binary,args:[],root,plan:'fixture',env:process.env,abortSignal:preAborted.signal
}),/aborted before launch/);
assert.throws(()=>executeBoundedNativeProcess({
 binary,args:[],root,plan:'x'.repeat(40000),env:process.env
}),/Invalid bounded Native subprocess parameters/);
const failing=await run('process.exit(7)');
assert.equal(failing.exit_code,7);
await assert.rejects(executeBoundedNativeProcess({
  binary:'/definitely/not/an/executable/gcf-supervisor',args:[],root,
  plan:'fixture',timeoutMs:500,graceMs:50,env:process.env
}),/ENOENT/);
const gracefulAbort=new AbortController();
const selfTerminating=run("process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);",{
  timeoutMs:1500,abortSignal:gracefulAbort.signal
});
setTimeout(()=>gracefulAbort.abort(),250);
const declaredAborted=await selfTerminating;
assert.equal(declaredAborted.termination_reason,'ABORT');
assert.equal(declaredAborted.timed_out,false);
// An interrupted child is not successful even when it exits with code zero.
assert.equal(declaredAborted.exit_code,0);
assert.equal(failing.timed_out,false);
assert.equal(process.listenerCount('SIGINT'),beforeSigint);
assert.equal(process.listenerCount('SIGTERM'),beforeSigterm);
console.log('PASS: refusal, exit error and signal listener cleanup');

if(process.platform!=='win32'){
 const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-descendant-'));
 try{
  const marker=path.join(fixture,'orphan-survived');
  const script="setTimeout(()=>require('node:fs').writeFileSync("+JSON.stringify(marker)+",'unsafe'),500)";
  const result=await run("require('node:child_process').spawn(process.execPath,['-e',"+JSON.stringify(script)+"],{stdio:'ignore'}).unref();");
  assert.equal(result.exit_code,0);
  await new Promise(resolve=>setTimeout(resolve,700));
  await assert.rejects(fs.access(marker),{code:'ENOENT'});
  console.log('PASS: successful leader cannot leave a background descendant alive');
 }finally{await fs.rm(fixture,{recursive:true,force:true});}
}
