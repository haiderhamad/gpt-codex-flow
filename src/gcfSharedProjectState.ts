import fs from 'node:fs';
import path from 'node:path';
import type {CodexBridgeConfig} from './config.js';
import type {Workspace} from './guard.js';
import {hasGitWorkingTree,gitStatus} from './gitOps.js';

/**
 * Read-only continuity facts for either ChatGPT or Codex using the SAME approved
 * workspace. Facts from files are recorded claims, not model attestations.
 * No file is created, no process is launched by this module, and no handoff
 * approval, identity, or completed verification is inferred.
 */
const taskId=/^task_[0-9a-f-]{8,80}$/;
const maxTask=24_000,maxJournal=512_000;
const iso=(x:unknown):x is string=>typeof x==='string'&&Number.isFinite(Date.parse(x));
type Obj=Record<string,unknown>;
function record(value:unknown):Obj {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid saved project-state record.');
  return value as Obj;
}
function context(config:CodexBridgeConfig,workspace:Workspace):string {
  const parts=config.contextDir.split('/');
  if(!config.contextDir||path.isAbsolute(config.contextDir)||parts.some(x=>!x||x==='..'||x==='.')||
      parts.some(x=>x.includes('\\')||x.includes('\0')))
    throw Error('Unsafe project context directory.');
  let current=workspace.root;
  for(const part of parts){
    const next=path.join(current,part);
    const s=fs.lstatSync(next,{throwIfNoEntry:false});
    if(!s)return path.join(workspace.root,config.contextDir);
    if(!s.isDirectory()||s.isSymbolicLink())throw Error('Unsafe project context directory.');
    current=next;
  }
  return current;
}
function folder(parent:string,name:string):string|null {
  const dest=path.join(parent,name);
  const stat=fs.lstatSync(dest,{throwIfNoEntry:false});
  if(!stat)return null;
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unsafe project-state subdirectory.');
  return dest;
}
function safeRead(parent:string,name:string,limit:number):{content:string;modified:string}|null {
  if(name.includes('/')||name.includes('\\')||name==='.'||name==='..')throw Error('Unsafe record name.');
  const file=path.join(parent,name),s=fs.lstatSync(file,{throwIfNoEntry:false});
  if(!s)return null;
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>limit)throw Error('Unsafe project-state file.');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try{
    const after=fs.fstatSync(fd);
    if(!after.isFile()||after.nlink!==1||s.ino!==after.ino||s.dev!==after.dev||
       after.size>limit||after.size!==s.size)throw Error('Project-state file changed during read.');
    return {content:fs.readFileSync(fd,'utf8'),modified:after.mtime.toISOString()};
  }finally{fs.closeSync(fd);}
}
function readTask(value:string,source:string) {
  const t=record(JSON.parse(value));
  if(t.schema_version!==1||!taskId.test(String(t.task_id))||
     typeof t.goal!=='string'||!t.goal.trim()||t.goal.length>2000||
     !['in_progress','complete','abandoned'].includes(String(t.status))||
     !Array.isArray(t.plan_steps)||t.plan_steps.length>100||t.plan_steps.some(x=>typeof x!=='string'||x.length>1500)||
     !Array.isArray(t.target_paths)||t.target_paths.length>100||
     t.target_paths.some(x=>typeof x!=='string'||x.length>500)||
     !iso(t.created_at)||!iso(t.updated_at))throw Error('Invalid saved GCF task.');
  return {task_id:t.task_id as string,goal:t.goal as string,
    reported_status:t.status as string,created_at:t.created_at as string,
    updated_at:t.updated_at as string,
    planned_steps:(t.plan_steps as string[]).slice(0,12),
    target_paths:(t.target_paths as string[]).slice(0,25),
    source,progress_verified:false};
}
function savedTask(ctx:string) {
  const current=safeRead(ctx,'current-task.json',maxTask);
  if(current){
    const t=readTask(current.content,'current-task.json');
    if(t.reported_status==='in_progress')return {...t,file_modified_at:current.modified};
  }
  const dir=folder(ctx,'tasks');
  if(!dir)return null;
  const names=fs.readdirSync(dir);
  if(names.length>300)throw Error('Project task archive exceeds bounded read limit.');
  const candidates=names.filter(n=>n.endsWith('.json')&&taskId.test(n.slice(0,-5)));
  if(names.length!==candidates.length)throw Error('Unexpected task archive entry.');
  const sorted=candidates.map(n=>({name:n,modified:fs.lstatSync(path.join(dir,n)).mtimeMs}))
    .sort((a,b)=>b.modified-a.modified).slice(0,1);
  if(!sorted.length)return null;
  const last=safeRead(dir,sorted[0].name,maxTask);
  if(!last)return null;
  const task=readTask(last.content,'tasks/'+sorted[0].name);
  if(task.task_id+'.json'!==sorted[0].name)throw Error('Archived task ID does not match filename.');
  return {...task,file_modified_at:last.modified};
}
function events(ctx:string) {
  const file=safeRead(ctx,'operation-journal.jsonl',maxJournal);
  if(!file)return {latest:null as null|{event:string;status:string;ts:string},count:0,source:null as string|null};
  const lines=file.content.split(/\r?\n/).filter(Boolean);
  if(lines.length>2500)throw Error('Project journal exceeds bounded event limit.');
  const parsed:Array<{event:string;status:string;ts:string}>=[];
  for(const line of lines){
    const v=record(JSON.parse(line));
    if(typeof v.event!=='string'||v.event.length>80||
       !['ok','error'].includes(String(v.status))||!iso(v.ts))
      throw Error('Invalid project journal entry.');
    // Exclude command output, free-form errors and secrets.
    parsed.push({event:v.event,status:v.status as string,ts:v.ts});
  }
  return {latest:parsed.at(-1)??null,count:parsed.length,source:'operation-journal.jsonl'};
}
export function readSharedProjectState(config:CodexBridgeConfig,workspace:Workspace) {
  if(!config.allowedRoots.some(root=>workspace.root===root))
    throw Error('Shared state requires an exact approved project root.');
  if(fs.realpathSync(workspace.root)!==workspace.root)
    throw Error('Approved project root identity changed.');
  const inspectedAt=new Date().toISOString();
  const ctx=context(config,workspace);
  const available=fs.existsSync(ctx);
  const task=available?savedTask(ctx):null;
  const journal=available?events(ctx):{latest:null,count:0,source:null};
  const rawCheckpoint=available?safeRead(ctx,'continuity-checkpoint.json',4096):null;
  let checkpoint:null|{observed_at:string;observed_operation:string;observed_result:string;evidence:string;verified_completion:false}=null;
  if(rawCheckpoint){
    const v=record(JSON.parse(rawCheckpoint.content));
    if(v.schema_version!==1||!iso(v.observed_at)||typeof v.observed_operation!=='string'||
      !['ok','error'].includes(String(v.observed_result))||v.evidence!=='gcf_operation_journal')
      throw Error('Invalid continuity checkpoint.');
    checkpoint={observed_at:v.observed_at,observed_operation:v.observed_operation,
      observed_result:v.observed_result as string,evidence:'gcf_operation_journal',verified_completion:false};
  }
  const gitAvailable=hasGitWorkingTree(workspace);
  const rawGit=gitAvailable?gitStatus(config,workspace):'Git unavailable for this folder.';
  const lines=rawGit.split(/\r?\n/);
  const changed=gitAvailable?lines.filter(l=>l.trim()&&!l.startsWith('##')&&l!=='(no output)'):[];
  const stateTimestamp=checkpoint?.observed_at??task?.updated_at??journal.latest?.ts??null;
  const ageMs=stateTimestamp?Math.max(0,Date.now()-Date.parse(stateTimestamp)):null;
  return {
    schema_version:1,project:{name:path.basename(workspace.root),workspace_id:workspace.id,root:workspace.root},
    inspected_at:inspectedAt,context_available:available,
    task,git:{available:gitAvailable,dirty:gitAvailable?changed.length>0:null,
      changed_count:changed.length,changed_paths_preview:changed.slice(0,25).map(x=>x.slice(0,220)),
      inspected_at:inspectedAt,source:'live_git_status',verification:'filesystem_evidence_not_test_results'},
    operation_journal:journal,observed_checkpoint:checkpoint,
    continuity:{last_recorded_update:stateTimestamp,age_ms:ageMs,
      freshness:ageMs===null?'unknown':ageMs>24*60*60*1000?'stale':'recent',
      last_checkpoint_verified:false,completed_work_verified:false,
      tests_verified:false,recorded_plan_is_not_completion:true,
      next_steps:task?.planned_steps??[],
      next_steps_are_unverified_plan:true,
      assistant_identity_verified:false,automatic_cross_client_capture:false,
      note:'Inspect actual files and tests before continuing. Journal and task entries are historical claims, not proof that another model executed work.'},
    read_only:true,no_process_started:true,no_permissions_granted:true
  };
}
