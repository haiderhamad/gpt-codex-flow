import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  makeProjectRootsManifest,
  readProjectRootsManifest,
  readProjectRootsManifestSnapshot,
  validateProjectRootPaths
} from '../dist/projectRootsFile.js';
import { gitDiff, gitStatus, hasGitWorkingTree } from '../dist/gitOps.js';

const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gcf-nongit-')));
let client;
try {
  const ordinary = path.join(temp, 'ordinary');
  const repository = path.join(temp, 'repository');
  fs.mkdirSync(ordinary);
  fs.mkdirSync(repository);
  fs.writeFileSync(path.join(ordinary, 'notes.txt'), 'ordinary folder\n');
  assert.equal(spawnSync('git', ['init', '-q', repository]).status, 0);

  const manifest = path.join(temp, 'roots.json');
  fs.writeFileSync(manifest, JSON.stringify(makeProjectRootsManifest([ordinary, repository])), { mode: 0o600 });
  assert.deepEqual(readProjectRootsManifest(manifest), [ordinary, repository]);
  assert.equal(hasGitWorkingTree({ root: ordinary }), false);
  assert.equal(hasGitWorkingTree({ root: repository }), true);
  assert.match(gitStatus({ maxOutputBytes: 100_000 }, { root: ordinary }), /Git features require a Git repository/);
  assert.match(gitStatus({ maxOutputBytes: 100_000 }, { root: repository }), /^## /);
  assert.match(gitDiff({ maxOutputBytes: 100_000 }, { resolve() { throw Error('unused'); } }, { root: ordinary }), /Git features require a Git repository/);

  const env = { ...process.env, HOME: temp, NO_COLOR: '1' };
  for (const key of ['CODEXBRIDGE_ROOT', 'CODEXBRIDGE_ALLOWED_ROOTS', 'CODEXBRIDGE_PROJECT_ROOTS_FILE', 'CODEXBRIDGE_ALLOW_HOME']) delete env[key];
  client = new Client({ name: 'gcf-nongit-smoke', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['dist/stdio.js', '--project-roots-file', manifest, '--tool-mode', 'full', '--write', 'workspace', '--bash', 'off'],
    cwd: process.cwd(), env
  }));
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const listed = (await call('list_projects')).structuredContent;
  assert.deepEqual(listed.projects.map(item => item.root), [ordinary, repository]);
  const selected = (await call('select_project', { project_id: listed.projects[0].project_id })).structuredContent;
  assert.equal(selected.root, ordinary);
  const opened = (await call('open_workspace', { root: ordinary, include_tree: true, include_skills: false })).structuredContent;
  assert.equal(opened.root, ordinary);
  assert.equal(opened.git_available, false);
  const read = (await call('read', { workspace_id: opened.workspace_id, path: 'notes.txt' })).structuredContent;
  assert.match(JSON.stringify(read), /ordinary folder/);
  const write = await call('write', { workspace_id: opened.workspace_id, path: 'new.txt', content: 'new workspace file\n' });
  assert.notEqual(write.isError, true);
  assert.equal(fs.readFileSync(path.join(ordinary, 'new.txt'), 'utf8'), 'new workspace file\n');
  const gitOnly = (await call('git_status', { workspace_id: opened.workspace_id })).structuredContent;
  assert.match(gitOnly.status_error, /Git features require a Git repository/);
  const changes = (await call('show_changes', { workspace_id: opened.workspace_id })).structuredContent;
  assert.equal(changes.changed, false);
  assert.equal(changes.additions, 0);
  assert.match(changes.status_error, /Git features require a Git repository/);
  const report = (await call('task_report', { workspace_id: opened.workspace_id })).structuredContent;
  assert.equal(report.changed, false);
  assert.equal(report.additions, 0);
  assert.equal(report.diff, '');
  const gitProject = (await call('open_workspace', { root: repository, include_tree: false, include_skills: false })).structuredContent;
  assert.equal(gitProject.git_available, true);

  const nested = path.join(repository, 'nested');
  fs.mkdirSync(nested);
  assert.equal(hasGitWorkingTree({ root: nested }), false, 'Git must not walk above an approved root');
  assert.match(gitStatus({ maxOutputBytes: 100_000 }, { root: nested }), /Git features require a Git repository/);
  assert.throws(() => makeProjectRootsManifest([repository, nested]), /cannot duplicate or contain/);
  assert.throws(() => makeProjectRootsManifest([ordinary, ordinary]), /cannot duplicate or contain/);

  const symlink = path.join(temp, 'link');
  fs.symlinkSync(ordinary, symlink);
  assert.throws(() => makeProjectRootsManifest([symlink]), /canonical/);
  assert.throws(() => makeProjectRootsManifest([os.homedir()]), /home or filesystem root/);
  assert.throws(() => makeProjectRootsManifest([path.parse(ordinary).root]), /home or filesystem root/);

  // Recovery can represent the last folder being removed, while MCP startup
  // keeps requiring an explicitly approved nonempty allowlist.
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, roots: [] }), { mode: 0o600 });
  assert.deepEqual(readProjectRootsManifestSnapshot(manifest), []);
  assert.deepEqual(validateProjectRootPaths([]), []);
  assert.throws(() => readProjectRootsManifest(manifest), /requires 1-20/);
  console.log('non-Git workspace smoke passed');
} finally {
  if (client) await client.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
