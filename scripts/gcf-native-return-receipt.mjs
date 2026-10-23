// Owner-reviewed, advisory result delivery after a bounded local Codex handoff.
// Does NOT authenticate Codex, grant execution authority, or run a model.
// The local owner launch covers the requested bounded Inbox publication.
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inboxId = /^inbox_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = text => createHash('sha256').update(text).digest('hex');

export function composeOwnerReturnReceipt(result, {inReplyTo} = {}) {
  if (!result || result.status !== 'CODEX_PROCESS_EXITED_REVIEW_REQUIRED' ||
      result.codex_invoked !== true || result.postflight_passed !== true ||
      result.exit_code !== 0 || result.timed_out || result.termination_reason ||
      result.tests_run !== false || result.merged !== false ||
      !/^task_[0-9a-f-]{8,80}$/.test(result.task_id ?? '') ||
      !/^transfer_[0-9a-f-]{36}$/.test(result.transfer_id ?? '') ||
      !/^[a-f0-9]{64}$/.test(result.plan_sha256 ?? '') ||
      !Array.isArray(result.changed_paths) || !result.changed_paths.length ||
      result.changed_paths.length > 25 ||
      !Array.isArray(result.allowed_paths) ||
      result.changed_paths.some(p => !result.allowed_paths.includes(p)) ||
      new Set(result.changed_paths).size !== result.changed_paths.length)
    throw new Error('A successful bounded native postflight is required before preparing a return note.');
  if (inReplyTo !== undefined && !inboxId.test(inReplyTo))
    throw new Error('Invalid exact Task Inbox parent note ID.');
  const payload = [
    'Local owner-attended Codex handoff result (ADVISORY, not model-authenticated).',
    'Task: ' + result.task_id,
    'Transfer: ' + result.transfer_id,
    'Plan SHA-256: ' + result.plan_sha256,
    'Codex CLI exit code: 0; bounded postflight: PASS; review required.',
    'Changed paths: ' + result.changed_paths.join(', '),
    'Tests run: NO. Merge/push: NO. Model identity and sandbox isolation: NOT VERIFIED.',
    'Inspect actual Git diff and run trusted tests before accepting any code.'
  ].join('\n');
  if (payload.length > 2400) throw new Error('Bounded native handoff receipt too large.');
  return {
    task_id: result.task_id,
    from: 'codex_lead', to: 'chatgpt_lead',
    title: 'Codex result — Git review required',
    request: payload, ...(inReplyTo ? {in_reply_to: inReplyTo} : {}),
    user_confirmed: true
  };
}

export function composeOwnerFailureReceipt(result, {inReplyTo} = {}) {
  if (!result || result.status !== 'BLOCKED_POSTFLIGHT_OR_EXECUTION' ||
      result.codex_invoked !== true || result.tests_run !== false || result.merged !== false ||
      !/^task_[0-9a-f-]{8,80}$/.test(result.task_id ?? '') ||
      !/^transfer_[0-9a-f-]{36}$/.test(result.transfer_id ?? '') ||
      !/^[a-f0-9]{64}$/.test(result.plan_sha256 ?? '') ||
      !(result.exit_code === null || Number.isInteger(result.exit_code)) ||
      typeof result.timed_out !== 'boolean' || typeof result.postflight_passed !== 'boolean' ||
      ![null,'ABORT','SIGINT','SIGTERM','TIMEOUT'].includes(result.termination_reason) ||
      !Array.isArray(result.postflight_reasons) || result.postflight_reasons.length > 30 ||
      result.postflight_reasons.some(reason=>typeof reason!=='string'||!/^[A-Z_]{1,80}$/.test(reason)) ||
      (result.exit_code===0&&!result.timed_out&&!result.termination_reason&&result.postflight_passed))
    throw new Error('A bounded failed native result is required for a failure receipt.');
  if (inReplyTo !== undefined && !inboxId.test(inReplyTo)) throw new Error('Invalid exact Task Inbox parent note ID.');
  return {
    task_id:result.task_id,from:'codex_lead',to:'chatgpt_lead',
    title:'Codex task incomplete — owner review required',
    request:[
      'Local Codex task INCOMPLETE (ADVISORY, not model-authenticated).',
      'Task: '+result.task_id,'Transfer: '+result.transfer_id,
      'Plan SHA-256: '+result.plan_sha256,
      'Exit code: '+String(result.exit_code)+'; termination: '+(result.termination_reason??'none')+'; timed out: '+result.timed_out+'.',
      'Git postflight: '+(result.postflight_passed?'PASS':'FAIL')+'; reasons: '+(result.postflight_reasons.join(', ')||'none')+'.',
      'No successful completion is claimed. Tests run: NO. Merge/push: NO.',
      'Inspect Git and recorded worker status. Claimed tasks do not automatically retry.'
    ].join('\n'),...(inReplyTo?{in_reply_to:inReplyTo}:{}),user_confirmed:true
  };
}

