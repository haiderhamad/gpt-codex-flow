// OFFLINE, READ-ONLY candidate for future independently installed macOS broker.
// Never creates an enrollment from untrusted records, grants permissions,
// calls Codex, writes to Git, or authenticates a process.
// "enrollment" MUST be supplied and pinned by a trusted authority independent
// of the agent-editable parallel-session.json. This module is NOT that authority.
import {normalizedRolePublicKeys,roleProofModeConsistent,verifyRoleReportProof}
  from './gcf-parallel-role-proof.mjs';

const roles=['chatgpt','codex'];
const idPattern=/^parallel_[a-f0-9-]{36}$/;
const headPattern=/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const validPath=p=>typeof p==='string'&&p.length>0&&p.length<250&&
  !p.startsWith('/')&&!p.includes('\\')&&!/[\u0000-\u001f\u007f]/.test(p)&&
  p.split('/').every(segment=>segment&&segment!=='.'&&segment!=='..'&&
    segment!=='.git'&&segment!=='.ai-bridge');
function validatedEnrollment(e){
  if(!e||typeof e!=='object'||Array.isArray(e)||
     !idPattern.test(e.session_id??'')||!headPattern.test(e.base_head??'')||
     typeof e.goal!=='string'||!e.goal.trim()||e.goal.length>1500)
    throw new Error('Trusted enrollment shape invalid.');
  const publicKeys=normalizedRolePublicKeys(e.role_public_keys);
  if(!publicKeys)throw new Error('Trusted enrollment needs both role keys.');
  if(!e.roles||typeof e.roles!=='object'||Array.isArray(e.roles)||
     Object.keys(e.roles).length!==2||!roles.every(r=>Object.hasOwn(e.roles,r)))
    throw new Error('Trusted enrollment requires both roles.');
  const all=[];
  for(const r of roles){
    const entry=e.roles[r];
    if(!entry||typeof entry.task!=='string'||!entry.task.trim()||
       entry.task.length>1500||!Array.isArray(entry.target_paths)||
       entry.target_paths.length<1||entry.target_paths.length>30||
       !entry.target_paths.every(validPath)||
       new Set(entry.target_paths).size!==entry.target_paths.length)
      throw new Error('Trusted enrollment has invalid assignment.');
    all.push(...entry.target_paths);
  }
  if(new Set(all).size!==all.length)
    throw new Error('Trusted enrollment has overlapping ownership.');
  return publicKeys;
}
function equalArray(x,y){
  return Array.isArray(x)&&Array.isArray(y)&&
    x.length===y.length&&x.every((v,i)=>v===y[i]);
}
export function auditPinnedParallelEnrollment({session,enrollment}){
  // This is only evidence comparison. The caller cannot bootstrap trust by
  // constructing "enrollment" from the same mutable session under inspection.
  const keys=validatedEnrollment(enrollment);
  const reasons=[];
  if(!session||typeof session!=='object'||Array.isArray(session))
    return {status:'REFUSED',reasons:['INVALID_SESSION'],pinned_enrollment_matches:false,
      role_signatures_valid:false,client_identity_verified:false,
      owner_approval_granted:false,execution_performed:false};
  if(session.schema!==1)reasons.push('INVALID_SCHEMA');
  if(!['ready_to_preview','preview_verified'].includes(session.status))
    reasons.push('SESSION_NOT_REVIEWABLE');
  if(!roleProofModeConsistent(session)||session.role_proof_required!==true)
    reasons.push('SIGNED_MODE_REQUIRED');
  if(session.session_id!==enrollment.session_id)
    reasons.push('SESSION_ID_MISMATCH');
  if(session.base_head!==enrollment.base_head)
    reasons.push('BASE_HEAD_MISMATCH');
  if(session.goal!==enrollment.goal)
    reasons.push('GOAL_MISMATCH');
  for(const role of roles){
    if(session.role_public_keys?.[role]!==keys[role])
      reasons.push('ROLE_KEY_MISMATCH_'+role.toUpperCase());
    const expected=enrollment.roles[role],actual=session.roles?.[role];
    if(!actual||actual.task!==expected.task||
       !equalArray(actual.target_paths,expected.target_paths))
      reasons.push('ASSIGNMENT_MISMATCH_'+role.toUpperCase());
  }
  if(session.roles?.chatgpt?.state==='reported'||
     session.roles?.codex?.state==='reported'){
    for(const role of roles){
      const entry=session.roles?.[role];
      if(entry?.state!=='reported'){
        reasons.push('INCOMPLETE_SIGNED_REPORTS');
        continue;
      }
      const owned=enrollment.roles[role].target_paths;
      if(!Array.isArray(entry.changed_paths)||!entry.changed_paths.length||
         entry.changed_paths.length>30||
         entry.changed_paths.some(p=>!owned.includes(p))||
         new Set(entry.changed_paths).size!==entry.changed_paths.length)
        reasons.push('OUT_OF_SCOPE_REPORT_PATHS_'+role.toUpperCase());
      if(!verifyRoleReportProof({session,role,evidence:entry.evidence,
        patchSha256:entry.patch_sha256,signature:entry.proof_signature}))
        reasons.push('INVALID_REPORT_PROOF_'+role.toUpperCase());
    }
  }else{
    reasons.push('NO_SIGNED_REPORTS_YET');
  }
  const unique=[...new Set(reasons)];
  const blockers=unique.filter(reason=>reason!=='NO_SIGNED_REPORTS_YET');
  return {
    status:blockers.length?'REFUSED':unique.length?'INCOMPLETE':'PASS',
    reasons:unique,
    pinned_enrollment_matches:!unique.some(r=>r.startsWith('SIGNED_MODE')||
      r.includes('_MISMATCH')),
    role_signatures_valid:unique.length===0,
    client_identity_verified:false,owner_approval_granted:false,
    execution_performed:false,merge_performed:false,
    requires_independent_installed_broker:true
  };
}
