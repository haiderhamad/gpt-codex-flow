import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-transfer-'));
const git = (...args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};
let client;
let recipientClient;
try {
  git('init', '-q');
  await fs.writeFile(path.join(root, 'tracked.txt'), 'baseline\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.ai-bridge/\n');
  git('add', '.gitignore', 'tracked.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'fixture');
  await fs.writeFile(path.join(root, 'tracked.txt'), 'dirty before handoff\n');
  await fs.writeFile(path.join(root, 'scratch.txt'), 'untracked original\n');
  await fs.mkdir(path.join(root, '.ai-bridge'), { recursive: true });
  const taskId = 'task_test-' + Date.now();
  const now = new Date().toISOString();
  await fs.writeFile(path.join(root, '.ai-bridge/current-task.json'), JSON.stringify({
    schema_version: 1, task_id: taskId, goal: 'Test safe handoff',
    target_paths: ['src/a.ts'], plan_steps: ['Review', 'Implement'],
    status: 'in_progress', created_at: now, updated_at: now
  }));
  client = new Client({ name: 'transfer-smoke', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['dist/stdio.js', '--root', root, '--allow-root', root, '--tool-mode', 'standard', '--write', 'workspace', '--bash', 'off'],
    cwd: process.cwd(),
    env: { ...process.env, GCF_ROOT: root, GCF_ALLOWED_ROOTS: root }
  }));
  // Separate MCP process models a second client reading the same durable transfer record.
  // It is NOT an independently authenticated native Codex process.
  recipientClient = new Client({ name: 'mock-codex-recipient', version: '1.0.0' }, { capabilities: {} });
  await recipientClient.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['dist/stdio.js', '--root', root, '--allow-root', root, '--tool-mode', 'standard', '--write', 'workspace', '--bash', 'off'],
    cwd: process.cwd(),
    env: { ...process.env, GCF_ROOT: root, GCF_ALLOWED_ROOTS: root }
  }));
  const recipientCall = (name, args = {}) => recipientClient.callTool({ name, arguments: args });
  const names = (await client.listTools()).tools;
  for (const name of ['request_transfer', 'transfer_status', 'accept_transfer', 'cancel_transfer']) {
    const entry = names.find(tool => tool.name === name);
    assert.ok(entry, name + ' missing');
    assert.ok(entry._meta?.ui?.resourceUri || entry._meta?.['openai/outputTemplate']);
    assert.equal(entry.annotations?.readOnlyHint, name === 'transfer_status');
  }
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const direction = { task_id: taskId, from: 'chatgpt_lead', to: 'codex_lead' };
  assert.ok((await call('request_transfer', { ...direction, user_confirmed: false })).isError);
  assert.ok((await call('request_transfer', { ...direction, task_id: 'task_wrong', user_confirmed: true })).isError);
  const first = await call('request_transfer', { ...direction, user_confirmed: true });
  assert.ok(!first.isError, JSON.stringify(first));
  const id = first.structuredContent.transfer.id;
  assert.match(first.structuredContent.transfer.git_status_sha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(first.structuredContent.transfer, 'git_status'), false);
  const replay = await call('request_transfer', { ...direction, user_confirmed: true });
  assert.ok(!replay.isError, JSON.stringify(replay));
  assert.equal(replay.structuredContent.transfer.id, id);
  assert.equal((await call('transfer_status')).structuredContent.transfer.state, 'requested');
  assert.ok((await call('accept_transfer', { transfer_id: id, recipient: 'codex_lead', user_confirmed: false })).isError);
  assert.ok((await call('accept_transfer', { transfer_id: id, recipient: 'chatgpt_lead', user_confirmed: true })).isError);
  assert.equal((await recipientCall('transfer_status')).structuredContent.transfer.id, id);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'modified while transfer pending\n');
  assert.ok((await recipientCall('accept_transfer', { transfer_id: id, recipient: 'codex_lead', user_confirmed: true })).isError);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'dirty before handoff\n');
  await fs.writeFile(path.join(root, 'scratch.txt'), 'untracked changed content\n');
  assert.ok((await recipientCall('accept_transfer', { transfer_id: id, recipient: 'codex_lead', user_confirmed: true })).isError);
  await fs.writeFile(path.join(root, 'scratch.txt'), 'untracked original\n');
  const accepted = await recipientCall('accept_transfer', { transfer_id: id, recipient: 'codex_lead', user_confirmed: true });
  assert.ok(!accepted.isError, JSON.stringify(accepted));
  assert.equal(accepted.structuredContent.transfer.state, 'accepted');
  await fs.writeFile(path.join(root, 'changed.txt'), 'dirty again');
  assert.ok((await call('accept_transfer', { transfer_id: id, recipient: 'codex_lead', user_confirmed: true })).isError);
  await fs.rm(path.join(root, 'changed.txt'));
  const acceptedReplay = await call('accept_transfer', { transfer_id: id, recipient: 'codex_lead', user_confirmed: true });
  assert.ok(!acceptedReplay.isError, JSON.stringify(acceptedReplay));
  assert.equal(acceptedReplay.structuredContent.transfer.id, id);
  // Emulate recipient progress in the disposable repo, not native Codex execution.
  // Both clients can still write: advisory "lead" state is NOT an actual write lock.
  const modified = await recipientCall('edit', {
    path: 'tracked.txt', old_text: 'dirty before handoff', new_text: 'reviewed by simulated recipient'
  });
  assert.ok(!modified.isError, JSON.stringify(modified));
  assert.match((await fs.readFile(path.join(root, 'tracked.txt'), 'utf8')), /reviewed by simulated recipient/);
  const reverse = await recipientCall('request_transfer', {
    task_id: taskId, from: 'codex_lead', to: 'chatgpt_lead', user_confirmed: true
  });
  assert.ok(!reverse.isError, JSON.stringify(reverse));
  const reverseId = reverse.structuredContent.transfer.id;
  // A content change between request and acceptance invalidates the reverse baseline.
  await fs.writeFile(path.join(root, 'scratch.txt'), 'new content during reverse handoff\n');
  assert.ok((await call('accept_transfer', {
    transfer_id: reverseId, recipient: 'chatgpt_lead', user_confirmed: true
  })).isError);
  await fs.writeFile(path.join(root, 'scratch.txt'), 'untracked original\n');
  // A new MCP process must recover the same task and transfer from disk.
  await client.close();
  client = new Client({ name: 'reconnected-chatgpt', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['dist/stdio.js', '--root', root, '--allow-root', root,
      '--tool-mode', 'standard', '--write', 'workspace', '--bash', 'off'],
    cwd: process.cwd(),
    env: { ...process.env, GCF_ROOT: root, GCF_ALLOWED_ROOTS: root }
  }));
  const resumedCall = (name, args = {}) => client.callTool({ name, arguments: args });
  assert.equal((await resumedCall('task_resume')).structuredContent.task_id, taskId);
  assert.equal((await resumedCall('transfer_status')).structuredContent.transfer.id, reverseId);
  const returned = await resumedCall('accept_transfer', {
    transfer_id: reverseId, recipient: 'chatgpt_lead', user_confirmed: true
  });
  assert.ok(!returned.isError, JSON.stringify(returned));
  assert.equal(returned.structuredContent.transfer.state, 'accepted');
  const afterReturn = await resumedCall('request_transfer', {
    task_id: taskId, from: 'chatgpt_lead', to: 'codex_lead', user_confirmed: true
  });
  assert.ok(!afterReturn.isError, JSON.stringify(afterReturn));
  const cancelledId = afterReturn.structuredContent.transfer.id;
  assert.ok((await resumedCall('cancel_transfer', {
    transfer_id: cancelledId, user_confirmed: false
  })).isError);
  const cancelled = await resumedCall('cancel_transfer', {
    transfer_id: cancelledId, user_confirmed: true
  });
  assert.equal(cancelled.structuredContent.transfer.state, 'cancelled');
  assert.ok((await resumedCall('accept_transfer', {
    transfer_id: cancelledId, recipient: 'codex_lead', user_confirmed: true
  })).isError);
  const status = await call('transfer_status');
  assert.equal(status.structuredContent.ownership_enforced, false);
  assert.equal(status.structuredContent.client_identity_verified, false);
  console.log('PASS: two MCP processes, dirty tracked/untracked baseline checks, reverse handoff, persisted restart recovery and cancellation (advisory only)');
} finally {
  if (recipientClient) await recipientClient.close();
  if (client) await client.close();
  await fs.rm(root, { recursive: true, force: true });
}
