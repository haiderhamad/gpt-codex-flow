#!/usr/bin/env node
// GPT Codex Flow: local owner-controlled REAL Codex trial, in a disposable repo.
// Default --preview NEVER invokes Codex. --run requires a real interactive TTY,
// an exact typed phrase, a detected CLI, and the conservative sandbox argv.
// This is NOT reachable through an MCP tool and never changes the project repo.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { inspectNativeCodex } from './gcf-native-codex-preflight.mjs';
import { inspectNativeCodexPostflight, snapshotProtectedNativeFiles, snapshotManagedMcpMetadata } from './gcf-native-codex-postflight.mjs';
import { previewNativeTransfer } from './gcf-native-transfer-preview.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CONSENT = 'RUN CODEX DISPOSABLE TRIAL';
const TIMEOUT_MS = 180_000;
const LIMIT = 6000;
const PROMPT = [
  'You are participating in a disposable GPT Codex Flow integration test.',
  'In the current Git repository, edit ONLY src/message.mjs.',
  "Replace the string 'before' returned by message() with 'after'.",
  'Run node --test test/message.test.mjs and report its result.',
  'Never change other files, call network services, install packages,',
  'access files outside the worktree, modify Git history, or create commits.',
  'If you cannot comply, stop and explain.'
].join('\n');

