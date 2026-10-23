import assert from 'node:assert/strict';
import { prepareSandboxInvocation } from '../dist/sandboxInvocation.js';

const cases = [
  { platform: 'darwin', codexExecutable: '/opt/homebrew/bin/codex', workspaceRoot: '/Users/dev/repo', command: ['git', 'status'] },
  { platform: 'win32', codexExecutable: 'C:\\Tools\\codex.exe', workspaceRoot: 'C:\\Projects\\repo', command: ['cmd.exe', '/c', 'echo', 'ok'] },
  { platform: 'linux', codexExecutable: '/usr/local/bin/codex', workspaceRoot: '/home/dev/repo', command: ['ls', '-la'] }
];
for (const c of cases) {
  for (const permission of ['read-only', 'workspace-write']) {
    const invocation = prepareSandboxInvocation({ ...c, permission });
    assert.equal(invocation.executable, c.codexExecutable);
    assert.equal(invocation.cwd, c.workspaceRoot);
    assert.equal(invocation.platform, c.platform);
    assert.equal(invocation.permissionProfile, permission === 'read-only' ? ':read-only' : ':workspace');
    assert.deepEqual(invocation.argv,
      ['sandbox', '--permission-profile', invocation.permissionProfile, '--cd', c.workspaceRoot, '--', ...c.command]);
    assert.equal(invocation.noHostFallback, true);
    assert.equal(invocation.verifiedIsolation, false);
    assert.ok(Object.isFrozen(invocation.argv));
  }
}
const good = { ...cases[0], permission: 'workspace-write' };
for (const overrides of [
  { platform: 'freebsd' }, { codexExecutable: 'codex' },
  { workspaceRoot: '.' }, { permission: 'danger-full-access' },
  { command: [] }, { command: [''] }, { command: ['echo', 'x\u0000y'] },
  { command: 'echo ok' }
]) {
  assert.throws(() => prepareSandboxInvocation({ ...good, ...overrides }));
}
assert.throws(() => prepareSandboxInvocation({
  ...cases[1], permission: 'read-only', workspaceRoot: 'relative/path'
}), /absolute trusted path/);
console.log('Sandbox invocation planning passed: macOS, Windows and Linux; unsafe/unknown inputs fail closed.');
console.log('Planning only: Codex CLI availability and OS isolation have not been tested.');
