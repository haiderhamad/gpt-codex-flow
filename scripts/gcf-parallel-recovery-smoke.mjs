import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createParallelSession,readParallelSession,reportParallelRole,
  previewParallelSession,interruptParallelSession
} from './gcf-parallel-session.mjs';
import {inspectParallelSessionRecovery} from './gcf-parallel-recovery.mjs';
import {exportParallelReviewBundle} from './gcf-parallel-review.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const temp=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-recovery-'));
const base=path.join(temp,'base'),chatgpt=path.join(temp,'chatgpt');
const codex=path.join(temp,'codex');
const stateDir=path.join(base,'.ai-bridge');
function git(dir,...args){
 const p=spawnSync('git',args,{cwd:dir,encoding:'utf8',timeout:12000});
 assert.equal(p.status,0,p.stderr);
}
const assignments={
 chatgpt:{task:'Update UI',target_paths:['src/ui.txt']},
 codex:{task:'Update API',target_paths:['src/api.txt']}
};
try{
 await fs.mkdir(path.join(base,'src'),{recursive:true});
 await fs.writeFile(path.join(base,'.gitignore'),'.ai-bridge/\n');
 await fs.writeFile(path.join(base,'src/ui.txt'),'ui base\n');
 await fs.writeFile(path.join(base,'src/api.txt'),'api base\n');
 git(base,'init','-q');
 git(base,'add','.gitignore','src');
 git(base,'-c','user.name=Disposable','-c','user.email=disposable@example.invalid',
    'commit','-q','-m','baseline');
 git(base,'worktree','add','-q','-b','recovery-chat',chatgpt,'HEAD');
 git(base,'worktree','add','-q','-b','recovery-codex',codex,'HEAD');
 const session=await createParallelSession({
   dir:stateDir,base,chatgpt,codex,
   goal:'Check crash recovery without restarting either worker',
   assignments
 });
 const args={dir:stateDir,session_id:session.session_id};
 const planned=await inspectParallelSessionRecovery(args);
 assert.equal(planned.session_status,'planned');
 assert.equal(planned.status,'OWNER_REVIEW_REQUIRED');
 assert.equal(planned.auto_resume_allowed,false);
 assert.equal(planned.agent_started,false);
 assert.deepEqual(planned.reported_roles,[]);
 assert.equal(planned.record_consistent,true);
 console.log('PASS: planned session recovery is read-only; no auto-resume or agent invocation');

 await fs.writeFile(path.join(chatgpt,'src/ui.txt'),'UI edited\n');
 await reportParallelRole({...args,role:'chatgpt',evidence:'local fixture touched UI only'});
 const partial=await inspectParallelSessionRecovery(args);
 assert.equal(partial.session_status,'in_progress');
 assert.deepEqual(partial.reported_roles,['chatgpt']);
 assert.deepEqual(partial.remaining_roles,['codex']);
 assert.ok(partial.reasons.includes('PARTIAL_WORKER_REPORT'));
 assert.equal(partial.auto_resume_allowed,false);
 const missingBundle=path.join(temp,'incomplete-review');
 await assert.rejects(exportParallelReviewBundle({
   ...args,outputDir:missingBundle
 }),/Only a verified, successful review preview/);
 await assert.rejects(fs.stat(missingBundle),{code:'ENOENT'});
 const cli=spawnSync(process.execPath,[
   'scripts/gcf-parallel-recovery.mjs','--state-dir',stateDir,
   '--session-id',session.session_id
 ],{cwd:process.cwd(),encoding:'utf8',timeout:12000});
 assert.equal(cli.status,0,cli.stderr);
 const reloaded=JSON.parse(cli.stdout);
 assert.equal(reloaded.record_sha256,partial.record_sha256);
 assert.equal(reloaded.auto_resume_allowed,false);
 assert.equal(reloaded.session_status,'in_progress');
 console.log('PASS: partial persisted role report survives process restart; bundle export denied');

 const lockFile=path.join(stateDir,'parallel-session.json.lock');
 await fs.writeFile(lockFile,'fixture stale lock\n',{flag:'wx'});
 const locked=await inspectParallelSessionRecovery(args);
 assert.ok(locked.reasons.includes('SESSION_LOCK_PRESENT'));
 await assert.rejects(interruptParallelSession({
   ...args,reason_code:'WORKER_INTERRUPTED'
 }),{code:'EEXIST'});
 assert.equal((await fs.readFile(lockFile,'utf8')),'fixture stale lock\n');
 await fs.rm(lockFile); // Only remove the explicitly fixture-created lock.
 const interrupted=await interruptParallelSession({
   ...args,reason_code:'WORKER_INTERRUPTED'
 });
 assert.equal(interrupted.status,'interrupted');
 assert.equal(interrupted.interruption.automatic_resume_allowed,false);
 const persisted=await readParallelSession(stateDir);
 assert.equal(persisted.roles.chatgpt.state,'reported');
 assert.equal(persisted.roles.codex.state,'assigned');
 assert.equal(persisted.interruption.reason_code,'WORKER_INTERRUPTED');
 const final=await inspectParallelSessionRecovery(args);
 assert.ok(final.reasons.includes('SESSION_INTERRUPTED'));
 assert.equal(final.auto_resume_allowed,false);
 // Real read-only MCP observer must report interruption without assigning an
 // agent identity, executing work, or treating this as an exportable preview.
 const observer=new Client({name:'gcf-recovery-observer',version:'1.0.0'},
   {capabilities:{}});
 try{
   await observer.connect(new StdioClientTransport({
     command:process.execPath,
     args:['dist/stdio.js','--root',base,'--allow-root',base,
       '--write','workspace','--bash','off','--tool-mode','standard'],
     cwd:process.cwd(),
     env:{...process.env,GCF_ROOT:base,GCF_ALLOWED_ROOTS:base,
       GCF_BASH_MODE:'off'}
   }));
   const response=await observer.callTool({name:'parallel_session_status',arguments:{}});
   assert.equal(Boolean(response.isError),false,JSON.stringify(response));
   assert.equal(response.structuredContent.status,'interrupted');
   assert.equal(response.structuredContent.active,true);
   assert.equal(response.structuredContent.client_identity_verified,false);
   assert.equal(response.structuredContent.merged_into_original,false);
 }finally{await observer.close();}
 await assert.rejects(reportParallelRole({
   ...args,role:'codex',evidence:'late invalid report'
 }),/closed for reports/);
 await assert.rejects(previewParallelSession(args),/Both roles must report first/);
 await assert.rejects(exportParallelReviewBundle({
   ...args,outputDir:missingBundle
 }),/Only a verified, successful review preview/);
 await assert.rejects(interruptParallelSession({
   ...args,reason_code:'WORKER_FAILED'
 }),/cannot be interrupted/);
 console.log('PASS: interruption is durable, preserves evidence and locks out late reports/previews/bundles');

 const savedFile=path.join(stateDir,'parallel-session.json');
 const saved=await fs.readFile(savedFile);
 const forged=JSON.parse(saved.toString('utf8'));
 forged.roles.chatgpt.patch_sha256='not-a-sha';
 await fs.writeFile(savedFile,JSON.stringify(forged,null,2)+'\n');
 const bad=await inspectParallelSessionRecovery(args);
 assert.ok(bad.reasons.includes('UNTRUSTED_ROLE_REPORT'));
 assert.equal(bad.record_consistent,false);
 await fs.writeFile(savedFile,saved);
 assert.equal((await inspectParallelSessionRecovery(args)).record_consistent,true);
 await assert.rejects(inspectParallelSessionRecovery({
   ...args,session_id:'parallel_'+ '0'.repeat(36)
 }),/mismatch/);
 console.log('PASS: malformed persisted reports and mismatched recovery IDs cannot be treated as valid');

 // A verified preview must also lose export eligibility upon explicit interruption.
 await fs.writeFile(path.join(chatgpt,'src/ui.txt'),'ui base\n');
 const stateTwo=path.join(temp,'second-state');
 const second=await createParallelSession({
   dir:stateTwo,base,chatgpt,codex,goal:'Previously verified preview invalidation',
   assignments
 });
 const argsTwo={dir:stateTwo,session_id:second.session_id};
 await fs.writeFile(path.join(chatgpt,'src/ui.txt'),'UI edited again\n');
 await fs.writeFile(path.join(codex,'src/api.txt'),'API edited again\n');
 await reportParallelRole({...argsTwo,role:'chatgpt',evidence:'UI fixture edit'});
 await reportParallelRole({...argsTwo,role:'codex',evidence:'API fixture edit'});
 assert.equal((await previewParallelSession(argsTwo)).status,'PASS');
 const prior=await inspectParallelSessionRecovery(argsTwo);
 assert.equal(prior.prior_preview_requires_fresh_verification,true);
 assert.equal(prior.auto_resume_allowed,false);
 await interruptParallelSession({...argsTwo,reason_code:'OWNER_ABORTED'});
 assert.equal((await readParallelSession(stateTwo)).preview,undefined);
 const noExport=path.join(temp,'review-after-interrupt');
 await assert.rejects(exportParallelReviewBundle({
   ...argsTwo,outputDir:noExport
 }),/Only a verified, successful review preview/);
 await assert.rejects(fs.stat(noExport),{code:'ENOENT'});
 assert.equal((await inspectParallelSessionRecovery(argsTwo)).session_status,'interrupted');
 console.log('PASS: owner interruption invalidates prior review and blocks bundle export');
}finally{await fs.rm(temp,{recursive:true,force:true});}
