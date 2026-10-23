// Test-only independently held reference. It is never loaded from the mutable
// session under inspection and does not grant access to any workspace.
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,createHash} from 'node:crypto';
import {auditPinnedParallelEnrollment} from './gcf-parallel-trust-audit.mjs';
import {signRoleReportProof,verifyRoleReportProof} from './gcf-parallel-role-proof.mjs';

const keyPairs=Object.fromEntries(['chatgpt','codex'].map(r=>
  [r,generateKeyPairSync('ed25519')]));
const encoded=keys=>Object.fromEntries(['chatgpt','codex'].map(role=>
  [role,keys[role].publicKey.export({format:'der',type:'spki'}).toString('base64')]));
const pin={
  session_id:'parallel_'+randomUUID(),
  base_head:'a'.repeat(40),
  goal:'Bounded disposable proof-audit',
  role_public_keys:encoded(keyPairs),
  roles:{
    chatgpt:{task:'Update UI only',target_paths:['src/ui.txt']},
    codex:{task:'Update API only',target_paths:['src/api.txt']}
  }
};
const data=JSON.parse(JSON.stringify(pin));
data.schema=1;
data.role_proof_required=true;
data.status='ready_to_preview';
for(const role of ['chatgpt','codex']){
  const entry=data.roles[role];
  entry.state='reported';
  entry.evidence=role+' finished';
  entry.patch_sha256=createHash('sha256').update(role+' patch').digest('hex');
  entry.changed_paths=[...pin.roles[role].target_paths];
  entry.proof_signature=signRoleReportProof({session:data,role,evidence:entry.evidence,
    patchSha256:entry.patch_sha256,privateKey:keyPairs[role].privateKey});
}
const check=(session=data, enrollment=pin)=>
  auditPinnedParallelEnrollment({session,enrollment});
const valid=check();
assert.equal(valid.status,'PASS');
assert.equal(valid.pinned_enrollment_matches,true);
assert.equal(valid.role_signatures_valid,true);
assert.equal(valid.client_identity_verified,false);
assert.equal(valid.owner_approval_granted,false);
assert.equal(valid.execution_performed,false);
assert.equal(valid.merge_performed,false);
console.log('PASS: independent test-held enrollment matches signed session but grants no identity or execution');

// Tampering with the mutable session cannot change independently supplied pins.
function denied(change, code) {
  const forged=structuredClone(data);
  change(forged);
  const result=check(forged);
  assert.equal(result.status,'REFUSED',JSON.stringify(result));
  assert.ok(result.reasons.includes(code),JSON.stringify(result));
}
denied(s=>{s.session_id='parallel_'+'0'.repeat(36);},'SESSION_ID_MISMATCH');
denied(s=>{s.base_head='b'.repeat(40);},'BASE_HEAD_MISMATCH');
denied(s=>{s.goal='Different goal';},'GOAL_MISMATCH');
denied(s=>{s.roles.chatgpt.target_paths=['src/api.txt'];},'ASSIGNMENT_MISMATCH_CHATGPT');
denied(s=>{s.roles.codex.task='Changed work';},'ASSIGNMENT_MISMATCH_CODEX');
denied(s=>{s.roles.codex.changed_paths=['src/ui.txt'];},'OUT_OF_SCOPE_REPORT_PATHS_CODEX');
denied(s=>{s.status='interrupted';},'SESSION_NOT_REVIEWABLE');
denied(s=>{s.schema=2;},'INVALID_SCHEMA');
denied(s=>{s.role_public_keys={
  chatgpt:pin.role_public_keys.codex,codex:pin.role_public_keys.chatgpt
};},'ROLE_KEY_MISMATCH_CHATGPT');
denied(s=>{s.role_proof_required=undefined;delete s.role_public_keys;},
  'SIGNED_MODE_REQUIRED');
denied(s=>{s.roles.chatgpt.proof_signature=data.roles.codex.proof_signature;},
  'INVALID_REPORT_PROOF_CHATGPT');
console.log('PASS: session ID, Git HEAD, goal, assignment, keys, downgrade and signature edits refused');

const replacedKeys=Object.fromEntries(['chatgpt','codex'].map(r=>
  [r,generateKeyPairSync('ed25519')]));
const forgedAll=structuredClone(data);
forgedAll.role_public_keys=encoded(replacedKeys);
for(const role of ['chatgpt','codex']){
  const entry=forgedAll.roles[role];
  entry.proof_signature=signRoleReportProof({session:forgedAll,role,
    evidence:entry.evidence,patchSha256:entry.patch_sha256,
    privateKey:replacedKeys[role].privateKey});
  assert.equal(verifyRoleReportProof({session:forgedAll,role,
    evidence:entry.evidence,patchSha256:entry.patch_sha256,
    signature:entry.proof_signature}),true);
}
const whole=check(forgedAll);
assert.equal(whole.status,'REFUSED');
assert.ok(whole.reasons.includes('ROLE_KEY_MISMATCH_CHATGPT'));
assert.ok(whole.reasons.includes('ROLE_KEY_MISMATCH_CODEX'));
console.log('PASS: wholly replaced session with new, internally valid signatures is refused by external pins');

const partial=structuredClone(data);
partial.roles.codex.state='assigned';
delete partial.roles.codex.proof_signature;
const pending=check(partial);
assert.equal(pending.status,'REFUSED');
assert.ok(pending.reasons.includes('INCOMPLETE_SIGNED_REPORTS'));
const unsigned=structuredClone(data);
delete unsigned.role_proof_required;
delete unsigned.role_public_keys;
for(const role of ['chatgpt','codex'])delete unsigned.roles[role].proof_signature;
assert.equal(check(unsigned).status,'REFUSED');
const invalid=structuredClone(pin);
invalid.roles.codex.target_paths=['src/ui.txt'];
assert.throws(()=>check(data,invalid),/overlapping ownership/);
console.log('PASS: partial proof, legacy downgrade and invalid trusted enrollment denied');

// A caller that can forge/replace BOTH the trust pins and the record remains
// outside the scope of this test: a protected broker is still the P0 gate.
console.log('SECURITY LIMIT: trusted pins are TEST-HELD, NOT an installed macOS trust anchor');
