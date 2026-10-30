// Read-only ChatGPT Project Instructions generator: exact manifest and project selection.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeProjectRootsManifest} from '../dist/projectRootsFile.js';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const launcher=path.join(repo,'scripts','gcf-cli.mjs');
const tmp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gcf-chat-guide-')));
const a=path.join(tmp,'A'),b=path.join(tmp,'B');
const manifest=path.join(tmp,'projects.json');
const env={...process.env,GCF_HOME:path.join(tmp,'unconfigured-home'),NO_COLOR:'1'};
const id=root=>'ws_'+createHash('sha256').update(root).digest('hex').slice(0,24);
const invoke=args=>spawnSync(process.execPath,[launcher,'chat-guide',...args],{
  cwd:repo,env,encoding:'utf8',timeout:12000,maxBuffer:200000
});
async function git(root){
  await fs.mkdir(root,{recursive:true});
  const r=spawnSync('git',['init','-q'],{cwd:root,encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);
}
try {
  await git(a);await git(b);
  await fs.writeFile(manifest,JSON.stringify(makeProjectRootsManifest([a,b]))+'\n',{mode:0o600});
  const before=await fs.readFile(manifest,'utf8');
  const ambiguous=invoke(['--manifest',manifest]);
  assert.equal(ambiguous.status,2,ambiguous.stderr);
  const candidates=JSON.parse(ambiguous.stdout);
  assert.equal(candidates.status,'SELECTION_REQUIRED');
  assert.deepEqual(candidates.projects.map(p=>p.project_id),[id(a),id(b)]);
  const bad=invoke(['--manifest',manifest,'--project-id','ws_000000000000000000000000']);
  assert.equal(bad.status,2,bad.stderr);
  assert.equal(JSON.parse(bad.stdout).status,'NOT_FOUND');
  assert.notEqual(invoke(['--manifest',manifest,'--project-id','not-an-id']).status,0);
  assert.notEqual(invoke(['--manifest',manifest,'--project-id',id(a),'--write','workspace']).status,0);
  const success=invoke(['--manifest',manifest,'--project-id',id(b)]);
  assert.equal(success.status,0,success.stderr);
  assert.match(success.stdout,/ChatGPT Project Instructions/);
  assert.match(success.stdout,/list_projects.*select_project/);
  assert.match(success.stdout,/project_summary/);
  assert.match(success.stdout,/Before substantive work, read AGENTS\.md/);
  assert.match(success.stdout,/AGENTS\.md points to NOTION_MEMORY\.md/);
  assert.match(success.stdout,/official Notion plugin\/MCP/);
  assert.match(success.stdout,/NOTION_SYNC_PENDING/);
  assert.match(success.stdout,/GCF handoff, shared_project_state, task_resume and Task Inbox never depend on Notion/);
  assert.match(success.stdout,/SKIP Notion and do not report a pending sync/);
  assert.match(success.stdout,/If opted in but Notion is unavailable, continue GCF work normally/);
  assert.match(success.stdout,/New chat starter/);
  assert.match(success.stdout,new RegExp(id(b)));
  assert.doesNotMatch(success.stdout,new RegExp(id(a)));
  assert.match(success.stdout,/not automatic ChatGPT Project creation/);
  assert.equal(await fs.readFile(manifest,'utf8'),before);
  assert.deepEqual(await fs.readdir(a),['.git']);
  assert.deepEqual(await fs.readdir(b),['.git']);
  await fs.writeFile(manifest,JSON.stringify(makeProjectRootsManifest([a]))+'\n');
  const single=invoke(['--manifest',manifest]);
  assert.equal(single.status,0,single.stderr);
  assert.match(single.stdout,new RegExp(id(a)));
  assert.notEqual(invoke(['--manifest',path.join(tmp,'missing.json')]).status,0);
  console.log('PASS: chat-guide is read-only, single-root convenient, multi-root exact, and never expands permissions');
}finally{
  await fs.rm(tmp,{recursive:true,force:true});
}
