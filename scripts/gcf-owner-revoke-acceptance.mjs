#!/usr/bin/env node
/**
 * M37 owner-positive project revocation acceptance, isolated temporary roots.
 *
 * prepare: creates exactly two disposable Git repos and an independent allowlist,
 *          prints owner-review commands, NEVER auto-approves.
 * verify:  read-only MCP reconnection check AFTER a human has separately typed
 *          the real "REMOVE LOCAL PROJECT ROOT" consent in a local Terminal.
 *
 * Never creates or updates the real ~/.codexbridge manifest, never deletes repos,
 * never invokes native Codex, and never issues a postTaskInbox request.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {makeProjectRootsManifest,readProjectRootsManifestSnapshot} from '../dist/projectRootsFile.js';

const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const launcher=path.join(source,'scripts','gcf-cli.mjs');
const kind='GCF_M37_OWNER_DISPOSABLE_REVOCATION';
const prefix='gcf-m37-owner-revoke-';
const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
function callLocal(args) {
  const r=spawnSync(process.execPath,[launcher,...args],{
    cwd:source,encoding:'utf8',timeout:15000,maxBuffer:800000,shell:false,
    env:{...process.env,CODEXBRIDGE_ALLOWED_ROOTS:'',
      CODEBASE_BRIDGE_ALLOWED_ROOTS:'',CODEXBRIDGE_ALLOW_HOME:'0'}
  });
  return r;
}
async function readFileSafe(file) {
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink())throw Error('Expected an ordinary acceptance file: '+file);
  return await fs.readFile(file,'utf8');
}
function failIfGitInitFails(root) {
  const result=spawnSync('git',['init','-q'],{
    cwd:root,encoding:'utf8',timeout:10000,maxBuffer:100000,shell:false
  });
  if(result.error||result.status!==0)throw Error('Could not initialize disposable Git fixture.');
}
export async function prepareAcceptance() {
  const fixture=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),prefix)));
  const a=path.join(fixture,'Git-A'),b=path.join(fixture,'Git-B');
  const owner=path.join(fixture,'owner'),manifest=path.join(owner,'projects.json');
  await fs.mkdir(a,{mode:0o700});
  await fs.mkdir(b,{mode:0o700});
  await fs.mkdir(owner,{mode:0o700});
  for(const [root,name] of [[a,'Git-A'],[b,'Git-B']]){
    failIfGitInitFails(root);
    await fs.writeFile(path.join(root,'marker.txt'),name+'\n',{flag:'wx',mode:0o600});
  }
  await fs.writeFile(manifest,JSON.stringify(makeProjectRootsManifest([a,b]),null,2)+'\n',
    {flag:'wx',mode:0o600});
  const meta={version:1,kind,fixture,GitA:a,GitB:b,manifest};
  await fs.writeFile(path.join(fixture,'fixture.json'),JSON.stringify(meta,null,2)+'\n',
    {flag:'wx',mode:0o600});
  const preview=callLocal(['remove','--preview','--manifest',manifest,'--project',b]);
  if(preview.status!==0 || !preview.stdout.includes('READY_FOR_LOCAL_OWNER_REVIEW'))
    throw Error('Fixture setup failed revocation preview; do not proceed.');
  const command=parts=>[process.execPath,launcher,...parts].map(quote).join(' ');
  return {
    status:'READY_FOR_HUMAN_OWNER_REVIEW',
    fixture,manifest,GitA:a,GitB:b,
    preview_command:command(['remove','--preview','--manifest',manifest,'--project',b]),
    owner_command:command(['remove','--manifest',manifest,'--project',b]),
    verify_command:commandForVerify(fixture),
    required_confirmation:'OWNER MUST TYPE THE EXACT CONSENT PHRASE INTERACTIVELY',
    original_project_manifest_modified:false,
    original_repository_modified:false,
    no_approval_generated:true
  };
}
function commandForVerify(fixture){
  return [process.execPath,fileURLToPath(import.meta.url),'--verify','--fixture',fixture]
    .map(quote).join(' ');
}
export async function inspectFixture(fixtureArg) {
  if(typeof fixtureArg!=='string'||!path.isAbsolute(fixtureArg))
    throw Error('Fixture must be an absolute path.');
  const base=await fs.realpath(os.tmpdir());
  const fixture=await fs.realpath(fixtureArg);
  const relative=path.relative(base,fixture);
  if(!relative ||relative.startsWith('..')||path.isAbsolute(relative)||
    path.dirname(relative)!=='.'||!path.basename(fixture).startsWith(prefix))
    throw Error('Refusing fixture outside immediate temporary test directory.');
  const meta=JSON.parse(await readFileSafe(path.join(fixture,'fixture.json')));
  const a=path.join(fixture,'Git-A'),b=path.join(fixture,'Git-B');
  const manifest=path.join(fixture,'owner','projects.json');
  if(meta.kind!==kind||meta.version!==1||meta.fixture!==fixture||
     meta.GitA!==a||meta.GitB!==b||meta.manifest!==manifest)
    throw Error('Fixture provenance mismatch; refusing to inspect.');
  for(const root of [a,b]) {
    if(await fs.realpath(root)!==root)throw Error('Test repo root cannot be a symlink.');
    if(!(await fs.stat(path.join(root,'.git'))).isDirectory())
      throw Error('Disposable Git root was removed; abort.');
    const marker=await readFileSafe(path.join(root,'marker.txt'));
    if(marker!==path.basename(root)+'\n')throw Error('Fixture repository marker modified.');
  }
  await readFileSafe(manifest);
  const roots=readProjectRootsManifestSnapshot(manifest);
  if(JSON.stringify(roots)===JSON.stringify([a,b]))
    return {status:'AWAITING_MANUAL_OWNER_APPROVAL',fixture,
      manifest,GitA:a,GitB:b,approved:false,source_repo_modified:false};
  if(JSON.stringify(roots)!==JSON.stringify([a]))
    throw Error('Unexpected manifest contents; accepted only untouched [A,B] or revoked [A].');
  return {status:'READY_TO_VERIFY_MCP_RECONNECT',fixture,manifest,GitA:a,GitB:b,
    approved:true,source_repo_modified:false};
}
export async function verifyAcceptance(fixtureArg) {
  const result=await inspectFixture(fixtureArg);
  if(!result.approved)return result;
  const client=new Client({name:'gcf-m37-owner-positive-revocation',version:'1.0.0'},
    {capabilities:{}});
  const env={...process.env,CODEXBRIDGE_ALLOWED_ROOTS:'',
    CODEBASE_BRIDGE_ALLOWED_ROOTS:'',CODEXBRIDGE_ALLOW_HOME:'0'};
  try {
    await client.connect(new StdioClientTransport({
      command:process.execPath,
      args:[launcher,'start','--transport','stdio','--manifest',result.manifest,
        '--write','off','--bash','off'],
      cwd:source,env
    }));
    const call=(name,args={})=>client.callTool({name,arguments:args});
    const projects=(await call('list_projects')).structuredContent?.projects;
    assert.deepEqual(projects?.map(p=>p.root),[result.GitA]);
    const selected=await call('select_project',{project_id:projects[0].project_id});
    assert.equal(selected.structuredContent?.workspace_id,projects[0].project_id);
    const removed=await call('find_project',{name:'Git-B'});
    assert.equal(removed.structuredContent?.status,'not_found');
    const denied=await call('open_workspace',{
      root:result.GitB,include_tree:false,include_skills:false});
    assert.equal(denied.isError,true);
    const file=await call('read',{workspace_id:projects[0].project_id,path:'marker.txt'});
    assert.notEqual(file.isError,true);
    assert.match(file.structuredContent?.text??'',/Git-A/);
    return {...result,status:'OWNER_REVOCATION_AND_RECONNECT_VERIFIED',
      project_count:projects.length,GitB_denied:true,
      original_repository_modified:false,mcp_read_only:true,bash_off:true};
  }finally{await client.close().catch(()=>{});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const mode=process.argv[2];
  if(mode==='--prepare'&&process.argv.length===3) console.log(JSON.stringify(await prepareAcceptance(),null,2));
  else if(mode==='--verify'&&process.argv.length===5&&process.argv[3]==='--fixture')
    console.log(JSON.stringify(await verifyAcceptance(process.argv[4]),null,2));
  else throw Error('Usage: node scripts/gcf-owner-revoke-acceptance.mjs --prepare OR --verify --fixture /tmp/... . No consent is supplied by the script.');
}