export async function publishOwnerFailureReceipt({worktree,result,inReplyTo}={}) {
  return publishOwnerReceipt({worktree,result,request:composeOwnerFailureReceipt(result,{inReplyTo})});
}

export async function publishOwnerReturnReceipt({worktree, result, inReplyTo} = {}) {
  return publishOwnerReceipt({worktree,result,request:composeOwnerReturnReceipt(result,{inReplyTo})});
}

async function publishOwnerReceipt({worktree,result,request}) {
  // This entry point must be called from the OWNER-CONFIRMED local CLI path.
  // Exporting it for tests is not an OS security boundary.
  if (!path.isAbsolute(worktree ?? '') || path.resolve(worktree) !== worktree ||
      worktree === path.parse(worktree).root)
    throw new Error('Exact canonical project root required.');
  // Project IDs are provider-assigned; always resolve them from the exact root.
  const client = new Client({name:'gcf-owner-reviewed-native-return',version:'1.0.0'}, {capabilities:{}});
  try {
    // Ephemeral local-only MCP child: no Bash; handoff write is authorized
    // only for this explicit owner-confirmed note, never for remote clients.
    await client.connect(new StdioClientTransport({
      command:process.execPath,
      args:[path.join(bridgeRoot,'dist','stdio.js'),'--root',worktree,
        '--allow-root',worktree,'--tool-mode','standard','--write','workspace','--bash','off'],
      cwd:bridgeRoot,
      env:{...process.env,CODEXBRIDGE_ROOT:worktree,CODEXBRIDGE_ALLOWED_ROOTS:worktree}
    }));
    const discovered=await client.callTool({name:'list_projects',arguments:{}});
    const canonicalRoot=await fs.realpath(worktree);
    const matching=discovered.structuredContent?.projects?.filter(x=>x.root===canonicalRoot)??[];
    if(discovered.isError || matching.length!==1 || typeof matching[0].project_id!=='string')
      throw new Error('Exact approved project was not uniquely found.');
    const project_id=matching[0].project_id;
    const selected = await client.callTool({name:'select_project',arguments:{project_id}});
    if (selected.isError || !selected.structuredContent)
      throw new Error('Local MCP could not select the exact project.');
    const resumed = await client.callTool({name:'task_resume',arguments:{workspace_id:project_id}});
    if (resumed.isError || resumed.structuredContent?.task_id !== result.task_id)
      throw new Error('Active MCP task differs from the verified native handoff.');
    const posted = await client.callTool({name:'task_inbox_post',
      arguments:{workspace_id:project_id,...request}});
    if (posted.isError || posted.structuredContent?.message?.task_id !== result.task_id ||
        posted.structuredContent?.message?.to !== 'chatgpt_lead')
      throw new Error('Local MCP declined the bounded owner-reviewed return note.');
    return {
      posted:true,project_id,task_id:result.task_id,
      message_id:posted.structuredContent.message.id,
      in_reply_to:posted.structuredContent.message.in_reply_to??null,
      advisory_only:true,model_identity_verified:false,owner_os_identity_verified:false,
      no_model_invoked_by_post:true
    };
  }finally{
    await client.close().catch(()=>{});
  }
}
