// No broker installation, no credential usage, no model calls. Cross-language
// cryptographic parity test: real Node Ed25519 signature verified by Swift CryptoKit.
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {signRoleReportProof} from './gcf-parallel-role-proof.mjs';

if(process.platform!=='darwin'){
 console.log('SKIP: native macOS CryptoKit is required');
 process.exit(0);
}
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-owner-role-native-'));
try{
 const bin=path.join(tmp,'role-proof-audit-test');
 const built=spawnSync('/usr/bin/swiftc',[
   '-D','GCF_OWNER_ROLE_AUDIT_TEST','scripts/gcf-owner-native-role-audit.swift',
   '-o',bin
 ],{cwd:process.cwd(),encoding:'utf8',timeout:90000,maxBuffer:256000});
 assert.equal(built.status,0,built.stderr||built.stdout);
 const pairs=Object.fromEntries(['chatgpt','codex'].map(role=>
   [role,generateKeyPairSync('ed25519')]));
 const roles=['chatgpt','codex'];
 const pin={
   session_id:'parallel_'+randomUUID(),
   base_head:'a'.repeat(40),goal:'Offline cross-language role proof',
   role_public_keys:Object.fromEntries(roles.map(r=>[
     r,pairs[r].publicKey.export({format:'der',type:'spki'}).toString('base64')
   ])),
   roles:{
     chatgpt:{task:'Update UI',target_paths:['src/ui.txt']},
     codex:{task:'Update API',target_paths:['src/api.txt']}
   }
 };
 const session={
   schema:1,session_id:pin.session_id,base_head:pin.base_head,
   goal:pin.goal,role_proof_required:true,
   role_public_keys:structuredClone(pin.role_public_keys),
   status:'ready_to_preview',roles:{}
 };
 for(const r of roles){
   session.roles[r]={
     ...structuredClone(pin.roles[r]),state:'reported',
     changed_paths:[...pin.roles[r].target_paths],
     patch_sha256:createHash('sha256').update('fixture patch '+r).digest('hex'),
     evidence:r+' completed the assigned change'
   };
   const entry=session.roles[r];
   entry.proof_signature=signRoleReportProof({
     session,role:r,evidence:entry.evidence,
     patchSha256:entry.patch_sha256,privateKey:pairs[r].privateKey
   });
 }
 function invoke(p=pin,s=session){
   return spawnSync(bin,[],{
     input:JSON.stringify({enrollment:p,session:s}),
     encoding:'utf8',timeout:7000,maxBuffer:100000,
     env:{PATH:'/usr/bin:/bin',HOME:tmp,LANG:'C'}
   });
 }
 const good=invoke();
 assert.equal(good.status,0,good.stderr||good.stdout);
 assert.match(good.stdout,/PASS:CRYPTOGRAPHIC_ROLE_PROOF_ONLY/);
 assert.match(good.stdout,/CLIENT_IDENTITY_VERIFIED=false/);
 assert.match(good.stdout,/OWNER_APPROVAL_GRANTED=false/);
 console.log('PASS: Node Ed25519 signatures validated natively by macOS CryptoKit');
 // Cross-language canonical JSON compatibility with Unicode, slash and emoji.
 const unicodePin=structuredClone(pin),unicodeSession=structuredClone(session);
 unicodePin.roles.chatgpt.task='Update UI — تدقيق / 📦';
 unicodeSession.roles.chatgpt.task=unicodePin.roles.chatgpt.task;
 unicodeSession.roles.chatgpt.proof_signature=signRoleReportProof({
   session:unicodeSession,role:'chatgpt',
   evidence:unicodeSession.roles.chatgpt.evidence,
   patchSha256:unicodeSession.roles.chatgpt.patch_sha256,
   privateKey:pairs.chatgpt.privateKey
 });
 const unicodeProof=invoke(unicodePin,unicodeSession);
 assert.equal(unicodeProof.status,0,unicodeProof.stderr||unicodeProof.stdout);
 console.log('PASS: cross-language role signature transcript handles Unicode task text');

 function rejected(label,mutate){
   const pinClone=structuredClone(pin),sessionClone=structuredClone(session);
   mutate(pinClone,sessionClone);
   const out=invoke(pinClone,sessionClone);
   assert.equal(out.status,2,label+': '+out.stderr+' '+out.stdout);
   assert.match(out.stderr,/REFUSED:NATIVE_ROLE_PROOF_AUDIT/,label);
   assert.doesNotMatch(out.stdout,/PASS:/,label);
 }
 rejected('cross-role signature swap',(_,s)=>{
   s.roles.codex.proof_signature=s.roles.chatgpt.proof_signature;
 });
 rejected('modified session ID',(_,s)=>{s.session_id='parallel_'+randomUUID();});
 rejected('modified git head',(_,s)=>{s.base_head='b'.repeat(40);});
 rejected('modified task',(_,s)=>{s.roles.codex.task='different task';});
 rejected('out of scope changes',(_,s)=>{s.roles.chatgpt.changed_paths=['src/api.txt'];});
 rejected('fake identity key',(_,s)=>{
   s.role_public_keys.codex=s.role_public_keys.chatgpt;
 });
 rejected('signed mode removed',(_,s)=>{delete s.role_proof_required;});
 rejected('expired/interrupted session',(_,s)=>{s.status='interrupted';});
 rejected('partial report',(_,s)=>{s.roles.codex.state='assigned';});
 rejected('forged signature',(_,s)=>{
   s.roles.codex.proof_signature=Buffer.alloc(64).toString('base64');
 });
 rejected('task mismatch in independent pin',(p)=>{p.roles.chatgpt.task='modified';});
 // A model-supplied approval/identity claim is itself suspicious and refused.
 rejected('spoofed owner approval',(_,s)=>{s.userApproved=true;});
 rejected('spoofed client identity',(_,s)=>{s.client_identity_verified=true;});
 rejected('signature with altered evidence',(_,s)=>{s.roles.chatgpt.evidence='tampered';});
 rejected('malformed public key',p=>{p.role_public_keys.codex='not-a-key';});
 const swapped=Object.fromEntries(roles.map(r=>[r,generateKeyPairSync('ed25519')]));
 rejected('fully re-signed record with attacker keys',(_,s)=>{
   s.role_public_keys=Object.fromEntries(roles.map(r=>[
     r,swapped[r].publicKey.export({format:'der',type:'spki'}).toString('base64')
   ]));
   for(const r of roles){
     const entry=s.roles[r];
     entry.proof_signature=signRoleReportProof({
       session:s,role:r,evidence:entry.evidence,
       patchSha256:entry.patch_sha256,privateKey:swapped[r].privateKey
     });
   }
 });
 const unsigned=structuredClone(session);
 delete unsigned.role_proof_required;
 delete unsigned.role_public_keys;
 for(const role of roles)delete unsigned.roles[role].proof_signature;
 assert.equal(invoke(pin,unsigned).status,2);
 console.log('PASS: native verifier rejects wrong-role, replay, pin/key replacement, tampering, unsigned downgrade and incomplete reports');
 console.log('SECURITY LIMIT: test-held pins are not from a protected, signed macOS broker');
}finally{await fs.rm(tmp,{recursive:true,force:true});}
