// Full local launcher integration: preview, owner gate, manifest, real MCP.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {makeProjectRootsManifest} from '../dist/projectRootsFile.js';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const launcher=path.join(repo,'scripts','gcf-cli.mjs');
const tmp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gcf-launcher-smoke-')));
const a=path.join(tmp,'Git-A'),b=path.join(tmp,'Git-B'),c=path.join(tmp,'Git-C');
const manifest=path.join(tmp,'settings','projects.json');
const env={...process.env,CODEXBRIDGE_HOME:path.join(tmp,'settings-home'),
  CODEXBRIDGE_ALLOWED_ROOTS:c,CODEBASE_BRIDGE_ALLOWED_ROOTS:c,
  CODEXBRIDGE_ALLOW_HOME:'1',CODEXBRIDGE_ROOT:c,NO_COLOR:'1'};
const clients=[];
function invoke(args) {
  return spawnSync(process.execPath,[launcher,...args],{
    cwd:repo,env,encoding:'utf8',timeout:15000,maxBuffer:500000
  });
}
async function makeRepo(root){
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'identity.txt'),path.basename(root)+'\n');
  const init=spawnSync('git',['init','-q'],{cwd:root,encoding:'utf8',timeout:10000});
  assert.equal(init.status,0,init.stderr);
  return await fs.realpath(root);
}
try {
  await makeRepo(a);await makeRepo(b);await makeRepo(c);
  const preview=invoke(['setup','--preview','--manifest',manifest,
    '--project',a,'--project',b]);
  assert.equal(preview.status,0,preview.stderr);
  assert.match(preview.stdout,/READY_FOR_LOCAL_OWNER_REVIEW/);
  await assert.rejects(fs.stat(manifest),{code:'ENOENT'});
  const denied=invoke(['setup','--manifest',manifest,'--project',a]);
  assert.notEqual(denied.status,0);
  assert.match(denied.stderr,/interactive TTY owner approval/);
  await assert.rejects(fs.stat(manifest),{code:'ENOENT'});
  console.log('PASS: unified setup preview stays read-only; non-TTY approval denied');

  await fs.mkdir(path.dirname(manifest),{recursive:true,mode:0o700});
  await fs.writeFile(manifest,JSON.stringify(makeProjectRootsManifest([a,b]))+'\n',
    {mode:0o600});
  const dry=invoke(['start','--manifest',manifest,'--dry-run']);
  assert.equal(dry.status,0,dry.stderr);
  const data=JSON.parse(dry.stdout);
  assert.deepEqual(data.approved_roots,[a,b]);
  assert.equal(data.write,'off');
  assert.equal(data.bash,'off');
  assert.equal(data.no_tunnel,true);
  assert.equal(data.no_process_started,true);
  assert.notEqual(invoke(['start','--manifest',manifest,'--write','unsafe','--dry-run']).status,0);
  assert.notEqual(invoke(['start','--manifest',path.join(tmp,'missing.json'),'--dry-run']).status,0);
  console.log('PASS: start preview uses exact allowlist, no process, no tunnel and read-only defaults');
  const verified=invoke(['verify','--manifest',manifest]);
  assert.equal(verified.status,0,verified.stderr);
  const local=JSON.parse(verified.stdout);
  assert.equal(local.status,'VERIFIED_LOCAL_MCP');
  assert.deepEqual(local.projects.map(x=>x.root),[a,b]);
  assert.equal(local.approved_roots_match,true);
  assert.equal(local.project_selection_verified,true);
  assert.equal(local.selected_project_count,2);
  assert.equal(local.read_only,true);
  assert.equal(local.bash_disabled,true);
  assert.equal(local.chatgpt_connector_verified,false);
  assert.equal(local.code_modified,false);
  assert.equal(local.permanent_server_started,false);
  assert.notEqual(invoke(['verify','--manifest',path.join(tmp,'missing.json')]).status,0);
  assert.notEqual(invoke(['verify','--manifest',manifest,'--write','workspace']).status,0);
  console.log('PASS: verify performs separate read-only MCP roundtrip against exact owner manifest');

  const client=new Client({name:'gcf-launcher-integration',version:'1.0.0'},{capabilities:{}});
  await client.connect(new StdioClientTransport({
    command:process.execPath,
    args:[launcher,'start','--manifest',manifest,'--transport','stdio'],
    cwd:repo,env
  }));
  clients.push(client);
  const call=(name,args={})=>client.callTool({name,arguments:args});
  const listed=(await call('list_projects')).structuredContent;
  assert.deepEqual(listed.projects.map(p=>p.root),[a,b]);
  assert.equal(listed.requires_selection,true);
  const found=(await call('find_project',{name:'git-b'})).structuredContent;
  assert.equal(found.status,'unique');
  const selected=(await call('select_project',
    {project_id:found.matches[0].project_id})).structuredContent;
  assert.equal(selected.root,b);
  const read=(await call('read',
    {workspace_id:selected.workspace_id,path:'identity.txt'})).structuredContent;
  assert.match(read.text,/Git-B/);
  const badWrite=await call('write',{
    workspace_id:selected.workspace_id,path:'must-not-create.txt',content:'blocked'
  });
  assert.equal(badWrite.isError,true);
  const badRoot=await call('open_workspace',{
    root:c,include_tree:false,include_skills:false
  });
  assert.equal(badRoot.isError,true);
  await assert.rejects(fs.stat(path.join(b,'must-not-create.txt')),{code:'ENOENT'});
  console.log('PASS: real MCP via gcf start selects B, refuses C and denies writes by default');
} finally {
  await Promise.allSettled(clients.map(c=>c.close()));
  await fs.rm(tmp,{recursive:true,force:true});
}
