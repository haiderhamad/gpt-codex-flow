import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepareSandboxInvocation } from '../dist/sandboxInvocation.js';

// IMPORTANT: This deliberately exercises the installed Codex CLI on macOS only.
// Windows needs independent native negative tests; never infer its protection
// from these results. This script does not enable any Gcf tool mode.
if (process.platform !== 'darwin') {
  console.log('SKIP: restricted native sandbox checks require macOS. Windows is NOT verified.');
  process.exit(0);
}

const hasFile = path => access(path).then(() => true, () => false);
const cli = execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8' }).trim();
assert.ok(cli.startsWith('/'), 'Codex CLI did not resolve to an absolute path');

const root = await mkdtemp(join(homedir(), 'gcf-restricted-test-'));
const workspace = join(root, 'workspace');
const outside = join(root, 'outside');
const codexHome = join(root, 'codex-home');

const config = `
[permissions.cb-scoped]
extends = ":workspace"
[permissions.cb-scoped.filesystem]
":root" = "deny"
":minimal" = "read"
":tmpdir" = "deny"
":slash_tmp" = "deny"
[permissions.cb-scoped.network]
enabled = false
`;

// Pass an explicit environment allowlist, not the entire bridge/host process.env.
// This is a *test harness* example, not yet the production executor.
function sandboxEnv() {
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: homedir(),
    CODEX_HOME: codexHome,
    LANG: 'C',
  };
  for (const key of ['TMPDIR', 'USER', 'LOGNAME']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function runSandbox(args) {
  const plan = prepareSandboxInvocation({
    platform: 'darwin',
    codexExecutable: cli,
    workspaceRoot: workspace,
    permission: 'workspace-write',
    command: args,
  });
  assert.equal(plan.permissionProfile, ':workspace');
  assert.equal(plan.verifiedIsolation, false);

  // Override only the profile name; preserve the adapter's structured argv.
  const argv = [...plan.argv];
  const profileIndex = argv.indexOf('--permission-profile');
  assert.ok(profileIndex >= 0 && argv[profileIndex + 1] === ':workspace');
  argv[profileIndex + 1] = 'cb-scoped';

  return await new Promise((resolve, reject) => {
    let output = '';
    let error = '';
    let timedOut = false;
    const child = spawn(plan.executable, argv, {
      cwd: plan.cwd,
      env: sandboxEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // On macOS, isolate group for timeout cleanup.
    });
    const append = (previous, chunk) => (previous + chunk.toString()).slice(-12000);
    child.stdout.on('data', data => { output = append(output, data); });
    child.stderr.on('data', data => { error = append(error, data); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, 20_000);
    child.once('error', cause => { clearTimeout(timer); reject(cause); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout: output, stderr: error });
    });
  });
}

function wasDenied(result, marker) {
  assert.equal(result.timedOut, false, `Test timed out: ${result.stderr}`);
  assert.notEqual(result.code, 0, 'Outside operation unexpectedly succeeded');
  assert.equal(result.stdout.includes(marker), false, 'Outside sentinel leaked to stdout');
  assert.match(result.stderr, /Operation not permitted|Permission denied/i,
    `Outside operation failed for a reason other than OS permission denial: ${result.stderr}`);
}

try {
  await Promise.all([mkdir(workspace), mkdir(outside), mkdir(codexHome)]);
  await writeFile(join(codexHome, 'config.toml'), config, { mode: 0o600 });

  const insideMarker = 'BRIDGE_INSIDE_HARMLESS_MARKER';
  const outsideMarker = 'BRIDGE_OUTSIDE_HARMLESS_MARKER';
  const insidePath = join(workspace, 'inside.txt');
  const outsidePath = join(outside, 'outside.txt');
  await writeFile(insidePath, insideMarker);
  await writeFile(outsidePath, outsideMarker);
  const link = join(workspace, 'link-to-outside');
  await symlink(outside, link, 'dir');

  let result = await runSandbox(['/bin/cat', insidePath]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), insideMarker);
  console.log('PASS 1: read inside workspace');

  result = await runSandbox(['/bin/cat', outsidePath]);
  wasDenied(result, outsideMarker);
  console.log('PASS 2: outside read denied by OS');

  result = await runSandbox(['/bin/cat', join(link, 'outside.txt')]);
  wasDenied(result, outsideMarker);
  console.log('PASS 3: outside read via symlink denied');

  const allowedWrite = join(workspace, 'write-inside.txt');
  result = await runSandbox(['/usr/bin/touch', allowedWrite]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await hasFile(allowedWrite), true);
  console.log('PASS 4: write inside workspace');

  const deniedWrite = join(outside, 'write-outside.txt');
  result = await runSandbox(['/usr/bin/touch', deniedWrite]);
  wasDenied(result, 'UNUSED_MARKER');
  assert.equal(await hasFile(deniedWrite), false);
  console.log('PASS 5: outside write denied');

  const symlinkWrite = join(link, 'write-via-link.txt');
  result = await runSandbox(['/usr/bin/touch', symlinkWrite]);
  wasDenied(result, 'UNUSED_MARKER');
  assert.equal(await hasFile(join(outside, 'write-via-link.txt')), false);
  console.log('PASS 6: outside write via symlink denied');

  // Positive process-control: an executable spawned by Python must actually run.
  const childCode = 'import subprocess,sys; p=subprocess.run(["/bin/cat",sys.argv[1]],capture_output=True,text=True); print(p.stdout,end=""); sys.exit(p.returncode)';
  result = await runSandbox(['python3', '-c', childCode, insidePath]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), insideMarker);
  console.log('PASS 7: child process can read inside workspace');

  result = await runSandbox(['python3', '-c', childCode, outsidePath]);
  assert.notEqual(result.code, 0, 'Child process read outside workspace');
  assert.equal(result.stdout.includes(outsideMarker), false, 'Child leaked outside marker');
  // Child captures cat's stderr, hence no requirement on the outer stderr.
  console.log('PASS 8: child process cannot read outside workspace');

  const networkCode = `import errno,socket,sys
s=socket.socket();s.settimeout(2)
try:s.connect(('1.1.1.1',443))
except PermissionError as e:
 print('NETWORK_PERMISSION_DENIED', e.errno)
 sys.exit(77 if e.errno in (errno.EPERM,errno.EACCES) else 78)
except Exception as e:
 print('NETWORK_INCONCLUSIVE', type(e).__name__)
 sys.exit(78)
else:
 print('NETWORK_ALLOWED')
 sys.exit(0)
finally:s.close()`;
  result = await runSandbox(['python3', '-c', networkCode]);
  assert.equal(result.code, 77, `Network test did not prove OS denial: ${result.stdout} ${result.stderr}`);
  assert.match(result.stdout, /NETWORK_PERMISSION_DENIED/);
  console.log('PASS 9: direct outbound TCP denied with EPERM/EACCES');

  // Fake token is only in this *parent* process, not in the child's allowlisted env.
  process.env.CB_FAKE_PARENT_TEST_TOKEN = 'NON_SECRET_FAKE_TEST_VALUE';
  try {
    result = await runSandbox(['python3', '-c',
      'import os; print("ABSENT" if os.getenv("CB_FAKE_PARENT_TEST_TOKEN") is None else "LEAKED")']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'ABSENT', 'Fake parent token leaked to subprocess');
    console.log('PASS 10: test harness does not inherit fake parent token');
  } finally {
    delete process.env.CB_FAKE_PARENT_TEST_TOKEN;
  }

  console.log('PASS: 10 scoped sandbox checks on macOS; NOT proof of comprehensive isolation or Windows safety.');
} finally {
  await rm(root, { recursive: true, force: true });
}