function git(root, args) {
  const p = spawnSync('git', args, {
    cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024,
    timeout: 10000, shell: false
  });
  if (p.status !== 0) throw new Error('Fixture Git failed: ' + (p.stderr ?? '').slice(0, 250));
  return (p.stdout ?? '').trim();
}
function testUnit(root) {
  const p = spawnSync(process.execPath, ['--test', 'test/message.test.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 15000,
    maxBuffer: 1024 * 1024, shell: false
  });
  return { exit: p.status, output: String(p.stdout ?? p.stderr ?? '').slice(-1100) };
}
async function fixture(root) {
  await fs.mkdir(path.join(root, 'src'), {recursive: true});
  await fs.mkdir(path.join(root, 'test'), {recursive: true});
  await fs.mkdir(path.join(root, '.ai-bridge'), {recursive: true});
  await fs.writeFile(path.join(root, '.gitignore'), '.ai-bridge/\n');
  await fs.writeFile(path.join(root, 'src/message.mjs'),
    "export function message() { return 'before'; }\n");
  await fs.writeFile(path.join(root, 'test/message.test.mjs'),
    "import test from 'node:test';\n" +
    "import assert from 'node:assert/strict';\n" +
    "import { message } from '../src/message.mjs';\n" +
    "test('corrected message', () => assert.equal(message(), 'after'));\n");
  await fs.writeFile(path.join(root, '.ai-bridge/current-plan.md'), PROMPT + '\n', {mode:0o600});
  git(root, ['init', '-q']);
  git(root, ['add', '.gitignore', 'src/message.mjs', 'test/message.test.mjs']);
  git(root, ['-c', 'user.name=Disposable', '-c', 'user.email=disposable@example.invalid',
    'commit', '-q', '-m', 'disposable starting point']);
  const now = new Date().toISOString();
  const taskId = 'task_trial_' + path.basename(path.dirname(root)).replaceAll(/[^a-zA-Z0-9_-]/g,'');
  await fs.writeFile(path.join(root, '.ai-bridge/current-task.json'), JSON.stringify({
    schema_version: 1, task_id: taskId,
    goal: 'Fix disposable message() regression (before to after)',
    target_paths: ['src/message.mjs'],
    plan_steps: ["Replace the string 'before' returned by message() with 'after'.",
      'Run node --test test/message.test.mjs and report its result.'],
    status: 'in_progress', created_at: now, updated_at: now
  }), {mode:0o600});
  assert.equal(testUnit(root).exit, 1, 'Fixture must start with a failing unit test.');
}
async function acceptDisposableMcpTransfer(root, searchPath) {
  // This MCP round-trip runs only against the freshly created throwaway repo.
  // user_confirmed below models fixture consent; it is NOT owner authentication.
  let client;
  try {
    const task = JSON.parse(await fs.readFile(path.join(root, '.ai-bridge/current-task.json'), 'utf8'));
    client = new Client({name:'gcf-native-trial-fixture', version:'1.0.0'}, {capabilities:{}});
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ['dist/stdio.js', '--root', root, '--allow-root', root,
        '--tool-mode', 'standard', '--write', 'workspace', '--bash', 'off'],
      cwd: path.resolve('.'),
      env: { ...process.env, GCF_ROOT:root, GCF_ALLOWED_ROOTS:root }
    }));
    const request = await client.callTool({name:'request_transfer', arguments:{
      task_id:task.task_id, from:'chatgpt_lead', to:'codex_lead', user_confirmed:true
    }});
    if (request.isError || request.structuredContent?.transfer?.state !== 'requested')
      throw new Error('Disposable MCP transfer request refused.');
    const id = request.structuredContent.transfer.id;
    const accepted = await client.callTool({name:'accept_transfer', arguments:{
      transfer_id:id, recipient:'codex_lead', user_confirmed:true
    }});
    if (accepted.isError || accepted.structuredContent?.transfer?.state !== 'accepted' ||
        accepted.structuredContent.transfer.id !== id)
      throw new Error('Disposable MCP transfer acceptance refused.');
    const result = await previewNativeTransfer({worktree:root, searchPath, includeLocalPlan:true});
    if (!['READY_FOR_OWNER_REVIEW', 'BLOCKED'].includes(result.status) || result.transfer_id !== id ||
        !result.git_snapshot_matches_transfer ||
        result.allowed_paths.length !== 1 || result.allowed_paths[0] !== 'src/message.mjs')
      throw new Error('Native MCP handoff preflight refused.');
    return result;
  } finally {
    if (client) await client.close();
  }
}
function bounded(buffer) { return buffer.slice(-LIMIT); }
export function classifyCodexExecution(live, passed) {
  const cliArgumentRejected = /error:\s+unexpected argument|Usage:\s+codex exec/.test(live.stderr ?? '');
  return {
    cli_argument_rejected: cliArgumentRejected,
    agent_started: cliArgumentRejected ? false : passed ? true : null,
    model_request_verified: false
  };
}
async function executeCodex(binary, args, root, plan) {
  const env = Object.fromEntries(
    ['HOME', 'PATH', 'CODEX_HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'USER']
      .filter((k) => typeof process.env[k] === 'string')
      .map((k) => [k, process.env[k]])
  );
  // Only allowlisted inherited vars are exposed to the native CLI, not a full
  // shell environment. Home-based Codex authentication remains a user risk.
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: root, env, shell: false, detached: process.platform !== 'win32',
      stdio: ['pipe','pipe','pipe']
    });
    let result = '', error = '', timedOut = false, done = false;
    const stop = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch { /* already exited */ }
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, TIMEOUT_MS);
    const killTimer = setTimeout(() => {
      if (timedOut) {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* already exited */ }
      }
    }, TIMEOUT_MS + 3000);
    const finish = (e, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      if (e) reject(e);
      else resolve(value);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    child.on('error', (e) => finish(e));
    child.stdout?.on('data', (v) => { result = bounded(result + String(v)); });
    child.stderr?.on('data', (v) => { error = bounded(error + String(v)); });
    child.on('close', (exitCode, signal) =>
      finish(null, { exitCode, signal, timedOut, stdout: result, stderr: error }));
    child.stdin.on('error', () => {});
    child.stdin.end(plan);
  });
}
export async function runDisposableTrial({
  run = false, searchPath = process.env.PATH ?? '', interactive = stdin.isTTY && stdout.isTTY
} = {}) {
  if (run && !interactive)
    throw new Error('Live Codex invocation needs a human at an interactive terminal. No remote/non-TTY fallback.');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gcf-live-codex-trial-'));
  const root = path.join(base, 'repo');
  try {
    await fixture(root);
    const check = await inspectNativeCodex({worktree:root, searchPath});
    // Real MCP round-trip on disposable fixture, but never invoke Codex in preview.
    const handoff = await acceptDisposableMcpTransfer(root, searchPath);
    const { _local_plan, _local_codex_binary, ...publicHandoff } = handoff;
    // Snapshot trusted fixture metadata BEFORE native Codex starts. Unlisted ignored
    // files are refused, and captured metadata must remain byte-for-byte intact.
    const protectedPaths = ['.ai-bridge/current-task.json',
      '.ai-bridge/transfer-control.json', '.ai-bridge/current-plan.md'];
    const protectedHashes = await snapshotProtectedNativeFiles({
      worktree: root, paths: protectedPaths
    });
    const managedMcpHashes = await snapshotManagedMcpMetadata({
      worktree: root, protectedHashes
    });
    const command = [
      'exec', '--sandbox', 'workspace-write', '--config', 'approval_policy=never',
      '--config', 'sandbox_workspace_write.network_access=false',
      '--config', 'sandbox_workspace_write.exclude_slash_tmp=true',
      '--config', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      '--cd', root, '-'
    ];
    const preview = {
      fixture_is_disposable: true,
      initial_test_exit: 1,
      ...check,
      handoff: publicHandoff,
      command_argv: ['codex', ...command],
      network_disabled_requested: true,
      outside_tmp_writes_disabled_requested: true,
      shell_interpolation: false,
      git_history_modified_in_original: false,
      user_confirmed: false,
      trusted_mcp_metadata_count: Object.keys(managedMcpHashes).length,
      live_result: null
    };
    if (!run) return preview;
    if (!check.ready_for_owner_review || !check.codex_binary ||
        handoff.status !== 'READY_FOR_OWNER_REVIEW' ||
        check.git_head !== handoff.git_head)
      throw new Error('Native Codex is unavailable or fixture preflight refused. No execution.');
    stdout.write('\nDISPOSABLE NATIVE CODEX TRIAL — may incur model usage and access Codex credentials.\n');
    stdout.write('Worktree: ' + root + '\n');
    stdout.write('Exact argv: ' + JSON.stringify(preview.command_argv) + '\n');
    stdout.write('Accepted fixture MCP handoff: ' + handoff.transfer_id + '\n');
    stdout.write('Task: ' + PROMPT + '\n');
    stdout.write('Consent phrase: ' + CONSENT + '\n');
    const rl = createInterface({input:stdin, output:stdout, terminal:true});
    let answer;
    try { answer = await rl.question('Confirm exact phrase: '); }
    finally { rl.close(); }
    if (answer !== CONSENT) throw new Error('Owner confirmation rejected. Codex not invoked.');
    const beforeExec = await previewNativeTransfer({worktree:root, searchPath});
    if (beforeExec.status !== 'READY_FOR_OWNER_REVIEW' ||
        beforeExec.transfer_id !== handoff.transfer_id ||
        beforeExec.plan_sha256 !== handoff.plan_sha256 ||
        beforeExec.git_status_sha256 !== handoff.git_status_sha256)
      throw new Error('Native trial handoff changed after consent. Codex not invoked.');
    // Do not bless metadata that appeared or changed while awaiting consent.
    const recheckedProtected = await snapshotProtectedNativeFiles({
      worktree: root, paths: protectedPaths
    });
    const recheckedManaged = await snapshotManagedMcpMetadata({
      worktree: root, protectedHashes
    });
    if (JSON.stringify(recheckedProtected) !== JSON.stringify(protectedHashes) ||
        JSON.stringify(recheckedManaged) !== JSON.stringify(managedMcpHashes))
      throw new Error('Fixture MCP metadata changed during owner review. Codex not invoked.');
    const live = await executeCodex(check.codex_binary, command, root,
      _local_plan + '\n\n' + PROMPT);
    // Inspect the filesystem BEFORE executing test code from that filesystem.
    const postflight = await inspectNativeCodexPostflight({
      worktree: root, expectedHead: check.git_head,
      allowedPaths: handoff.allowed_paths, protectedHashes, managedMcpHashes
    });
    const test = postflight.passed ? testUnit(root) :
      { exit: null, output: 'Skipped: unsafe native Codex postflight changes.' };
    const finalText = postflight.passed
      ? await fs.readFile(path.join(root, 'src/message.mjs'), 'utf8') : '';
    const passed = live.exitCode === 0 && !live.timedOut && postflight.passed &&
      finalText.includes("return 'after'") && test.exit === 0;
    const assessment = classifyCodexExecution(live, passed);
    return {
      ...preview,
      warnings: [
        ...preview.warnings.filter((warning) => !warning.startsWith('No credentials, model request,')),
        'Native Codex CLI was invoked with explicit owner consent. Model access and sandbox enforcement are not independently attested.'
      ],
      user_confirmed: true,
      actual_codex_execution: true, // The CLI binary was invoked; not evidence of a completed model turn.
      codex_process_launched: true,
      agent_started: assessment.agent_started,
      model_request_verified: assessment.model_request_verified,
      live_result: {
        passed, exit_code: live.exitCode, timed_out: live.timedOut,
        cli_argument_rejected: assessment.cli_argument_rejected,
        fixture_git_head_unchanged: postflight.fixture_git_head_unchanged,
        changed_paths: postflight.changed_paths,
        only_allowed_file_changed: postflight.only_allowed_file_changed,
        postflight_passed: postflight.passed, postflight_reasons: postflight.reasons,
        protected_records_intact: postflight.protected_records_intact,
        unit_test_exit: test.exit, unit_test_excerpt: test.output,
        codex_stdout_excerpt: live.stdout.slice(-1500),
        codex_stderr_excerpt: live.stderr.slice(-1500),
        original_repository_modified: false
      }
    };
  } finally {
    await fs.rm(base, {recursive:true, force:true});
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 1 || !['--preview','--run'].includes(args[0])) {
      throw new Error('Usage: node scripts/gcf-native-codex-trial.mjs --preview | --run');
    }
    const result = await runDisposableTrial({run:args[0] === '--run'});
    console.log(JSON.stringify(result, null, 2));
    if (args[0] === '--run' && !result.live_result?.passed) process.exitCode = 1;
  } catch (e) {
    console.error('Native trial refused: ' + (e instanceof Error ? e.message : String(e)));
    process.exitCode = 2;
  }
}
