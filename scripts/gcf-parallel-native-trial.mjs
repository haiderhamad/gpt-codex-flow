// Owner-operated, disposable parallel trial: one real Native Codex and one
// independent MCP client (NOT an authenticated ChatGPT model). No source merge.
// --preview is non-executing; --run requires a real local TTY + exact consent.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {stdin,stdout} from 'node:process';
import {createInterface} from 'node:readline/promises';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createParallelSession,reportParallelRole,previewParallelSession,interruptParallelSession} from './gcf-parallel-session.mjs';
import {previewParallelNativeCodex} from './gcf-parallel-native-preflight.mjs';
import {inspectNativeCodexPostflight,snapshotManagedMcpMetadata} from './gcf-native-codex-postflight.mjs';
import {exportParallelReviewBundle} from './gcf-parallel-review.mjs';
import {verifyParallelReviewBundle} from './gcf-parallel-verify.mjs';
import {executeBoundedNativeProcess} from './gcf-native-process-supervisor.mjs';
import {pinNativeCodexExecutable,verifyPinnedNativeCodexExecutable} from './gcf-native-executable-pin.mjs';

const PHRASE='RUN DISPOSABLE PARALLEL CODEX';
const sha=data=>createHash('sha256').update(data).digest('hex');
const LIMIT=2400;
function git(root,args) {
 const p=spawnSync('git',args,{cwd:root,encoding:'utf8',timeout:15000,
   maxBuffer:1024*1024,shell:false});
 if(p.status!==0||p.error)throw new Error('Disposable Git '+args[0]+' failed.');
 return p.stdout.trim();
}
async function createFixture(tmp) {
 const base=path.join(tmp,'base'),chatgpt=path.join(tmp,'chatgpt'),codex=path.join(tmp,'codex');
 await fs.mkdir(path.join(base,'src'),{recursive:true});
 await fs.writeFile(path.join(base,'.gitignore'),'.ai-bridge/\n');
 await fs.writeFile(path.join(base,'src/ui.txt'),'ui before\n');
 await fs.writeFile(path.join(base,'src/api.txt'),'api before\n');
 git(base,['init','-q']);
 git(base,['add','.gitignore','src']);
 git(base,['-c','user.name=Disposable','-c','user.email=disposable@example.invalid',
   'commit','-q','-m','disposable baseline']);
 git(base,['worktree','add','-q','-b','gcf-live-peer',chatgpt,'HEAD']);
 git(base,['worktree','add','-q','-b','gcf-live-native',codex,'HEAD']);
 const stateDir=path.join(base,'.ai-bridge');
 const session=await createParallelSession({
   dir:stateDir,base,chatgpt,codex,goal:'Disposable two-worker integration proof',
   assignments:{
     chatgpt:{task:'Change UI copy from ui before to ui after',target_paths:['src/ui.txt']},
     codex:{task:'Change src/api.txt text from api before to api after. Do not alter other files.',
       target_paths:['src/api.txt']}
   }
 });
 return {base,chatgpt,codex,stateDir,session_id:session.session_id,
   head:git(base,['rev-parse','HEAD'])};
}
async function mcpPeerEdit(chatgpt) {
 let client;
 try {
   client=new Client({name:'gcf-parallel-disposable-mcp-fixture',version:'1.0.0'},
     {capabilities:{}});
   await client.connect(new StdioClientTransport({
     command:process.execPath,
     args:['dist/stdio.js','--root',chatgpt,'--allow-root',chatgpt,
       '--tool-mode','standard','--write','workspace','--bash','off'],
     cwd:path.resolve('.'),
     env:{...process.env,GCF_ROOT:chatgpt,
       GCF_ALLOWED_ROOTS:chatgpt,GCF_BASH_MODE:'off'}
   }));
   const reply=await client.callTool({name:'edit',arguments:{
     path:'src/ui.txt',old_text:'ui before',new_text:'ui after'
   }});
   if(reply.isError)throw new Error('Disposable MCP peer edit refused.');
   // Defer managed metadata capture until after MCP transport closes.
 }finally{if(client)await client.close();}
  return {passed:true,process_type:'real MCP client, simulated ChatGPT role',
    managedMcpHashes:await snapshotManagedMcpMetadata({worktree:chatgpt})};
}
function runCodex(binary,root,plan) {
 const args=['exec','--sandbox','workspace-write','--config','approval_policy=never',
   '--config','sandbox_workspace_write.network_access=false',
   '--config','sandbox_workspace_write.exclude_slash_tmp=true',
   '--config','sandbox_workspace_write.exclude_tmpdir_env_var=true','--cd',root,'-'];
 const env=Object.fromEntries(
   ['HOME','PATH','CODEX_HOME','LANG','LC_ALL','TERM','TMPDIR','USER']
     .filter(k=>typeof process.env[k]==='string').map(k=>[k,process.env[k]])
 );
 return executeBoundedNativeProcess({binary,args,root,env,plan,maxOutput:LIMIT});
}
async function askOwner(preview) {
 stdout.write('\nDISPOSABLE PARALLEL NATIVE CODEX — model usage possible.\n');
 stdout.write('Only Codex is a real AI model. The other worker is an MCP fixture client.\n');
 stdout.write('Native assigned paths: '+JSON.stringify(preview.owned_paths)+'\n');
 stdout.write('Peer assigned paths: '+JSON.stringify(preview.peer_owned_paths)+'\n');
 stdout.write('Native plan SHA-256: '+preview.plan_sha256+'\n');
 stdout.write('Native plan:\n'+preview._local_plan+'\n');
 stdout.write('Consent phrase: '+PHRASE+'\n');
 const rl=createInterface({input:stdin,output:stdout,terminal:true});
 let response;
 try{response=await rl.question('Confirm exact phrase: ');}finally{rl.close();}
 if(response!==PHRASE)throw new Error('Owner consent refused. No native process invoked.');
}
export async function runDisposableParallelTrial({
 run=false,simulated=false,simulatedFault=null,
 searchPath=process.env.PATH??''
}={}) {
 if(run&&simulated)throw new Error('Simulation and live execution cannot be combined.');
 // A caller must not be able to bypass human consent with {interactive:true}.
 if(run&&!(stdin.isTTY&&stdout.isTTY))
   throw new Error('Real Native Codex requires interactive owner Terminal; no remote fallback.');
 if(simulatedFault!==null && (!simulated ||
   !['out_of_scope','ignored_output','deleted_owned','wrong_content','nonzero_exit',
      'mcp_metadata_tamper','mcp_checkpoint_tamper','mcp_ignored_output','interrupted_zero'].includes(simulatedFault)))
   throw new Error('Only supported disposable simulation fault scenarios are allowed.');
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-native-parallel-live-'));
 try {
   const fixture=await createFixture(tmp);
   const {base,chatgpt,codex,stateDir,session_id,head}=fixture;
   const proposal=await previewParallelNativeCodex({
     dir:stateDir,session_id,searchPath,includeLocalPlan:true
   });
   const {_local_plan,...publicProposal}=proposal;
   const report={
     fixture_disposable:true,
     session_id,preview:publicProposal,
     native_codex_executed:false,model_request_verified:false,
     peer_type:'real MCP client (role simulated, NOT independently authenticated ChatGPT)',
     original_project_modified:false,merge_performed:false,
     fixture_removed_after_run:true,live_result:null
   };
   if(!run&&!simulated)return report;
   if(run&&proposal.status!=='READY_FOR_OWNER_REVIEW')
     throw new Error('Native Codex unavailable; no execution.');
   const pinnedNative=run?await pinNativeCodexExecutable({searchPath}):null;
   if(run)await askOwner(proposal);
   const before=await previewParallelNativeCodex({
     dir:stateDir,session_id,searchPath,includeLocalPlan:true
   });
   if(before.plan_sha256!==proposal.plan_sha256 ||
     before.status!=='READY_FOR_OWNER_REVIEW' ||
     before.base_head!==head || before.session_id!==session_id)
     throw new Error('Parallel session changed after review. Refused.');
   const sessionPath=path.join(stateDir,'parallel-session.json');
   const stateDigest=sha(await fs.readFile(sessionPath));
   // Fault injection runs ONLY in a disposable simulated worker. Never pass
   // these controls to real Codex or expose them as executable CLI options.
   const simulatedJob=async()=>{
     if(simulatedFault==='deleted_owned')await fs.rm(path.join(codex,'src/api.txt'));
     else await fs.writeFile(path.join(codex,'src/api.txt'),
       simulatedFault==='wrong_content'?'incorrect result\n':'api after\n');
     if(simulatedFault==='out_of_scope')
       await fs.writeFile(path.join(codex,'src/ui.txt'),'unauthorized modification\n');
     if(simulatedFault==='ignored_output'){
       await fs.mkdir(path.join(codex,'.ai-bridge'),{recursive:true});
       await fs.writeFile(path.join(codex,'.ai-bridge/hidden.log'),'hidden output\n');
     }
     return {exit_code:simulatedFault==='nonzero_exit'?1:0,
       timed_out:false,simulated:true,
       termination_reason:simulatedFault==='interrupted_zero'?'SIGINT':null,
       interrupted:simulatedFault==='interrupted_zero'};
   };
   const codexJob=simulated ? simulatedJob()
     : runCodex(await verifyPinnedNativeCodexExecutable(pinnedNative),codex,
         _local_plan+'\n\nChange only src/api.txt: replace api before with api after.\n');
   const outcomes=await Promise.allSettled([mcpPeerEdit(chatgpt),codexJob]);
   const workerFailure=outcomes.some(o=>o.status==='rejected');
   // Only this deterministic, trusted MCP fixture client may supply managed
   // metadata. Snapshot exact hashes after it exits; native Codex receives NO
   // such exemption. Role claims are still not authenticated identities.
   const managedMcpHashes=outcomes[0].status==='fulfilled'
     ? outcomes[0].value.managedMcpHashes : {};
   if(simulatedFault==='mcp_metadata_tamper') {
     const captured=Object.keys(managedMcpHashes)[0];
     if(!captured)throw new Error('No managed MCP metadata exists for fixture tamper test.');
     await fs.appendFile(path.join(chatgpt,captured),'tampered after report\n');
   }
   if(simulatedFault==='mcp_checkpoint_tamper') {
     const checkpoint='.ai-bridge/continuity-checkpoint.json';
     if(!Object.hasOwn(managedMcpHashes,checkpoint))
       throw new Error('Trusted MCP checkpoint missing from fixture inventory.');
     await fs.appendFile(path.join(chatgpt,checkpoint),'tampered after snapshot\n');
   }
   if(simulatedFault==='mcp_ignored_output')
     await fs.writeFile(path.join(chatgpt,'.ai-bridge/hidden-peer.log'),'unexpected peer output\n');
   const codexResult=outcomes[1].status==='fulfilled'?outcomes[1].value:null;
   const reports={
     codex:await inspectNativeCodexPostflight({
       worktree:codex,expectedHead:head,allowedPaths:['src/api.txt']
     }),
     chatgpt:await inspectNativeCodexPostflight({
       worktree:chatgpt,expectedHead:head,allowedPaths:['src/ui.txt'],
       managedMcpHashes
     })
   };
   const sessionIntact=sha(await fs.readFile(sessionPath))===stateDigest;
   const baseIntact=git(base,['rev-parse','HEAD'])===head &&
     !git(base,['status','--porcelain=v1','--untracked-files=all']);
   // Never open an agent-edited path until both postflight checks have proved
   // it is a regular in-scope file, not a symlink into another filesystem tree.
   const contentsMatch=reports.codex.passed && reports.chatgpt.passed &&
     await fs.readFile(path.join(codex,'src/api.txt'),'utf8')==='api after\n' &&
     await fs.readFile(path.join(chatgpt,'src/ui.txt'),'utf8')==='ui after\n';
   const workersPass=!workerFailure && codexResult?.exit_code===0 &&
     !codexResult?.timed_out && !codexResult?.termination_reason &&
     sessionIntact && baseIntact && contentsMatch &&
     reports.codex.passed && reports.chatgpt.passed;
   const live_result={
     passed:false,native_exit_code:codexResult?.exit_code??null,
     native_termination_reason:codexResult?.termination_reason??null,
     native_interrupted:Boolean(codexResult?.interrupted),
     native_process_invoked:run,concurrent_workers_started:true,
     simulated_native_worker:simulated,
     worker_error:workerFailure,
     codex_postflight:reports.codex,
     mcp_postflight:reports.chatgpt,
     session_record_intact:sessionIntact,base_git_clean:baseIntact,
     expected_fixture_contents:contentsMatch,
     isolated_patch_replay_verified:false,
     interruption_recorded:false,interruption_reason:null,
     owner_merge_approval_required:true
   };
   if(workersPass) {
     await Promise.all([
       reportParallelRole({dir:stateDir,session_id,role:'chatgpt',
         evidence:'Real MCP fixture edited the exclusively assigned UI file'}),
       reportParallelRole({dir:stateDir,session_id,role:'codex',
         evidence:simulated?'Deterministic fake codex worker modified API file':
           'Native Codex CLI ran in assigned disposable worktree'})
     ]);
     const preview=await previewParallelSession({dir:stateDir,session_id});
     if(preview.status==='PASS') {
       const reviewDir=path.join(tmp,'review');
       await exportParallelReviewBundle({dir:stateDir,session_id,outputDir:reviewDir});
       const verification=await verifyParallelReviewBundle({base,reviewDir});
       live_result.isolated_patch_replay_verified=verification.status==='PASS';
       live_result.combined_patch_sha256=verification.combined_patch_sha256;
       live_result.reviewed_paths=verification.reviewed_paths;
     }
   }
   if(!workersPass && sessionIntact){
     const reason_code=codexResult?.termination_reason
       ? 'WORKER_INTERRUPTED'
       : workerFailure||codexResult?.exit_code!==0||codexResult?.timed_out
         ? 'WORKER_FAILED':'POSTFLIGHT_REJECTED';
     const interruption=await interruptParallelSession({
       dir:stateDir,session_id,reason_code
     });
     live_result.interruption_recorded=interruption.status==='interrupted';
     live_result.interruption_reason=reason_code;
   }
   live_result.passed=workersPass&&live_result.isolated_patch_replay_verified;
   return {...report,native_codex_executed:run,live_result};
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
}
async function resolveCodexExecutable(searchPath) {
 for(const dir of searchPath.split(path.delimiter)) {
   if(!dir||!path.isAbsolute(dir))continue;
   const binary=path.join(dir,'codex');
   try{
     const stat=await fs.stat(await fs.realpath(binary));
     if(stat.isFile()) {
       await fs.access(binary,(await import('node:constants')).X_OK);
       return binary;
     }
   }catch{/* next */}
 }
 throw new Error('Native Codex binary missing at final execution gate.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
 try{
   if(process.argv.length!==3||!['--preview','--run'].includes(process.argv[2]))
     throw new Error('Usage: node scripts/gcf-parallel-native-trial.mjs --preview | --run');
   const result=await runDisposableParallelTrial({run:process.argv[2]==='--run'});
   console.log(JSON.stringify(result,null,2));
   if(process.argv[2]==='--run'&&!result.live_result?.passed)process.exitCode=1;
 }catch(error){
   console.error('Parallel Native trial REFUSED: '+(error?.message??String(error)));
   process.exitCode=2;
 }
}
