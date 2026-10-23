#!/usr/bin/env node
// Local-owner-only removal of ONE Git root from the explicit project allowlist.
// No repo or .ai-bridge deletion, model calls, runtime permission changes, or MCP writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {readProjectRootsManifestSnapshot,validateProjectRootPaths}
  from '../dist/projectRootsFile.js';

const argv=process.argv.slice(2);
let run=false,preview=false,output='',target='';
for(let i=0;i<argv.length;i++){
  const a=argv[i];
  if(a==='--run')run=true;
  else if(a==='--preview')preview=true;
  else if(a==='--output'||a==='--project'){
    if(!argv[i+1]||argv[i+1].startsWith('--'))throw Error(a+' needs an absolute path');
    if(a==='--output')output=argv[++i];else target=argv[++i];
  }else throw Error('Unknown option '+a);
}
if(preview===run || !path.isAbsolute(target))
  throw Error('Use --preview OR --run with exact --project /absolute/path/to/Git.');
const configFile=output || path.join(process.env.CODEXBRIDGE_HOME?
  path.resolve(process.env.CODEXBRIDGE_HOME):path.join(os.homedir(),'.codexbridge'),
  'gpt-codex-flow','projects.json');
if(!path.isAbsolute(configFile))throw Error('Manifest path must be absolute');
const file=path.resolve(configFile);
// Recovery snapshot intentionally tolerates missing Git folders; the actual
// MCP startup remains strictly validated and fails if ANY such root remains.
const roots=readProjectRootsManifestSnapshot(file);
if(!roots.includes(target))throw Error('Project is not registered; use its exact canonical manifest path.');
const remaining=roots.filter(x=>x!==target);
const proposed={version:1,roots:validateProjectRootPaths(remaining)};
const stillUnavailable=remaining.filter(root=>{
  try {
    return !fs.statSync(root).isDirectory() || fs.realpathSync(root)!==root;
  } catch {return true;}
});
const report={
  status:'READY_FOR_LOCAL_OWNER_REVIEW',manifest:file,project_to_revoke:target,
  remaining_roots:remaining,configured_roots_before:roots,
  repository_files_modified:false,active_server_changed:false,
  owner_action_required:true,server_restart_required:true,
  remaining_missing_roots:stillUnavailable,
  requires_further_cleanup:stillUnavailable.length>0
};
if(preview){console.log(JSON.stringify({...report,preview_only:true},null,2));process.exit(0);}
if(!process.stdin.isTTY || !process.stdout.isTTY)
  throw Error('Project revocation requires an interactive local owner TTY; no changes made.');
console.log(JSON.stringify(report,null,2));
const phrase='REMOVE LOCAL PROJECT ROOT';
const rl=createInterface({input:process.stdin,output:process.stdout});
let answer='';
try{answer=(await rl.question('To revoke this root (NOT delete Git files), type '+phrase+'\n> ')).trim();}
finally{rl.close();}
if(answer!==phrase)throw Error('Owner did not approve project revocation; no changes made.');
// Fail closed if owner-reviewed manifest was changed while awaiting approval.
const current=readProjectRootsManifestSnapshot(file);
if(JSON.stringify(current)!==JSON.stringify(roots))
  throw Error('Manifest changed during approval; rerun preview.');
const dir=path.dirname(file);
const parent=fs.lstatSync(dir);
if(!parent.isDirectory()||parent.isSymbolicLink())throw Error('Unsafe config parent.');
const temp=path.join(dir,'.gcf-remove-'+randomUUID()+'.tmp');
try{
  const fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL
    |(fs.constants.O_NOFOLLOW??0),0o600);
  try{
    fs.writeFileSync(fd,JSON.stringify(proposed,null,2)+'\n');
    fs.fsyncSync(fd);
  }finally{fs.closeSync(fd);}
  // Verify again directly before replacement (advisory TOCTOU protection).
  if(JSON.stringify(readProjectRootsManifestSnapshot(file))!==JSON.stringify(roots))
    throw Error('Manifest changed before save; no replacement performed.');
  const backup=file+'.backup-'+randomUUID();
  fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup,0o600);
  console.log('Original manifest backed up: '+backup);
  fs.renameSync(temp,file);
}finally{
  try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}
}
console.log(JSON.stringify({
  status:'OWNER_APPROVED_PROJECT_REVOKED',project_removed_from_manifest:target,
  remaining_roots:remaining,repository_files_modified:false,
  server_restart_required:true,active_server_changed:false
},null,2));
