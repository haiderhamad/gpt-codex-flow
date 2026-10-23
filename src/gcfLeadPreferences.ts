import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readOwnerFolders} from './ownerProjectStore.js';
import {validateProjectRoots} from './projectRootsFile.js';
import {planOrchestration, type CodexAvailability, type OrchestratorMode} from './orchestrationOps.js';

const MODES = ['chatgpt_lead','codex_lead','auto'] as const;
const VALID_AVAILABILITY = ['unknown','available','rate_limited','context_exhausted','unavailable'] as const;
export type SavedLeadMode = OrchestratorMode;

function storePath(manifest: string) {
  if (!path.isAbsolute(manifest)) throw Error('Manifest path must be absolute');
  return path.join(path.dirname(manifest),'gcf-lead-preferences.json');
}
function readStored(manifest: string): Record<string,SavedLeadMode> {
  const file=storePath(manifest);
  const stat=fs.lstatSync(file,{throwIfNoEntry:false});
  if (!stat) return {};
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 ||
      stat.size>32_768 || (stat.mode & 0o077)!==0)
    throw Error('Lead settings file is unsafe; review it locally before continuing.');
  const fd=fs.openSync(file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW??0));
  try {
    const opened=fs.fstatSync(fd);
    if(opened.dev!==stat.dev || opened.ino!==stat.ino ||
       opened.nlink!==1 || opened.size>32_768)
      throw Error('Lead settings changed during read.');
    const parsed: unknown=JSON.parse(fs.readFileSync(fd,'utf8'));
    if (!parsed || typeof parsed!=='object' || Array.isArray(parsed)) throw Error('Invalid lead settings.');
    const data=parsed as Record<string,unknown>;
    if (data.version!==1 || !data.modes || typeof data.modes!=='object' || Array.isArray(data.modes) ||
        Object.keys(data).some(key=>key!=='version' && key!=='modes')) throw Error('Invalid lead settings schema.');
    const modes=data.modes as Record<string,unknown>;
    if(Object.keys(modes).length>100) throw Error('Too many lead settings.');
    for(const [root,mode] of Object.entries(modes)){
      if(!path.isAbsolute(root) || !MODES.includes(mode as SavedLeadMode))
        throw Error('Invalid lead settings entry.');
    }
    return modes as Record<string,SavedLeadMode>;
  } finally {fs.closeSync(fd);}
}
export function ownerLeadSnapshot(manifest: string) {
  const roots=readOwnerFolders(manifest);
  const saved=readStored(manifest);
  return roots.map(root=>({project:root,name:path.basename(root),mode:saved[root]??'auto'}));
}
/** Only the trusted owner-local Control Center can call this from its guarded routes. */
export function saveOwnerProjectLead(manifest: string, project: string, mode: string, expected: string) {
  if (!MODES.includes(mode as SavedLeadMode) || !MODES.includes(expected as SavedLeadMode))
    throw Error('Choose ChatGPT Lead, Codex Lead, or Auto.');
  const roots=readOwnerFolders(manifest);
  if(typeof project!=='string' || !roots.includes(project)) throw Error('Project not approved.');
  validateProjectRoots([project]);
  const saved=readStored(manifest);
  const previous=saved[project]??'auto';
  if(previous!==expected) throw Error('Lead preference changed. Reload before saving.');
  const modes=Object.fromEntries(Object.entries(saved).filter(([root])=>roots.includes(root))) as Record<string,SavedLeadMode>;
  modes[project]=mode as SavedLeadMode;
  const file=storePath(manifest);
  const dir=path.dirname(file);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const parent=fs.lstatSync(dir);
  if(!parent.isDirectory() || parent.isSymbolicLink()) throw Error('Owner settings directory is unsafe.');
  const temp=path.join(dir,'.gcf-lead-'+randomUUID()+'.tmp');
  try {
    const fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW??0),0o600);
    try {
      fs.writeFileSync(fd,JSON.stringify({version:1,modes},null,2)+'\n');
      fs.fsyncSync(fd);
    } finally {fs.closeSync(fd);}
    if(JSON.stringify(readStored(manifest))!==JSON.stringify(saved)) throw Error('Lead settings changed. Reload and try again.');
    fs.renameSync(temp,file);
  } finally {try {fs.unlinkSync(temp);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  return {project,mode,saved:true,clientSessionStarted:false,executionStarted:false};
}

export function previewProjectTaskRouting(manifest: string, project: string, goal: string, availability: CodexAvailability='unknown') {
  const entry=ownerLeadSnapshot(manifest).find(item=>item.project===project);
  if(!entry) throw Error('Project not approved.');
  if(!VALID_AVAILABILITY.includes(availability)) throw Error('Invalid Codex availability.');
  const plan=planOrchestration(goal,entry.mode,{codex_availability:availability});
  const hasChatgptSignals=plan.matched_signals.chatgpt.length>0;
  const hasCodexSignals=plan.matched_signals.codex.length>0;
  const codexBlocked=['rate_limited','context_exhausted','unavailable'].includes(availability);
  const lead=plan.proposed_mode;
  const codingAssignee=codexBlocked?'chatgpt':entry.mode==='chatgpt_lead'?'chatgpt':'codex';
  const steps: Array<{stage:string;assignee:'chatgpt'|'codex';reason:string}>=[];
  if(hasChatgptSignals || !hasCodexSignals){
    steps.push({stage:'Scope and plan',assignee:entry.mode==='codex_lead'?'codex':'chatgpt',
      reason:lead==='codex_lead'?'Codex is the owner-selected coordinator.':'ChatGPT handles analysis and planning.'});
  }
  if(hasCodexSignals){
    steps.push({stage:'Implement and test',assignee:codingAssignee,
      reason:codexBlocked?'Codex reported unavailable; ChatGPT can code only with its own approved edit/test access.':
        codingAssignee==='chatgpt'?'Keep implementation with the ChatGPT coordinator; optional Codex handoff needs owner approval.':
        'Codex is suggested for scoped local code changes and tests.'});
  }
  if(hasChatgptSignals && hasCodexSignals){
    steps.push({stage:'Review and verify',assignee:'chatgpt',
      reason:'Check scoped changes, test receipts and handoff notes before marking work complete.'});
  }
  return {project,mode:entry.mode,goal,availability,proposed_lead:lead,
    recommendation_reason:plan.recommendation_reason,
    steps,previewOnly:true,executionStarted:false,clientSessionStarted:false,
    taskCreated:false,permissionChanged:false,requiresOwnerApprovedExecution:true,
    note:'Advisory plan only. This does not invoke models or grant file/shell permissions.'};
}
