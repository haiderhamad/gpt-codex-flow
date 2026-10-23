// GPT Codex Flow: advisory two-role coordination for a trusted LOCAL CLI runner.
// Does not execute agents, authenticate role identities, or merge to the original.
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectParallelWorktrees, previewParallelIntegration } from './gcf-parallel-sync.mjs';
import { normalizedRolePublicKeys, verifyRoleReportProof, roleProofModeConsistent } from './gcf-parallel-role-proof.mjs';

const ROLES = ['chatgpt', 'codex'];
const hash = (data) => createHash('sha256').update(data).digest('hex');
const sessionFile = (dir) => path.join(path.resolve(dir), 'parallel-session.json');
function validTarget(p) {
  return typeof p === 'string' && p.length > 0 && p.length < 250 &&
    !p.startsWith('/') && !p.includes('\\') &&
    p.split('/').every((x) => x !== '..' && x !== '.' && x !== '' && x !== '.git');
}
function publicRecord(record) {
  const { base, worktrees, ...safe } = record;
  return { ...safe, paths_redacted: true };
}
export async function readParallelSession(dir) {
  const data = await fs.readFile(sessionFile(dir));
  if (data.length > 32_000) throw new Error('Session exceeds size limit.');
  const state = JSON.parse(data.toString('utf8'));
  if (state.schema !== 1 || !state.session_id?.startsWith('parallel_') ||
      !ROLES.every((role) => state.roles?.[role]) || !state.base || !state.worktrees)
    throw new Error('Invalid session record.');
  return state;
}
async function update(dir, before, after) {
  const file = sessionFile(dir), lock = file + '.lock';
  const handle = await fs.open(lock, 'wx', 0o600);
  let temp;
  try {
    const onDisk = await fs.readFile(file);
    if (hash(onDisk) !== hash(Buffer.from(JSON.stringify(before, null, 2) + '\n')))
      throw new Error('Stale session update.');
    temp = file + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temp, JSON.stringify(after, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
    return publicRecord(after);
  } finally {
    if (temp) await fs.rm(temp, { force: true });
    await handle.close();
    await fs.rm(lock, { force: true });
  }
}
export async function createParallelSession({ dir, base, chatgpt, codex, goal, assignments, rolePublicKeys }) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Absolute state directory required.');
  if (typeof goal !== 'string' || !goal.trim() || goal.length > 1500)
    throw new Error('Bounded nonempty goal required.');
  for (const role of ROLES) {
    const a = assignments?.[role];
    if (!a || typeof a.task !== 'string' || !a.task.trim() || a.task.length > 1500 ||
        !Array.isArray(a.target_paths) || !a.target_paths.length || a.target_paths.length > 30 ||
        a.target_paths.some((p) => !validTarget(p)) ||
        new Set(a.target_paths).size !== a.target_paths.length)
      throw new Error('Each role needs a task and unique owned file paths.');
  }
  const chat = assignments.chatgpt.target_paths, cod = assignments.codex.target_paths;
  if (chat.some((p) => cod.includes(p))) throw new Error('Overlapping file ownership.');
  const inspection = await inspectParallelWorktrees({ base, chatgpt, codex });
  if (inspection.reasons.includes('STALE_GIT_HEAD') ||
      inspection.reasons.includes('BASE_WORKTREE_DIRTY') ||
      inspection.reasons.includes('UNTRACKED_WORKER_FILES') ||
      inspection.participants.chatgpt.changedPaths.length ||
      inspection.participants.codex.changedPaths.length)
    throw new Error('All worktrees must start clean at the same HEAD.');
  const proofKeys=normalizedRolePublicKeys(rolePublicKeys);
  const state = {
    schema: 1, session_id: 'parallel_' + randomUUID(), goal: goal.trim(),
    ...(proofKeys ? {role_public_keys:proofKeys,role_proof_required:true} : {}),
    base: inspection._roots.baseRoot,
    worktrees: { chatgpt: inspection._roots.chatgptRoot, codex: inspection._roots.codexRoot },
    base_head: inspection.baseHead,
    status: 'planned', created_at: new Date().toISOString(),
    roles: Object.fromEntries(ROLES.map((role) => [role, {
      task: assignments[role].task.trim(),
      target_paths: [...assignments[role].target_paths],
      state: 'assigned', evidence: null
    }]))
  };
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(sessionFile(dir), JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return publicRecord(state);
}
export async function reportParallelRole({ dir, session_id, role, evidence, signature }) {
  if (!ROLES.includes(role)) throw new Error('Unknown role.');
  // Independent clients can report simultaneously; serialize writes using the
  // existing lock and reload after contention, never overwrite another report.
  for (let attempt = 0; attempt < 8; attempt++) {
    try { return await reportRoleOnce({ dir, session_id, role, evidence, signature }); }
    catch (error) {
      if (!(error?.code === 'EEXIST' || error?.message === 'Stale session update.') || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
    }
  }
}
async function reportRoleOnce({ dir, session_id, role, evidence, signature }) {
  const state = await readParallelSession(dir);
  if (state.session_id !== session_id) throw new Error('Session mismatch.');
  if (!['planned', 'in_progress'].includes(state.status)) throw new Error('Session is closed for reports.');
  if (state.roles[role].state !== 'assigned') throw new Error('Duplicate role report.');
  if (typeof evidence !== 'string' || !evidence.trim() || evidence.length > 500)
    throw new Error('Bounded evidence required.');
  // A completion claim must be backed by actual in-scope Git changes.
  // Other roles may still be unmodified; do not require the whole plan to be ready.
  const inspection = await inspectParallelWorktrees({ base: state.base, ...state.worktrees });
  if (inspection.baseHead !== state.base_head ||
      inspection.reasons.some((reason) => ['STALE_GIT_HEAD', 'BASE_WORKTREE_DIRTY',
        'UNTRACKED_WORKER_FILES', 'UNSUPPORTED_CHANGE_TYPE', 'OVERLAPPING_FILES',
        'UNSAFE_WORKER_PATH'].includes(reason)))
    throw new Error('Unsafe or stale Git baseline for role completion.');
  const candidate = inspection.participants[role];
  if (!candidate.changedPaths.length ||
      candidate.changedPaths.some((p) => !state.roles[role].target_paths.includes(p)))
    throw new Error('Role has no verified changes or modified an unassigned file.');
  if(!roleProofModeConsistent(state))
    throw new Error('Inconsistent role proof mode.');
  if(state.role_proof_required){
    if(!verifyRoleReportProof({session:state,role,evidence,
      patchSha256:candidate.patchSha256,signature}))
      throw new Error('Missing or invalid Ed25519 role completion proof.');
  }
  const next = structuredClone(state);
  if(state.role_proof_required)next.roles[role].proof_signature=signature;
  next.roles[role].patch_sha256 = candidate.patchSha256;
  next.roles[role].changed_paths = [...candidate.changedPaths];
  next.roles[role].state = 'reported';
  next.roles[role].evidence = evidence.trim();
  next.status = ROLES.every((r) => next.roles[r].state === 'reported') ? 'ready_to_preview' : 'in_progress';
  return update(dir, state, next);
}
// Durable, fail-closed interruption marker. No attempts are made to resume a
// worker or to claim that role labels are authenticated client identities.
export async function interruptParallelSession({dir, session_id, reason_code}) {
  const reasons = ['WORKER_FAILED','WORKER_INTERRUPTED','POSTFLIGHT_REJECTED',
    'REVIEW_FAILED','OWNER_ABORTED'];
  if (!reasons.includes(reason_code)) throw new Error('Invalid interruption reason.');
  const state = await readParallelSession(dir);
  if (state.session_id !== session_id) throw new Error('Session mismatch.');
  if (!['planned','in_progress','ready_to_preview','preview_verified'].includes(state.status))
    throw new Error('Session cannot be interrupted in its current state.');
  const next = structuredClone(state);
  next.status = 'interrupted';
  next.interruption = {
    reason_code, recorded_at: new Date().toISOString(),
    automatic_resume_allowed: false, owner_review_required: true
  };
  // A previous verification is not valid for future exports after interruption.
  delete next.preview;
  return update(dir, state, next);
}
export async function previewParallelSession({ dir, session_id }) {
  const state = await readParallelSession(dir);
  if (state.session_id !== session_id) throw new Error('Session mismatch.');
  if (state.status !== 'ready_to_preview') throw new Error('Both roles must report first.');
  const args = { base: state.base, ...state.worktrees };
  if(state.role_proof_required===true && ['chatgpt','codex'].some(role=>
     !verifyRoleReportProof({session:state,role,
       evidence:state.roles[role].evidence,
       patchSha256:state.roles[role].patch_sha256,
       signature:state.roles[role].proof_signature})))
    throw new Error('Persisted role proof invalid: cannot preview.');
  if(!roleProofModeConsistent(state))
    throw new Error('Inconsistent role proof mode.');
  const inspection = await inspectParallelWorktrees(args);
  if (inspection.baseHead !== state.base_head)
    throw new Error('Original base HEAD changed.');
  const outOfScope = ROLES.flatMap((role) => inspection.participants[role].changedPaths
    .filter((p) => !state.roles[role].target_paths.includes(p))
    .map((p) => [role, p].join(':')));
  const changedAfterReport = ROLES.some((role) =>
    !/^[0-9a-f]{64}$/.test(state.roles[role].patch_sha256 ?? '') ||
    inspection.participants[role].patchSha256 !== state.roles[role].patch_sha256);
  let result = outOfScope.length
    ? { preview: 'BLOCKED', reasons: ['OUT_OF_SCOPE_CHANGES'] }
    : changedAfterReport
      ? { preview: 'BLOCKED', reasons: ['ROLE_CHANGED_AFTER_REPORT'] }
      : await previewParallelIntegration(args);
  // The integration preview snapshots Git a second time. Re-validate its
  // digests, so a late edit cannot slip between the initial and final checks.
  if (result.preview === 'PASS' && ROLES.some((role) =>
    result.participants[role].patchSha256 !== state.roles[role].patch_sha256)) {
    result = { preview: 'BLOCKED', reasons: ['ROLE_CHANGED_AFTER_REPORT'] };
  }
  const next = structuredClone(state);
  next.status = result.preview === 'PASS' ? 'preview_verified' : 'blocked';
  next.preview = {
    status: result.preview, reasons: result.reasons ?? [],
    paths: result.combinedPaths ?? [],
    sha256: result.combinedPatchSha256 ?? null,
    applied_to_original: false
  };
  await update(dir, state, next);
  return { session_id, ...next.preview, requires_owner_merge_approval: true };
}
