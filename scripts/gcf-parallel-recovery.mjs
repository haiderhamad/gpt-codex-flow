// READ-ONLY recovery assessment for interrupted local parallel sessions.
// Recovery NEVER restarts agents, accepts completion, releases stale locks,
// exports a review bundle, or authenticates role names.
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readParallelSession} from './gcf-parallel-session.mjs';
import {verifyRoleReportProof,normalizedRolePublicKeys,roleProofModeConsistent} from './gcf-parallel-role-proof.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const validPath=p=>typeof p==='string'&&p.length>0&&p.length<=250&&
  !p.startsWith('/')&&!p.includes('\\')&&!/[\0\r\n]/.test(p)&&
  p.split('/').every(v=>v&&v!=='.'&&v!=='..'&&v!=='.git'&&v!=='.ai-bridge');
const statuses=new Set(['planned','in_progress','ready_to_preview',
  'preview_verified','interrupted','blocked']);
const uuid=/^parallel_[a-f0-9-]{36}$/;
async function regularStateFile(file){
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.size<1||stat.size>32000)
    throw new Error('Recovery requires a bounded regular session record.');
}
async function lockExists(file){
  try{await fs.lstat(file);return true;}
  catch(e){if(e?.code==='ENOENT')return false;throw e;}
}
export async function inspectParallelSessionRecovery({dir,session_id}){
  if(typeof dir!=='string'||!path.isAbsolute(dir)||!uuid.test(session_id??''))
    throw new Error('Absolute state directory and valid session ID required.');
  const file=path.join(dir,'parallel-session.json');
  await regularStateFile(file);
  const before=await fs.readFile(file);
  const session=await readParallelSession(dir);
  if(session.session_id!==session_id||!statuses.has(session.status))
    throw new Error('Recovery session mismatch or invalid state.');
  const reasons=[];
  if(!roleProofModeConsistent(session))
    reasons.push('INVALID_ROLE_PROOF_MODE');
  if(session.role_proof_required===true){
    try{normalizedRolePublicKeys(session.role_public_keys);}
    catch{reasons.push('INVALID_ROLE_PROOF_KEYS');}
  }
  if(await lockExists(file+'.lock')) reasons.push('SESSION_LOCK_PRESENT');
  const reported=[];
  for(const role of ['chatgpt','codex']){
    const entry=session.roles[role],targets=entry?.target_paths;
    if(!Array.isArray(targets)||!targets.length||targets.length>30||
       targets.some(v=>!validPath(v))||new Set(targets).size!==targets.length){
      reasons.push('INVALID_ROLE_TARGETS');continue;
    }
    if(entry.state==='reported'){
      reported.push(role);
      if(session.role_proof_required===true && !verifyRoleReportProof({
        session,role,evidence:entry.evidence,patchSha256:entry.patch_sha256,
        signature:entry.proof_signature
      }))reasons.push('ROLE_PROOF_INVALID');
      if(!/^[0-9a-f]{64}$/.test(entry.patch_sha256??'')||
         !Array.isArray(entry.changed_paths)||!entry.changed_paths.length||
         entry.changed_paths.length>30||
         entry.changed_paths.some(p=>!targets.includes(p))||
         new Set(entry.changed_paths).size!==entry.changed_paths.length)
        reasons.push('UNTRUSTED_ROLE_REPORT');
    }else if(entry.state!=='assigned'){
      reasons.push('INVALID_ROLE_STATE');
    }
  }
  const allTargets=['chatgpt','codex'].flatMap(r=>
    Array.isArray(session.roles[r]?.target_paths)?
      session.roles[r].target_paths:[]);
  if(new Set(allTargets).size!==allTargets.length)
    reasons.push('OVERLAPPING_ROLE_TARGETS');
  if(session.status==='in_progress'&&reported.length<2)
    reasons.push('PARTIAL_WORKER_REPORT');
  if(session.status==='ready_to_preview'&&reported.length!==2)
    reasons.push('INCOMPLETE_WORKER_REPORTS');
  if(session.status==='preview_verified'&&
     (reported.length!==2||session.preview?.status!=='PASS'||
      !/^[0-9a-f]{64}$/.test(session.preview?.sha256??'')))
    reasons.push('INVALID_PREVIEW_RECORD');
  if(session.status==='interrupted')reasons.push('SESSION_INTERRUPTED');
  if(session.status==='blocked')reasons.push('SESSION_BLOCKED');
  await regularStateFile(file);
  const after=await fs.readFile(file);
  if(!before.equals(after))throw new Error('Session changed during recovery inspection.');
  const afterLock=await lockExists(file+'.lock');
  if(afterLock&&!reasons.includes('SESSION_LOCK_PRESENT'))
    reasons.push('SESSION_LOCK_PRESENT');
  if(session.status==='planned'&&reported.length>0)
    reasons.push('INCONSISTENT_SESSION_STATUS');
  return {
    session_id,session_status:session.status,
    record_sha256:hash(after),
    status:'OWNER_REVIEW_REQUIRED',auto_resume_allowed:false,
    agent_started:false,model_called:false,
    bundle_export_performed:false,merge_performed:false,
    prior_preview_requires_fresh_verification:session.status==='preview_verified',
    reported_roles:reported,remaining_roles:['chatgpt','codex'].filter(r=>!reported.includes(r)),
    record_consistent:!reasons.some(r=>['INVALID_ROLE_TARGETS','UNTRUSTED_ROLE_REPORT',
      'INVALID_ROLE_STATE','OVERLAPPING_ROLE_TARGETS','INCOMPLETE_WORKER_REPORTS',
      'INVALID_PREVIEW_RECORD','INCONSISTENT_SESSION_STATUS',
      'INVALID_ROLE_PROOF_MODE','INVALID_ROLE_PROOF_KEYS',
      'ROLE_PROOF_INVALID'].includes(r)),
    reasons:[...new Set(reasons)],
    role_signatures_verified:session.role_proof_required===true && reported.length===2 &&
      !reasons.some(r=>['INVALID_ROLE_PROOF_MODE','INVALID_ROLE_PROOF_KEYS',
        'ROLE_PROOF_INVALID'].includes(r)),
    role_proof_is_identity_attestation:false,
    client_identity_verified:false,
    next_action:'Inspect local Git worktrees and obtain explicit owner review; never auto-resume.'
  };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const a=process.argv.slice(2);
    if(a.length!==4||a[0]!=='--state-dir'||a[2]!=='--session-id')
      throw new Error('Usage: node scripts/gcf-parallel-recovery.mjs --state-dir ABS_PATH --session-id parallel_UUID');
    console.log(JSON.stringify(await inspectParallelSessionRecovery({dir:a[1],session_id:a[3]}),null,2));
  }catch(e){
    console.error('Parallel recovery REFUSED: '+(e?.message??String(e)));
    process.exitCode=2;
  }
}
