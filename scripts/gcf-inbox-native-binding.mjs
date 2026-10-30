#!/usr/bin/env node
/**
 * M34: bind an owner-approved, existing advisory inbox note to the fixed
 * disposable native Codex trial. This script NEVER executes inbox text.
 *
 * Preview: read the approved MCP inbox note, fingerprint its exact request,
 * and preview the existing disposable trial (no model call).
 * Run: require the previewed digest, then delegate to the existing owner
 * terminal consent gate. Emit local evidence; do NOT forge/post a Codex reply.
 */
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readProjectRootsManifest} from '../dist/projectRootsFile.js';
import {runDisposableTrial} from './gcf-native-codex-trial.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const projectIdFor = root => 'ws_' + sha(root).slice(0,24);
const ID = /^inbox_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT_ID = /^ws_[0-9a-f]{24}$/;
const SHA = /^[a-f0-9]{64}$/;
const TITLE = 'M33 disposable native Codex coding trial plan';
const MARKERS = [
  'M33 controlled native Codex programming proof',
  'scripts/gcf-native-codex-trial.mjs',
  'Fixture: src/message.mjs',
  "initially returns 'before'",
  "test/message.test.mjs expects 'after'",
  'ONLY fixture src/message.mjs',
  'Only owner may run npm run gcf:native-trial'
];

export function parseArgs(argv) {
  let mode = null, project_id, message_id, manifest, expected_sha256;
  for (let i=0; i<argv.length; i++) {
    const key=argv[i];
    if (key==='--preview'||key==='--run') {
      if (mode) throw Error('Specify exactly one of --preview or --run.');
      mode=key.slice(2); continue;
    }
    if (!['--project-id','--message-id','--manifest','--expect-request-sha256'].includes(key) ||
        !argv[i+1] || argv[i+1].startsWith('--')) throw Error('Unknown or incomplete option: '+key);
    const val=argv[++i];
    if (key==='--project-id') {if(project_id)throw Error('Duplicate project ID.');project_id=val;}
    if (key==='--message-id') {if(message_id)throw Error('Duplicate message ID.');message_id=val;}
    if (key==='--manifest') {if(manifest)throw Error('Duplicate manifest.');manifest=val;}
    if (key==='--expect-request-sha256') {if(expected_sha256)throw Error('Duplicate digest.');expected_sha256=val;}
  }
  if (!mode || !PROJECT_ID.test(project_id??'') || !ID.test(message_id??''))
    throw Error('Usage: --preview|--run --project-id ws_... --message-id inbox_UUID [--manifest absolute_path] [--expect-request-sha256 hex64 for --run]');
  if (manifest && !path.isAbsolute(manifest)) throw Error('Manifest path must be absolute.');
  if (mode==='run' && !SHA.test(expected_sha256??'')) throw Error('Run requires --expect-request-sha256 from a prior preview.');
  if (mode==='preview' && expected_sha256) throw Error('Digest is for --run only.');
  return {mode,project_id,message_id,manifest,expected_sha256};
}

export function validateInboxNote(note, selected, {project_id,message_id}) {
  if (!selected || selected.workspace_id!==project_id || !selected.active_task?.task_id)
    throw Error('Approved project/active task selection mismatch.');
  if (!note || note.id!==message_id || !ID.test(note.id) ||
      note.schema_version!==1 || note.task_id!==selected.active_task.task_id ||
      note.from!=='chatgpt_lead' || note.to!=='codex_lead' ||
      note.title!==TITLE || note.state!=='pending' ||
      typeof note.request!=='string' || note.request.length>2400 ||
      !MARKERS.every(marker=>note.request.includes(marker)))
    throw Error('Inbox note is not the exact supported M33 disposable-trial recipe; refuse.');
  return {
    source_project_id:project_id,
    source_message_id:message_id,
    source_task_id:note.task_id,
    source_request_sha256:sha(note.request),
    fixed_recipe:'disposable-message-before-after',
    advisory_only:true,
    inbox_instructions_executed:false,
    client_identity_verified:false
  };
}

