import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {CodexBridgeConfig} from './config.js';
import type {Workspace} from './guard.js';
import {PathGuard} from './guard.js';
import {assertInboxGitPrivacy} from './inboxGitPrivacy.js';
import type {JournalEvent} from './journal.js';

/**
 * Local observed-operation checkpoint. Best-effort sibling to the existing
 * journal: never authorizes execution and never stores commands, output,
 * prompts, model identity, secrets or full file contents.
 */
const events=new Set(['write','edit','apply_change_set','task_verify','bash',
  'request_transfer','accept_transfer','cancel_transfer','ssh_exec']);
export function persistObservedCheckpoint(config:CodexBridgeConfig,guard:PathGuard,workspace:Workspace,event:JournalEvent):boolean {
  if(config.writeMode==='off'||event.status!=='ok'||!events.has(event.event))return false;
  if(!config.allowedRoots.some(root=>root===workspace.root))return false;
  // GCF metadata must remain private from normal Git commits; never fix ignore rules automatically.
  assertInboxGitPrivacy(workspace.root);
  const resolved=guard.resolve(workspace,`${config.contextDir}/continuity-checkpoint.json`,{forWrite:true});
  const parent=path.dirname(resolved.absPath);
  const dir=fs.lstatSync(parent);
  if(!dir.isDirectory()||dir.isSymbolicLink())throw Error('Unsafe checkpoint directory.');
  const prior=fs.lstatSync(resolved.absPath,{throwIfNoEntry:false});
  if(prior&&(!prior.isFile()||prior.isSymbolicLink()||prior.nlink!==1))
    throw Error('Unsafe existing checkpoint.');
  const payload={
    schema_version:1,
    observed_at:new Date().toISOString(),
    journal_timestamp:event.ts,
    operation_id:event.operation_id,
    observed_operation:event.event,
    observed_result:event.status,
    affected_paths_count:Math.min(event.paths?.length??0,100),
    evidence:'gcf_operation_journal',
    command_or_output_stored:false,
    client_identity_verified:false,
    cross_client_capture:false,
    completed_task_verified:false
  };
  const temp=path.join(parent,`.gcf-checkpoint-${randomUUID()}.tmp`);
  try {
    const fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_EXCL|fs.constants.O_CREAT|(fs.constants.O_NOFOLLOW??0),0o600);
    try {
      fs.writeFileSync(fd,JSON.stringify(payload,null,2)+'\n','utf8');
      fs.fsyncSync(fd);
    }finally{fs.closeSync(fd);}
    fs.renameSync(temp,resolved.absPath);
    return true;
  }finally{
    try{fs.unlinkSync(temp);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  }
}
