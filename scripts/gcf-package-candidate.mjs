#!/usr/bin/env node
/**
 * Private, disposable GPT Codex Flow package candidate acceptance.
 * No writes to source checkout, no external network, npm install, tarball
 * publication, user manifest changes, Git commits, or native model execution.
 *
 * This validates a minimal CANDIDATE, not a release-ready distribution.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const runtimeScripts=[
  'scripts/gcf-cli.mjs',
  'scripts/gcf-projects-onboard.mjs',
  'scripts/gcf-projects-remove.mjs',
  'scripts/gcf-local-auto-worker.mjs',
  'scripts/gcf-native-transfer-run.mjs',
  'scripts/gcf-native-transfer-preview.mjs',
  'scripts/gcf-native-codex-preflight.mjs',
  'scripts/gcf-native-codex-postflight.mjs',
  'scripts/gcf-native-return-receipt.mjs',
  'scripts/gcf-native-executable-pin.mjs',
  'scripts/gcf-native-process-supervisor.mjs'
];
const packageName='gpt-codex-flow-local-preview';
const MAX_FILES=120;
const envFor=(temp,{online=false}={})=>({
  ...process.env,
  // The consumer is disposable and must never use credentials from the
  // owner's user-level npm configuration.
  npm_config_userconfig:path.join(temp,'empty-npmrc'),
  npm_config_cache:path.join(temp,'npm-cache'),
  npm_config_registry:'https://registry.npmjs.org/',
  npm_config_offline:online?'false':'true',
  npm_config_ignore_scripts:'true',
  npm_config_update_notifier:'false',
  npm_config_audit:'false',
  npm_config_fund:'false',
  npm_config_fetch_retries:'0',
  npm_config_fetch_timeout:'20000'
});

export function validateCandidateList(files,requiredJs) {
  if(!Array.isArray(files)||files.length>MAX_FILES)throw Error('Invalid candidate file count.');
  const names=files.map(item=>item.path);
  if(names.some(name=>typeof name!=='string' || name.includes('\\') ||
      name.startsWith('/') || name.split('/').some(part=>!part||part==='..'||part==='.')))
    throw Error('Unsafe file path in candidate pack list.');
  if(new Set(names).size!==names.length)throw Error('Duplicate package paths.');
  for(const required of ['package.json','README.md','LICENSE',...runtimeScripts,...requiredJs])
    if(!names.includes(required))throw Error('Missing candidate dependency: '+required);
  for(const name of names) {
    if(!(['package.json','README.md','LICENSE'].includes(name) ||
         runtimeScripts.includes(name) || requiredJs.includes(name)))
      throw Error('Unapproved candidate file: '+name);
    if(name.endsWith('.map') || name.endsWith('.swift') ||
       name.endsWith('-smoke.mjs') || /(^|\/)\.env/.test(name))
      throw Error('Forbidden release path: '+name);
  }
  return {fileCount:names.length,rootFiles:3,
    runtimeScripts:runtimeScripts.length,compiledJs:requiredJs.length};
}

async function copyStrict(base,rel,target) {
  const segments=rel.split('/');
  let prefix=base;
  for(let i=0;i<segments.length;i++) {
    prefix=path.join(prefix,segments[i]);
    const info=await fs.lstat(prefix);
    if(info.isSymbolicLink())throw Error('Source symlink refused: '+rel);
    if(i<segments.length-1&&!info.isDirectory())throw Error('Source parent is not directory: '+rel);
    if(i===segments.length-1&&!info.isFile())throw Error('Source is not regular file: '+rel);
  }
  const to=path.join(target,rel);
  await fs.mkdir(path.dirname(to),{recursive:true});
  await fs.copyFile(prefix,to);
}

function childResult(command,args,options) {
  const r=spawnSync(command,args,{...options,encoding:'utf8',timeout:30000,
    maxBuffer:3*1024*1024,shell:false});
  if(r.error)throw r.error;
  if(r.status!==0)throw Error(command+' '+args.slice(0,2).join(' ')+
    ' failed (exit '+r.status+'): '+(r.stderr||r.stdout||'').slice(-700));
  return r.stdout;
}

async function verifyInstalledMcp({installRoot,manifest,approvedRoot,fixtureTemp,environment}) {
  const consumerSdk=await import('node:module');
  const require=consumerSdk.createRequire(path.join(installRoot,'package.json'));
  const {Client:InstalledClient}=require('@modelcontextprotocol/sdk/client/index.js');
  const {StdioClientTransport:InstalledTransport}=require('@modelcontextprotocol/sdk/client/stdio.js');
  const client=new InstalledClient({name:'gcf-packed-consumer-smoke',version:'1.0.0'},{capabilities:{}});
  const bin=path.join(installRoot,'node_modules','.bin','gcf');
  try {
    await client.connect(new InstalledTransport({command:process.execPath,
      args:[bin,'start','--transport','stdio','--manifest',manifest,'--write','off','--bash','off'],
      cwd:installRoot,env:environment,stderr:'pipe'}));
    const list=await client.callTool({name:'list_projects',arguments:{}});
    assert.notEqual(list.isError,true);
    const projects=list.structuredContent?.projects;
    assert.equal(projects?.length,1);
    assert.equal(projects[0].root,approvedRoot);
    const pick=await client.callTool({name:'select_project',arguments:{project_id:projects[0].project_id}});
    assert.notEqual(pick.isError,true);
    assert.equal(pick.structuredContent?.workspace_id,projects[0].project_id);
    const summary=await client.callTool({name:'project_summary',arguments:{workspace_id:projects[0].project_id}});
    assert.notEqual(summary.isError,true);
    const unwanted=path.join(fixtureTemp,'unapproved-project');
    await fs.mkdir(unwanted);
    childResult('git',['init','-q',unwanted],{cwd:fixtureTemp,env:environment});
    const denied=await client.callTool({name:'open_workspace',arguments:{root:await fs.realpath(unwanted),include_tree:false,include_skills:false}});
    assert.equal(denied.isError,true);
    const catalog=await client.listTools();
    const exposed=catalog.tools.map(t=>t.name);
    assert.ok(exposed.includes('list_projects')&&exposed.includes('select_project'));
    return {status:'INSTALLED_MCP_READ_ONLY_ROUNDTRIP_PASS',
      list_projects:true,select_project:true,project_summary:true,unapproved_root_denied:true,
      exposed_tools:exposed.length,connected_package_install:true};
  }finally{await client.close().catch(()=>{});}
}
export async function checkCandidate({base=sourceRoot,offlineInstall=false,onlineInstall=false,liveMcp=false}={}) {
  if(liveMcp&&!onlineInstall)throw Error('Live installed MCP test requires explicit onlineInstall.');
  if(offlineInstall&&onlineInstall)throw Error('Choose only one installation mode.');
  const repo=await fs.realpath(base);
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-package-candidate-'));
  try {
    const stage=path.join(temp,'stage');
    await fs.mkdir(stage);
    await fs.writeFile(path.join(temp,'empty-npmrc'),'',{flag:'wx',mode:0o600});
    const original=JSON.parse(await fs.readFile(path.join(repo,'package.json'),'utf8'));
    const compiled=await fs.readdir(path.join(repo,'dist'),{withFileTypes:true});
    if(compiled.some(d=>d.isSymbolicLink()))throw Error('Compiled artifact symlink refused.');
    const js=compiled.filter(d=>d.isFile()&&d.name.endsWith('.js'))
      .map(d=>'dist/'+d.name).sort();
    if(js.length<2||js.length>MAX_FILES-runtimeScripts.length-3 ||
       !js.includes('dist/stdio.js')||!js.includes('dist/projectRootsFile.js') ||
       !js.includes('dist/http.js')||!js.includes('dist/inboxGitPrivacy.js'))
      throw Error('Missing or unexpected compiled GCF runtime artifacts. Build first.');
    for(const file of [...js,...runtimeScripts,'LICENSE'])
      await copyStrict(repo,file,stage);
    await fs.chmod(path.join(stage,'scripts/gcf-cli.mjs'),0o755);
    const candidate={
      name:packageName,version:'0.0.0',
      private:true,type:'module',license:original.license,
      description:'LOCAL ACCEPTANCE FIXTURE ONLY — not for publication',
      engines:original.engines,
      bin:{gcf:'scripts/gcf-cli.mjs',
        'gcf-auto-worker':'scripts/gcf-local-auto-worker.mjs',
        'gcf-handoff-run':'scripts/gcf-native-transfer-run.mjs'},
      files:['dist/*.js',...runtimeScripts,'README.md','LICENSE'],
      dependencies:original.dependencies
    };
    await fs.writeFile(path.join(stage,'package.json'),JSON.stringify(candidate,null,2)+'\n',
      {flag:'wx',mode:0o600});
    await fs.writeFile(path.join(stage,'README.md'),
      '# GPT Codex Flow — local packaging acceptance fixture\n\n'+
      'PRIVATE testing candidate, not a published or independently audited product.\n'+
      'The runtime preserves owner-approved project roots, read-only defaults, and interactive approvals.\n'+
      'No trusted unattended elevated execution; Codex-native sandbox does not confine separate MCP tools.\n',
      {flag:'wx',mode:0o600});
    // Preview-only dependency bridge: reuse the already-installed development
    // dependencies. This DOES NOT prove an independently installed package.
    const existingModules=path.join(repo,'node_modules');
    if(!(await fs.stat(existingModules)).isDirectory())
      throw Error('Existing checkout node_modules missing; no network install attempted.');
    await fs.symlink(existingModules,path.join(stage,'node_modules'),'dir');
    const opts={cwd:stage,env:envFor(temp)};
    const help=childResult(path.join(stage,'scripts/gcf-cli.mjs'),['--help'],opts);
    assert.match(help,/GPT Codex Flow/);
    // Import the shipped orchestration modules without executing a model or
    // claiming this proves model availability. Missing helper dependencies fail.
    const imports=childResult(process.execPath,['--input-type=module','-e',
      'await import("./scripts/gcf-local-auto-worker.mjs"); await import("./scripts/gcf-native-transfer-run.mjs"); console.log("STAGED_ORCHESTRATION_IMPORT_PASS");'],opts);
    assert.match(imports,/STAGED_ORCHESTRATION_IMPORT_PASS/);
    const approvedGit=path.join(temp,'fixture-project');
    await fs.mkdir(approvedGit);
    childResult('git',['init','-q',approvedGit],{cwd:temp,env:envFor(temp)});
    const canonicalGit=await fs.realpath(approvedGit);
    const manifest=path.join(temp,'approved-projects.json');
    await fs.writeFile(manifest,JSON.stringify({version:1,roots:[canonicalGit]})+'\n',
      {flag:'wx',mode:0o600});
    const dry=JSON.parse(childResult(path.join(stage,'scripts/gcf-cli.mjs'),
      ['start','--dry-run','--manifest',manifest],opts));
    assert.equal(dry.dry_run,true);
    assert.equal(dry.no_process_started,true);
    assert.equal(dry.write,'off');
    assert.equal(dry.bash,'off');
    assert.deepEqual(dry.approved_roots,[canonicalGit]);
    const packRaw=childResult('npm',['pack','--dry-run','--json','--ignore-scripts',
      '--offline','--no-audit','--no-fund'],opts);
    const pack=JSON.parse(packRaw);
    assert.equal(pack.length,1);
    assert.equal(pack[0].name,packageName);
    const summary=validateCandidateList(pack[0].files,js);
    let installation={status:'NOT_ATTEMPTED'};
    if(offlineInstall||onlineInstall) {
      const packed=childResult('npm',['pack','--json','--ignore-scripts','--offline','--no-audit','--no-fund'],opts);
      const archive=JSON.parse(packed)[0]?.filename;
      if(typeof archive!=='string'||archive.includes('/')||!archive.endsWith('.tgz')) throw Error('Unexpected archive path.');
      const installRoot=path.join(temp,'consumer');
      await fs.mkdir(installRoot);
      await fs.writeFile(path.join(installRoot,'package.json'),JSON.stringify({name:'gcf-temporary-consumer',private:true,version:'0.0.0'})+'\n');
      const p=spawnSync('npm',['install',...(onlineInstall?[]:['--offline']),'--ignore-scripts','--no-audit','--no-fund','--no-save','--no-package-lock',path.join(stage,archive)],{
        cwd:installRoot,env:envFor(temp,{online:onlineInstall}),encoding:'utf8',timeout:120000,maxBuffer:2*1024*1024,shell:false
      });
      const installed=p.status===0&&!p.error;
      installation={status:installed?'NPM_INSTALL_SUCCEEDED':onlineInstall?'ONLINE_NPM_INSTALL_FAILED':'OFFLINE_DEPENDENCIES_UNAVAILABLE',exit_code:p.status,diagnostic:(p.stderr||p.stdout||'').slice(-500)};
      if(installed){
        const bin=path.join(installRoot,'node_modules','.bin','gcf');
        const out=childResult(bin,['--help'],{cwd:installRoot,env:envFor(temp)});
        assert.match(out,/GPT Codex Flow/);
        const installedDry=JSON.parse(childResult(bin,
          ['start','--dry-run','--manifest',manifest],{cwd:installRoot,env:envFor(temp,{online:onlineInstall})}));
        assert.equal(installedDry.dry_run,true);
        assert.equal(installedDry.no_process_started,true);
        assert.equal(installedDry.write,'off');
        assert.equal(installedDry.bash,'off');
        assert.deepEqual(installedDry.approved_roots,[canonicalGit]);
        installation.installed_manifest_dry_run_passed=true;
        installation.status=onlineInstall?'ONLINE_PACKED_BIN_VERIFIED':'OFFLINE_PACKED_BIN_VERIFIED';
        installation.installed_bin_help_passed=true;
        if(liveMcp) installation.mcp=await verifyInstalledMcp({installRoot,manifest,approvedRoot:canonicalGit,fixtureTemp:temp,environment:envFor(temp,{online:onlineInstall})});
      }
    }
    return {
      status:'CANDIDATE_PACKLIST_AND_STAGED_BIN_VERIFIED',
      scoped_release_status:'NOT_APPROVED',
      candidate_private:true,
      package_name:packageName,
      ...summary,
      staged_bin_help_passed:true,
      staged_orchestration_imports_passed:true,
      runtime_scope:'LOCAL_MCP_AND_OWNER_STARTED_ORCHESTRATION',
      isolated_manifest_dry_run_passed:true,
      requested_write_mode:'off',
      requested_bash_mode:'off',
      npm_pack_dry_run_passed:true,
      npm_pack_tarball_created:offlineInstall||onlineInstall,
      npm_install_attempted:offlineInstall||onlineInstall,
      installation,
      external_network_requested:onlineInstall,
      original_repository_modified:false,
      cleanup:'TEMPORARY_STAGING_REMOVED',
      caveat:'Installed live read-only MCP roundtrip verified only when installation.mcp exists; clean checkout, sender identity, owner-positive revoke and production broker remain unverified.'
    };
  } finally {
    await fs.rm(temp,{recursive:true,force:true});
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.length!==3||!['--online-install','--online-live-mcp'].includes(process.argv[2]))throw Error('Use --online-install or --online-live-mcp only, with owner approval.');
  console.log(JSON.stringify(await checkCandidate({onlineInstall:true,liveMcp:process.argv[2]==='--online-live-mcp'}),null,2));
}
