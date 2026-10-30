#!/usr/bin/env node
/**
 * Guided, owner-local project onboarding for GPT Codex Flow.
 * Never stores credentials, registers MCP clients, runs a tunnel, or invokes AI.
 * Reuses the existing interactive owner approval for project roots.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath} from 'node:url';
import {readProjectRootsManifest,readProjectRootsManifestSnapshot} from '../dist/projectRootsFile.js';

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const script=path.join(sourceRoot,'scripts','gcf-cli.mjs');
const ownerSetup=path.join(sourceRoot,'scripts','gcf-projects-onboard.mjs');

export function shellQuote(input){
  return "'"+String(input).replaceAll("'","'\"'\"'")+"'";
}
export function inspectProjectFolder(input,{cwd=process.cwd(),home=os.homedir()}={}){
  const raw=String(input).trim();
  const provided=raw===''?cwd:raw==='~'?home:
    raw.startsWith('~/')?path.join(home,raw.slice(2)):
    raw==='$HOME'?home:
    raw.startsWith('$HOME/')?path.join(home,raw.slice(6)):raw;
  const selected=path.resolve(cwd,provided);
  // Never silently resolve a user-selected symbolic-link directory to a new target.
  if(fs.lstatSync(selected).isSymbolicLink())
    throw Error('Folder is a symbolic link; choose its real path: '+selected);
  const root=fs.realpathSync(selected);
  if(!fs.statSync(root).isDirectory())throw Error('Not a directory: '+root);
  const marker=fs.lstatSync(path.join(root,'.git'),{throwIfNoEntry:false});
  if(marker && (marker.isSymbolicLink() || (!marker.isFile()&&!marker.isDirectory())))
    throw Error('Unsafe .git entry; inspect manually: '+root);
  return {root,isGit:Boolean(marker)};
}
export function validateProject(input,options){
  const folder=inspectProjectFolder(input,options);
  if(!folder.isGit)throw Error('Not a Git project root: '+folder.root);
  return folder.root;
}
export function initializeGitFolder(folder,confirmation,{home=os.homedir()}={}){
  // Only the explicit phrase from the local TTY prompt permits an actual git init.
  if(confirmation!=='INITIALIZE GIT')
    throw Error('Git initialization was not approved; no files changed.');
  const {root,isGit}=inspectProjectFolder(folder);
  if(isGit)throw Error('This folder already contains .git: '+root);
  if(root===fs.realpathSync(home) || root===path.parse(root).root)
    throw Error('Refusing to initialize Git in home or the filesystem root.');
  let ancestor=path.dirname(root);
  while(ancestor!==path.dirname(ancestor)){
    if(fs.lstatSync(path.join(ancestor,'.git'),{throwIfNoEntry:false}))
      throw Error('Folder is inside another Git repository; choose its root: '+ancestor);
    ancestor=path.dirname(ancestor);
  }
  const env={...process.env};
  for(const variable of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES'])delete env[variable];
  const result=spawnSync('git',['-C',root,'init','--quiet'],{
    cwd:root,env,encoding:'utf8',shell:false,timeout:15000
  });
  if(result.error)throw Error('Cannot initialize Git: '+result.error.message);
  if(result.status!==0)
    throw Error('git init failed: '+(result.stderr?.trim()||'exit '+result.status));
  if(validateProject(root)!==root)throw Error('Git initialization verification failed.');
  return root;
}
export function connectionGuide({manifest,node=process.execPath,launcher=script}){
  if(!path.isAbsolute(manifest))throw Error('Manifest path must be absolute.');
  return [
    'GPT Codex Flow — Cloudflare Quick Tunnel setup',
    'These commands are NOT executed by this wizard.',
    'Only owner-approved project folders in '+manifest+' are accessible.',
    '',
    'Open the owner-local Control Center:',
    shellQuote(node)+' '+shellQuote(launcher)+' ui',
    'In Connections, select approved projects and the required access level.',
    'Start Cloudflare only after reviewing the local owner confirmation.',
    'Copy the private Connection URL into ChatGPT with No authentication.',
    'GCF authenticates the secret in that URL; keep it out of chat, screenshots and Git.',
    'Quick Tunnel URLs change after restart; update the ChatGPT connection when needed.',
    'Verify list_projects and project_summary in ChatGPT before coding.',
    'The wizard does not start a tunnel, register a client or invoke an agent.',
    'Native Codex registration remains available in the Control Center.'
  ].join('\n');
}
function ownerScript(argumentsList){
  const result=spawnSync(process.execPath,[ownerSetup,...argumentsList],{
    cwd:sourceRoot,env:process.env,stdio:'inherit',shell:false});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error('Owner review was cancelled or failed ('+result.status+').');
}
async function runWizard(){
  if(!process.stdin.isTTY||!process.stdout.isTTY)
    throw Error('Run guided setup inside a local interactive Terminal.');
  const base=process.env.GCF_HOME
    ?path.resolve(process.env.GCF_HOME):path.join(os.homedir(),'.gcf');
  const manifest=path.join(base,'gpt-codex-flow','projects.json');
  const rl=createInterface({input:process.stdin,output:process.stdout});
  let roots=[],confirmed=false,repair=false;
  console.log('\nGPT Codex Flow — Guided Setup\nNo cloud account or tunnel is connected automatically.\n');
  try{
    for(;;){
      const answer=await rl.question('Git project folder [current directory]: ');
      try{
        const folder=inspectProjectFolder(answer);
        if(folder.isGit){
          roots.push(folder.root);
        }else{
          console.log('This folder is not a Git repository: '+folder.root);
          console.log('  1 Initialize Git here (requires explicit approval)');
          console.log('  2 Choose another folder');
          console.log('  3 Cancel setup');
          const choice=(await rl.question('Choose [2]: ')).trim()||'2';
          if(choice==='3'){console.log('Cancelled. No Git changes made.');return;}
          if(choice==='2')continue;
          if(choice!=='1'){console.log('Invalid choice. No changes made.');continue;}
          console.log('Git initialization creates a .git directory in: '+folder.root);
          console.log('It does not commit, stage or delete your existing project files.');
          const typed=(await rl.question('Type INITIALIZE GIT to confirm: ')).trim();
          if(typed!=='INITIALIZE GIT'){
            console.log('Initialization cancelled. No Git changes made.');
            continue;
          }
          roots.push(initializeGitFolder(folder.root,typed));
          console.log('Git repository initialized and verified: '+folder.root);
        }
      }catch(err){
        console.log('Not added: '+err.message);
        const retry=(await rl.question('Try a different folder? [Y/n]: ')).trim().toLowerCase();
        if(retry==='n'||retry==='no')return;
        continue;
      }
      const more=(await rl.question('Add another Git project? [y/N]: ')).trim().toLowerCase();
      if(more!=='y'&&more!=='yes')break;
    }
    roots=[...new Set(roots)];
    const saved=fs.existsSync(manifest)?readProjectRootsManifestSnapshot(manifest):[];
    const missing=saved.filter(root=>!fs.existsSync(root));
    if(missing.length){
      console.log('\nPreviously approved Git folders no longer exist:');
      for(const root of missing)console.log('  - '+root);
      console.log('These stale entries block normal setup. No folders will be deleted.');
      const response=(await rl.question('Remove ONLY these missing entries from the allowlist (back up settings first)? [y/N]: ')).trim().toLowerCase();
      if(response!=='y'&&response!=='yes'){
        console.log('Cancelled. Existing owner configuration was not changed.');
        return;
      }
      repair=true;
    }
    console.log('\nReview the proposed project allowlist:');
    ownerScript(['--preview',...(repair?['--replace-missing']:[]),'--output',manifest,...roots.flatMap(p=>['--project',p])]);
    const ok=(await rl.question('Continue to owner approval? [y/N]: ')).trim().toLowerCase();
    confirmed=ok==='y'||ok==='yes';
  }finally{rl.close();}
  if(!confirmed){console.log('Cancelled. No project permissions changed.');return;}
  const existing=fs.existsSync(manifest)?(repair?readProjectRootsManifestSnapshot(manifest):readProjectRootsManifest(manifest)):[];
  if(repair || roots.some(root=>!existing.includes(root))){
    // The existing owner-only script enforces its own exact typed consent.
    ownerScript(['--run',...(repair?['--replace-missing']:[]),'--output',manifest,...roots.flatMap(p=>['--project',p])]);
  }else{
    console.log('Selected projects were already owner-approved.');
  }
  console.log('\n'+connectionGuide({manifest})+'\n');
  console.log('Optional check: node '+shellQuote(script)+' doctor');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--help'))console.log('GPT Codex Flow guided setup: run gcf setup in a local interactive Terminal.');
  else runWizard().catch(err=>{console.error('Setup stopped: '+err.message);process.exitCode=1;});
}