export async function loadBinding({project_id,message_id,manifest}) {
  const manifestPath = manifest??path.join(
    process.env.GCF_HOME ? path.resolve(process.env.GCF_HOME) : path.join(os.homedir(),'.gcf'),
    'gpt-codex-flow','projects.json'
  );
  const approved=readProjectRootsManifest(manifestPath);
  const cwd=await fs.realpath(process.cwd());
  if (!approved.includes(cwd) || projectIdFor(cwd)!==project_id)
    throw Error('Current directory is not the exact owner-approved project ID.');
  const client=new Client({name:'gcf-m34-owner-preview',version:'1.0.0'},{capabilities:{}});
  try {
    await client.connect(new StdioClientTransport({
      command:process.execPath,
      args:[path.join(repo,'scripts','gcf-cli.mjs'),'start','--transport','stdio',
        '--manifest',manifestPath,'--write','off','--bash','off'],
      cwd:repo,
      env:{...process.env,GCF_ALLOW_HOME:'0',
        GCF_ALLOWED_ROOTS:'',CODEBASE_BRIDGE_ALLOWED_ROOTS:''}
    }));
    const selected=await client.callTool({name:'select_project',arguments:{project_id}});
    if (selected.isError || !selected.structuredContent) throw Error('GCF project selection failed.');
    const fetched=await client.callTool({name:'task_inbox_read',arguments:{
      workspace_id:project_id,message_id
    }});
    if (fetched.isError || !fetched.structuredContent?.message)
      throw Error('GCF inbox read failed.');
    return validateInboxNote(fetched.structuredContent.message,selected.structuredContent,
      {project_id,message_id});
  } finally { await client.close().catch(()=>{}); }
}

export async function runBinding(args) {
  const initial=await loadBinding(args);
  if (args.mode==='run' && initial.source_request_sha256!==args.expected_sha256)
    throw Error('Inbox request digest differs from owner-reviewed preview. No Codex invocation.');
  if (args.mode==='run' && !(process.stdin.isTTY && process.stdout.isTTY))
    throw Error('Native Codex requires direct interactive owner Terminal. No remote fallback.');
  const trial=await runDisposableTrial({run:args.mode==='run'});
  if (args.mode==='preview') {
    return {status:trial.ready_for_owner_review?'READY_FOR_OWNER_REVIEW':'BLOCKED',
      ...initial,owner_action_required:true,native_codex_executed:false,
      trial_preview:{ready_for_owner_review:trial.ready_for_owner_review,
        command_argv:trial.command_argv,allowed_paths:trial.handoff?.allowed_paths,
        fixture_is_disposable:trial.fixture_is_disposable,
        network_disabled_requested:trial.network_disabled_requested,
        outside_tmp_writes_disabled_requested:trial.outside_tmp_writes_disabled_requested},
      result_reply_posted:false};
  }
  const current=await loadBinding(args);
  const binding_intact=current.source_request_sha256===initial.source_request_sha256 &&
    current.source_task_id===initial.source_task_id;
  const passed=Boolean(trial.live_result?.passed && binding_intact);
  return {status:passed?'VERIFIED_DISPOSABLE_TRIAL':'BLOCKED',
    ...initial,binding_intact,owner_action_required:true,
    native_codex_executed:trial.actual_codex_execution,
    owner_confirmed:trial.user_confirmed,
    trial_evidence:{live_result:trial.live_result,model_request_verified:trial.model_request_verified},
    result_reply_posted:false,passed};
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=parseArgs(process.argv.slice(2));
    const result=await runBinding(args);
    console.log(JSON.stringify(result,null,2));
    if (result.status==='BLOCKED') process.exitCode=1;
  } catch(error) {
    console.error('M34 binding refused: '+(error instanceof Error?error.message:String(error)));
    process.exitCode=2;
  }
}
