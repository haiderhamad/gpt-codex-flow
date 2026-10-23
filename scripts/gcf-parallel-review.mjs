// GPT Codex Flow — explicit, LOCAL, non-destructive reviewed integration export.
// Does not run an AI agent, execute source code, modify any source worktree,
// merge branches, change Git history, authenticate clients or grant permissions.
// Caller chooses an external *new* directory and must review patch before use.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readParallelSession } from './gcf-parallel-session.mjs';
import { previewParallelIntegration } from './gcf-parallel-sync.mjs';
import {verifyRoleReportProof,roleProofModeConsistent} from './gcf-parallel-role-proof.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const roles = ['chatgpt', 'codex'];
function equalPaths(left, right) {
  return Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((name, i) => name === right[i]);
}
function within(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

export async function exportParallelReviewBundle({ dir, session_id, outputDir }) {
  if (typeof session_id !== 'string' || !/^parallel_[a-f0-9-]{36}$/.test(session_id))
    throw new Error('Valid parallel session ID required.');
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir))
    throw new Error('Absolute review output directory required.');
  const state = await readParallelSession(dir);
  if (state.session_id !== session_id) throw new Error('Session ID mismatch.');
  if (state.status !== 'preview_verified' || state.preview?.status !== 'PASS')
    throw new Error('Only a verified, successful review preview can be exported.');
  const validPath = (p) => typeof p === 'string' && p.length > 0 &&
    p.length <= 250 && !path.isAbsolute(p) && !p.includes('\\') &&
    p.split('/').every((part) => part && part !== '.' && part !== '..' && part !== '.git');
  const validList = (list) => Array.isArray(list) && list.length > 0 &&
    list.length <= 100 && list.every(validPath) &&
    new Set(list).size === list.length;
  if (!/^[a-f0-9]{64}$/.test(state.preview.sha256 ?? '') ||
      !validList(state.preview.paths))
    throw new Error('Stored review preview is malformed.');
  if(!roleProofModeConsistent(state))
    throw new Error('Inconsistent role proof mode.');
  for (const role of roles) {
    if(state.role_proof_required===true && !verifyRoleReportProof({
      session:state,role,evidence:state.roles[role]?.evidence,
      patchSha256:state.roles[role]?.patch_sha256,
      signature:state.roles[role]?.proof_signature
    }))throw new Error('Invalid signed role completion proof; export refused.');
    if (state.roles[role]?.state !== 'reported' ||
        !/^[a-f0-9]{64}$/.test(state.roles[role]?.patch_sha256 ?? '') ||
        !validList(state.roles[role]?.changed_paths)) {
      throw new Error('Both roles require verified completion fingerprints.');
    }
  }
  const latest = await previewParallelIntegration({
    base: state.base, ...state.worktrees
  }, { includeReviewPatch: true });
  if (latest.preview !== 'PASS' || latest.baseHead !== state.base_head ||
      !equalPaths(latest.combinedPaths, state.preview.paths) ||
      latest.combinedPatchSha256 !== state.preview.sha256 ||
      roles.some((role) =>
        latest.participants[role].patchSha256 !== state.roles[role].patch_sha256 ||
        !equalPaths(latest.participants[role].changedPaths, state.roles[role].changed_paths))) {
    throw new Error('Git changes differ from the verified session; export refused.');
  }
  const patch = latest._reviewPatch;
  if (!Buffer.isBuffer(patch) || patch.length === 0 || patch.length > 8_000_000 ||
      sha256(patch) !== state.preview.sha256)
    throw new Error('Combined patch is missing or failed the SHA-256 check.');

  // Export must not touch original repo/agent worktrees or write into another
  // already-existing path. Parent is resolved before output path creation.
  const parent = await fs.realpath(path.dirname(outputDir));
  const target = path.join(parent, path.basename(outputDir));
  if (path.basename(outputDir) === '.' || path.basename(outputDir) === '..' ||
      !target.startsWith(parent + path.sep)) {
    throw new Error('Invalid output path.');
  }
  const roots = await Promise.all([state.base, ...roles.map((role) => state.worktrees[role])]
    .map((folder) => fs.realpath(folder)));
  if (roots.some((root) => within(root, target) || within(target, root))) {
    throw new Error('Review output must be outside all project and agent worktrees.');
  }
  const manifest = {
    schema: 1,
    session_id: state.session_id,
    goal: state.goal,
    base_head: state.base_head,
    preview_status: 'PASS',
    exported_at: new Date().toISOString(),
    participants: Object.fromEntries(roles.map((role) => [role, {
      changed_paths: state.roles[role].changed_paths,
      patch_sha256: state.roles[role].patch_sha256,
      completion_reported: true
    }])),
    combined_paths: latest.combinedPaths,
    combined_patch_file: 'combined.patch',
    combined_patch_sha256: sha256(patch),
    combined_patch_bytes: patch.length,
    original_modified: false,
    merge_performed: false,
    verification_type: 'read-only Git patch replay in disposable clone',
    post_merge_tests_executed: false,
    worker_identity_verified: false,
    role_signatures_verified:state.role_proof_required===true,
    role_signatures_are_identity_attestation:false,
    owner_merge_approval_required: true
  };

  await fs.mkdir(target, { mode: 0o700 }); // fails if pre-existing, including symlink
  try {
    await fs.writeFile(path.join(target, 'combined.patch'), patch,
      { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(target, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
  return {
    review_dir: target,
    manifest_file: path.join(target, 'manifest.json'),
    patch_file: path.join(target, 'combined.patch'),
    patch_sha256: manifest.combined_patch_sha256,
    requires_owner_merge_approval: true,
    merged: false
  };
}

// Optional explicit local command; never a remote MCP merge/execute surface.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 6 ||
        args[0] !== '--state-dir' || args[2] !== '--session-id' || args[4] !== '--out') {
      throw new Error('Usage: node scripts/gcf-parallel-review.mjs --state-dir ABS_PATH --session-id parallel_UUID --out NEW_ABS_DIR');
    }
    const result = await exportParallelReviewBundle({
      dir: args[1], session_id: args[3], outputDir: args[5]
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Review bundle export REFUSED: ' +
      (error instanceof Error ? error.message : String(error)));
    process.exitCode = 2;
  }
}
