#!/usr/bin/env node
// Local-owner-only project root onboarding. No MCP write, no model calls,
// no execution of project code, and NO automatic permission changes at runtime.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import {makeProjectRootsManifest,readProjectRootsManifest,readProjectRootsManifestSnapshot}
  from '../dist/projectRootsFile.js';

function usage() {
  return `GPT Codex Flow — project roots onboarding (local owner only)
Usage:
  node scripts/gcf-projects-onboard.mjs --preview --project /absolute/path/to/repo [--project ...]
  node scripts/gcf-projects-onboard.mjs --run --project /absolute/path/to/repo [--project ...]
Optional:
  --output /absolute/path/to/projects.json   Custom local config path.
Existing roots are preserved by default. --replace-missing is an explicit,
owner-confirmed recovery option for vanished Git paths; it backs up the original
manifest before replacing missing entries. No Git folders are deleted.
--run requires local interactive typed approval and does not start MCP.`;
}
const args=process.argv.slice(2);
let run=false,preview=false,replaceMissing=false,output='',paths=[];
for(let i=0;i<args.length;i++) {
  const arg=args[i];
  if(arg==='--preview') preview=true;
  else if(arg==='--replace-missing') replaceMissing=true;
  else if(arg==='--run') run=true;
  else if(arg==='--project') {
    if(!args[i+1]||args[i+1].startsWith('--')) throw Error('--project requires a path');
    paths.push(args[++i]);
  } else if(arg==='--output') {
    if(!args[i+1]||args[i+1].startsWith('--')) throw Error('--output requires absolute path');
    output=args[++i];
  } else if(arg==='--help') {console.log(usage());process.exit(0);}
  else throw Error('Unknown argument: '+arg+'\n'+usage());
}
if(run===preview || paths.length<1) throw Error('Choose --preview OR --run and at least one --project.\n'+usage());
const base=process.env.CODEXBRIDGE_HOME ?
  path.resolve(process.env.CODEXBRIDGE_HOME):path.join(os.homedir(),'.codexbridge');
const target=output || path.join(base,'gpt-codex-flow','projects.json');
if(!path.isAbsolute(target)) throw Error('--output must be absolute');
const configFile=path.resolve(target);
const existing=fs.lstatSync(configFile,{throwIfNoEntry:false})
  ? (replaceMissing?readProjectRootsManifestSnapshot(configFile):readProjectRootsManifest(configFile)) : [];
// Recovery may revoke ONLY currently absent paths. Existing but invalid folders
// are not silently removed or made valid by a new project selection.
const missing=replaceMissing?existing.filter(root=>!fs.existsSync(root)):[];
if(replaceMissing && missing.length===0)
  throw Error('No missing roots to repair. Use ordinary setup without --replace-missing.');
const retained=existing.filter(root=>!missing.includes(root));
const canonicalInput=paths.map(p=>{
  if(!path.isAbsolute(p)) throw Error('Project root must be absolute: '+p);
  return fs.realpathSync(path.resolve(p));
});
const manifest=makeProjectRootsManifest([...retained,...canonicalInput.filter(p=>!retained.includes(p))]);
const additions=manifest.roots.filter(p=>!existing.includes(p));
const report={
  status:'READY_FOR_LOCAL_OWNER_REVIEW',
  config_file:configFile, existing_roots:existing, added_roots:additions,
  missing_roots_to_revoke:missing, recovery_requested:replaceMissing,
  final_roots:manifest.roots, total_projects:manifest.roots.length,
  owner_action_required:true, runtime_permissions_changed:false,
  repo_files_modified:false, mcp_connection_started:false,
  next_command:'node dist/stdio.js --project-roots-file '+JSON.stringify(configFile)+
    ' --tool-mode standard --write off --bash off'
};
if(preview) {console.log(JSON.stringify({...report,preview_only:true},null,2));process.exit(0);}
if(!process.stdin.isTTY||!process.stdout.isTTY) throw Error('--run requires local interactive TTY owner approval.');
if(additions.length===0 && missing.length===0) throw Error('No changes to save; unchanged project manifest.');
console.log(JSON.stringify(report,null,2));
const phrase=replaceMissing?'REPLACE MISSING PROJECT ROOTS':'SAVE LOCAL PROJECT ROOTS';
const rl=createInterface({input:process.stdin,output:process.stdout});
let accepted='';
try { accepted=(await rl.question('To save exactly these authorized paths type: '+phrase+'\n> ')).trim(); }
finally {rl.close();}
if(accepted!==phrase) throw Error('No owner approval: no configuration written.');
const dir=path.dirname(configFile);
fs.mkdirSync(dir,{recursive:true,mode:0o700});
const parent=fs.lstatSync(dir);
if(!parent.isDirectory()||parent.isSymbolicLink()) throw Error('Unsafe config parent directory.');
if(fs.existsSync(configFile)) {
  const check=replaceMissing?readProjectRootsManifestSnapshot(configFile):readProjectRootsManifest(configFile);
  if(JSON.stringify(check)!==JSON.stringify(existing)) throw Error('Projects changed during approval; retry setup.');
}
const temp=path.join(dir,'.gcf-projects-'+randomUUID()+'.tmp');
if(fs.existsSync(configFile)){
  // Keep the original owner configuration before changing the allowlist.
  const backup=configFile+'.backup-'+randomUUID();
  fs.copyFileSync(configFile,backup,fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup,0o600);
  console.log('Original manifest backed up: '+backup);
}
try {
  const descriptor=fs.openSync(temp,'wx',0o600);
  try {
    fs.writeFileSync(descriptor,JSON.stringify(manifest,null,2)+'\n');
    fs.fsyncSync(descriptor);
  } finally {fs.closeSync(descriptor);}
  fs.renameSync(temp,configFile);
} finally {try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
console.log(JSON.stringify({
  status:'SAVED_OWNER_APPROVED',config_file:configFile,
  root_count:manifest.roots.length,
  server_restart_required:true, runtime_permissions_changed:false,
  mcp_connection_started:false,next_command:report.next_command
},null,2));
