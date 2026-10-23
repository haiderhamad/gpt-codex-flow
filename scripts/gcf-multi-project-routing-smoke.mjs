// Real MCP multi-project routing regression. No agent/model calls or user files.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const temp=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-multi-project-'));
const projectA=path.join(temp,'alpha','SameName');
const projectB=path.join(temp,'beta','SameName');
const projectC=path.join(temp,'unallowed','Other');
const aliasRegistry=path.join(temp,'settings','project-aliases.json');
const clients=[];
async function fixture(root,marker) {
  await fs.mkdir(path.join(root,'.ai-bridge'),{recursive:true});
  await fs.writeFile(path.join(root,'shared.txt'),marker+'\n');
  await fs.writeFile(path.join(root,'.ai-bridge','PROJECT.md'),'Project: '+marker+'\n');
  await fs.writeFile(path.join(root,'.ai-bridge','HISTORY.md'),'History: '+marker+'\n');
  const init=spawnSync('git',['init','-q'],{cwd:root,encoding:'utf8',timeout:12000});
  assert.equal(init.status,0,init.stderr);
  const staged=spawnSync('git',['add','-A'],{cwd:root,encoding:'utf8',timeout:12000});
  assert.equal(staged.status,0,staged.stderr);
  const committed=spawnSync('git',['-c','user.name=Fixture',
    '-c','user.email=fixture@example.invalid',
    '-c','core.hooksPath=/dev/null','commit','-q','--no-gpg-sign','-m','fixture baseline'],
    {cwd:root,encoding:'utf8',timeout:12000});
  assert.equal(committed.status,0,committed.stderr);
}
async function connect(roots,writeMode='workspace') {
  const [defaultRoot,...extra]=roots;
  const client=new Client({name:'gcf-multi-project-fixture',version:'1.0.0'},{capabilities:{}});
  await client.connect(new StdioClientTransport({
    command:process.execPath,
    args:['dist/stdio.js','--root',defaultRoot,
      ...roots.flatMap(root=>['--allow-root',root]),
      '--tool-mode','standard','--write',writeMode,'--bash','off'],
    cwd:process.cwd(),
    env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:temp,TMPDIR:temp,
      CODEXBRIDGE_ROOT:defaultRoot,CODEXBRIDGE_ALLOWED_ROOTS:'',
      CODEBASE_BRIDGE_ALLOWED_ROOTS:'',CODEXBRIDGE_ALLOW_HOME:'0',
      CODEXBRIDGE_TOOL_MODE:'standard',CODEXBRIDGE_WRITE_MODE:writeMode,
      CODEXBRIDGE_BASH_MODE:'off',CODEXBRIDGE_PROJECT_ALIAS_FILE:aliasRegistry,
      NO_COLOR:'1'}
  }));
  clients.push(client);
  return client;
}
const call=(client,name,args={})=>client.callTool({name,arguments:args});
function payload(reply){return JSON.stringify(reply);}
async function error(client,name,args,match) {
  let result;
  try { result=await call(client,name,args); }
  catch(e) {
    assert.match(String(e),match,name+' should reject the requested project scope');
    return;
  }
  assert.equal(result.isError,true,name+' unexpectedly succeeded '+payload(result));
  assert.match(payload(result),match,name+' should reject the requested project scope');
}
try {
  await fixture(projectA,'A-UNCHANGED');
  await fixture(projectB,'B-ORIGINAL');
  await fixture(projectC,'C-PRIVATE');
  const readOnly=await connect([projectA,projectB],'off');
  const readOnlyProjects=(await call(readOnly,'list_projects')).structuredContent.projects;
  await error(readOnly,'set_project_alias',{project_id:readOnlyProjects[0].project_id,alias:'No writes'},/require handoff write permission/i);
  await error(readOnly,'recover_project_alias',{previous_project_id:'ws_old',new_project_id:readOnlyProjects[0].project_id,expected_alias:'No writes'},/require handoff write permission/i);
  await assert.rejects(fs.stat(aliasRegistry),{code:'ENOENT'});
  const client=await connect([projectA,projectB]);
  const toolList=await client.listTools();
  for(const name of ['list_projects','select_project','open_current_workspace','find_project','read','edit','task_plan']) {
    assert.ok(toolList.tools.some(tool=>tool.name===name),'standard mode missing '+name);
  }
  const listed=(await call(client,'list_projects')).structuredContent;
  assert.equal(listed.count,2);
  assert.equal(listed.requires_selection,true);
  assert.deepEqual(listed.projects.map(p=>p.name),['SameName','SameName']);
  const [a,b]=listed.projects;
  const ambiguous=(await call(client,'find_project',{name:'SameName'})).structuredContent;
  assert.equal(ambiguous.status,'ambiguous');
  assert.equal(ambiguous.next_action,'ask_user');
  assert.equal(ambiguous.project_selected,false);
  assert.deepEqual(ambiguous.matches.map(p=>p.project_id),[a.project_id,b.project_id]);
  const none=(await call(client,'find_project',{name:'Not a configured project'})).structuredContent;
  assert.equal(none.status,'not_found');
  assert.deepEqual(none.matches,[]);
  assert.equal(none.next_action,'list_projects');
  const partial=(await call(client,'find_project',{name:'Same'})).structuredContent;
  assert.equal(partial.status,'not_found','no unsafe partial/fuzzy matching');
  const unauthorizedLookup=(await call(client,'find_project',{name:'../unallowed/Other'})).structuredContent;
  assert.equal(unauthorizedLookup.status,'not_found');
  assert.deepEqual(unauthorizedLookup.matches,[]);
  assert.notEqual(a.project_id,b.project_id);
  assert.equal(a.root,await fs.realpath(projectA));
  assert.equal(b.root,await fs.realpath(projectB));
  const defaultAttempt=(await call(client,'open_current_workspace')).structuredContent;
  assert.equal(defaultAttempt.requires_selection,true);
  assert.equal(Object.hasOwn(defaultAttempt,'workspace_id'),false);
  for(const [name,args] of [
    ['read',{path:'shared.txt'}],
    ['write',{path:'wrong.txt',content:'wrong repo\n'}],
    ['edit',{path:'shared.txt',old_text:'A-UNCHANGED',new_text:'damaged'}],
    ['task_plan',{goal:'Must select',plan_steps:['do not persist']}],
    ['task_resume',{}],
    ['bash',{command:'npm test'}]
  ])await error(client,name,args,/Project selection required/);
  await error(client,'select_project',{project_id:'ws_unknown'},/Unknown project_id/);
  await error(client,'open_workspace',{root:projectC,include_tree:false,include_skills:false},
    /outside allowed roots/);
  await assert.rejects(fs.stat(path.join(projectA,'wrong.txt')),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(projectA,'shared.txt'),'utf8'),'A-UNCHANGED\n');
  console.log('PASS: ambiguous project names and new-chat default are not silently selected');

  const selectedB=(await call(client,'select_project',{project_id:b.project_id})).structuredContent;
  assert.equal(selectedB.workspace_id,b.project_id);
  assert.equal(selectedB.root,await fs.realpath(projectB));
  assert.equal(selectedB.selection_is_request_scoped,true);
  const originalB=(await call(client,'read',{workspace_id:b.project_id,path:'shared.txt'})).structuredContent;
  assert.match(originalB.text,/B-ORIGINAL/);
  const changed=await call(client,'edit',{workspace_id:b.project_id,path:'shared.txt',
    old_text:'B-ORIGINAL',new_text:'B-CHANGED'});
  assert.equal(changed.isError??false,false,payload(changed));
  const planned=await call(client,'task_plan',{workspace_id:b.project_id,
    goal:'Continue Project B independently',plan_steps:['Verify B and never edit A']});
  assert.equal(planned.isError??false,false,payload(planned));
  assert.equal(await fs.readFile(path.join(projectB,'shared.txt'),'utf8'),'B-CHANGED\n');
  assert.equal(await fs.readFile(path.join(projectA,'shared.txt'),'utf8'),'A-UNCHANGED\n');

  const selectedA=(await call(client,'select_project',{project_id:a.project_id})).structuredContent;
  assert.equal(selectedA.workspace_id,a.project_id);
  const readA=(await call(client,'read',{workspace_id:a.project_id,path:'.ai-bridge/HISTORY.md'})).structuredContent;
  const readB=(await call(client,'read',{workspace_id:b.project_id,path:'.ai-bridge/HISTORY.md'})).structuredContent;
  assert.match(readA.text,/History: A-UNCHANGED/);
  assert.match(readB.text,/History: B-ORIGINAL/);
  const resumeA=(await call(client,'task_resume',{workspace_id:a.project_id})).structuredContent;
  const resumeB=(await call(client,'task_resume',{workspace_id:b.project_id})).structuredContent;
  assert.equal(resumeA.active,false);
  assert.equal(resumeB.active,true);
  assert.equal(resumeB.goal,'Continue Project B independently');
  assert.ok(!payload(resumeA).includes('Continue Project B independently'));
  await error(client,'read',{workspace_id:'ws_not_opened',path:'shared.txt'},/Unknown workspace_id/);
  console.log('PASS: scoped B edit/task/history, A remains unchanged with separate state');

  const named=await call(client,'set_project_alias',{project_id:b.project_id,alias:'Invest Atlas'});
  assert.equal(named.isError??false,false,payload(named));
  assert.equal(named.structuredContent.name,'Invest Atlas');
  const foundB=(await call(client,'find_project',{name:' INVEST ATLAS '})).structuredContent;
  assert.equal(foundB.status,'unique');
  assert.equal(foundB.next_action,'select_project');
  assert.equal(foundB.project_selected,false);
  assert.equal(foundB.filesystem_scope_changed,false);
  assert.equal(foundB.matches[0].project_id,b.project_id);
  assert.equal(foundB.matches[0].root,await fs.realpath(projectB));
  const folderCollision=(await call(client,'find_project',{name:'samename'})).structuredContent;
  assert.equal(folderCollision.status,'ambiguous');
  assert.equal(folderCollision.matches.length,2);
  assert.equal(named.structuredContent.filesystem_scope_changed,false);
  assert.equal((await call(client,'list_projects')).structuredContent.projects[1].name,'Invest Atlas');
  assert.equal((await call(client,'select_project',{project_id:b.project_id})).structuredContent.name,'Invest Atlas');
  const summaryB=(await call(client,'project_summary',{workspace_id:b.project_id})).structuredContent;
  assert.equal(summaryB.name,'Invest Atlas');
  assert.match(summaryB.sections['PROJECT.md'],/Project: B-ORIGINAL/);
  assert.match(summaryB.sections['HISTORY.md'],/History: B-ORIGINAL/);
  assert.equal(summaryB.active_task.goal,'Continue Project B independently');
  assert.equal(summaryB.full_chat_transcript_included,false);
  const summaryA=(await call(client,'project_summary',{workspace_id:a.project_id})).structuredContent;
  assert.match(summaryA.sections['HISTORY.md'],/History: A-UNCHANGED/);
  assert.ok(!payload(summaryA).includes('Continue Project B independently'));
  await error(client,'project_summary',{},/required|Invalid arguments/i);
  await error(client,'set_project_alias',{project_id:a.project_id,alias:'invest atlas'},/already belongs/);
  await error(client,'set_project_alias',{project_id:'ws_unknown',alias:'Hacked'},/Unknown project_id/);
  await error(client,'set_project_alias',{project_id:a.project_id,alias:'Bad\nAlias'},/control characters/);
  assert.equal((await fs.readFile(aliasRegistry,'utf8')).includes('Invest Atlas'),true);
  console.log('PASS: explicit aliases persist on disk; duplicate, invalid and unauthorized renames denied');

  // A fresh MCP connection approximates a new chat, not a real ChatGPT conversation.
  const fresh=await connect([projectA,projectB]);
  await error(fresh,'edit',{path:'shared.txt',old_text:'A-UNCHANGED',new_text:'leak'},/Project selection required/);
  await error(fresh,'task_resume',{workspace_id:b.project_id},/Unknown workspace_id/);
  const again=(await call(fresh,'select_project',{project_id:b.project_id})).structuredContent;
  assert.equal(again.workspace_id,b.project_id);
  const persisted=(await call(fresh,'list_projects')).structuredContent;
  assert.equal(persisted.projects[1].name,'Invest Atlas');
  const freshFound=(await call(fresh,'find_project',{name:'invest atlas'})).structuredContent;
  assert.equal(freshFound.status,'unique');
  assert.equal(freshFound.matches[0].project_id,b.project_id);
  const resumed=(await call(fresh,'task_resume',{workspace_id:b.project_id})).structuredContent;
  assert.equal(resumed.active,true);
  assert.equal(resumed.goal,'Continue Project B independently');
  console.log('PASS: fresh MCP client must select project again; B task resumes, A is untouched');

  const single=await connect([projectA]);
  const singleCurrent=(await call(single,'open_current_workspace')).structuredContent;
  assert.equal(singleCurrent.workspace_id,a.project_id);
  const singleRead=(await call(single,'read',{path:'shared.txt'})).structuredContent;
  assert.match(singleRead.text,/A-UNCHANGED/);
  console.log('PASS: one-project legacy default remains backwards-compatible');

  // M3 relocation fixture: move the REAL temporary Git repository, restart MCP
  // with its new explicitly authorized root, and recover ONLY its display alias.
  const movedB=path.join(temp,'moved','Project-B-Renamed');
  await fs.mkdir(path.dirname(movedB),{recursive:true});
  const gitHeadBefore=spawnSync('git',['rev-parse','HEAD'],{cwd:projectB,encoding:'utf8'});
  assert.equal(gitHeadBefore.status,0,gitHeadBefore.stderr);
  await fs.rename(projectB,movedB);
  await error(fresh,'read',{workspace_id:b.project_id,path:'shared.txt'},
    /Workspace root moved, missing, or replaced/);
  await fs.mkdir(projectB,{recursive:true});
  await fs.writeFile(path.join(projectB,'shared.txt'),'UNRELATED-NEW-ROOT\n');
  await error(fresh,'read',{workspace_id:b.project_id,path:'shared.txt'},
    /Workspace root moved, missing, or replaced/);
  const gitHeadAfter=spawnSync('git',['rev-parse','HEAD'],{cwd:movedB,encoding:'utf8'});
  assert.equal(gitHeadAfter.status,0,gitHeadAfter.stderr);
  assert.equal(gitHeadAfter.stdout,gitHeadBefore.stdout,
    'Git commit history should travel with moved directory');
  const relocated=await connect([projectA,movedB]);
  const relisted=(await call(relocated,'list_projects')).structuredContent;
  const newB=relisted.projects[1];
  assert.notEqual(newB.project_id,b.project_id);
  assert.equal(newB.name,'Project-B-Renamed','path change must not auto-recover alias');
  assert.deepEqual(relisted.unassigned_aliases,
    [{project_id:b.project_id,name:'Invest Atlas'}]);
  await error(relocated,'select_project',{project_id:b.project_id},/Unknown project_id/);
  await error(relocated,'recover_project_alias',{
    previous_project_id:b.project_id,new_project_id:newB.project_id,
    expected_alias:'Wrong Name'},/Expected old project alias does not match/);
  await error(relocated,'recover_project_alias',{
    previous_project_id:a.project_id,new_project_id:newB.project_id,
    expected_alias:'Some Alias'},/Old project is still configured/);
  await error(relocated,'recover_project_alias',{
    previous_project_id:b.project_id,new_project_id:'ws_unknown',
    expected_alias:'Invest Atlas'},/Destination project is not configured/);
  const namedA=await call(relocated,'set_project_alias',{
    project_id:a.project_id,alias:'Project A Saved'});
  assert.equal(namedA.isError??false,false,payload(namedA));
  await error(relocated,'recover_project_alias',{
    previous_project_id:b.project_id,new_project_id:a.project_id,
    expected_alias:'Invest Atlas'},/Destination already has a saved alias/);
  const unlinkedSummary=(await call(relocated,'select_project',{
    project_id:newB.project_id})).structuredContent;
  assert.equal(unlinkedSummary.name,'Project-B-Renamed');
  const historyBefore=(await call(relocated,'project_summary',{
    workspace_id:newB.project_id})).structuredContent;
  assert.match(historyBefore.sections['HISTORY.md'],/History: B-ORIGINAL/);
  assert.equal(historyBefore.active_task.goal,'Continue Project B independently');
  const recovered=await call(relocated,'recover_project_alias',{
    previous_project_id:b.project_id,new_project_id:newB.project_id,
    expected_alias:'Invest Atlas'});
  assert.equal(recovered.isError??false,false,payload(recovered));
  assert.equal(recovered.structuredContent.alias_recovered,true);
  assert.equal(recovered.structuredContent.git_identity_verified,false);
  assert.equal(recovered.structuredContent.project_files_changed,false);
  const afterRecover=(await call(relocated,'list_projects')).structuredContent;
  assert.equal(afterRecover.projects[1].name,'Invest Atlas');
  assert.deepEqual(afterRecover.unassigned_aliases,[]);
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(aliasRegistry,'utf8')).aliases,
    b.project_id),false);
  assert.equal((await call(relocated,'project_summary',{
    workspace_id:newB.project_id})).structuredContent.active_task.goal,
    'Continue Project B independently');
  assert.equal(await fs.readFile(path.join(movedB,'shared.txt'),'utf8'),'B-CHANGED\n');
  assert.equal(await fs.readFile(path.join(projectA,'shared.txt'),'utf8'),'A-UNCHANGED\n');
  await error(relocated,'recover_project_alias',{
    previous_project_id:b.project_id,new_project_id:newB.project_id,
    expected_alias:'Invest Atlas'},/No saved alias for old project ID/);
  console.log('PASS: moved Git repo retains task/history; old alias is unassigned until explicit safe recovery');


  const backup=await fs.readFile(aliasRegistry);
  await fs.writeFile(aliasRegistry,'not-json');
  await error(client,'list_projects',{},/registry unreadable or invalid/);
  await fs.writeFile(aliasRegistry,backup);
  const sentinel=path.join(temp,'outside-alias-content.json');
  await fs.writeFile(sentinel,'SENTINEL');
  await fs.rm(aliasRegistry);
  await fs.symlink(sentinel,aliasRegistry);
  await error(client,'set_project_alias',{project_id:b.project_id,alias:'Alias hijack'},/not a bounded ordinary file/);
  assert.equal(await fs.readFile(sentinel,'utf8'),'SENTINEL');
  console.log('PASS: invalid registry and symlink substitution refused without touching external file');
}finally {
  await Promise.allSettled(clients.map(c=>c.close()));
  await fs.rm(temp,{recursive:true,force:true});
}
