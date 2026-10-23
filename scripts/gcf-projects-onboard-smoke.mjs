// Owner-only project roots onboarding, local config and real MCP integration.
// Fixtures are disposable; NEVER write a user's real onboarding config.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {makeProjectRootsManifest,readProjectRootsManifest}
  from '../dist/projectRootsFile.js';
import {loadConfig} from '../dist/config.js';

const temp=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-roots-onboard-'));
const rootA=path.join(temp,'project-A');
const rootB=path.join(temp,'project-B');
const rootC=path.join(temp,'private-C');
const nested=path.join(rootA,'nested-git');
const configFile=path.join(temp,'owner','projects.json');
const clients=[];
const env={...process.env,HOME:temp,TMPDIR:temp,NO_COLOR:'1'};
for(const k of ['CODEXBRIDGE_ROOT','CODEBASE_BRIDGE_REPO_ROOT',
  'CODEXBRIDGE_ALLOWED_ROOTS','CODEBASE_BRIDGE_ALLOWED_ROOTS',
  'CODEXBRIDGE_PROJECT_ROOTS_FILE','CODEXBRIDGE_ALLOW_HOME'])delete env[k];
function cli(...args) {
  return spawnSync(process.execPath,['scripts/gcf-projects-onboard.mjs',...args],
    {cwd:process.cwd(),env,encoding:'utf8',timeout:15000,maxBuffer:500000,
      stdio:['ignore','pipe','pipe']});
}
async function gitFixture(root) {
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'identifier.txt'),root+'\n');
  const init=spawnSync('git',['init','-q'],{cwd:root,encoding:'utf8',timeout:12000});
  assert.equal(init.status,0,init.stderr);
  return await fs.realpath(root);
}
const call=(client,name,args={})=>client.callTool({name,arguments:args});
try {
  const a=await gitFixture(rootA);
  const b=await gitFixture(rootB);
  const c=await gitFixture(rootC);
  const inner=await gitFixture(nested);
  assert.throws(()=>makeProjectRootsManifest([a,inner]),/cannot duplicate or contain/);
  assert.throws(()=>makeProjectRootsManifest([a,a]),/cannot duplicate or contain/);
  assert.throws(()=>makeProjectRootsManifest([a,path.resolve(os.homedir())]),/Git working tree|home|canonical/);
  assert.throws(()=>makeProjectRootsManifest([a,path.join(temp,'not-a-repository')]),/does not exist/);
  const preview=cli('--preview','--output',configFile,'--project',a,'--project',b);
  assert.equal(preview.status,0,preview.stderr);
  const p=JSON.parse(preview.stdout);
  assert.equal(p.preview_only,true);
  assert.equal(p.total_projects,2);
  assert.equal(p.runtime_permissions_changed,false);
  assert.deepEqual(p.final_roots,[a,b]);
  assert.equal(fss.existsSync(configFile),false);
  const noninteractive=cli('--run','--output',configFile,'--project',a);
  assert.notEqual(noninteractive.status,0);
  assert.match(noninteractive.stderr,/interactive TTY owner approval/);
  assert.equal(fss.existsSync(configFile),false);
  const invalid=cli('--preview','--output',configFile,'--project',temp);
  assert.notEqual(invalid.status,0);
  assert.equal(fss.existsSync(configFile),false);
  console.log('PASS: local preview never writes; actual save refuses noninteractive caller; unsafe roots rejected');

  // Test fixture creates a synthetic owner-reviewed manifest without invoking
  // the real interactive owner approval. Production --run remains TTY-only.
  await fs.mkdir(path.dirname(configFile),{recursive:true,mode:0o700});
  await fs.writeFile(configFile,JSON.stringify(makeProjectRootsManifest([a,b]))+'\n',
    {mode:0o600});
  assert.deepEqual(readProjectRootsManifest(configFile),[a,b]);
  const more=cli('--preview','--output',configFile,'--project',c);
  assert.equal(more.status,0,more.stderr);
  const q=JSON.parse(more.stdout);
  assert.deepEqual(q.existing_roots,[a,b]);
  assert.deepEqual(q.added_roots,[c]);
  assert.deepEqual(q.final_roots,[a,b,c]);
  assert.deepEqual(readProjectRootsManifest(configFile),[a,b],
    'preview MUST NOT add C to disk');
  const cfg=loadConfig(['--project-roots-file',configFile,
    '--write','off','--bash','off']);
  assert.deepEqual(cfg.allowedRoots,[a,b]);
  assert.equal(cfg.defaultRoot,a);
  assert.throws(()=>loadConfig(['--project-roots-file',configFile,
    '--root',c]),/Explicit default root is not listed/);
  assert.throws(()=>loadConfig(['--project-roots-file',configFile,
    '--allow-root',c]),/forbids --allow-home and extra --allow-root/);
  assert.throws(()=>loadConfig(['--project-roots-file',configFile,
    '--allow-home']),/forbids --allow-home/);
  console.log('PASS: optional manifest is explicit, preserves roots, and refuses implicit extra scopes');

  const client=new Client({name:'gcf-owner-project-config-smoke',version:'1.0.0'},
    {capabilities:{}});
  await client.connect(new StdioClientTransport({
    command:process.execPath,
    args:['dist/stdio.js','--project-roots-file',configFile,
      '--tool-mode','standard','--write','off','--bash','off'],
    cwd:process.cwd(),env
  }));
  clients.push(client);
  const projects=(await call(client,'list_projects')).structuredContent;
  assert.deepEqual(projects.projects.map(item=>item.root),[a,b]);
  assert.equal(projects.requires_selection,true);
  const notSelected=(await call(client,'open_current_workspace')).structuredContent;
  assert.equal(notSelected.requires_selection,true);
  const found=(await call(client,'find_project',{name:'project-B'})).structuredContent;
  assert.equal(found.status,'unique');
  assert.equal(found.matches[0].root,b);
  const selected=(await call(client,'select_project',
    {project_id:found.matches[0].project_id})).structuredContent;
  assert.equal(selected.root,b);
  const outside=await call(client,'open_workspace',
    {root:c,include_tree:false,include_skills:false});
  assert.equal(outside.isError,true,'unlisted root C must be denied');
  assert.match(JSON.stringify(outside),/outside allowed roots/);
  console.log('PASS: real local MCP uses ONLY owner-reviewed A/B roots from manifest; C denied');

  await fs.writeFile(configFile,'bad-json');
  assert.throws(()=>readProjectRootsManifest(configFile),/Unexpected token|JSON/);
  const badDoc=JSON.stringify({version:1,roots:[a,a]});
  await fs.writeFile(configFile,badDoc);
  assert.throws(()=>readProjectRootsManifest(configFile),/cannot duplicate or contain/);
  await fs.rm(configFile);
  const external=path.join(temp,'external-file.json');
  await fs.writeFile(external,JSON.stringify(makeProjectRootsManifest([c])));
  await fs.symlink(external,configFile);
  assert.throws(()=>readProjectRootsManifest(configFile),/not a symlink/);
  assert.deepEqual(JSON.parse(await fs.readFile(external,'utf8')).roots,[c]);
  console.log('PASS: corrupt, duplicate and symlink root manifests fail closed');
}finally {
  await Promise.allSettled(clients.map(c=>c.close()));
  await fs.rm(temp,{recursive:true,force:true});
}
