// Cryptographic ROLE CLAIM proof, not independent client identity attestation.
// The trust anchor (session's public keys) is stored in a mutable local JSON
// file. A privileged/same-UID writer can replace it: treat this as advisory.
import {createHash,createPublicKey,sign,verify} from 'node:crypto';

const sha=data=>createHash('sha256').update(data).digest('hex');
const roles=['chatgpt','codex'];
const validDigest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function normalizedRolePublicKeys(input) {
  if(input===undefined)return undefined; // Legacy advisory-only sessions
  if(!input||typeof input!=='object'||Array.isArray(input)||
     Object.keys(input).length!==2||
     !roles.every(role=>Object.hasOwn(input,role)))
    throw new Error('Both role public keys are required in strict proof mode.');
  const normalized={};
  for(const role of roles){
    const encoded=input[role];
    if(typeof encoded!=='string'||encoded.length>256||
       !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)||
       Buffer.from(encoded,'base64').toString('base64')!==encoded)
      throw new Error('Role proof public key must be canonical base64 SPKI DER.');
    const raw=Buffer.from(encoded,'base64');
    if(raw.length>128||raw.length<30)throw new Error('Role public key length refused.');
    const key=createPublicKey({key:raw,format:'der',type:'spki'});
    if(key.asymmetricKeyType!=='ed25519')throw new Error('Only Ed25519 role proof keys allowed.');
    const roundtrip=key.export({format:'der',type:'spki'});
    if(!roundtrip.equals(raw))throw new Error('Noncanonical Ed25519 public key refused.');
    normalized[role]=encoded;
  }
  if(normalized.chatgpt===normalized.codex)
    throw new Error('Parallel roles require distinct role proof keys.');
  return normalized;
}
// Reject internally inconsistent signed/unsigned session records. This cannot
// detect an attacker replacing the entire mutable session with a legacy record.
export function roleProofModeConsistent(session) {
  if(session?.role_proof_required===undefined && session?.role_public_keys===undefined)
    return true;
  if(session?.role_proof_required!==true)return false;
  try { return Boolean(normalizedRolePublicKeys(session.role_public_keys)); }
  catch { return false; }
}
export function roleReportTranscript({session,role,evidence,patchSha256}) {
  if(!session||!roles.includes(role)||typeof evidence!=='string'||
     evidence.length<1||evidence.length>500||!validDigest(patchSha256)||
     !/^parallel_[a-f0-9-]{36}$/.test(session.session_id??'')||
     !/^[a-f0-9]{40,64}$/.test(session.base_head??'')||
     typeof session.roles?.[role]?.task!=='string'||
     !Array.isArray(session.roles[role].target_paths))
    throw new Error('Invalid role report proof transcript.');
  return Buffer.from(JSON.stringify([
    'gcf:parallel-role-report-proof:v1',session.session_id,session.base_head,
    role,sha(session.roles[role].task),session.roles[role].target_paths,
    patchSha256,sha(evidence)
  ]),'utf8');
}
export function signRoleReportProof({session,role,evidence,patchSha256,privateKey}) {
  return sign(null,roleReportTranscript({session,role,evidence,patchSha256}),privateKey).toString('base64');
}
export function verifyRoleReportProof({session,role,evidence,patchSha256,signature}) {
  if(!session.role_public_keys)return false;
  const keyDer=session.role_public_keys[role];
  if(typeof signature!=='string'||signature.length!==88||
     Buffer.from(signature,'base64').toString('base64')!==signature||
     typeof keyDer!=='string')return false;
  const bytes=Buffer.from(signature,'base64');
  if(bytes.length!==64)return false;
  try {
    const keys=normalizedRolePublicKeys(session.role_public_keys);
    const key=createPublicKey({key:Buffer.from(keys[role],'base64'),format:'der',type:'spki'});
    return verify(null,roleReportTranscript({session,role,evidence,patchSha256}),key,bytes);
  }catch{return false;}
}
