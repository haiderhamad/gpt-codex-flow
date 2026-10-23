// Pure cross-platform contract test: does NOT launch Codex or claim OS isolation.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { argumentsForNative } from './gcf-native-transfer-run.mjs';

const worktree = path.resolve(os.tmpdir(), 'gcf-native-sandbox-contract-fixture');
const strict = [
  'exec', '--ignore-user-config', '--ephemeral',
  '--sandbox', 'workspace-write',
  '--config', 'approval_policy=never',
  '--config', 'sandbox_workspace_write.network_access=false',
  '--config', 'sandbox_workspace_write.exclude_slash_tmp=true',
  '--config', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
  '--cd', worktree, '-'
];
const preview = {worktree, command_argv: ['codex', ...strict]};
const normal = argumentsForNative(preview, {model:null, effort:'auto'});
assert.deepEqual(normal, strict);
assert.equal(normal.includes('danger-full-access'), false);
assert.equal(normal.includes('--ignore-rules'), false);
assert.equal(normal.includes('--yolo'), false);
assert.equal(normal.at(-1), '-', 'plan stays on stdin, never a shell string');

const configured = argumentsForNative(preview, {model:'test-model', effort:'high'});
assert.deepEqual(configured.slice(-strict.length + 1), strict.slice(1));
assert.ok(configured.includes('test-model'));
assert.ok(configured.includes('model_reasoning_effort="high"'));
assert.ok(configured.includes('workspace-write'));
assert.ok(configured.includes('sandbox_workspace_write.network_access=false'));

for (const altered of [
  ['codex', ...strict.slice(0, -1)],
  ['codex', ...strict.map(arg => arg === 'workspace-write' ? 'danger-full-access' : arg)],
  ['codex', ...strict.map(arg => arg === 'sandbox_workspace_write.network_access=false'
    ? 'sandbox_workspace_write.network_access=true' : arg)],
  ['codex', ...strict, '--yolo']
]) {
  assert.throws(() => argumentsForNative(
    {...preview, command_argv: altered}, {model:null, effort:'auto'}
  ), /differs from known-safe preview/);
}
const dangerous = argumentsForNative(preview, {model:null, effort:'auto'}, {fullAccess:true});
assert.ok(dangerous.includes('danger-full-access'),
  'separate explicit manual bypass remains intentionally labelled unsafe');
assert.ok(!dangerous.includes('workspace-write'));
console.log('PASS: real Codex runner argv enforces workspace-write and no sandbox network by default.');
console.log('PASS: tampered preview rejected; dangerous mode is a distinct explicit option.');
console.log('LIMIT: ' + process.platform + ' argv-only test; no Codex process, Windows OS sandbox, or MCP shell isolated.');
