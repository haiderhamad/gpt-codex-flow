// Owner project revocation: no simulated human consent, only disposable fixture roots.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {makeProjectRootsManifest,readProjectRootsManifest} from '../dist/projectRootsFile.js';
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gcf-revoke-fixture-')));
const a=path.join(tmp,'Git-A'),b=path.join(tmp,'Git-B'),c=path.join(tmp,'Git-C');
const manifest=path.join(tmp,'owner','projects.json');
const launcher=path.join(sourceRoot,'scripts','gcf-cli.mjs');
const env={...process.env,CODEXBRIDGE_ROOT:c,CODEXBRIDGE_ALLOWED_ROOTS:c,
  CODEXBRIDGE_ALLOW_HOME:'1',NO_COLOR:'1'};
function invoke(...args) {
  return spawnSync(process.execPath,[launcher,...args],{
    cwd:sourceRoot,env,encoding:'utf8',timeout:15000,maxBuffer:500000
  });
}
async function repo(pathname){
  await fs.mkdir(pathname,{recursive:true});
  await fs.writeFile(path.join(pathname,'marker.txt'),path.basename(pathname));
  const git=spawnSync('git',['init','-q'],{cwd:pathname,encoding:'utf8'});
  assert.equal(git.status,0,git.stderr);
}
const clients=[];
try {
  for(const project of [a,b,c])await repo(project);
  const firstRun=invoke('doctor','--manifest',manifest);
  assert.equal(firstRun.status,2,firstRun.stderr);
  const onboarding=JSON.parse(firstRun.stdout);
  assert.equal(onboarding.status,'BLOCKED');
  assert.equal(onboarding.setup_required,true);
  assert.equal(onboarding.configured_count,0);
  assert.equal(onboarding.read_only,true);
  assert.equal(onboarding.mcp_started,false);
  assert.equal(onboarding.permissions_changed,false);
  assert.match(onboarding.issues.join(' '),/No project roots configured yet/);
  assert.ok(onboarding.actions.some(x=>x.includes('gcf:setup')&&x.includes('--preview')));
  assert.ok(onboarding.actions.some(x=>x.includes('gcf:doctor')));
  assert.ok(!onboarding.actions.some(x=>x.includes('remove --preview')));
  await assert.rejects(fs.stat(manifest),{code:'ENOENT'});
  console.log('PASS: first-run Doctor reports missing setup, not stale-project removal');
  await fs.mkdir(path.dirname(manifest),{recursive:true,mode:0o700});
  await fs.writeFile(manifest,JSON.stringify(makeProjectRootsManifest([a,b]))+'\n',{mode:0o600});
  const original=await fs.readFile(manifest,'utf8');
  const healthy=invoke('doctor','--manifest',manifest);
  assert.equal(healthy.status,0,healthy.stderr);
  const ready=JSON.parse(healthy.stdout);
  assert.equal(ready.status,'READY');
  assert.equal(ready.read_only,true);
  assert.equal(ready.configured_count,2);
  assert.equal(ready.mcp_started,false);
  assert.equal(ready.permissions_changed,false);
  assert.deepEqual(ready.projects.map(x=>x.status),['READY','READY']);
  assert.equal(await fs.readFile(manifest,'utf8'),original);
  console.log('PASS: doctor inspects both registered Git roots without starting MCP or writing config');
  const preview=invoke('remove','--preview','--manifest',manifest,'--project',b);
  assert.equal(preview.status,0,preview.stderr);
  assert.match(preview.stdout,/READY_FOR_LOCAL_OWNER_REVIEW/);
  assert.match(preview.stdout,/Git-B/);
  assert.deepEqual(readProjectRootsManifest(manifest),[a,b]);
  const denied=invoke('remove','--manifest',manifest,'--project',b);
  assert.notEqual(denied.status,0);
  assert.match(denied.stderr,/interactive local owner TTY/);
  assert.equal(await fs.readFile(manifest,'utf8'),original);
  const wrong=invoke('remove','--preview','--manifest',manifest,'--project',c);
  assert.notEqual(wrong.status,0);
  assert.match(wrong.stderr,/not registered/);
  assert.deepEqual(readProjectRootsManifest(manifest),[a,b]);
  console.log('PASS: revoke preview has no write; noninteractive owner revocation blocked; unknown project rejected');

  // A user-approved write is deliberately NOT simulated. The fixture sets a
  // reduced manifest directly to verify downstream server authorization.
  await fs.writeFile(manifest,JSON.stringify(makeProjectRootsManifest([a]))+'\n',{mode:0o600});
  assert.equal((await fs.readFile(path.join(b,'marker.txt'),'utf8')),'Git-B',
    'revoking a root must not delete the Git repository or its files');
  const last=invoke('remove','--preview','--manifest',manifest,'--project',a);
  assert.equal(last.status,0,last.stderr);
  assert.match(last.stdout,/READY_FOR_LOCAL_OWNER_REVIEW/);
  assert.deepEqual(readProjectRootsManifest(manifest),[a], 'preview must not clear the live allowlist');
  const client=new Client({name:'gcf-revocation-smoke',version:'1.0.0'},{capabilities:{}});
  await client.connect(new StdioClientTransport({
    command:process.execPath,args:[launcher,'start','--manifest',manifest],
    cwd:sourceRoot,env
  }));
  clients.push(client);
  const call=(name,args={})=>client.callTool({name,arguments:args});
  const list=(await call('list_projects')).structuredContent;
  assert.deepEqual(list.projects.map(x=>x.root),[a]);
  const old=await call('open_workspace',{root:b,include_tree:false,include_skills:false});
  assert.equal(old.isError,true,'revoked B unexpectedly accessible on reconnected MCP');
  const found=(await call('find_project',{name:'Git-B'})).structuredContent;
  assert.equal(found.status,'not_found');
  const only=(await call('read',{path:'marker.txt'})).structuredContent;
  assert.match(only.text,/Git-A/);
  console.log('PASS: restarted real MCP permits A, denies revoked B; B Git/files untouched');

  // Recovery: a registered root was physically moved BEFORE it was removed
  // from the manifest. Server startup MUST fail closed; owner preview MUST work.
  await fs.writeFile(manifest,JSON.stringify(makeProjectRootsManifest([a,b]))+String.fromCharCode(10),{mode:0o600});
  const movedB=path.join(tmp,'Git-B-Moved');
  await fs.rename(b,movedB);
  assert.throws(()=>readProjectRootsManifest(manifest),/does not exist/);
  const broken=invoke('doctor','--manifest',manifest);
  assert.equal(broken.status,2,broken.stderr);
  const diagnosis=JSON.parse(broken.stdout);
  assert.equal(diagnosis.status,'BLOCKED');
  assert.equal(diagnosis.read_only,true);
  assert.equal(diagnosis.projects[1].status,'BLOCKED');
  assert.match(diagnosis.issues.join(' '),/Unavailable configured project/);
  assert.equal(diagnosis.permissions_changed,false);
  const stale=invoke('remove','--preview','--manifest',manifest,'--project',b);
  assert.equal(stale.status,0,stale.stderr);
  const report=JSON.parse(stale.stdout.slice(stale.stdout.indexOf('{'),
    stale.stdout.lastIndexOf('}')+1));
  assert.deepEqual(report.remaining_roots,[a]);
  assert.equal(report.requires_further_cleanup,false);
  const unchanged=await fs.readFile(manifest,'utf8');
  const deniedStale=invoke('remove','--manifest',manifest,'--project',b);
  assert.notEqual(deniedStale.status,0);
  assert.match(deniedStale.stderr,/interactive local owner TTY/);
  assert.equal(await fs.readFile(manifest,'utf8'),unchanged);
  const cannotStart=invoke('start','--manifest',manifest,'--dry-run');
  assert.notEqual(cannotStart.status,0,'live MCP startup must refuse a stale root');
  assert.equal(await fs.readFile(path.join(movedB,'marker.txt'),'utf8'),'Git-B');
  console.log('PASS: moved/stale root can be previewed for owner revocation; MCP startup still fails closed');

  const movedC=path.join(tmp,'Git-C-Moved');
  await fs.writeFile(manifest,JSON.stringify(makeProjectRootsManifest([a,c]))+String.fromCharCode(10),{mode:0o600});
  await fs.rename(c,movedC);
  const missing=invoke('remove','--preview','--manifest',manifest,'--project',c);
  assert.equal(missing.status,0,missing.stderr);
  const invalid=JSON.parse(missing.stdout.slice(missing.stdout.indexOf('{'),
    missing.stdout.lastIndexOf('}')+1));
  assert.deepEqual(invalid.remaining_roots,[a]);
  assert.equal(invalid.requires_further_cleanup,false);
  console.log('PASS: missing Git root can be targeted without weakening strict server authorization');

  // Two absent roots may need two owner-reviewed removals. The recovery
  // snapshot can explain the situation without falsely enabling MCP startup.
  const multiStale={version:1,roots:[a,b,c]};
  await fs.writeFile(manifest,JSON.stringify(multiStale)+String.fromCharCode(10),{mode:0o600});
  const multiPreview=invoke('remove','--preview','--manifest',manifest,'--project',b);
  assert.equal(multiPreview.status,0,multiPreview.stderr);
  const multi=JSON.parse(multiPreview.stdout.slice(multiPreview.stdout.indexOf('{'),
    multiPreview.stdout.lastIndexOf('}')+1));
  assert.deepEqual(multi.remaining_missing_roots,[c]);
  assert.equal(multi.requires_further_cleanup,true);
  assert.notEqual(invoke('start','--manifest',manifest,'--dry-run').status,0);
  console.log('PASS: multiple stale roots require further owner cleanup before any MCP startup');

  const ownerManifest=await fs.readFile(manifest,'utf8');
  await fs.writeFile(manifest,'{not-json');
  const corruptPreview=invoke('remove','--preview','--manifest',manifest,'--project',b);
  assert.notEqual(corruptPreview.status,0);
  assert.equal(await fs.readFile(manifest,'utf8'),'{not-json');
  const external=path.join(tmp,'untouched-config.json');
  await fs.writeFile(external,ownerManifest);
  await fs.rm(manifest);
  await fs.symlink(external,manifest);
  const symlinkPreview=invoke('remove','--preview','--manifest',manifest,'--project',b);
  assert.notEqual(symlinkPreview.status,0);
  assert.match(symlinkPreview.stderr,/not a symlink|ordinary file|bounded/);
  assert.equal(await fs.readFile(external,'utf8'),ownerManifest);
  console.log('PASS: corrupt/symlink manifests refused during owner recovery without overwriting external file');
}finally{
  await Promise.allSettled(clients.map(c=>c.close()));
  await fs.rm(tmp,{recursive:true,force:true});
}
