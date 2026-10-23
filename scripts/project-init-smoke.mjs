import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const cli = path.resolve('scripts/codexbridge.mjs');

function runInit(root, envOverrides = {}) {
  return spawnSync(process.execPath, [cli, 'init', '--root', root], {
    cwd: path.resolve('.'),
    env: { ...process.env, ...envOverrides },
    encoding: 'utf8'
  });
}

function requireSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function requireFailure(result, label, pattern) {
  if (result.status === 0) {
    throw new Error(`${label} unexpectedly succeeded\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (pattern && !pattern.test(output)) throw new Error(`${label} failed for the wrong reason\n${output}`);
}

async function gitRepo(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  requireSuccess(spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' }), `${prefix} git init`);
  return root;
}

async function snapshot(files) {
  return Promise.all(files.map(async (file) => {
    const [content, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return { content, mtimeMs: stat.mtimeMs, ino: stat.ino };
  }));
}

const noteNames = ['PROJECT.md', 'HISTORY.md', 'HANDOFF.md'];

const freshRoot = await gitRepo('codexbridge-project-init-fresh-');
requireSuccess(runInit(freshRoot), 'fresh project init');
const freshEntries = (await fs.readdir(path.join(freshRoot, '.ai-bridge'))).sort();
if (JSON.stringify(freshEntries) !== JSON.stringify([...noteNames].sort())) {
  throw new Error(`fresh init created unexpected files: ${freshEntries.join(', ')}`);
}
const freshNotes = await Promise.all(noteNames.map((name) => fs.readFile(path.join(freshRoot, '.ai-bridge', name), 'utf8')));
const requiredTemplateText = {
  'PROJECT.md': ['## Identity', '## Goals', '## Architecture', '## References', 'Document verified'],
  'HISTORY.md': ['# Verified Project History', 'No verified history has been recorded', '- Evidence:', '- Decision or outcome:'],
  'HANDOFF.md': ['## Current task', '## Progress', '## Verification', '## Blockers', '## Next agent instructions', 'No verification results have been recorded']
};
for (const [index, content] of freshNotes.entries()) {
  const name = noteNames[index];
  for (const expected of requiredTemplateText[name]) {
    if (!content.includes(expected)) throw new Error(`${name} template is missing: ${expected}`);
  }
  if (/tests? pass(?:ed)?|implementation complete|milestone achieved/i.test(content)) {
    throw new Error(`${name} contains a fabricated status`);
  }
}
for (const untouched of ['AGENTS.md', 'current-task.json', 'operation-journal.jsonl']) {
  const target = untouched === 'AGENTS.md' ? path.join(freshRoot, untouched) : path.join(freshRoot, '.ai-bridge', untouched);
  try {
    await fs.stat(target);
    throw new Error(`fresh init unexpectedly created ${untouched}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

for (const [index, name] of noteNames.entries()) {
  await fs.writeFile(path.join(freshRoot, '.ai-bridge', name), `custom repeat sentinel ${index}\n`, 'utf8');
}
const firstSnapshot = await snapshot(noteNames.map((name) => path.join(freshRoot, '.ai-bridge', name)));
requireSuccess(runInit(freshRoot), 'repeated project init');
const secondSnapshot = await snapshot(noteNames.map((name) => path.join(freshRoot, '.ai-bridge', name)));
if (JSON.stringify(firstSnapshot) !== JSON.stringify(secondSnapshot)) {
  throw new Error('repeated init changed project context content or file metadata');
}

const preserveRoot = await gitRepo('codexbridge-project-init-preserve-');
await fs.mkdir(path.join(preserveRoot, '.ai-bridge'));
const sentinels = new Map([
  [path.join(preserveRoot, 'AGENTS.md'), '# Keep these instructions\n'],
  [path.join(preserveRoot, '.ai-bridge', 'PROJECT.md'), '# Custom project notes\n'],
  [path.join(preserveRoot, '.ai-bridge', 'HISTORY.md'), '# Custom verified history\n'],
  [path.join(preserveRoot, '.ai-bridge', 'HANDOFF.md'), '# Custom handoff\n'],
  [path.join(preserveRoot, '.ai-bridge', 'current-task.json'), '{"keep":true}\n'],
  [path.join(preserveRoot, '.ai-bridge', 'operation-journal.jsonl'), '{"event":"keep"}\n']
]);
for (const [file, content] of sentinels) await fs.writeFile(file, content, 'utf8');
requireSuccess(runInit(preserveRoot), 'preserving project init');
for (const [file, content] of sentinels) {
  if (await fs.readFile(file, 'utf8') !== content) throw new Error(`init changed existing file: ${file}`);
}
const nonRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'codexbridge-project-init-nonrepo-'));
requireFailure(runInit(nonRepo), 'non-repository root', /requires an existing Git repository root/i);
try {
  await fs.stat(path.join(nonRepo, '.ai-bridge'));
  throw new Error('non-repository validation created .ai-bridge');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

requireFailure(
  runInit(nonRepo, { GIT_DIR: path.join(freshRoot, '.git'), GIT_WORK_TREE: nonRepo }),
  'ambient Git environment override',
  /requires an existing Git repository root/i
);

const nestedRoot = await gitRepo('codexbridge-project-init-nested-');
const nested = path.join(nestedRoot, 'nested');
await fs.mkdir(nested);
requireFailure(runInit(nested), 'nested repository path', /must select the Git repository top-level/i);
try {
  await fs.stat(path.join(nested, '.ai-bridge'));
  throw new Error('nested-root validation created .ai-bridge');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
requireSuccess(runInit(path.join(nested, '..')), 'normalized repository root');

const symlinkRoot = await gitRepo('codexbridge-project-init-link-root-');
const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexbridge-project-init-outside-'));
try {
  await fs.symlink(outsideDir, path.join(symlinkRoot, '.ai-bridge'), process.platform === 'win32' ? 'junction' : 'dir');
  requireFailure(runInit(symlinkRoot), 'symlinked bridge directory', /symlinked \.ai-bridge directory/i);
  if ((await fs.readdir(outsideDir)).length !== 0) throw new Error('symlinked bridge init wrote outside the repository');
} catch (error) {
  if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
}

const fileLinkRoot = await gitRepo('codexbridge-project-init-file-link-');
await fs.mkdir(path.join(fileLinkRoot, '.ai-bridge'));
const outsideFile = path.join(outsideDir, 'escaped-project.md');
try {
  await fs.symlink(outsideFile, path.join(fileLinkRoot, '.ai-bridge', 'PROJECT.md'));
  requireFailure(runInit(fileLinkRoot), 'symlinked project note', /symlinked project context file/i);
  try {
    await fs.stat(outsideFile);
    throw new Error('symlinked project note wrote outside the repository');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
} catch (error) {
  if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
}

const partialRoot = await gitRepo('codexbridge-project-init-partial-');
await fs.mkdir(path.join(partialRoot, '.ai-bridge'));
const customHandoff = '# Existing human-authored handoff\n';
await fs.writeFile(path.join(partialRoot, '.ai-bridge', 'HANDOFF.md'), customHandoff, 'utf8');
requireSuccess(runInit(partialRoot), 'partially initialized repository');
if (await fs.readFile(path.join(partialRoot, '.ai-bridge', 'HANDOFF.md'), 'utf8') !== customHandoff) {
  throw new Error('partial init overwrote the existing handoff');
}
for (const name of ['PROJECT.md', 'HISTORY.md']) {
  await fs.stat(path.join(partialRoot, '.ai-bridge', name));
}

const obstructedRoot = await gitRepo('codexbridge-project-init-obstructed-');
await fs.mkdir(path.join(obstructedRoot, '.ai-bridge'));
await fs.mkdir(path.join(obstructedRoot, '.ai-bridge', 'PROJECT.md'));
requireFailure(runInit(obstructedRoot), 'directory in place of a project note', /not a regular file/i);
for (const name of ['HISTORY.md', 'HANDOFF.md']) {
  try {
    await fs.stat(path.join(obstructedRoot, '.ai-bridge', name));
    throw new Error(`unsafe init unexpectedly created ${name}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

const concurrentRoot = await gitRepo('codexbridge-project-init-concurrent-');
await Promise.all(Array.from({ length: 6 }, () =>
  execFileAsync(process.execPath, [cli, 'init', '--root', concurrentRoot], {
    cwd: path.resolve('.'),
    env: process.env
  })
));
const concurrentFiles = (await fs.readdir(path.join(concurrentRoot, '.ai-bridge'))).sort();
if (JSON.stringify(concurrentFiles) !== JSON.stringify([...noteNames].sort())) {
  throw new Error(`concurrent init created unexpected files: ${concurrentFiles.join(', ')}`);
}
for (const name of noteNames) {
  const content = await fs.readFile(path.join(concurrentRoot, '.ai-bridge', name), 'utf8');
  if (!content.trim()) throw new Error(`concurrent init left ${name} empty`);
}

console.log('✓ project init smoke test passed');
