import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { planOrchestration } from '../dist/orchestrationOps.js';

assert.equal(planOrchestration('Implement TypeScript backend tests').recommended_mode, 'codex_lead');
assert.equal(planOrchestration('Research architecture strategy').recommended_mode, 'chatgpt_lead');
assert.equal(planOrchestration('Implement code and review design').confirmation_required, true);
assert.equal(planOrchestration('Investigate the issue').recommended_mode, 'chatgpt_lead');
assert.equal(planOrchestration('Fix bug', 'chatgpt_lead').proposed_mode, 'chatgpt_lead');
const fallback=planOrchestration('Implement TypeScript backend tests','auto',{codex_availability:'rate_limited'});
assert.equal(fallback.proposed_mode,'chatgpt_lead');
assert.equal(fallback.coding_handoff_recommended,true);
assert.equal(fallback.chatgpt_lead_can_code,true);
assert.equal(fallback.chatgpt_coding_requires_write_permission,true);
assert.equal(fallback.chatgpt_session_started,false);
assert.equal(planOrchestration('Fix bug','codex_lead',{codex_availability:'context_exhausted'}).confirmation_required,true);
assert.equal(planOrchestration('Implement code','auto',{codex_availability:'available'}).proposed_mode,'codex_lead');
assert.throws(()=>planOrchestration('Fix bug','auto',{codex_availability:'fake'}),/Unknown Codex availability/);
assert.equal(planOrchestration('Research strategy', 'codex_lead').proposed_mode, 'codex_lead');
assert.equal(planOrchestration('اكتب كود ونفذ اختبر').recommended_mode, 'codex_lead');
assert.equal(planOrchestration('راجع تصميم معمارية').recommended_mode, 'chatgpt_lead');
assert.equal(planOrchestration('Plan the API').selection_persisted, false);
assert.equal(planOrchestration('Plan the API').execution_started, false);
assert.equal(planOrchestration('Plan the API').transfer_performed, false);
assert.throws(() => planOrchestration(''), /nonempty/);
assert.throws(() => planOrchestration('a'.repeat(2001)), /2000/);
assert.throws(() => planOrchestration('task', 'invalid'), /Unknown/);
assert.equal(planOrchestration('Fix typo').recommended_reasoning_effort, 'low');
assert.equal(planOrchestration('Implement backend tests').recommended_reasoning_effort, 'medium');
assert.equal(planOrchestration('Review security broker architecture').recommended_reasoning_effort, 'high');
assert.equal(planOrchestration('Fix typo', 'codex_lead', {reasoning_effort:'high',codex_model:'gpt-5.3-codex'}).proposed_reasoning_effort, 'high');
assert.equal(planOrchestration('Fix typo', 'auto', {codex_model:'gpt-5.3-codex'}).codex_model_applied, false);
assert.equal(planOrchestration('Fix typo').reasoning_effort_applied, false);
assert.throws(() => planOrchestration('task','auto',{reasoning_effort:'extreme'}), /Unknown Codex/);
assert.throws(() => planOrchestration('task','auto',{codex_model:'foo;rm -rf /'}), /valid bounded/);

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-orchestrator-'));
const client = new Client({ name: 'orchestration-smoke', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/stdio.js', '--root', root, '--allow-root', root, '--tool-mode', 'standard', '--bash', 'off'],
  cwd: process.cwd(),
  env: { ...process.env, GCF_ROOT: root, GCF_ALLOWED_ROOTS: root }
});
try {
  await client.connect(transport);
  const mcpInstructions=client.getInstructions();
  assert.match(mcpInstructions,/Notion Project Memory is OPTIONAL/);
  assert.match(mcpInstructions,/read AGENTS\.md first/);
  assert.match(mcpInstructions,/enabled NOTION_MEMORY\.md/);
  assert.match(mcpInstructions,/official Notion plugin\/MCP/);
  assert.match(mcpInstructions,/Notion Project Memory is OPTIONAL/);
  assert.match(mcpInstructions,/SKIP all Notion actions and pending-sync warnings/);
  assert.match(mcpInstructions,/continue all GCF work and report NOTION_SYNC_PENDING/);
  assert.match(mcpInstructions,/shared_project_state and task_resume/);
  assert.match(mcpInstructions,/never mirror transient handoffs/);
  assert.match(mcpInstructions,/consolidate without duplication/);
  const tool = (await client.listTools()).tools.find((entry) => entry.name === 'recommend_orchestrator');
  assert.ok(tool);
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.ok(tool._meta?.ui?.resourceUri || tool._meta?.['openai/outputTemplate']);
  const result = await client.callTool({
    name: 'recommend_orchestrator', arguments: { goal: 'Implement backend tests', mode: 'auto' }
  });
  assert.ok(!result.isError);
  assert.equal(result.structuredContent.proposed_mode, 'codex_lead');
  assert.equal(result.structuredContent.confirmation_required, true);
  assert.equal(result.structuredContent.execution_started, false);
  assert.equal(result.structuredContent.selection_persisted, false);
  assert.equal(result.structuredContent.transfer_performed, false);
  const effort = await client.callTool({name:'recommend_orchestrator',arguments:{goal:'Audit broker security', mode:'codex_lead',codex_model:'gpt-5.3-codex', reasoning_effort:'high'}});
  assert.ok(!effort.isError);
  assert.equal(effort.structuredContent.proposed_reasoning_effort,'high');
  assert.equal(effort.structuredContent.codex_model,'gpt-5.3-codex');
  assert.equal(effort.structuredContent.reasoning_effort_applied,false);
  const explicit = await client.callTool({
    name: 'recommend_orchestrator', arguments: { goal: 'Implement backend tests', mode: 'chatgpt_lead' }
  });
  assert.equal(explicit.structuredContent.proposed_mode, 'chatgpt_lead');
  assert.equal(explicit.structuredContent.confirmation_required, false);
  const limited=await client.callTool({name:'recommend_orchestrator',arguments:{goal:'Implement TypeScript backend tests',mode:'auto',codex_availability:'rate_limited'}});
  assert.ok(!limited.isError);
  assert.equal(limited.structuredContent.proposed_mode,'chatgpt_lead');
  assert.equal(limited.structuredContent.chatgpt_lead_can_code,true);
  assert.equal(limited.structuredContent.chatgpt_session_started,false);
  const invalid = await client.callTool({
    name: 'recommend_orchestrator', arguments: { goal: '', mode: 'auto' }
  });
  assert.ok(invalid.isError);
  const parallelTool = (await client.listTools()).tools.find((entry) => entry.name === 'parallel_session_status');
  assert.ok(parallelTool);
  assert.equal(parallelTool.annotations?.readOnlyHint, true);
  const emptyParallel = await client.callTool({name:'parallel_session_status',arguments:{}});
  assert.ok(!emptyParallel.isError, JSON.stringify(emptyParallel));
  assert.equal(emptyParallel.structuredContent.active, false);
  assert.equal(emptyParallel.structuredContent.merged_into_original, false);
  await fs.mkdir(path.join(root, '.ai-bridge'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai-bridge', 'parallel-session.json'), '{"schema":1,"session_id":"bad"}');
  const invalidParallel = await client.callTool({name:'parallel_session_status',arguments:{}});
  assert.equal(invalidParallel.isError, true, 'corrupt parallel status should be rejected');
  await assert.rejects(fs.stat(path.join(root, '.ai-bridge', 'current-task.json')), { code: 'ENOENT' });
} finally {
  await client.close();
  await fs.rm(root, { recursive: true, force: true });
}
// Owner-local manifest bridge: persisted Dashboard selection must be visible only on an approved workspace.
const ownerRoot=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gcf-owner-lead-mcp-')));
const projectA=path.join(ownerRoot,'approved-a'),projectB=path.join(ownerRoot,'approved-b');
await fs.mkdir(projectA);await fs.mkdir(projectB);
const ownerDir=path.join(ownerRoot,'private');await fs.mkdir(ownerDir);
const manifest=path.join(ownerDir,'projects.json');
await fs.writeFile(manifest,JSON.stringify({version:1,roots:[projectA,projectB]}));
const prefs=path.join(ownerDir,'gcf-lead-preferences.json');
await fs.writeFile(prefs,JSON.stringify({version:1,modes:{[projectA]:'codex_lead',[projectB]:'chatgpt_lead'}}),{mode:0o600});
async function checkLead(ownerContext) {
  const c=new Client({name:'owner-lead-smoke',version:'1.0.0'},{capabilities:{}});
  const t=new StdioClientTransport({command:process.execPath,args:['dist/stdio.js','--root',projectA,'--allow-root',projectA,'--tool-mode','standard','--bash','off'],cwd:process.cwd(),
    env:{...process.env,GCF_ROOT:projectA,GCF_ALLOWED_ROOTS:projectA,
      GCF_OWNER_LEAD_MANIFEST:ownerContext?manifest:''}});
  try{
    await c.connect(t);
    const tool=(await c.listTools()).tools.find(x=>x.name==='get_project_orchestrator_mode');
    assert.ok(tool);assert.equal(tool.annotations?.readOnlyHint,true);
    const selected=await c.callTool({name:'get_project_orchestrator_mode',arguments:{workspace_id:projectA}});
    // Workspace IDs are opaque and must be taken from the configured project listing.
    assert.equal(selected.isError,true);
    const projects=await c.callTool({name:'list_projects',arguments:{}});
    const projectId=projects.structuredContent.projects[0].project_id;
    const opened=await c.callTool({name:'select_project',arguments:{project_id:projectId}});
    const id=opened.structuredContent.workspace_id;
    const result=await c.callTool({name:'get_project_orchestrator_mode',arguments:{workspace_id:id}});
    assert.equal(result.isError,undefined);
    assert.equal(result.structuredContent.mode,ownerContext?'codex_lead':null,JSON.stringify({result:result.structuredContent,projects:projects.structuredContent,opened:opened.structuredContent,projectA,manifest}));
    assert.equal(result.structuredContent.available,ownerContext);
    assert.ok(!JSON.stringify(result.structuredContent).includes('chatgpt_lead'),'Other approved project selection is not disclosed');
    const missing=await c.callTool({name:'get_project_orchestrator_mode',arguments:{}});
    assert.equal(missing.isError,true);
  }finally{await c.close();}
}
try{await checkLead(true);await checkLead(false);}finally{await fs.rm(ownerRoot,{recursive:true,force:true});}
console.log('Orchestration recommendation and saved Dashboard Lead MCP integration tests passed');
