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
async function withClient(label,fn) {
 const client=new Client({name:label,version:'1.0.0'},{capabilities:{}});
 const transport=new StdioClientTransport({
   command:process.execPath,
   args:[path.join(sourceRoot,'scripts','gcf-cli.mjs'),'start','--transport','stdio','--manifest',manifest,'--write','off','--bash','off'],
   cwd:sourceRoot,
   env:{...process.env,CODEXBRIDGE_ALLOW_HOME:'0',CODEXBRIDGE_ALLOWED_ROOTS:'',
     CODEBASE_BRIDGE_ALLOWED_ROOTS:'',CODEXBRIDGE_CONTEXT_DIR:'.ai-bridge'}
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
   const state=await client.callTool({name:'shared_project_state',arguments:{workspace_id:selected.project_id}});
   assert.notEqual(state.isError,true);
   return fn(state.structuredContent);
 } finally {
   await client.close().catch(()=>{});
 }
}
try {
 const before=await withClient('gcf-fixture-client-a',s=>{
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
 const after=await withClient('gcf-fixture-client-b',s=>{
   assert.equal(s.task.task_id,taskId);
   assert.equal(s.operation_journal.latest.event,'task_verify');
   assert.equal(s.continuity.next_steps[1],'Review results');
   assert.equal(s.continuity.completed_work_verified,false);
   assert.equal(s.no_permissions_granted,true);
   return s;
 });
 assert.equal(before.operation_journal.count,0);
 assert.equal(after.operation_journal.count,1);
 console.log('PASS independent MCP client A -> client B continuity (same approved project, new connection, bounded unverified history).');
 console.log('NOT TESTED: actual ChatGPT Web/Desktop, native Codex models, Cloudflare OAuth or automatic external-client capture.');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
