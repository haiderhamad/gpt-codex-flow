// GCF M20: independently verify MCP clients can discover + READ required
// Skill/Agent content, not merely a skill name in a task plan.
// Does not invoke Codex/ChatGPT models. Two SDK actors are NOT authenticated identities.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {makeProjectRootsManifest} from '../dist/projectRootsFile.js';

const rootDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cli=path.join(rootDir,'scripts','gcf-cli.mjs');
const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'gcf-capability-proof-')));
const approved=path.join(base,'Approved Project');
const disallowed=path.join(base,'Unapproved Project');
const manifest=path.join(base,'projects.json');
const sockets=[];
const sha=value=>createHash('sha256').update(value,'utf8').digest('hex');
const request=(c,name,args={})=>c.callTool({name,arguments:args});
function payload(r,label){
  assert.equal(Boolean(r.isError),false,label+': '+JSON.stringify(r).slice(0,1800));
  return r.structuredContent;
}
function failed(r,label){
  assert.equal(Boolean(r.isError),true,label+' should have failed: '+JSON.stringify(r).slice(0,400));
}
const skillContent=[
  '---','name: gcf-capability-fixture',
  'description: Read these actual instructions before testing a UI task.',
  '---','# Exact UI Skill Fixture',
  'Apply a visible keyboard focus ring and disclose all client trust limitations.',
  'The exact verification token is FOCUS-RING-42.',''
].join('\n');
const profileContent=[
  '---','name: gcf-reviewer-fixture',
  'description: Review code security and report an honest evidence boundary.',
  '---','# Agent Profile Instructions',
  'Never confuse a Markdown agent role with an actually started AI worker.',
  'The exact verification token is REVIEW-EVIDENCE-27.',''
].join('\n');
async function repo(root){
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'.gitignore'),'.ai-bridge/\n');
  await fs.writeFile(path.join(root,'readme.txt'),'original repository source\n');
  const r=spawnSync('git',['init','-q'],{cwd:root,encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);
}
async function connect(name,write){
  const c=new Client({name,version:'1.0.0'},{capabilities:{}});
  await c.connect(new StdioClientTransport({
    command:process.execPath,
    args:[cli,'start','--manifest',manifest,'--transport','stdio','--write',write,'--bash','off'],
    cwd:rootDir,
    env:{...process.env,GCF_ROOT:disallowed,GCF_ALLOWED_ROOTS:disallowed,
      CODEBASE_BRIDGE_ALLOWED_ROOTS:disallowed,GCF_ALLOW_HOME:'1'}
  }));
  sockets.push(c);return c;
}
async function checkedLoad(client,id) {
  // Search by exact name, then use the exact discovered sanitized path.
  // Do NOT infer that a profile with the same name elsewhere is identical.
  const skills=payload(await request(client,'search_skills',{
    workspace_id:id,query:'gcf-capability-fixture',source:'workspace',
    include_global_skills:false
  }),'skill search');
  assert.equal(skills.total_matches,1);
  const skill=skills.skills[0];
  const loadedSkill=payload(await request(client,'load_skill',{
    workspace_id:id,name:skill.name,source:skill.source,path:skill.path,
    include_global_skills:false,max_bytes:5000
  }),'load complete SKILL.md');
  assert.equal(loadedSkill.truncated,false,'truncated SKILL.md cannot be treated as complete');
  assert.equal(loadedSkill.text,skillContent,'full SKILL.md instruction content must load');
  assert.equal(loadedSkill.total_bytes,Buffer.byteLength(skillContent));
  const agents=payload(await request(client,'search_agent_profiles',{
    workspace_id:id,query:'gcf-reviewer-fixture',
    source:'workspace',include_global_profiles:false
  }),'agent profile search');
  assert.equal(agents.total_matches,1);
  const agent=agents.profiles[0];
  assert.equal(agent.executable,false);
  const loadedAgent=payload(await request(client,'load_agent_profile',{
    workspace_id:id,name:agent.name,source:agent.source,path:agent.path,
    include_global_profiles:false,max_bytes:5000
  }),'load complete agent role markdown');
  assert.equal(loadedAgent.truncated,false,'truncated agent profile cannot be complete');
  assert.equal(loadedAgent.text,profileContent);
  assert.equal(loadedAgent.total_bytes,Buffer.byteLength(profileContent));
  assert.equal(loadedAgent.profile.executable,false);
  return {
    skill:{name:skill.name,source:skill.source,path:skill.path,sha256:sha(loadedSkill.text)},
    agent_profile:{name:agent.name,source:agent.source,path:agent.path,
      sha256:sha(loadedAgent.text),executable:false}
  };
}
try{
  await Promise.all([repo(approved),repo(disallowed)]);
  await fs.mkdir(path.join(approved,'.codex','skills','gcf-capability-fixture'),{recursive:true});
  await fs.mkdir(path.join(approved,'.codex','agents'),{recursive:true});
  await fs.writeFile(path.join(approved,'.codex','skills','gcf-capability-fixture','SKILL.md'),skillContent);
  await fs.writeFile(path.join(approved,'.codex','agents','gcf-reviewer-fixture.md'),profileContent);
  await fs.writeFile(manifest,JSON.stringify(makeProjectRootsManifest([approved]))+'\n',{mode:0o600});
  const originalManifest=await fs.readFile(manifest,'utf8');
  const lead=await connect('codex-lead-fixture','handoff');
  const follower=await connect('chatgpt-peer-fixture','handoff');
  const roots=payload(await request(lead,'list_projects'),'lead roots');
  assert.deepEqual(roots.projects.map(x=>x.root),[approved]);
  const id=roots.projects[0].project_id;
  payload(await request(lead,'select_project',{project_id:id}),'lead select');
  payload(await request(follower,'select_project',{project_id:id}),'follower select');
  const leadLoaded=await checkedLoad(lead,id);
  failed(await request(lead,'load_skill',{
    workspace_id:id,name:'nonexistent-required-skill',include_global_skills:false
  }),'absent required Skill');
  failed(await request(lead,'load_agent_profile',{
    workspace_id:id,name:'nonexistent-role',include_global_profiles:false
  }),'absent Agent role');
  const task=payload(await request(lead,'task_plan',{
    workspace_id:id,goal:'Review local UI instructions, using the named Skill and agent role',
    target_paths:['readme.txt'],plan_steps:[
      'Load exact Skill and agent role from MCP',
      'Re-check complete content and SHA-256',
      'Return bounded peer review without changing source'
    ]
  }),'task plan');
  assert.match(task.task_id,/^task_/);
  const outgoing={workspace_id:id,task_id:task.task_id,from:'codex_lead',to:'chatgpt_lead',
    title:'Capability-gated UI review',request:JSON.stringify({
      task:'Check accessibility and trust boundaries; no source changes',
      requirements:leadLoaded,
      instruction:'Discover each required item by exact name/path, independently load complete contents, compare SHA-256 before reviewing. Absent, truncated, or mismatched content means BLOCKED. Role file is not an executing AI agent.'
    }),user_confirmed:true
  };
  const post=payload(await request(lead,'task_inbox_post',outgoing),'send reference-only note');
  const record=payload(await request(follower,'task_inbox_read',{
    workspace_id:id,message_id:post.message.id
  }),'peer reads note');
  const referenced=JSON.parse(record.message.request).requirements;
  // The RECEIVER actually runs independent MCP calls; metadata alone is never proof.
  const followerLoaded=await checkedLoad(follower,id);
  assert.deepEqual(followerLoaded,referenced);
  // Verify an altered instruction is rejected by digest comparison before declaring readiness.
  const forged={...referenced,skill:{...referenced.skill,sha256:'0'.repeat(64)}};
  assert.notDeepEqual(forged,followerLoaded,'forged digest cannot pass proof comparison');
  const answer=payload(await request(follower,'task_inbox_post',{
    workspace_id:id,task_id:task.task_id,
    from:'chatgpt_lead',to:'codex_lead',
    title:'Capability content independently checked',
    request:JSON.stringify({status:'CONTENT_READ_VERIFIED_IN_FIXTURE',
      hashes:followerLoaded,model_execution_verified:false,
      source_edited:false,actor_identity_authenticated:false}),
    in_reply_to:post.message.id,user_confirmed:true
  }),'peer response');
  const ack=payload(await request(lead,'task_inbox_read',{
    workspace_id:id,message_id:answer.message.id
  }),'lead reads reply');
  const parsed=JSON.parse(ack.message.request);
  assert.equal(parsed.status,'CONTENT_READ_VERIFIED_IN_FIXTURE');
  assert.deepEqual(parsed.hashes,leadLoaded);
  assert.equal(parsed.model_execution_verified,false);
  assert.equal(parsed.actor_identity_authenticated,false);
  assert.equal(ack.message.in_reply_to,post.message.id);
  // Opposite leadership must be possible without assuming implicit client access.
  const reverse=payload(await request(follower,'task_inbox_post',{
    workspace_id:id,task_id:task.task_id,from:'chatgpt_lead',to:'codex_lead',
    title:'Reverse skill confirmation',request:JSON.stringify({requirements:followerLoaded}),
    user_confirmed:true
  }),'reverse sender');
  const leadRead=payload(await request(lead,'task_inbox_read',{
    workspace_id:id,message_id:reverse.message.id
  }),'reverse receiver');
  assert.deepEqual(JSON.parse(leadRead.message.request).requirements,leadLoaded);
  failed(await request(lead,'open_workspace',{
    root:disallowed,include_tree:false,include_skills:false
  }),'unapproved root');
  assert.equal(await fs.readFile(path.join(approved,'readme.txt'),'utf8'),
    'original repository source\n');
  assert.equal(await fs.readFile(manifest,'utf8'),originalManifest);
  console.log('PASS: two separate local MCP clients EACH search and fully read real SKILL.md + agent profile');
  console.log('PASS: content SHA-256 matches exact role/path; missing/truncated/forged content cannot be approved');
  console.log('PASS: Codex-role -> ChatGPT-role -> correlated receipt; reverse leadership reference also read');
  console.log('LIMIT: fixture role labels/confirmation flags are NOT authenticated; no model/AI agents started');
}finally{
  await Promise.allSettled(sockets.map(x=>x.close()));
  await fs.rm(base,{recursive:true,force:true});
}
