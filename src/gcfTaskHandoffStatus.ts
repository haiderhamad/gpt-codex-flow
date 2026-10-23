import fs from 'node:fs';
import path from 'node:path';
import {readOwnerFolders} from './ownerProjectStore.js';
import {validateProjectRoots} from './projectRootsFile.js';
import {previewProjectTaskRouting} from './gcfLeadPreferences.js';

/**
 * Read-only owner view of existing GCF task, inbox and transfer artifacts.
 * No actor role, approval, worker status or model identity is inferred from JSON claims.
 * File writes/execution remain the responsibility of existing gated MCP tools.
 */
const TASK_ID=/^task_[0-9a-f-]{8,80}$/;
const MESSAGE_ID=/^inbox_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROLE=['chatgpt_lead','codex_lead'];
function directory(root:string,part:string): string|null {
  const target=path.join(root,part);
  const stat=fs.lstatSync(target,{throwIfNoEntry:false});
  if(!stat)return null;
  if(!stat.isDirectory() || stat.isSymbolicLink())throw Error('Unsafe GCF task directory.');
  return target;
}
function safeJson(root:string,part:string,maxBytes:number):unknown|null {
  const fragments=part.split('/');
  if(fragments.some(p=>!p || p==='.' || p==='..'))throw Error('Invalid task artifact path.');
  let dir=root;
  for(const segment of fragments.slice(0,-1)){
    const found=directory(dir,segment);
    if(!found)return null;
    dir=found;
  }
  const file=path.join(dir,fragments[fragments.length-1]);
  const before=fs.lstatSync(file,{throwIfNoEntry:false});
  if(!before)return null;
  if(!before.isFile() || before.isSymbolicLink() || before.nlink!==1 || before.size>maxBytes)
    throw Error('Unsafe or oversized GCF task artifact.');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try{
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.ino!==before.ino||stat.dev!==before.dev||stat.size>maxBytes)
      throw Error('GCF task artifact changed during read.');
    return JSON.parse(fs.readFileSync(fd,'utf8'));
  }finally{fs.closeSync(fd);}
}
function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Corrupt GCF task metadata.');
  return value as Record<string,unknown>;
}
function isRole(value:unknown):value is 'chatgpt_lead'|'codex_lead' {
  return typeof value==='string'&&ROLE.includes(value);
}
function inbox(root:string,taskId:string) {
  const bridge=directory(root,'.ai-bridge');
  const dir=bridge?directory(bridge,'task-inbox'):null;
  if(!dir)return [];
  const names=fs.readdirSync(dir);
  if(names.length>41)throw Error('Task Inbox exceeds its supported capacity.');
  const messages:Array<{id:string;from:string;to:string;title:string;state:string;created_at:string}>=[];
  for(const name of names){
    if(name==='.post.lock')continue;
    if(!name.endsWith('.json')||!MESSAGE_ID.test(name.slice(0,-5)))throw Error('Unexpected Task Inbox entry.');
    const v=object(safeJson(root,'.ai-bridge/task-inbox/'+name,6500));
    const id=name.slice(0,-5);
    if(v.schema_version!==1||v.id!==id||!TASK_ID.test(String(v.task_id??''))||
       !isRole(v.from)||!isRole(v.to)||v.from===v.to||
       v.state!=='pending'||typeof v.title!=='string'||!v.title.trim()||
       v.title.length>120||typeof v.created_at!=='string'||!Number.isFinite(Date.parse(v.created_at))||
       typeof v.request!=='string'||!v.request.trim()||v.request.length>2400)
      throw Error('Corrupt Task Inbox entry.');
    if(v.task_id===taskId)messages.push({id,from:v.from,to:v.to,title:v.title,state:'pending',created_at:v.created_at});
  }
  messages.sort((a,b)=>b.created_at.localeCompare(a.created_at));
  return messages;
}
export function inspectOwnerProjectHandoff(manifest:string,project:string) {
  if(typeof project!=='string'||!readOwnerFolders(manifest).includes(project))
    throw Error('Project not approved.');
  validateProjectRoots([project]);
  const base={project,read_only:true,auto_execution:false,client_identity_verified:false,ownership_enforced:false};
  const data=safeJson(project,'.ai-bridge/current-task.json',16000);
  if(data===null)return {...base,active_task:null,handoff:null,inbox:[],stages:[],status:'no_active_task'};
  const task=object(data);
  if(task.schema_version!==1||!TASK_ID.test(String(task.task_id??''))||
     typeof task.goal!=='string'||!task.goal.trim()||task.goal.length>2000||
     !['in_progress','complete','abandoned'].includes(String(task.status))||
     !Array.isArray(task.plan_steps)||!Array.isArray(task.target_paths)||
     typeof task.created_at!=='string'||!Number.isFinite(Date.parse(task.created_at)))
    throw Error('Corrupt current task record.');
  if(task.status!=='in_progress')return {...base,active_task:null,handoff:null,inbox:[],stages:[],status:'no_active_task'};
  const taskId=task.task_id as string;
  const messages=inbox(project,taskId);
  const transferData=safeJson(project,'.ai-bridge/transfer-control.json',30000);
  let transfer:null|{id:string;from:string;to:string;state:string;expires_at:string;expired:boolean}=null;
  if(transferData!==null){
    const t=object(transferData);
    if(typeof t.task_id!=='string'||!TASK_ID.test(t.task_id)||typeof t.id!=='string'||
       !/^transfer_[0-9a-f-]{12,80}$/.test(t.id)||!isRole(t.from)||!isRole(t.to)||t.from===t.to||
       !['requested','accepted','cancelled'].includes(String(t.state))||
       typeof t.expires_at!=='string'||!Number.isFinite(Date.parse(t.expires_at)))
      throw Error('Corrupt Transfer Control metadata.');
    if(t.task_id===taskId)transfer={id:t.id,from:t.from,to:t.to,state:t.state as string,
      expires_at:t.expires_at,expired:Date.now()>=Date.parse(t.expires_at)};
  }
  const route=previewProjectTaskRouting(manifest,project,task.goal);
  const stages=route.steps.map((step,i)=>{
    const role=step.assignee==='codex'?'codex_lead':'chatgpt_lead';
    return {index:i+1,stage:step.stage,suggested_assignee:step.assignee,
      matching_inbox_ids:messages.filter(m=>m.to===role).map(m=>m.id),
      matching_transfer_id:transfer?.to===role?transfer.id:null,
      status:'suggested_only'};
  });
  return {...base,status:'active_task_found',active_task:{task_id:taskId,goal:task.goal,
    created_at:task.created_at,reported_status:'in_progress'},lead_mode:route.mode,
    proposed_lead:route.proposed_lead,inbox:messages,handoff:transfer,stages,
    note:'Task, inbox and transfer links are read-only advisory state, not authenticated assignments or completed execution.'};
}
