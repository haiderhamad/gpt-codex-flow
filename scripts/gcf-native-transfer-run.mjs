#!/usr/bin/env node
// OWNER-ATTENDED ONLY: accepted ChatGPT->Codex task -> bounded local Codex CLI.
// Not an MCP tool or a trusted OS authorization service. No unattended privileged grant.
// This runner does not certify sandbox containment or the model's actual identity.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { composeOwnerReturnReceipt, publishOwnerReturnReceipt, publishOwnerFailureReceipt } from './gcf-native-return-receipt.mjs';
import { previewNativeTransfer } from './gcf-native-transfer-preview.mjs';
import { pinNativeCodexExecutable, verifyPinnedNativeCodexExecutable } from './gcf-native-executable-pin.mjs';
import { executeBoundedNativeProcess } from './gcf-native-process-supervisor.mjs';
import { inspectNativeCodexPostflight, snapshotProtectedNativeFiles,
  snapshotManagedMcpMetadata } from './gcf-native-codex-postflight.mjs';

const PROTECTED = ['.ai-bridge/current-task.json', '.ai-bridge/transfer-control.json'];
const EFFORTS = ['auto','low','medium','high','xhigh'];
function preferences({ model, effort = 'auto' } = {}) {
  if (model !== undefined && (typeof model !== 'string' ||
      model.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)))
    throw new Error('Invalid bounded Codex model identifier.');
  if (!EFFORTS.includes(effort)) throw new Error('Unsupported reasoning-effort preference.');
  return { model: model || null, effort };
}
export function argumentsForNative(preview, { model, effort }, { fullAccess = false } = {}) {
  // Only allow the existing strict sandbox argv; never accept caller-provided
  // executable/command flags. Keep user model/effort as explicitly reviewed args.
  const base = [
    'exec', '--ignore-user-config', '--ephemeral', '--sandbox', 'workspace-write',
    '--config', 'approval_policy=never',
    '--config', 'sandbox_workspace_write.network_access=false',
    '--config', 'sandbox_workspace_write.exclude_slash_tmp=true',
    '--config', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '--cd', preview.worktree, '-'
  ];
  if (JSON.stringify(preview.command_argv) !== JSON.stringify(['codex', ...base]))
    throw new Error('Native transfer command differs from known-safe preview.');
  const args = fullAccess
    ? ['exec','--ignore-user-config','--ephemeral','--sandbox','danger-full-access','--cd',preview.worktree,'-']
    : [...base];
  if (model) args.splice(1,0,'--model',model);
  if (effort !== 'auto') args.splice(1,0,'--config',`model_reasoning_effort="${effort}"`);
  return args;
}
async function unchanged(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error('Accepted handoff or managed metadata changed during owner review.');
}
export async function ownerNativeHandoff({
  worktree, run = false, model, effort = 'auto', returnToInbox = false, inReplyTo,
  ownerAutoOnce = false, expectedTransferId, fullAccess = false, abortSignal,
  searchPath = process.env.PATH ?? ''
} = {}) {
  const pref = preferences({model,effort});
  // TTY checks only prevent accidental noninteractive use. They are NOT OS
  // authentication: an adversarial process can allocate a pseudo-terminal.
  if (returnToInbox && !run) throw new Error('Return to Inbox requires an explicitly run task.');
  if (fullAccess && ownerAutoOnce)
    throw new Error('Full Access requires explicit interactive Terminal consent; never allowed in persistent Auto.');
  if (fullAccess && run && !(stdin.isTTY && stdout.isTTY))
    throw new Error('Full Access requires a local interactive terminal.');
  if (ownerAutoOnce && (!run || !returnToInbox || !/^transfer_[0-9a-f-]{36}$/.test(expectedTransferId ?? '')))
    throw new Error('One-shot owner opt-in requires --run, --return-to-inbox and exact --transfer-id.');
  if (run && !ownerAutoOnce && !(stdin.isTTY && stdout.isTTY))
    throw new Error('Owner-attended Codex run requires a real interactive terminal.');
  if (!worktree || !path.isAbsolute(worktree))
    throw new Error('Exact absolute Git worktree required.');
  const preview = await previewNativeTransfer({worktree,searchPath,includeLocalPlan:true});
  if (preview.status !== 'READY_FOR_OWNER_REVIEW' || !preview._local_plan)
    throw new Error('Accepted handoff not ready; no Codex execution.');
  if (ownerAutoOnce && preview.transfer_id !== expectedTransferId)
    throw new Error('One-shot owner opt-in transfer ID mismatch.');
  const pin = await pinNativeCodexExecutable({searchPath});
  if (pin.candidate !== preview._local_codex_binary)
    throw new Error('Codex executable differs from handoff preflight.');
  const root = await fs.realpath(worktree);
  const initialProtected = await snapshotProtectedNativeFiles({worktree:root, paths:PROTECTED});
  const initialManaged = await snapshotManagedMcpMetadata({
    worktree:root,protectedHashes:initialProtected
  });
  const args = argumentsForNative({...preview,worktree:root},pref,{fullAccess});
  const result = {
    execution_mode: fullAccess ? 'OWNER_ATTENDED_FULL_ACCESS_CODEX' : 'OWNER_ATTENDED_LOCAL_CODEX',
    full_access_requested:fullAccess,
    status: 'READY_FOR_OWNER_REVIEW',
    worktree:root,transfer_id:preview.transfer_id,task_id:preview.task_id,
    git_head:preview.git_head,git_status_sha256:preview.git_status_sha256,
    plan_sha256:preview.plan_sha256,allowed_paths:preview.allowed_paths,
    command_argv:['codex',...args],pinned_binary:pin.realpath,
    pinned_executable_sha256:pin.sha256,
    requested_model:pref.model??'Codex client default',
    requested_reasoning_effort:pref.effort,
    codex_invoked:false,model_request_verified:false,
    owner_action_required:true,broker_authorized:false,
    sandbox_attested:false,merged:false
  };
  if (!run) return result;
  stdout.write('\nGPT CODEX FLOW — OWNER-ATTENDED NATIVE CODEX HANDOFF\n');
  stdout.write('Target: ' + root + '\n');
  stdout.write('Task: ' + preview.task_id + '\n');
  stdout.write('Allowed paths: ' + preview.allowed_paths.join(', ') + '\n');
  stdout.write('Plan SHA-256: ' + preview.plan_sha256 + '\n');
  stdout.write('Exact Codex argv: ' + JSON.stringify(result.command_argv) + '\n');
  stdout.write('Codex executable: ' + pin.realpath + '\n');
  stdout.write('Executable SHA-256: ' + pin.sha256 + '\n');
  stdout.write('WARNING: will invoke your Codex subscription and native sandbox. The task text is untrusted.\n');
  stdout.write('WARNING: this CLI cannot authenticate owner identity and does not attest OS sandbox containment.\n');
  if (fullAccess) stdout.write('DANGER: Full Access requests NO Codex sandbox. Commands may access files/network beyond Git root; postflight cannot undo damage.\n');
  if (ownerAutoOnce) {
    stdout.write('ONE-SHOT LOCAL OWNER OPT-IN: explicitly targeted transfer; no terminal prompt.\n');
  } else {
    const phrase = fullAccess ? 'I ACCEPT FULL ACCESS CODEX TASK ' + preview.transfer_id
      : (returnToInbox ? 'RUN AND RETURN ACCEPTED CODEX TASK ' : 'RUN ACCEPTED CODEX TASK ') + preview.transfer_id;
    const rl = createInterface({input:stdin,output:stdout,terminal:true});
    let answer;
    try { answer = await rl.question('Type exactly "' + phrase + '" to consent: '); }
    finally { rl.close(); }
    if (answer !== phrase)
      throw new Error('Exact owner confirmation missing; no Codex execution.');
  }
  // Re-check everything that could have changed while awaiting owner consent.
  await verifyPinnedNativeCodexExecutable(pin);
  const fresh = await previewNativeTransfer({worktree:root,searchPath,includeLocalPlan:true});
  if (fresh.status !== 'READY_FOR_OWNER_REVIEW' ||
      fresh.transfer_id !== preview.transfer_id || fresh.task_id !== preview.task_id ||
      fresh.plan_sha256 !== preview.plan_sha256 ||
      fresh.git_head !== preview.git_head ||
      fresh.git_status_sha256 !== preview.git_status_sha256 ||
      JSON.stringify(fresh.allowed_paths) !== JSON.stringify(preview.allowed_paths) ||
      fresh._local_codex_binary !== pin.candidate)
    throw new Error('Transfer changed after consent; no execution.');
  await unchanged(initialProtected, await snapshotProtectedNativeFiles({worktree:root,paths:PROTECTED}));
  await unchanged(initialManaged, await snapshotManagedMcpMetadata({worktree:root,protectedHashes:initialProtected}));
  await verifyPinnedNativeCodexExecutable(pin);
  const env = Object.fromEntries(['HOME','PATH','CODEX_HOME','LANG','LC_ALL','TERM','TMPDIR','USER']
    .filter(k=>typeof process.env[k] === 'string').map(k=>[k,process.env[k]]));
  const live = await executeBoundedNativeProcess({
    binary:pin.realpath,args,root,plan:preview._local_plan,env,
    timeoutMs:180000,graceMs:3000,maxOutput:1600,abortSignal
  });
  // Do not execute untrusted repo tests before checking the working tree.
  const postflight = await inspectNativeCodexPostflight({
    worktree:root,expectedHead:preview.git_head,
    allowedPaths:preview.allowed_paths,protectedHashes:initialProtected,
    managedMcpHashes:initialManaged
  });
  const completed = {
    ...result,status:live.exit_code===0 && !live.termination_reason && postflight.passed
      ? 'CODEX_PROCESS_EXITED_REVIEW_REQUIRED':'BLOCKED_POSTFLIGHT_OR_EXECUTION',
    codex_invoked:true,owner_action_required:false,
    exit_code:live.exit_code, timed_out:live.timed_out,
    termination_reason:live.termination_reason,
    changed_paths:postflight.changed_paths,postflight_passed:postflight.passed,
    postflight_reasons:postflight.reasons,
    model_request_verified:false,
    output_excerpt:live.stdout_excerpt,
    error_excerpt:live.stderr_excerpt,
    tests_run:false,review_required:true,merged:false
  };
  if (!returnToInbox) return {...completed,return_note_posted:false};
  if (completed.status !== 'CODEX_PROCESS_EXITED_REVIEW_REQUIRED') {
    // Failure is a distinct advisory outcome, never a success receipt. Do not
    // publish if the active task/transfer was replaced or tampered with.
    await unchanged(initialProtected, await snapshotProtectedNativeFiles({worktree:root,paths:PROTECTED}));
    await unchanged(initialManaged, await snapshotManagedMcpMetadata({worktree:root,protectedHashes:initialProtected}));
    const delivered = await publishOwnerFailureReceipt({worktree:root,result:completed,inReplyTo});
    return {...completed,return_note_posted:true,return_note:delivered};
  }
  // A single explicit owner consent above covered execution AND return when requested.
  // No result is published if process exit or postflight failed.
  const receipt = composeOwnerReturnReceipt(completed,{inReplyTo});
  stdout.write('PROPOSED ADVISORY TASK INBOX RETURN:\n' + receipt.request + '\n');
  // Re-check postflight before the owner-authorized return publication.
  const again = await inspectNativeCodexPostflight({
    worktree:root,expectedHead:preview.git_head,allowedPaths:preview.allowed_paths,
    protectedHashes:initialProtected,managedMcpHashes:initialManaged
  });
  if (!again.passed || JSON.stringify(again.changed_paths)!==JSON.stringify(postflight.changed_paths))
    throw new Error('Git postflight changed before owner-approved return post.');
  const delivered = await publishOwnerReturnReceipt({worktree:root,result:completed,inReplyTo});
  return {...completed,return_note_posted:true,return_note:delivered};
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv=process.argv.slice(2);
  let worktree,model,effort='auto',run=false,returnToInbox=false,inReplyTo;
  let ownerAutoOnce=false,expectedTransferId,fullAccess=false;
  try {
    for(let i=0;i<argv.length;i++){
      const a=argv[i];
      if(a==='--worktree' && i+1<argv.length)worktree=argv[++i];
      else if(a==='--model' && i+1<argv.length)model=argv[++i];
      else if(a==='--effort' && i+1<argv.length)effort=argv[++i];
      else if(a==='--full-access' && !fullAccess)fullAccess=true;
       else if(a==='--owner-auto-once' && !ownerAutoOnce)ownerAutoOnce=true;
      else if(a==='--transfer-id' && i+1<argv.length && !expectedTransferId)expectedTransferId=argv[++i];
      else if(a==='--return-to-inbox' && !returnToInbox)returnToInbox=true;
      else if(a==='--in-reply-to' && i+1<argv.length && !inReplyTo)inReplyTo=argv[++i];
      else if(a==='--run' && !run)run=true;
      else if(a==='--preview' && !run){}
      else throw new Error('Unknown or conflicting argument: '+a);
    }
    const result=await ownerNativeHandoff({worktree,run,model,effort,returnToInbox,inReplyTo,ownerAutoOnce,expectedTransferId,fullAccess});
    stdout.write(JSON.stringify(result,null,2)+'\n');
    if(result.status==='BLOCKED_POSTFLIGHT_OR_EXECUTION')process.exitCode=3;
  }catch(error){stderr.write('OWNER_HANDOFF_REFUSED: '+String(error?.message??error)+'\n');process.exitCode=2;}
}
