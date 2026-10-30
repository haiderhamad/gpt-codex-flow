#!/usr/bin/env node
/**
 * Two independent real MCP STDIO connections, sequentially sharing ONE
 * disposable approved project. This simulates cross-client resumption without
 * claiming to launch ChatGPT, Codex, OAuth, Cloudflare or paid models.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'gcf-resume-e2e-')));
const project=path.join(tmp,'sample-project');
const manifest=path.join(tmp,'private','projects.json');
const taskId='task_'+randomUUID();
fs.mkdirSync(project);fs.mkdirSync(path.dirname(manifest));
fs.mkdirSync(path.join(project,'.ai-bridge'));
fs.writeFileSync(manifest,JSON.stringify({version:1,roots:[project]})+'\n');
const updated=new Date().toISOString();
fs.writeFileSync(path.join(project,'.ai-bridge','current-task.json'),JSON.stringify({
 schema_version:1,task_id:taskId,goal:'Complete test-driven bridge setup',
 plan_steps:['Inspect tests','Review results'],target_paths:['README.md'],
 status:'in_progress',created_at:updated,updated_at:updated
})+'\n');
const originalTaskBytes=fs.readFileSync(path.join(project,'.ai-bridge','current-task.json'));
async function withClient(label,expectedNotionStatus,fn) {
 const client=new Client({name:label,version:'1.0.0'},{capabilities:{}});
 const transport=new StdioClientTransport({
   command:process.execPath,
   args:[path.join(sourceRoot,'scripts','gcf-cli.mjs'),'start','--transport','stdio','--manifest',manifest,'--write','off','--bash','off'],
   cwd:sourceRoot,
   env:{...process.env,GCF_ALLOW_HOME:'0',GCF_ALLOWED_ROOTS:'',
     CODEBASE_BRIDGE_ALLOWED_ROOTS:'',GCF_CONTEXT_DIR:'.ai-bridge'}
 });
 try {
   await client.connect(transport);
   const listing=await client.listTools();
   assert.ok(listing.tools.some(t=>t.name==='shared_project_state'));
   const projects=await client.callTool({name:'list_projects',arguments:{}});
   assert.notEqual(projects.isError,true);
   const selected=projects.structuredContent?.projects?.[0];
   assert.equal(selected?.root,project);
   const open=await client.callTool({name:'select_project',arguments:{project_id:selected.project_id}});
   assert.notEqual(open.isError,true);
   assert.equal(open.structuredContent?.notion_memory?.status,expectedNotionStatus,label+' Notion status');
   // No external Notion client is installed or contacted in this test.
   const resumed=await client.callTool({name:'task_resume',arguments:{workspace_id:selected.project_id}});
   assert.notEqual(resumed.isError,true,label+' task_resume');
   assert.equal(resumed.structuredContent?.task_id,taskId,label+' task ID');
   const inbox=await client.callTool({name:'task_inbox_list',arguments:{workspace_id:selected.project_id}});
   assert.notEqual(inbox.isError,true,label+' Task Inbox');
   const transfer=await client.callTool({name:'transfer_status',arguments:{workspace_id:selected.project_id}});
   assert.notEqual(transfer.isError,true,label+' Transfer Status');
   assert.equal(transfer.structuredContent?.transfer,null,label+' transfer state');
   const state=await client.callTool({name:'shared_project_state',arguments:{workspace_id:selected.project_id}});
   assert.notEqual(state.isError,true,label+' shared_project_state');
   return fn(state.structuredContent);
 } finally {
   await client.close().catch(()=>{});
 }
}
try {
 assert.equal(fs.existsSync(path.join(project,'NOTION_MEMORY.md')),false,'Notion must be absent by default');
 const before=await withClient('gcf-fixture-client-a','disabled',s=>{
   assert.equal(s.task.task_id,taskId);
   assert.equal(s.continuity.completed_work_verified,false);
   assert.equal(s.no_process_started,true);
   return s;
 });
 // Simulate a completed journal event observed by GCF; the next fresh session
 // must see the changed shared state, without reusing connection memory.
 fs.writeFileSync(path.join(project,'.ai-bridge','operation-journal.jsonl'),JSON.stringify({
   ts:new Date().toISOString(),operation_id:'op_'+randomUUID(),
   event:'task_verify',status:'ok'
 })+'\n');
 // Invalid Notion configuration must not interfere with task continuity.
 fs.writeFileSync(path.join(project,'NOTION_MEMORY.md'),'not-a-valid-notion-opt-in\n');
 const after=await withClient('gcf-fixture-client-b','invalid',s=>{
   assert.equal(s.task.task_id,taskId);
   assert.equal(s.operation_journal.latest.event,'task_verify');
   assert.equal(s.continuity.next_steps[1],'Review results');
   assert.equal(s.continuity.completed_work_verified,false);
   assert.equal(s.no_permissions_granted,true);
   return s;
 });
 // Opted in, but with no Notion client integration: handoff still works.
 fs.writeFileSync(path.join(project,'NOTION_MEMORY.md'),
   '---\nschema: gcf-notion-memory/v1\nenabled: true\n---\n\nNo remote Notion connection.\n');
 const enabled=await withClient('gcf-fixture-client-c','needs_client_connection',s=>{
   assert.equal(s.task.task_id,taskId);
   assert.equal(s.operation_journal.latest.event,'task_verify');
   assert.equal(s.continuity.completed_work_verified,false);
   return s;
 });
 assert.equal(before.operation_journal.count,0);
 assert.equal(after.operation_journal.count,1);
 assert.equal(enabled.operation_journal.count,1);
 assert.deepEqual(fs.readFileSync(path.join(project,'.ai-bridge','current-task.json')),originalTaskBytes,
   'Fresh GCF sessions must not rewrite existing project-local handoff/task state');
 console.log('PASS task_resume, Task Inbox, transfer_status and shared_project_state with Notion absent, invalid, and enabled but disconnected (three fresh GCF MCP clients).');
 console.log('NOT TESTED: external Notion API outage/OAuth failure, native ChatGPT/Codex models or Cloudflare.');
 console.log('NOT TESTED: actual ChatGPT Web/Desktop, native Codex models, Cloudflare OAuth or automatic external-client capture.');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
