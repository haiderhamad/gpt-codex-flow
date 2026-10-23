import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {shellQuote,validateProject,inspectProjectFolder,initializeGitFolder,connectionGuide} from './gcf-onboarding.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gcf-onboarding-check-')));
const git=path.join(dir,'good');
const nonGit=path.join(dir,'ordinary');
const linked=path.join(dir,'link');
const manifest=path.join(dir,'settings','projects.json');
try{
  fs.mkdirSync(path.join(git,'.git'),{recursive:true});
  fs.mkdirSync(nonGit);
  fs.mkdirSync(linked);
  fs.symlinkSync(path.join(git,'.git'),path.join(linked,'.git'));
  assert.equal(validateProject(git),fs.realpathSync(git));
  assert.equal(validateProject('',{cwd:git}),fs.realpathSync(git));
  assert.equal(validateProject('./good',{cwd:dir}),fs.realpathSync(git));
  assert.equal(inspectProjectFolder('$HOME/good',{home:dir}).root,git);
  assert.throws(()=>validateProject(nonGit),/Not a Git project/);
  assert.deepEqual(inspectProjectFolder(nonGit),{root:nonGit,isGit:false});
  assert.throws(()=>initializeGitFolder(nonGit,'no'),/not approved/);
  assert.equal(fs.existsSync(path.join(nonGit,'.git')),false);
  assert.equal(initializeGitFolder(nonGit,'INITIALIZE GIT'),nonGit);
  assert.equal(validateProject(nonGit),nonGit);
  assert.throws(()=>initializeGitFolder(nonGit,'INITIALIZE GIT'),/already contains/);
  const nested=path.join(git,'nested');
  fs.mkdirSync(nested);
  assert.throws(()=>initializeGitFolder(nested,'INITIALIZE GIT'),/inside another Git repository/);
  assert.equal(fs.existsSync(path.join(nested,'.git')),false);
  assert.throws(()=>validateProject(linked),/Unsafe .git/);
  assert.throws(()=>initializeGitFolder(linked,'INITIALIZE GIT'),/Unsafe .git/);
  assert.throws(()=>validateProject(path.join(dir,'missing')),/ENOENT/);
  assert.equal(shellQuote("a'b"),"'a'\"'\"'b'");
  const guide=connectionGuide({manifest,node:'/usr/bin/node',launcher:'/my path/gcf-cli.mjs'});
  assert.match(guide,/Cloudflare Quick Tunnel setup/);
  assert.match(guide,/commands are NOT executed/);
  assert.match(guide,/'\/my path\/gcf-cli.mjs' ui/);
  assert.match(guide,/No authentication/);
  assert.match(guide,/authenticates the secret/);
  assert.match(guide,/Native Codex registration/);
  assert.doesNotMatch(guide,/Local HTTP|codex mcp add|--transport|cloudflared tunnel|Full Access/);
  assert.throws(()=>connectionGuide({manifest:'relative.json'}),/must be absolute/);

  const help=spawnSync(process.execPath,['scripts/gcf-cli.mjs','--help'],{
    cwd:repo,encoding:'utf8',timeout:10000});
  assert.equal(help.status,0,help.stderr);
  assert.match(help.stdout,/guided setup wizard/);
  const noTty=spawnSync(process.execPath,['scripts/gcf-cli.mjs','setup'],{
    cwd:repo,encoding:'utf8',timeout:10000});
  assert.notEqual(noTty.status,0);
  assert.match(noTty.stderr,/local interactive Terminal/);
  assert.equal(fs.existsSync(manifest),false);
  const configHome=path.join(dir,'owner-config');
  const configFile=path.join(configHome,'gpt-codex-flow','projects.json');
  fs.mkdirSync(path.dirname(configFile),{recursive:true});
  const {makeProjectRootsManifest}=await import('../dist/projectRootsFile.js');
  fs.writeFileSync(configFile,JSON.stringify(makeProjectRootsManifest([git]))+'\n',{mode:0o600});
  const listed=spawnSync(process.execPath,['scripts/gcf-cli.mjs','projects','list'],{
    cwd:repo,env:{...process.env,CODEXBRIDGE_HOME:configHome},
    encoding:'utf8',timeout:10000});
  assert.equal(listed.status,0,listed.stderr);
  assert.equal(JSON.parse(listed.stdout).projects[0].root,git);
  const stale=path.join(dir,'obsolete');
  fs.writeFileSync(configFile,JSON.stringify({version:1,roots:[git,stale]})+'\n');
  const recoveryArgs=['scripts/gcf-projects-onboard.mjs','--preview',
    '--replace-missing','--output',configFile,'--project',nonGit];
  const recovery=spawnSync(process.execPath,recoveryArgs,{
    cwd:repo,encoding:'utf8',timeout:10000});
  assert.equal(recovery.status,0,recovery.stderr);
  const review=JSON.parse(recovery.stdout);
  assert.deepEqual(review.missing_roots_to_revoke,[stale]);
  assert.deepEqual(review.final_roots,[git,nonGit]);
  assert.equal(review.preview_only,true);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile,'utf8')).roots,[git,stale],
    'Preview must not rewrite owner configuration.');
  const ordinary=spawnSync(process.execPath,
    ['scripts/gcf-projects-onboard.mjs','--preview','--output',configFile,'--project',nonGit],
    {cwd:repo,encoding:'utf8',timeout:10000});
  assert.notEqual(ordinary.status,0,'Ordinary flow must fail closed on stale roots');
  const blocked=spawnSync(process.execPath,
    ['scripts/gcf-projects-onboard.mjs','--run','--replace-missing','--output',configFile,'--project',nonGit],
    {cwd:repo,encoding:'utf8',timeout:10000});
  assert.notEqual(blocked.status,0,'Recovery must refuse noninteractive owner approval');
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile,'utf8')).roots,[git,stale]);
  const wizardSource=fs.readFileSync(path.join(repo,'scripts/gcf-onboarding.mjs'),'utf8');
  assert.match(wizardSource,/import \{readProjectRootsManifest,readProjectRootsManifestSnapshot\} from/);
  assert.doesNotMatch(wizardSource,/const \{readProjectRootsManifestSnapshot\}=await import/);
  assert.doesNotMatch(wizardSource,/const \{readProjectRootsManifest\}=await import/);
  console.log('GPT Codex Flow setup smoke passed: Git init safeguards, Cloudflare-only connection guide, stale-root owner recovery preview, non-TTY denial, no config rewrite.');
}finally{
  fs.rmSync(dir,{recursive:true,force:true});
}
