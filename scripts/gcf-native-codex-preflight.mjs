// GPT Codex Flow — Native Codex readiness preflight (NO agent execution).
// No installs, sign-ins, API calls, script evaluation or automatic approval.
// An owner-controlled, separate terminal may run Codex only after inspection.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const hash = (value) => createHash('sha256').update(value).digest('hex');
function git(root, args) {
  const r = spawnSync('git', ['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',
    '-c','diff.external=',...args], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    maxBuffer: 1024 * 1024, shell: false,
    env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
      GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_EXTERNAL_DIFF:'',GIT_PAGER:'cat'}
  });
  if (r.status !== 0) throw new Error('Not a usable Git worktree (' + args[0] + ').');
  return r.stdout.trim();
}
function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) &&
    relative !== '..' && !path.isAbsolute(relative));
}
async function executableInPath(name, dirs) {
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      const actual = await fs.realpath(candidate);
      const stat = await fs.stat(actual);
      if (!stat.isFile()) continue;
      await fs.access(actual, (await import('node:constants')).X_OK);
      return candidate;
    } catch { /* A PATH entry is unavailable or not executable. */ }
  }
  return null;
}
export async function inspectNativeCodex({
  worktree, planFile = '.ai-bridge/current-plan.md', planText,
  searchPath = process.env.PATH ?? ''
}) {
  if (typeof worktree !== 'string' || !path.isAbsolute(worktree))
    throw new Error('Supply an absolute worktree directory.');
  const root = await fs.realpath(worktree);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Worktree root must be a directory.');
  const toplevel = await fs.realpath(git(root, ['rev-parse', '--show-toplevel']));
  if (root !== toplevel) throw new Error('Worktree root must equal the Git toplevel.');
  const gitHead = git(root, ['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40,64}$/.test(gitHead)) throw new Error('Malformed Git HEAD.');
  const dirty = git(root, ['status', '--porcelain=v1', '--untracked-files=all']).length !== 0;
  let content;
  if (planText !== undefined) {
    if (typeof planText !== 'string' || !planText.trim() ||
        Buffer.byteLength(planText, 'utf8') > 32_000)
      throw new Error('In-memory plan must be nonempty and at most 32 KB.');
    content = planText;
  } else {
    const relativePlan = path.isAbsolute(planFile) ? path.relative(root, planFile) : planFile;
    if (relativePlan.startsWith('..') || !relativePlan.trim() ||
        relativePlan === '.' || path.isAbsolute(relativePlan))
      throw new Error('Handoff plan must be inside its worktree.');
    const planPath = await fs.realpath(path.resolve(root, relativePlan));
    if (!contains(root, planPath)) throw new Error('Handoff plan escapes worktree (symlink).');
    const planStat = await fs.stat(planPath);
    if (!planStat.isFile() || planStat.size < 1 || planStat.size > 32_000)
      throw new Error('Plan must be a nonempty regular file of at most 32 KB.');
    content = await fs.readFile(planPath, 'utf8');
    if (!content.trim()) throw new Error('Empty handoff plan.');
  }
  const codex = await executableInPath('codex', searchPath.split(path.delimiter));
  return {
    contract_version: 1,
    worktree: root,
    git_head: gitHead,
    git_clean: !dirty,
    codex_binary_detected: Boolean(codex),
    codex_binary: codex,
    command_argv: ['codex', 'exec', '--sandbox', 'workspace-write', '--cd', root, '-'],
    input: 'plan via stdin (not in process arguments)',
    plan_sha256: hash(content),
    sandbox_requested: 'workspace-write',
    owner_action_required: true,
    ready_for_owner_review: !dirty && Boolean(codex),
    actual_codex_execution: false,
    agent_started: false,
    credentials_checked: false,
    warnings: [
      'Presence of an executable does not prove Codex version, identity, login, or sandbox enforcement.',
      'Native execution can incur model usage and read workspace data; inspect the plan and permissions first.',
      'Git worktrees do not themselves provide operating-system isolation.',
      'No credentials, model request, shell invocation of codex, or repo merge were performed.'
    ]
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 2 || args[0] !== '--worktree') {
      throw new Error('Usage: node scripts/gcf-native-codex-preflight.mjs --worktree ABSOLUTE_PATH');
    }
    const result = await inspectNativeCodex({worktree: args[1]});
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready_for_owner_review) process.exitCode = 2;
  } catch (err) {
    console.error('Native Codex preflight refused: ' + (err?.message ?? String(err)));
    process.exitCode = 2;
  }
}
