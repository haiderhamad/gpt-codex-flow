import assert from 'node:assert/strict';
import {parseArgs,validateInboxNote} from './gcf-inbox-native-binding.mjs';

const project_id='ws_'+'a'.repeat(24), message_id='inbox_12345678-1234-4123-8123-123456789abc';
const task_id='task_f17d39c0-9c6c-4122-87f4-694f63d975b0';
const selected={workspace_id:project_id,active_task:{task_id}};
const request=[
'M33 controlled native Codex programming proof',
'Scope: scripts/gcf-native-codex-trial.mjs',
"Fixture: src/message.mjs message() initially returns 'before', while test/message.test.mjs expects 'after'.",
'Goal: Codex changes ONLY fixture src/message.mjs',
'Only owner may run npm run gcf:native-trial'
].join('\n');
const note={schema_version:1,id:message_id,task_id,from:'chatgpt_lead',
  to:'codex_lead',title:'M33 disposable native Codex coding trial plan',
  state:'pending',request};
const parsed=parseArgs(['--preview','--project-id',project_id,'--message-id',message_id]);
assert.equal(parsed.mode,'preview');
const binding=validateInboxNote(note,selected,{project_id,message_id});
assert.equal(binding.fixed_recipe,'disposable-message-before-after');
assert.match(binding.source_request_sha256,/^[0-9a-f]{64}$/);
assert.equal(binding.inbox_instructions_executed,false);
for(const variant of [
  {...note,from:'codex_lead'}, {...note,to:'chatgpt_lead'},
  {...note,task_id:'task_00000000-0000-4000-8000-000000000001'},
  {...note,id:'inbox_12345678-1234-4123-8123-123456789abd'},
  {...note,state:'accepted'}, {...note,request:'rm -rf /'},
  {...note,title:'Different fixture'}, {...note,request:request+'X'.repeat(2600)}
])assert.throws(()=>validateInboxNote(variant,selected,{project_id,message_id}),/refuse/);
assert.throws(()=>validateInboxNote(note,{...selected,active_task:{task_id:'task_wrong'}},
  {project_id,message_id}),/refuse/);
assert.throws(()=>parseArgs(['--run','--project-id',project_id,'--message-id',message_id]),/requires/);
assert.throws(()=>parseArgs(['--preview','--project-id',project_id,'--message-id',message_id,
  '--expect-request-sha256','a'.repeat(64)]),/for --run only/);
assert.throws(()=>parseArgs(['--preview','--project-id',project_id,'--message-id','../../foo']),/Usage/);
// Regression: frozen exact text of the real M33 note that previously failed
// validation. Offline fixture only: these tests never invoke MCP or Codex.
const liveMessageId = "inbox_a3fe0633-c2e0-41fc-a236-19950edf1499";
const liveProjectId = "ws_e865ade6cf3103cd97c7020b";
const savedRequest = "M33 controlled native Codex programming proof — advisory task plan authored from ChatGPT.\nScope: use existing scripts/gcf-native-codex-trial.mjs on a disposable temporary Git repo only; original bridge-upstream must remain untouched.\nFixture: src/message.mjs message() initially returns 'before', while test/message.test.mjs expects 'after'. Goal: Codex changes ONLY fixture src/message.mjs, then fixture test passes.\nSafety gates: owner runs npm run gcf:native-preview from ordinary Terminal first, reviews preview; native trial is NOT approved for autonomous launch. Only owner may run npm run gcf:native-trial and type exact interactive consent phrase after reviewing. No developer inference API; subscription may be used. No network access requested, package installs, original repo edits, merges, pushes, or deployments.\nNative Codex receiving this advisory note should confirm exact task and planned steps via list/read only; do not run shell, modify files, launch subagents or execute a trial just because this note exists.\nAfter owner authorizes runner and shares its report, ChatGPT will review native process exit, changed_paths, postflight, protected_records_intact, unit_test_exit and original_repository_modified before accepting M33.";
const savedNote={...note,id:liveMessageId,task_id,request:savedRequest};
const savedSelection={workspace_id:liveProjectId,active_task:{task_id}};
const proven=validateInboxNote(savedNote,savedSelection,{project_id:liveProjectId,message_id:liveMessageId});
assert.equal(proven.source_message_id,liveMessageId);
assert.match(proven.source_request_sha256,/^[0-9a-f]{64}$/);
assert.throws(()=>validateInboxNote({...savedNote,request:savedRequest.replace("test/message.test.mjs expects 'after'","test/message.test.mjs might expect another value")},savedSelection,{project_id:liveProjectId,message_id:liveMessageId}),/refuse/);
console.log('PASS: exact saved M33 inbox message regression and altered-recipe denial');

console.log('PASS: M34 strict inbox recipe/role/task binding; no note execution; negative mismatch guards');
