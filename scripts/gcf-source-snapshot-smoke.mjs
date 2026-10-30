#!/usr/bin/env node
/**
 * M37 disposable source closure test, NOT an isolated Git commit.
 * Copy bounded source trees into two temporary dirs, borrow existing node_modules
 * (no install/network), compile and run selected MCP integration smoke tests.
 * All git commits made by those smokes are confined to separate temporary fixtures.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const experimental=new Set(['src/scopedExecutionGate.ts','src/scopedSandboxExecutor.ts']);
const required=[
  'package.json','tsconfig.json','LICENSE',
  'scripts/gcf-cli.mjs',
  'scripts/gcf-projects-onboard.mjs',
  'scripts/gcf-projects-remove.mjs',
  'scripts/gcf-multi-project-routing-smoke.mjs',
  'scripts/gcf-task-inbox-smoke.mjs'
];
const MAX_FILES=300;
const MAX_TOTAL_BYTES=12*1024*1024;

function safeEnv(temp) {
  return {
    PATH:process.env.PATH??'/usr/bin:/bin',
    HOME:temp,TMPDIR:temp,LANG:'C',LC_ALL:'C',NO_COLOR:'1',
    GCF_ALLOW_HOME:'0',GCF_ALLOWED_ROOTS:'',
    CODEBASE_BRIDGE_ALLOWED_ROOTS:''
  };
}
async function listSources(directory,rel='src',files=[]) {
  for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
    const child=path.join(directory,entry.name);
    const relative=path.posix.join(rel,entry.name);
    if(entry.isSymbolicLink())throw Error('Source symlink refused: '+relative);
    if(entry.isDirectory())await listSources(child,relative,files);
    else if(entry.isFile())files.push(relative);
    else throw Error('Unexpected source entry: '+relative);
    if(files.length>MAX_FILES)throw Error('Source snapshot file count limit exceeded.');
  }
  return files;
}
async function copyBounded(source,stage,relative,ledger) {
  const original=path.join(source,relative);
  let current=source;
  for(const segment of relative.split('/')){
    current=path.join(current,segment);
    const st=await fs.lstat(current);
    if(st.isSymbolicLink())throw Error('Source symlink refused: '+relative);
  }
  const stat=await fs.stat(original);
  if(!stat.isFile())throw Error('Not a regular file: '+relative);
  ledger.totalBytes+=stat.size;
  ledger.count++;
  if(ledger.totalBytes>MAX_TOTAL_BYTES||ledger.count>MAX_FILES)
    throw Error('Snapshot file/byte review limit exceeded.');
  const bytes=await fs.readFile(original);
  assert.equal(bytes.length,stat.size,'Source changed during copy: '+relative);
  const target=path.join(stage,relative);
  await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.writeFile(target,bytes,{flag:'wx',mode:0o600});
  const digest=createHash('sha256').update(bytes).digest('hex');
  assert.equal(createHash('sha256').update(await fs.readFile(target)).digest('hex'),digest);
  ledger.checks.push({relative,digest});
}
function run(cmd,args,cwd,env,limit=45000) {
  const result=spawnSync(cmd,args,{cwd,env,shell:false,encoding:'utf8',
    timeout:limit,maxBuffer:2*1024*1024});
  if(result.error||result.status!==0)
    throw Error(path.basename(cmd)+' '+args.join(' ')+' failed (exit '+result.status+'): '+
      (result.stderr||result.stdout||result.error?.message||'').slice(-1100));
  return result.stdout??'';
}
async function oneVariant(temp,files,omit,name) {
  const stage=path.join(temp,name);
  await fs.mkdir(stage,{recursive:true,mode:0o700});
  const ledger={count:0,totalBytes:0,checks:[]};
  for(const file of [...required,...files])if(!omit.has(file))
    await copyBounded(root,stage,file,ledger);
  const nodeModules=path.join(root,'node_modules');
  if(!(await fs.stat(nodeModules)).isDirectory())
    throw Error('Developer node_modules absent; will not install dependencies.');
  await fs.symlink(nodeModules,path.join(stage,'node_modules'),'dir');
  const env=safeEnv(temp);
  const compiler=path.join(nodeModules,'typescript','bin','tsc');
  run(process.execPath,[compiler,'-p','tsconfig.json'],stage,env);
  assert.ok((await fs.stat(path.join(stage,'dist','stdio.js'))).isFile());
  assert.ok((await fs.stat(path.join(stage,'dist','projectRootsFile.js'))).isFile());
  for(const excluded of omit) {
    await assert.rejects(fs.stat(path.join(stage,excluded)),{code:'ENOENT'});
    await assert.rejects(fs.stat(path.join(stage,excluded.replace(/^src\//,'dist/').replace(/\.ts$/,'.js'))),{code:'ENOENT'});
  }
  const tests=[];
  for(const file of [
    'scripts/gcf-multi-project-routing-smoke.mjs',
    'scripts/gcf-task-inbox-smoke.mjs'
  ]) {
    const output=run(process.execPath,[file],stage,env,60000);
    assert.match(output,/PASS/i);
    tests.push({name:file.replace('scripts/',''),passed:true});
  }
  // Re-read only snapshotted source, verify this test did not change the originals.
  for(const check of ledger.checks) {
    const actual=createHash('sha256').update(await fs.readFile(path.join(root,check.relative))).digest('hex');
    if(actual!==check.digest)throw Error('Source changed during acceptance: '+check.relative);
  }
  return {variant:name,source_files:files.filter(f=>!omit.has(f)).length,
    copied_files:ledger.count,copied_bytes:ledger.totalBytes,
    build_passed:true,tests};
}
export async function checkIsolatedSource() {
  const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gcf-m37-source-closure-')));
  try {
    const files=await listSources(path.join(root,'src'));
    if(files.length<15||!files.includes('src/server.ts')||
       !files.includes('src/taskInbox.ts')||!files.includes('src/projectRootsFile.ts'))
      throw Error('Required GCF sources not present.');
    const full=await oneVariant(temp,files,new Set(),'full-source');
    const deferred=await oneVariant(temp,files,experimental,'without-scoped-experiments');
    return {
      status:'TEMP_SOURCE_BUILD_AND_SELECTED_MCP_SMOKES_VERIFIED',
      full,deferred,
      scope:'TWO DISPOSABLE SNAPSHOTS, NOT INTERMEDIATE GIT COMMITS',
      existing_node_modules_borrowed:true,
      owner_git_history_unchanged:true,
      original_source_hashes_rechecked:true,
      owner_manifest_untouched:true,
      temporary_files_cleaned:true,
      fresh_dependency_install_verified:false,
      independent_release_commit_verified:false,
      private_alpha_approved:false
    };
  } finally {
    await fs.rm(temp,{recursive:true,force:true});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.length!==2)throw Error('Fixture accepts no arguments.');
  console.log(JSON.stringify(await checkIsolatedSource(),null,2));
}
