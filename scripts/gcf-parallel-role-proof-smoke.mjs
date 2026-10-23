import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createParallelSession,readParallelSession,reportParallelRole,
  previewParallelSession} from './gcf-parallel-session.mjs';
import {inspectParallelWorktrees} from './gcf-parallel-sync.mjs';
import {exportParallelReviewBundle} from './gcf-parallel-review.mjs';
import {verifyParallelReviewBundle} from './gcf-parallel-verify.mjs';
import {inspectParallelSessionRecovery} from './gcf-parallel-recovery.mjs';
import {normalizedRolePublicKeys,signRoleReportProof,verifyRoleReportProof}
  from './gcf-parallel-role-proof.mjs';

const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-role-proof-'));
const base=path.join(tmp,'base'),chatgpt=path.join(tmp,'chatgpt');
const codex=path.join(tmp,'codex'),stateDir=path.join(base,'.ai-bridge');
const keys=Object.fromEntries(['chatgpt','codex'].map(role=>
  [role,generateKeyPairSync('ed25519')]));
const pubs=Object.fromEntries(['chatgpt','codex'].map(role=>
  [role,keys[role].publicKey.export({format:'der',type:'spki'}).toString('base64')]));
function git(cwd,...args){
  const r=spawnSync('git',args,{cwd,encoding:'utf8',timeout:12000});
  assert.equal(r.status,0,r.stderr||r.stdout);
}
try {
 assert.deepEqual(normalizedRolePublicKeys(pubs),pubs);
 assert.throws(()=>normalizedRolePublicKeys({...pubs,codex:pubs.chatgpt}),/distinct/);
 assert.throws(()=>normalizedRolePublicKeys({chatgpt:pubs.chatgpt}),/Both role/);
 await fs.mkdir(path.join(base,'src'),{recursive:true});
 await fs.writeFile(path.join(base,'.gitignore'),'.ai-bridge/\n');
 await fs.writeFile(path.join(base,'src/ui.txt'),'before UI\n');
 await fs.writeFile(path.join(base,'src/api.txt'),'before API\n');
 git(base,'init','-q');git(base,'add','.');
 git(base,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
   'commit','-q','-m','fixture');
 git(base,'worktree','add','-q','-b','proof-chat',chatgpt,'HEAD');
 git(base,'worktree','add','-q','-b','proof-codex',codex,'HEAD');
 const session=await createParallelSession({
   dir:stateDir,base,chatgpt,codex,goal:'Local role signature fixture',
   rolePublicKeys:pubs,
   assignments:{
     chatgpt:{task:'Change UI',target_paths:['src/ui.txt']},
     codex:{task:'Change API',target_paths:['src/api.txt']}
   }
 });
 const args={dir:stateDir,session_id:session.session_id};
 assert.equal((await inspectParallelSessionRecovery(args)).role_signatures_verified,false,
   'No signed role reports exist in a newly planned strict session.');
 const stateFile=path.join(stateDir,'parallel-session.json');
 await fs.writeFile(path.join(chatgpt,'src/ui.txt'),'after UI\n');
 await fs.writeFile(path.join(codex,'src/api.txt'),'after API\n');
 const snap=await inspectParallelWorktrees({base,chatgpt,codex});
 const reportArgs=role=>({
   ...args,role,
   evidence:role==='chatgpt'?'UI completed':'API completed'
 });
 const signature=role=>signRoleReportProof({
   session,role,evidence:reportArgs(role).evidence,
   patchSha256:snap.participants[role].patchSha256,
   privateKey:keys[role].privateKey
 });
 const chatSig=signature('chatgpt'),codSig=signature('codex');
 assert.equal(verifyRoleReportProof({
   session,role:'chatgpt',evidence:'UI completed',
   patchSha256:snap.participants.chatgpt.patchSha256,signature:chatSig
 }),true);
 assert.equal(verifyRoleReportProof({
   session,role:'codex',evidence:'UI completed',
   patchSha256:snap.participants.chatgpt.patchSha256,signature:chatSig
 }),false);
 assert.equal(verifyRoleReportProof({
   session:{...session,session_id:'parallel_'+'0'.repeat(36)},
   role:'chatgpt',evidence:'UI completed',
   patchSha256:snap.participants.chatgpt.patchSha256,signature:chatSig
 }),false);
 assert.equal(verifyRoleReportProof({
   session,role:'chatgpt',evidence:'modified claim',
   patchSha256:snap.participants.chatgpt.patchSha256,signature:chatSig
 }),false);
 assert.equal(verifyRoleReportProof({
   session,role:'chatgpt',evidence:'UI completed',
   patchSha256:createHash('sha256').update('modified patch').digest('hex'),
   signature:chatSig
 }),false);
 await assert.rejects(reportParallelRole(reportArgs('chatgpt')),
   /Missing or invalid Ed25519/);
 await assert.rejects(reportParallelRole({...reportArgs('chatgpt'),signature:codSig}),
   /Missing or invalid Ed25519/);
 await assert.rejects(reportParallelRole({...reportArgs('chatgpt'),signature:chatSig.slice(1)}),
   /Missing or invalid Ed25519/);
 const still=await readParallelSession(stateDir);
 assert.equal(still.status,'planned');
 assert.equal(still.roles.chatgpt.state,'assigned');
 assert.equal((await inspectParallelSessionRecovery(args)).auto_resume_allowed,false);
 console.log('PASS: forged, missing, wrong-role, wrong-task and replayed Ed25519 proofs refused');

 await reportParallelRole({...reportArgs('chatgpt'),signature:chatSig});
 await reportParallelRole({...reportArgs('codex'),signature:codSig});
 const recovery=await inspectParallelSessionRecovery(args);
 assert.equal(recovery.role_signatures_verified,true);
 assert.equal(recovery.client_identity_verified,false);
 assert.equal(recovery.record_consistent,true);
 assert.equal((await previewParallelSession(args)).status,'PASS');
 const exportRoot=path.join(tmp,'signed-review');
 await exportParallelReviewBundle({...args,outputDir:exportRoot});
 const manifest=JSON.parse(await fs.readFile(path.join(exportRoot,'manifest.json')));
 assert.equal(manifest.role_signatures_verified,true);
 assert.equal(manifest.worker_identity_verified,false);
 assert.equal(manifest.role_signatures_are_identity_attestation,false);
 assert.equal((await verifyParallelReviewBundle({base,reviewDir:exportRoot})).status,'PASS');
 console.log('PASS: two separate keys bind role+session+task+paths+patch+evidence through verified review bundle');

 const original=await fs.readFile(stateFile,'utf8');
 const forged=JSON.parse(original);
 forged.roles.chatgpt.proof_signature=codSig;
 await fs.writeFile(stateFile,JSON.stringify(forged,null,2)+'\n');
 await assert.rejects(exportParallelReviewBundle({
   ...args,outputDir:path.join(tmp,'tampered-review')
 }),/Invalid signed role completion proof/);
 assert.equal((await inspectParallelSessionRecovery(args)).record_consistent,false);
 assert.ok((await inspectParallelSessionRecovery(args)).reasons.includes('ROLE_PROOF_INVALID'));
 await fs.writeFile(stateFile,original);
 const swapped=JSON.parse(original);
 swapped.role_public_keys={chatgpt:pubs.codex,codex:pubs.chatgpt};
 await fs.writeFile(stateFile,JSON.stringify(swapped,null,2)+'\n');
 const readySwapped={...swapped,status:'ready_to_preview'};
 delete readySwapped.preview;
 await fs.writeFile(stateFile,JSON.stringify(readySwapped,null,2)+'\n');
 await assert.rejects(previewParallelSession(args),/Persisted role proof invalid/);
 await fs.writeFile(stateFile,JSON.stringify(swapped,null,2)+'\n');
 await assert.rejects(exportParallelReviewBundle({
   ...args,outputDir:path.join(tmp,'swapped-key-review')
 }),/Invalid signed role completion proof/);
 assert.ok((await inspectParallelSessionRecovery(args)).reasons.includes('ROLE_PROOF_INVALID'));
 await fs.writeFile(stateFile,original);
 const inconsistent=JSON.parse(original);
 delete inconsistent.role_proof_required;
 await fs.writeFile(stateFile,JSON.stringify(inconsistent,null,2)+'\n');
 await assert.rejects(exportParallelReviewBundle({
   ...args,outputDir:path.join(tmp,'downgraded-record-review')
 }),/Inconsistent role proof mode/);
 assert.ok((await inspectParallelSessionRecovery(args)).reasons.includes('INVALID_ROLE_PROOF_MODE'));
 await fs.writeFile(stateFile,original);
 const alteredTask=JSON.parse(original);
 alteredTask.roles.codex.task='Attacker changed task';
 await fs.writeFile(stateFile,JSON.stringify(alteredTask,null,2)+'\n');
 assert.equal((await inspectParallelSessionRecovery(args)).role_signatures_verified,false);
 await fs.writeFile(stateFile,original);
 assert.equal((await inspectParallelSessionRecovery(args)).record_consistent,true);
 console.log('PASS: persisted forged signature, swapped keys and changed task invalidate trusted report');

 // Legacy sessions continue to be unverified; no false identity claim.
 const legacyRoot=path.join(tmp,'legacy-state');
 await fs.writeFile(path.join(chatgpt,'src/ui.txt'),'before UI\n');
 await fs.writeFile(path.join(codex,'src/api.txt'),'before API\n');
 const legacy=await createParallelSession({
   dir:legacyRoot,base,chatgpt,codex,goal:'Legacy advisory flow',
   assignments:{
     chatgpt:{task:'UI',target_paths:['src/ui.txt']},
     codex:{task:'API',target_paths:['src/api.txt']}
   }
 });
 const legacyStatus=await inspectParallelSessionRecovery({
   dir:legacyRoot,session_id:legacy.session_id
 });
 assert.equal(legacyStatus.role_signatures_verified,false);
 assert.equal(legacyStatus.client_identity_verified,false);
 console.log('PASS: existing unsigned advisory-only sessions stay explicitly unverified');
}finally{await fs.rm(tmp,{recursive:true,force:true});}
