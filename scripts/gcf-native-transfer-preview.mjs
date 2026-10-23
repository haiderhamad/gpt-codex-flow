// GPT Codex Flow: LOCAL, non-executing review of an accepted advisory
// ChatGPT -> Codex transfer. This is NOT an authentication or execution gate.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectNativeCodex } from './gcf-native-codex-preflight.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const validPath = (p) => typeof p === 'string' && p.length > 0 &&
  p.length <= 180 && !path.isAbsolute(p) && !p.includes('\\') &&
  !/[\r\n\0]/.test(p) &&
  p.split('/').every((segment) => segment && !['.', '..', '.git', '.ai-bridge'].includes(segment));
function git(root, args) {
  const r = spawnSync('git', ['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',
    '-c','diff.external=',...args], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    maxBuffer: 1024 * 1024, shell: false,
    env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
      GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_EXTERNAL_DIFF:'',GIT_PAGER:'cat'}
  });
  if (r.status !== 0 || r.error) throw new Error('Git transfer baseline verification refused.');
  return r.stdout;
}
async function readRecord(root, name, maxBytes) {
  const filename = path.join(root, '.ai-bridge', name);
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes)
    throw new Error('Invalid bounded transfer/task record.');
  const resolved = await fs.realpath(filename);
  if (resolved !== filename) throw new Error('Transfer/task record uses a symlink.');
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}
async function requireRegularOwnedFile(root, filename) {
  const absolute = path.resolve(root, filename);
  if (!absolute.startsWith(root + path.sep))
    throw new Error('Owned file is outside worktree.');
  const [resolved, stat] = await Promise.all([fs.realpath(absolute), fs.lstat(absolute)]);
  if (!resolved.startsWith(root + path.sep) || !stat.isFile())
    throw new Error('Owned file is a symlink or nonregular path.');
}
function cleanSnapshot(root) {
  // Same Git digest framing as src/transferOps.ts snapshot().
  // This preview intentionally requires an entirely clean tracked/untracked
  // baseline; therefore no untracked-content iteration is necessary.
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const diff = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--']);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (status.length || diff.length || untracked.length)
    throw new Error('Native recipient requires clean disposable worktree.');
  const h = createHash('sha256');
  h.update(status).update('\0').update(diff).update('\0');
  return { head, status_sha256: h.digest('hex') };
}
export async function previewNativeTransfer({ worktree, searchPath = process.env.PATH ?? '', includeLocalPlan = false }) {
  if (typeof worktree !== 'string' || !path.isAbsolute(worktree))
    throw new Error('Absolute worktree is required.');
  const root = await fs.realpath(worktree);
  const transfer = await readRecord(root, 'transfer-control.json', 30_000);
  if (transfer?.state !== 'accepted' || transfer.to !== 'codex_lead' ||
      transfer.from !== 'chatgpt_lead' ||
      !/^transfer_[0-9a-f-]{36}$/.test(transfer.id ?? ''))
    throw new Error('Accepted ChatGPT-to-Codex transfer required.');
  if (!SHA256.test(transfer.git_status_sha256 ?? '') ||
      !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(transfer.git_head ?? ''))
    throw new Error('Transfer Git snapshot fingerprint missing or malformed.');
  const created = Date.parse(transfer.created_at);
  const expires = Date.parse(transfer.expires_at);
  if (!Number.isFinite(created) || !Number.isFinite(expires) ||
      created > Date.now() + 60_000 || expires <= created || expires <= Date.now())
    throw new Error('Transfer timestamp invalid or expired.');

  const task = await readRecord(root, 'current-task.json', 30_000);
  if (task?.status !== 'in_progress' || task.task_id !== transfer.task_id ||
      !Array.isArray(task.target_paths) || !Array.isArray(task.plan_steps) ||
      typeof task.goal !== 'string' || !task.goal.trim())
    throw new Error('Matching active task required.');
  const owned = transfer.handoff?.target_paths;
  if (!Array.isArray(owned) || owned.length < 1 || owned.length > 25 ||
      !owned.every(validPath) || new Set(owned).size !== owned.length ||
      !Array.isArray(transfer.handoff.plan) ||
      !transfer.handoff.plan.every((step) => typeof step === 'string'))
    throw new Error('Bounded safe owned file assignments required.');

  // Reject changes to the handoff metadata after it was accepted.
  const expectedPaths = task.target_paths.slice(0, 25).map((p) => p.slice(0, 180));
  const expectedSteps = task.plan_steps.slice(0, 25).map((s) => s.slice(0, 300));
  if (transfer.handoff.goal !== task.goal.slice(0, 1000) ||
      JSON.stringify(owned) !== JSON.stringify(expectedPaths) ||
      JSON.stringify(transfer.handoff.plan) !== JSON.stringify(expectedSteps))
    throw new Error('Transfer handoff differs from active task.');
  for (const name of owned) await requireRegularOwnedFile(root, name);

  const snapshot = cleanSnapshot(root);
  if (snapshot.head !== transfer.git_head ||
      snapshot.status_sha256 !== transfer.git_status_sha256)
    throw new Error('Stale or mismatched transfer Git snapshot.');
  const plan = [
    '# Native Codex transfer preview',
    'Task: ' + task.goal,
    'Allowed paths:', ...owned.map((p) => '- ' + p),
    'Steps:', ...expectedSteps.map((s) => '- ' + s),
    'Only modify allowed paths. Do not commit, push, install or access network.'
  ].join('\n');
  const check = await inspectNativeCodex({ worktree: root, planText: plan, searchPath });
  const finalSnapshot = cleanSnapshot(root);
  if (finalSnapshot.head !== snapshot.head ||
      finalSnapshot.status_sha256 !== snapshot.status_sha256)
    throw new Error('Git snapshot changed during Native Codex preflight.');
  return {
    status: check.ready_for_owner_review ? 'READY_FOR_OWNER_REVIEW' : 'BLOCKED',
    transfer_id: transfer.id, task_id: task.task_id,
    git_head: snapshot.head, git_status_sha256: snapshot.status_sha256,
    git_snapshot_matches_transfer: true,
    plan_sha256: check.plan_sha256,
    command_argv: [
      'codex', 'exec', '--ignore-user-config', '--ephemeral', '--sandbox', 'workspace-write',
      '--config', 'approval_policy=never',
      '--config', 'sandbox_workspace_write.network_access=false',
      '--config', 'sandbox_workspace_write.exclude_slash_tmp=true',
      '--config', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      '--cd', root, '-'
    ],
    allowed_paths: owned,
    // Trusted local CLI can request the bounded plan; public previews omit it.
    ...(includeLocalPlan ? { _local_plan: plan, _local_codex_binary: check.codex_binary } : {}),
    preview_only: true, agent_started: false, model_called: false,
    identity_verified: false, ownership_enforced: false,
    owner_action_required: true, merge_performed: false
  };
}
