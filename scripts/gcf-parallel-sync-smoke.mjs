import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { previewParallelIntegration } from './gcf-parallel-sync.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gcf-sync-test-'));
const base = path.join(tmp, 'base');
const chatgpt = path.join(tmp, 'chatgpt');
const codex = path.join(tmp, 'codex');
function git(dir, ...args) {
  const r = spawnSync('git', args, {cwd:dir,encoding:'utf8',timeout:12000});
  assert.equal(r.status,0, r.stderr);
}
try {
  await fs.mkdir(base);
  await fs.mkdir(path.join(base,'src'));
  await fs.writeFile(path.join(base,'.gitignore'),'.ai-bridge/\n');
  await fs.writeFile(path.join(base,'src','api.txt'),'api baseline\n');
  await fs.writeFile(path.join(base,'src','ui.txt'),'ui baseline\n');
  await fs.writeFile(path.join(base,'src','Dashboard.txt'),'dashboard baseline\n');
  git(base,'init','-q');
  git(base,'add','.gitignore','src');
  git(base,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-q','-m','fixture');
  git(base,'worktree','add','-q','-b','gcf-test-chatgpt',chatgpt,'HEAD');
  git(base,'worktree','add','-q','-b','gcf-test-codex',codex,'HEAD');
  // This is a deterministic ChatGPT role and Codex role simulation, NOT native clients.
  await Promise.all([
    fs.appendFile(path.join(chatgpt,'src','ui.txt'),'chatgpt change\n'),
    fs.appendFile(path.join(codex,'src','api.txt'),'codex change\n')
  ]);
  const ready = await previewParallelIntegration({base,chatgpt,codex});
  assert.equal(ready.ready,true,JSON.stringify(ready));
  assert.equal(ready.preview,'PASS');
  assert.deepEqual(ready.combinedPaths,['src/api.txt','src/ui.txt']);
  assert.equal(await fs.readFile(path.join(base,'src','api.txt'),'utf8'),'api baseline\n');
  assert.equal(await fs.readFile(path.join(base,'src','ui.txt'),'utf8'),'ui baseline\n');
  console.log('PASS: disjoint ChatGPT/Codex role changes preview together; original untouched');

  // Git status must be parsed as STATUS/PATH pairs, not arbitrary filename fields.
  await fs.appendFile(path.join(chatgpt,'src','Dashboard.txt'),'dashboard change\n');
  const named = await previewParallelIntegration({base,chatgpt,codex});
  assert.equal(named.preview,'PASS',JSON.stringify(named.reasons));
  assert.deepEqual(named.combinedPaths,['src/Dashboard.txt','src/api.txt','src/ui.txt']);
  assert.ok(!named.reasons.includes('UNSUPPORTED_CHANGE_TYPE'));
  await fs.writeFile(path.join(chatgpt,'src','Dashboard.txt'),'dashboard baseline\n');
  console.log('PASS: tracked Dashboard.txt modification not mistaken for Git deletion');

  // Actual deletion remains unsupported regardless of misleading filenames.
  await fs.rm(path.join(codex,'src','api.txt'));
  const deleted = await previewParallelIntegration({base,chatgpt,codex});
  assert.equal(deleted.ready,false);
  assert.ok(deleted.reasons.includes('UNSUPPORTED_CHANGE_TYPE'));
  await fs.writeFile(path.join(codex,'src','api.txt'),'api baseline\ncodex change\n');
  console.log('PASS: real Git deletion still refused');

  await fs.appendFile(path.join(codex,'src','ui.txt'),'collision\n');
  const overlap = await previewParallelIntegration({base,chatgpt,codex});
  assert.equal(overlap.ready,false);
  assert.ok(overlap.reasons.includes('OVERLAPPING_FILES'));
  console.log('PASS: conflicting file edits are rejected');

  await fs.writeFile(path.join(codex,'src','ui.txt'),'ui baseline\n');
  await fs.writeFile(path.join(codex,'new.txt'),'untracked\n');
  const untracked = await previewParallelIntegration({base,chatgpt,codex});
  assert.equal(untracked.ready,false);
  assert.ok(untracked.reasons.includes('UNTRACKED_WORKER_FILES'));
  await fs.rm(path.join(codex,'new.txt'));
  console.log('PASS: untracked outputs are rejected (not silently dropped)');

  await fs.appendFile(path.join(base,'src','api.txt'),'base modified\n');
  const dirty = await previewParallelIntegration({base,chatgpt,codex});
  assert.equal(dirty.ready,false);
  assert.ok(dirty.reasons.includes('BASE_WORKTREE_DIRTY'));
  console.log('PASS: dirty original worktree prevents synchronization');

  await fs.writeFile(path.join(base,'src','api.txt'),'api baseline\n');
  // A tracked regular file replaced by a symlink must never be proposed for integration.
  const outside = path.join(tmp, 'outside.txt');
  await fs.writeFile(outside, 'outside protected fixture\n');
  await fs.rm(path.join(codex, 'src', 'api.txt'));
  await fs.symlink(outside, path.join(codex, 'src', 'api.txt'));
  const symlink = await previewParallelIntegration({base,chatgpt,codex});
  assert.equal(symlink.ready, false);
  assert.ok(symlink.reasons.includes('UNSAFE_WORKER_PATH'));
  await fs.rm(path.join(codex, 'src', 'api.txt'));
  await fs.writeFile(path.join(codex, 'src', 'api.txt'), 'api baseline\ncodex change\n');
  console.log('PASS: tracked symlink pointing outside worktree rejected');
  git(codex,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-am','advance worker');
  const stale = await previewParallelIntegration({base,chatgpt,codex});
  assert.equal(stale.ready,false);
  assert.ok(stale.reasons.includes('STALE_GIT_HEAD'));
  console.log('PASS: changed Git baseline blocks preview');
} finally {
  await fs.rm(tmp,{recursive:true,force:true});
}
