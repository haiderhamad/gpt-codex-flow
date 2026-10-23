// Native Codex CLI readiness check: pure filesystem/Git checks only.
// A fake executable stands in for installation detection. It is NEVER executed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectNativeCodex } from './gcf-native-codex-preflight.mjs';

const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'gcf-native-preflight-'));
const root = path.join(folder, 'repo');
const bin = path.join(folder, 'bin');
const outside = path.join(folder, 'outside.md');
function git(...args) {
  const result = spawnSync('git', args, {
    cwd: root, encoding: 'utf8', timeout: 10000, shell: false
  });
  assert.equal(result.status, 0, result.stderr);
}
try {
  await fs.mkdir(path.join(root, '.ai-bridge'), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(root, '.gitignore'), '.ai-bridge/\n');
  await fs.writeFile(path.join(root, 'readme.txt'), 'starting tree\n');
  await fs.writeFile(path.join(root, '.ai-bridge', 'current-plan.md'),
    '# Disposable test plan\nEdit only readme.txt.\n');
  await fs.writeFile(path.join(bin, 'codex'), '#!/bin/sh\nexit 99\n', {mode: 0o755});
  // If the fake native executable was accidentally invoked, the test would fail.
  git('init', '-q');
  git('add', '.gitignore', 'readme.txt');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
    'commit','-q','-m','base');
  const available = await inspectNativeCodex({worktree: root, searchPath: bin});
  assert.equal(available.ready_for_owner_review, true);
  assert.equal(available.agent_started, false);
  assert.equal(available.actual_codex_execution, false);
  assert.equal(available.command_argv[3], 'workspace-write');
  assert.equal(available.command_argv.at(-1), '-');
  assert.equal(available.plan_sha256.length, 64);
  assert.equal(available.owner_action_required, true);
  console.log('PASS: native executable presence and safe command preview; no Codex invoked');

  const missing = await inspectNativeCodex({worktree: root, searchPath: path.join(folder, 'missing')});
  assert.equal(missing.ready_for_owner_review, false);
  assert.equal(missing.codex_binary_detected, false);
  await fs.appendFile(path.join(root, 'readme.txt'), 'dirty change\n');
  const dirty = await inspectNativeCodex({worktree: root, searchPath: bin});
  assert.equal(dirty.git_clean, false);
  assert.equal(dirty.ready_for_owner_review, false);
  console.log('PASS: missing binary and dirty tracked changes fail closed');

  await fs.writeFile(path.join(root, 'readme.txt'), 'starting tree\n');
  await fs.writeFile(outside, 'private outside plan\n');
  await fs.rm(path.join(root, '.ai-bridge', 'current-plan.md'));
  await fs.symlink(outside, path.join(root, '.ai-bridge', 'current-plan.md'));
  await assert.rejects(inspectNativeCodex({worktree: root, searchPath: bin}),
    /escapes worktree/);
  await assert.rejects(inspectNativeCodex({
    worktree: path.join(folder, 'missing-worktree'), searchPath: bin
  }));
  console.log('PASS: outside-worktree plan symlink and missing worktree rejected');
} finally {
  await fs.rm(folder, { recursive: true, force: true });
}
