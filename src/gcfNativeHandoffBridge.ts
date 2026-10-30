import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import {inspectOwnerProjectHandoff} from './gcfTaskHandoffStatus.js';
import {readOwnerCodexExecutionPreferences,DEFAULT_CODEX_EXECUTION} from './gcfCodexExecutionPreferences.js';
const exec=promisify(execFile);
const UUID=/^transfer_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
/** Builds the exact explicit owner-reviewed command, never runs Codex. */
export function ownerCodexHandoffCommand(manifest:string,project:string) {
  const stored=readOwnerCodexExecutionPreferences(manifest);
  const configured=stored[project]??DEFAULT_CODEX_EXECUTION;
  const flags=(configured.model?' --model '+quote(configured.model):'')+
    (configured.effort!=='auto'?' --effort '+quote(configured.effort):'');
  return {command:'npm run gcf:handoff-run -- --worktree '+quote(project)+flags+' --run --return-to-inbox',
    model:configured.model,effort:configured.effort};
}
/**
 * Owner-local ONLY. Bridges a previously accepted task transfer to the existing
 * native Codex runner's non-executing --preview. Does not accept arbitrary
 * CLI commands, run Codex, grant permissions, or bypass Terminal consent.
 */
export async function previewOwnerCodexHandoff(manifest:string, project:string, sourceRoot:string) {
  const summary=inspectOwnerProjectHandoff(manifest,project);
  if(summary.status!=='active_task_found'||!summary.active_task)
    throw Error('Start and accept a valid task handoff before preparing Codex.');
  const handoff=summary.handoff;
  if(!handoff || handoff.from!=='chatgpt_lead'||handoff.to!=='codex_lead'||
      handoff.state!=='accepted'||handoff.expired||!UUID.test(handoff.id))
    throw Error('An accepted, unexpired ChatGPT-to-Codex transfer is required.');
  if(!path.isAbsolute(sourceRoot))throw Error('Invalid local GCF source location.');
  const script=path.resolve(sourceRoot,'scripts','gcf-native-transfer-run.mjs');
  const realRoot=fs.realpathSync(sourceRoot);
  if(!script.startsWith(realRoot+path.sep)||!fs.statSync(script).isFile()||fs.realpathSync(script)!==script)
    throw Error('Trusted GCF handoff runner not found.');
  let raw:string;
  try {
    const result=await exec(process.execPath,[script,'--worktree',project,'--preview'],{
      cwd:realRoot,timeout:20000,maxBuffer:60000,windowsHide:true,shell:false,
      env:{...process.env,GCF_LOG_TOOL_CALLS:'0'}
    });
    raw=result.stdout;
  } catch {
    throw Error('Codex handoff preview refused. Check accepted transfer, clean Git worktree and Codex installation.');
  }
  let preview:Record<string,unknown>;
  try{preview=JSON.parse(raw);}catch{throw Error('Invalid local Codex handoff preview.');}
  const allowed=preview.allowed_paths;
  if(preview.status!=='READY_FOR_OWNER_REVIEW'||preview.transfer_id!==handoff.id||
     preview.task_id!==summary.active_task.task_id||preview.codex_invoked!==false||
     preview.full_access_requested!==false||preview.owner_action_required!==true||
     preview.broker_authorized!==false||!Array.isArray(allowed)||
     !allowed.every(a=>typeof a==='string'&&a.length>0))
    throw Error('Codex handoff failed local safety checks.');
  // Owner-selected per-project preferences are passed as reviewed CLI flags.
  // This never executes Codex. The runner itself ignores global Codex user config.
  const {command,model,effort}=ownerCodexHandoffCommand(manifest,project);
  return {
    project,task_id:summary.active_task.task_id,transfer_id:handoff.id,
    allowed_paths:allowed as string[],
    status:'OWNER_TERMINAL_CONSENT_REQUIRED' as const,
    owner_terminal_command:command,
    requested_model:model,requested_reasoning_effort:effort,
    model_selection_source:model?'saved_owner_project':'runner_default',
    reasoning_selection_source:effort==='auto'?'runner_default':'saved_owner_project',
    codex_user_config_loaded:false,model_applied:false,reasoning_applied:false,
    instructions:'Open Terminal yourself in the GPT Codex Flow source folder, review the exact target and command, and type the required consent phrase. The browser cannot execute this task.',
    preview_only:true,model_called:false,owner_action_required:true,
    exec_started:false,auto_execution:false,full_access:false,
    postflight_verified:false,return_receipt_posted:false
  };
}
