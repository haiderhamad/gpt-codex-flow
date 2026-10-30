// Parallel-agent workflow fixture. It launches two harmless deterministic local
// executors, NOT native Codex or a production multi-agent scheduler.
// Each gets its own temporary Git worktree. No remote calls, installs or pushes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'gcf-parallel-worktrees-'));
const repo = path.join(sandbox, 'repo');
const workerA = path.join(sandbox, 'agent-a');
const workerB = path.join(sandbox, 'agent-b');

function git(cwd, ...args) {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 200000
  });
  assert.equal(r.status, 0, 'git ' + args.join(' ') + ': ' + (r.stderr || r.stdout));
  return r.stdout;
}

function startFixtureAgent(cwd) {
  // The executable and task are fixed by this test, and only temporary files
  // are passed to the existing CLI adapter.
  const command = '"' + process.execPath.replaceAll('"', '\\"') +
    '" fixture-agent.mjs --task-file {{plan_file}}';
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      'scripts/gcf.mjs', 'execute-handoff',
      '--root', cwd, '--agent', 'custom',
      '--command', command, '--timeout-ms', '15000', '--yes'
    ], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' }
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 20000);
    const readBounded = (previous, next) => (previous + String(next)).slice(0, 30000);
    child.stdout.on('data', (c) => { stdout = readBounded(stdout, c); });
    child.stderr.on('data', (c) => { stderr = readBounded(stderr, c); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function prepare(cwd, id) {
  await fs.mkdir(path.join(cwd, '.ai-bridge'), { recursive: true });
  await fs.writeFile(path.join(cwd, '.ai-bridge', 'current-plan.md'),
    '# Test Agent ' + id.toUpperCase() + '\n\nTARGET=' + id + '\n');
}

try {
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, '.gitignore'), '.ai-bridge/\n');
  await fs.writeFile(path.join(repo, 'src', 'a.txt'), 'baseline a\n');
  await fs.writeFile(path.join(repo, 'src', 'b.txt'), 'baseline b\n');
  await fs.writeFile(path.join(repo, 'fixture-agent.mjs'), [
    "import fs from 'node:fs';",
    "const arg = process.argv.indexOf('--task-file');",
    "if (arg < 0) process.exit(11);",
    "const plan = fs.readFileSync(process.argv[arg + 1], 'utf8');",
    "const match = /^TARGET=(a|b)$/m.exec(plan);",
    "if (!match) process.exit(12);",
    "const target = match[1];",
    "fs.appendFileSync('src/' + target + '.txt', 'fixture agent ' + target + ' finished\\n');",
    "console.log('fixture agent completed ' + target);"
  ].join('\n') + '\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.gitignore', 'src/a.txt', 'src/b.txt', 'fixture-agent.mjs');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-q', '-m', 'fixture initial tree');
  git(repo, 'worktree', 'add', '-q', '-b', 'gcf-test-agent-a', workerA, 'HEAD');
  git(repo, 'worktree', 'add', '-q', '-b', 'gcf-test-agent-b', workerB, 'HEAD');
  await Promise.all([prepare(workerA, 'a'), prepare(workerB, 'b')]);

  // Both subprocesses start without waiting for each other. There is no write
  // contention because the branch/worktree roots are distinct.
  const [a, b] = await Promise.all([
    startFixtureAgent(workerA), startFixtureAgent(workerB)
  ]);
  assert.equal(a.code, 0, 'agent A: ' + a.stdout + '\n' + a.stderr);
  assert.equal(b.code, 0, 'agent B: ' + b.stdout + '\n' + b.stderr);
  assert.match(a.stdout, /Agent exited with code 0/);
  assert.match(b.stdout, /Agent exited with code 0/);

  const file = (cwd, name) => fs.readFile(path.join(cwd, 'src', name), 'utf8');
  assert.match(await file(workerA, 'a.txt'), /fixture agent a finished/);
  assert.equal(await file(workerA, 'b.txt'), 'baseline b\n');
  assert.match(await file(workerB, 'b.txt'), /fixture agent b finished/);
  assert.equal(await file(workerB, 'a.txt'), 'baseline a\n');
  assert.equal(await file(repo, 'a.txt'), 'baseline a\n');
  assert.equal(await file(repo, 'b.txt'), 'baseline b\n');

  const diffA = git(workerA, 'diff', '--no-ext-diff', '--');
  const diffB = git(workerB, 'diff', '--no-ext-diff', '--');
  assert.match(diffA, /a\.txt/);
  assert.doesNotMatch(diffA, /b\.txt/);
  assert.match(diffB, /b\.txt/);
  assert.doesNotMatch(diffB, /a\.txt/);
  assert.equal(git(repo, 'status', '--porcelain'), '', 'original branch changed');

  for (const [cwd, id] of [[workerA, 'a'], [workerB, 'b']]) {
    const status = await fs.readFile(path.join(cwd, '.ai-bridge', 'agent-status.md'), 'utf8');
    const patch = await fs.readFile(path.join(cwd, '.ai-bridge', 'implementation-diff.patch'), 'utf8');
    const log = await fs.readFile(path.join(cwd, '.ai-bridge', 'execution-log.jsonl'), 'utf8');
    assert.match(status, /Exit code: 0/);
    assert.match(status, /Agent: custom/);
    assert.match(patch, new RegExp('fixture agent ' + id + ' finished'));
    assert.match(log, /"event":"execute_handoff"/);
  }
  console.log('PASS: two concurrent local CLI fixture processes in separate Git worktrees');
  console.log('PASS: isolated per-worktree changes, logs, diffs, original tree unchanged');
  console.log('NOTE: native Codex, independent agent intelligence and OS sandbox NOT tested');
} finally {
  await fs.rm(sandbox, { recursive: true, force: true });
}
