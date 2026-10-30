/** Private, owner-local Codex runtime preferences. Never exposed for MCP writes or execution. */
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readOwnerFolders} from './ownerProjectStore.js';
import {validateProjectRoots} from './projectRootsFile.js';

export type CodexProjectEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh';
export type CodexProjectExecution = {model:string|null; effort:CodexProjectEffort};
export const DEFAULT_CODEX_EXECUTION: Readonly<CodexProjectExecution> = Object.freeze({model:null,effort:'auto'});
const EFFORTS = new Set<string>(['auto','low','medium','high','xhigh']);
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

function validateChoice(value:unknown):CodexProjectExecution {
  if(!value || typeof value!=='object' || Array.isArray(value) ||
    Object.keys(value).sort().join(',')!=='effort,model')
    throw Error('Invalid Codex model/effort selection.');
  const v=value as Record<string,unknown>;
  if(v.model!==null && (typeof v.model!=='string' || !MODEL.test(v.model)))
    throw Error('Invalid bounded Codex model identifier.');
  if(typeof v.effort!=='string'||!EFFORTS.has(v.effort))
    throw Error('Unsupported Codex reasoning effort.');
  return {model:v.model as string|null,effort:v.effort as CodexProjectEffort};
}

function configPath(manifest:string) {
  if(!path.isAbsolute(manifest))throw Error('Owner manifest must be absolute.');
  return path.join(path.dirname(manifest),'gcf-codex-execution-preferences.json');
}
export function readOwnerCodexExecutionPreferences(manifest:string):Record<string,CodexProjectExecution> {
  const filename=configPath(manifest);
  const stat=fs.lstatSync(filename,{throwIfNoEntry:false});
  if(!stat)return {};
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>32_768||
    (stat.mode&0o077)!==0)throw Error('Unsafe owner Codex configuration; review locally.');
  const fd=fs.openSync(filename,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try {
    const check=fs.fstatSync(fd);
    if(check.dev!==stat.dev||check.ino!==stat.ino||check.nlink!==1||check.size>32_768)
      throw Error('Owner Codex configuration changed while reading.');
    const source:unknown=JSON.parse(fs.readFileSync(fd,'utf8'));
    if(!source||typeof source!=='object'||Array.isArray(source))throw Error('Invalid owner Codex settings.');
    const data=source as Record<string,unknown>;
    if(data.version!==1||!data.projects||typeof data.projects!=='object'||
      Array.isArray(data.projects)||Object.keys(data).sort().join(',')!=='projects,version')
      throw Error('Invalid owner Codex settings schema.');
    const projects=data.projects as Record<string,unknown>;
    if(Object.keys(projects).length>100)throw Error('Too many owner Codex settings.');
    const result:Record<string,CodexProjectExecution>={};
    for(const [root,config] of Object.entries(projects)){
      if(!path.isAbsolute(root))throw Error('Owner Codex project path is not absolute.');
      result[root]=validateChoice(config);
    }
    return result;
  } finally{fs.closeSync(fd);}
}

/** Only called from authenticated owner-local routes; same file invariants as saved Lead. */
export function saveOwnerCodexExecutionPreferences(
  manifest:string,project:string,model:unknown,effort:unknown,
  expectedModel:unknown,expectedEffort:unknown
) {
  const requested=validateChoice({model,effort});
  const expected=validateChoice({model:expectedModel,effort:expectedEffort});
  const roots=readOwnerFolders(manifest);
  if(typeof project!=='string'||!roots.includes(project))throw Error('Project not approved.');
  validateProjectRoots([project]);
  const stored=readOwnerCodexExecutionPreferences(manifest);
  const previous=stored[project]??DEFAULT_CODEX_EXECUTION;
  if(previous.model!==expected.model||previous.effort!==expected.effort)
    throw Error('Codex settings changed. Reload before saving.');
  const projects=Object.fromEntries(Object.entries(stored).filter(([root])=>roots.includes(root)));
  projects[project]=requested;
  const filename=configPath(manifest),dir=path.dirname(filename);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const parent=fs.lstatSync(dir);
  if(!parent.isDirectory()||parent.isSymbolicLink())
    throw Error('Owner Codex settings directory is unsafe.');
  const temp=path.join(dir,'.gcf-codex-exec-'+randomUUID()+'.tmp');
  try {
    const fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW??0),0o600);
    try {fs.writeFileSync(fd,JSON.stringify({version:1,projects},null,2)+'\n');fs.fsyncSync(fd);}
    finally{fs.closeSync(fd);}
    if(JSON.stringify(readOwnerCodexExecutionPreferences(manifest))!==JSON.stringify(stored))
      throw Error('Owner Codex settings changed during save.');
    fs.renameSync(temp,filename);
  } finally{try{fs.unlinkSync(temp);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  return {project,model:requested.model,effort:requested.effort,saved:true,
    executionStarted:false,modelApplied:false,reasoningApplied:false,
    scope:'owner_local_codex_runner_only'};
}
