import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runDisposableParallelTrial} from './gcf-parallel-native-trial.mjs';

const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-parallel-native-smoke-'));
const bin=path.join(tmp,'bin'),sentinel=path.join(tmp,'CODEX_WAS_INVOKED');
try {
 await fs.mkdir(bin);
 await fs.writeFile(path.join(bin,'codex'),
   '#!/bin/sh\ntouch "'+sentinel+'"\nexit 99\n',{mode:0o755});
 const preview=await runDisposableParallelTrial({searchPath:bin});
 assert.equal(preview.fixture_disposable,true);
 assert.equal(preview.native_codex_executed,false);
 assert.equal(preview.preview.status,'READY_FOR_OWNER_REVIEW');
 assert.deepEqual(preview.preview.owned_paths,['src/api.txt']);
 assert.deepEqual(preview.preview.peer_owned_paths,['src/ui.txt']);
 assert.equal(preview.preview.role_identity_verified,false);
 assert.equal(preview.preview.preview_only,true);
 assert.equal(Object.hasOwn(preview.preview,'_local_plan'),false);
 assert.equal(preview.live_result,null);
 assert.equal(preview.original_project_modified,false);
 await assert.rejects(fs.stat(sentinel),{code:'ENOENT'});
 console.log('PASS: dual-role disposable preview is non-executing and redacts plan');

 const integration=await runDisposableParallelTrial({simulated:true,searchPath:bin});
 assert.equal(integration.native_codex_executed,false);
 assert.equal(integration.live_result?.passed,true,JSON.stringify(integration.live_result));
 assert.equal(integration.live_result.simulated_native_worker,true);
 assert.equal(integration.live_result.codex_postflight.passed,true);
 assert.equal(integration.live_result.mcp_postflight.passed,true);
 assert.equal(integration.live_result.session_record_intact,true);
 assert.equal(integration.live_result.base_git_clean,true);
 assert.equal(integration.live_result.isolated_patch_replay_verified,true);
 assert.deepEqual(integration.live_result.reviewed_paths,['src/api.txt','src/ui.txt']);
 await assert.rejects(fs.stat(sentinel),{code:'ENOENT'});
 console.log('PASS: real MCP peer + simulated Codex worker -> role reports -> isolated review replay');

 for(const [fault,expected] of [
   ['out_of_scope','OUT_OF_SCOPE_CHANGE'],
   ['ignored_output','UNEXPECTED_IGNORED_FILES'],
   ['deleted_owned','UNSUPPORTED_CHANGE_TYPE'],
   ['wrong_content',null],['nonzero_exit',null],
   ['mcp_metadata_tamper',null],['mcp_checkpoint_tamper',null],
   ['mcp_ignored_output',null],['interrupted_zero',null]
 ]){
   const denied=await runDisposableParallelTrial({simulated:true,simulatedFault:fault,searchPath:bin});
   assert.equal(denied.live_result?.passed,false,fault);
   assert.equal(denied.live_result.isolated_patch_replay_verified,false,fault);
   assert.equal(denied.live_result.base_git_clean,true,fault);
   assert.equal(denied.live_result.interruption_recorded,true,fault);
   assert.ok(['WORKER_FAILED','WORKER_INTERRUPTED','POSTFLIGHT_REJECTED']
     .includes(denied.live_result.interruption_reason),fault);
   if(expected)assert.ok(denied.live_result.codex_postflight.reasons.includes(expected),fault);
   if(fault==='mcp_metadata_tamper'||fault==='mcp_checkpoint_tamper')
     assert.ok(denied.live_result.mcp_postflight.reasons.includes('MANAGED_MCP_METADATA_CHANGED'),JSON.stringify(denied.live_result.mcp_postflight));
   if(fault==='mcp_ignored_output')
     assert.ok(denied.live_result.mcp_postflight.reasons.includes('UNEXPECTED_IGNORED_FILES'));
 }
 await assert.rejects(fs.stat(sentinel),{code:'ENOENT'});
 console.log('PASS: parallel runner rejects out-of-scope, ignored, deleted, wrong-content and failing workers before review');
 console.log('PASS: post-disconnect MCP metadata tamper rejected by saved SHA-256 evidence');

 // Exercise the real CLI from a child with piped stdio: this is non-TTY even
 // when npm test itself is launched from an interactive macOS Terminal.
 // "interactive" is not a runner option and cannot simulate a non-TTY caller.
 const nonInteractive=spawnSync(process.execPath,[
   fileURLToPath(new URL('./gcf-parallel-native-trial.mjs',import.meta.url)),
   '--run'
 ],{
   cwd:process.cwd(),encoding:'utf8',input:'',
   stdio:['pipe','pipe','pipe'],timeout:15000,maxBuffer:512*1024,
   env:{...process.env,PATH:[bin,process.env.PATH??''].filter(Boolean).join(path.delimiter)}
 });
 assert.equal(nonInteractive.error,undefined,nonInteractive.error?.message);
 assert.equal(nonInteractive.status,2,nonInteractive.stderr);
 assert.match(nonInteractive.stderr,/Real Native Codex requires interactive owner Terminal/);
 assert.doesNotMatch(nonInteractive.stdout,/Confirm exact phrase:/);
 await assert.rejects(runDisposableParallelTrial({
   run:true,simulated:true,searchPath:bin
 }),/cannot be combined/);
 await assert.rejects(fs.stat(sentinel),{code:'ENOENT'});
 console.log('PASS: piped non-TTY CLI and simulation/live mixing denied before model invocation');

 const missing=await runDisposableParallelTrial({
   searchPath:path.join(tmp,'missing')
 });
 assert.equal(missing.preview.status,'BLOCKED');
 assert.equal(missing.native_codex_executed,false);
 console.log('PASS: no Codex binary => blocked preview; no model call');
}finally{await fs.rm(tmp,{recursive:true,force:true});}
