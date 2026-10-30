import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { access, mkdtemp, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepareSandboxInvocation } from '../dist/sandboxInvocation.js';

if (process.platform !== 'darwin') {
  console.log('SKIP: native sandbox file-boundary smoke is macOS-only; Windows requires an independent native test.');
  process.exit(0);
}

const exists = async path => access(path).then(() => true, () => false);
const executable = execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8' }).trim();
assert.ok(executable.startsWith('/'), 'Codex CLI must resolve to an absolute path');

async function probe(permission, cwd, destination) {
  const plan = prepareSandboxInvocation({
    platform: process.platform,
    codexExecutable: executable,
    workspaceRoot: cwd,
    permission,
    command: ['/usr/bin/touch', destination]
  });
  assert.equal(plan.noHostFallback, true);
  assert.equal(plan.verifiedIsolation, false);

  return await new Promise((resolve, reject) => {
    const child = spawn(plan.executable, plan.argv, {
      cwd: plan.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 20_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) });
    });
  });
}

// Two fresh, unrelated directories under HOME, not inside the real repository.
// This avoids macOS's intentionally writable temporary-directory exceptions.
const workspace = await mkdtemp(join(homedir(), 'gcf-sandbox-work-'));
const outside = await mkdtemp(join(homedir(), 'gcf-sandbox-outside-'));
try {
  const readOnlyTarget = join(workspace, 'denied-readonly.txt');
  const deniedReadOnly = await probe('read-only', workspace, readOnlyTarget);
  assert.equal(deniedReadOnly.timedOut, false, 'read-only probe timed out');
  assert.notEqual(deniedReadOnly.code, 0, 'read-only profile unexpectedly allowed a write');
  assert.equal(await exists(readOnlyTarget), false, 'read-only write created a file');
  console.log('PASS: :read-only denied writing inside the test workspace');

  const permittedTarget = join(workspace, 'allowed-workspace.txt');
  const allowedWorkspace = await probe('workspace-write', workspace, permittedTarget);
  assert.equal(allowedWorkspace.timedOut, false, 'workspace-write probe timed out');
  assert.equal(allowedWorkspace.code, 0,
    'workspace-write failed inside the test workspace: ' + allowedWorkspace.stderr);
  assert.equal(await exists(permittedTarget), true, 'workspace-write did not create the test file');
  console.log('PASS: :workspace permitted writing inside the test workspace');

  const outsideTarget = join(outside, 'denied-outside.txt');
  const deniedOutside = await probe('workspace-write', workspace, outsideTarget);
  assert.equal(deniedOutside.timedOut, false, 'outside-write probe timed out');
  assert.notEqual(deniedOutside.code, 0, 'workspace profile unexpectedly allowed outside write');
  assert.equal(await exists(outsideTarget), false, 'outside write changed a file');
  console.log('PASS: :workspace denied writing to a sibling directory outside workspace');

  const linkPath = join(workspace, 'link-outside');
  await symlink(outside, linkPath, 'dir');
  const symlinkTarget = join(linkPath, 'denied-symlink-escape.txt');
  const deniedSymlink = await probe('workspace-write', workspace, symlinkTarget);
  assert.equal(deniedSymlink.timedOut, false, 'symlink escape probe timed out');
  assert.notEqual(deniedSymlink.code, 0, 'workspace profile unexpectedly allowed symlink escape');
  assert.equal(await exists(join(outside, 'denied-symlink-escape.txt')), false,
    'symlink escape created a file outside workspace');
  console.log('PASS: :workspace denied writing through a symlink to outside workspace');
  console.log('Native macOS sandbox smoke PASS; four file-write boundaries verified, not full isolation.');
} finally {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
