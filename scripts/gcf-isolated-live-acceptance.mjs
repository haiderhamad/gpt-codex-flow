#!/usr/bin/env node
/**
 * Owner-initiated, disposable, real GCF handoff acceptance.
 *
 * --preview never invokes a Codex model. --run requires the native
 * gcf-native-transfer-run.mjs owner-attended TTY confirmation; no
 * remote MCP execution route, no source repo modification and no
 * implicit subscription spending.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ownerNativeHandoff} from './gcf-native-transfer-run.mjs';

const bridge=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const expectedFile='src/message.mjs';
const before="export function message() { return 'before'; }\n";
const after="export function message() { return 'after'; }\n";
function git(root,args){
  const r=spawnSync('git',args,{cwd:root,encoding:'utf8',timeout:10000,shell:false});
  if(r.status!==0)throw Error('Disposable Git fixture refused: '+String(r.stderr).slice(0,150));
}
function test(root){
  return spawnSync(process.execPath,['--test','test/message.test.mjs'],{
    cwd:root,encoding:'utf8',timeout:12000,shell:false
  }).status;
}
async function clientFor(root,name,write){
  const client=new Client({name,version:'1.0.0'},{capabilities:{}});
  await client.connect(new StdioClientTransport({
    command:process.execPath,
    args:[path.join(bridge,'dist','stdio.js'),'--root',root,'--allow-root',root,
      '--tool-mode','standard','--write',write,'--bash','off'],
    cwd:bridge,env:{...process.env,CODEXBRIDGE_ROOT:root,CODEXBRIDGE_ALLOWED_ROOTS:root}
  }));
  return client;
}
function value(r,step){
  if(r.isError||!r.structuredContent)throw Error(step+': MCP refused.');
  return r.structuredContent;
}
export async function isolatedLiveAcceptance({
  run=false,searchPath=process.env.PATH??'',onPrepared
}={}){
  // The CLI itself, not an MCP caller, obtains exact per-task TTY consent.
  if(run&&!(process.stdin.isTTY&&process.stdout.isTTY))
    throw Error('Real isolated model acceptance requires an owner-attended local Terminal.');
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-isolated-acceptance-'));
  const root=path.join(base,'repo');
  let first,second;
  try{
    await fs.mkdir(path.join(root,'src'),{recursive:true});
    await fs.mkdir(path.join(root,'test'),{recursive:true});
    await fs.writeFile(path.join(root,'.gitignore'),'.ai-bridge/\n');
    await fs.writeFile(path.join(root,expectedFile),before);
    await fs.writeFile(path.join(root,'test/message.test.mjs'),
      "import test from 'node:test';\n"+
      "import assert from 'node:assert/strict';\n"+
      "import {message} from '../src/message.mjs';\n"+
      "test('implementation corrected',()=>assert.equal(message(),'after'));\n");
    git(root,['init','-q']);
    git(root,['add','.gitignore',expectedFile,'test/message.test.mjs']);
    git(root,['-c','user.name=Isolated Fixture','-c','user.email=fixture@example.invalid',
      'commit','-qm','baseline']);
    assert.equal(test(root),1,'disposable fixture must start with a failing unit test');
    first=await clientFor(root,'owner-prepared-chatgpt-task','workspace');
    const list=value(await first.callTool({name:'list_projects',arguments:{}}),'list projects');
    const canonicalRoot=await fs.realpath(root);
    const selected=list.projects.filter(p=>p.root===canonicalRoot);
    assert.equal(selected.length,1,'one exact disposable Git root is allowed');
    const project_id=selected[0].project_id;
    value(await first.callTool({name:'select_project',arguments:{project_id}}),'select');
    const task=value(await first.callTool({name:'task_plan',arguments:{
      workspace_id:project_id,
      goal:'Implement the minimal JavaScript correction in this disposable Git repository',
      target_paths:[expectedFile],
      plan_steps:["Change only src/message.mjs so message() returns 'after'.",
        'Do not modify task metadata, tests, other files, Git history or network.',
        'The owner will validate the unit test and Git diff after execution.']
    }}),'plan');
    const request=value(await first.callTool({name:'request_transfer',arguments:{
      workspace_id:project_id,task_id:task.task_id,
      from:'chatgpt_lead',to:'codex_lead',user_confirmed:true
    }}),'request transfer');
    const transfer_id=request.transfer.id;
    const accepted=value(await first.callTool({name:'accept_transfer',arguments:{
      workspace_id:project_id,transfer_id,recipient:'codex_lead',user_confirmed:true
    }}),'accept transfer');
    assert.equal(accepted.transfer.state,'accepted');
    await first.close();first=undefined;
    onPrepared?.({root,transfer_id});
    const preview=await ownerNativeHandoff({worktree:root,searchPath,run:false});
    assert.equal(preview.transfer_id,transfer_id);
    assert.equal(preview.status,'READY_FOR_OWNER_REVIEW');
    assert.deepEqual(preview.allowed_paths,[expectedFile]);
    const argv=preview.command_argv;
    assert.ok(argv.includes('--ignore-user-config')&&argv.includes('--ephemeral'));
    assert.ok(argv.includes('workspace-write'));
    assert.ok(argv.includes('sandbox_workspace_write.network_access=false'));
    if(!run)return {
      mode:'PREVIEW_ONLY',model_invoked:false,git_fixture_disposable:true,
      transfer_id,command_argv:argv,
      required_action:'Run locally in your own Terminal with --run and type the exact per-transfer phrase.'
    };
    const live=await ownerNativeHandoff({
      worktree:root,searchPath,run:true,returnToInbox:true
    });
    if(live.status!=='CODEX_PROCESS_EXITED_REVIEW_REQUIRED'||
       live.exit_code!==0||live.postflight_passed!==true||
       !live.return_note_posted)
      throw Error('Isolated Codex execution or Inbox return was not successful.');
    assert.deepEqual(live.changed_paths,[expectedFile]);
    assert.equal(await fs.readFile(path.join(root,expectedFile),'utf8'),after);
    assert.equal(test(root),0,'JavaScript unit test must pass after real CLI execution');
    // Only a fresh, READ-ONLY MCP session verifies the actual local Inbox receipt.
    second=await clientFor(root,'fresh-recipient-chatgpt-readonly','off');
    const listed=value(await second.callTool({name:'list_projects',arguments:{}}),'new session projects');
    assert.equal(listed.projects.length,1);
    value(await second.callTool({name:'select_project',arguments:{project_id}}),'select fresh');
    const inbox=value(await second.callTool({name:'task_inbox_list',arguments:{workspace_id:project_id}}),'list receipt');
    const note=inbox.entries.find(n=>n.task_id===task.task_id);
    if(!note)throw Error('Actual Codex handoff Inbox receipt missing in fresh session');
    const read=value(await second.callTool({name:'task_inbox_read',arguments:{
      workspace_id:project_id,message_id:note.id
    }}),'read receipt');
    assert.equal(read.message.task_id,task.task_id);
    assert.match(read.message.request,/Git review required|review required/i);
    return{
      status:'PASS_ISOLATED_OWNER_LIVE_CODEX',
      actual_codex_invoked:true,
      owner_typed_consent:true,
      isolated_cli_flags_verified:true,
      changed_paths:live.changed_paths,
      postflight_passed:true,
      node_unit_test_exit:0,
      fresh_readonly_mcp_receipt_verified:true,
      task_id:task.task_id,transfer_id,
      note:'Cli model identity and OS sandbox are not independently attested; this is a real local model-invocation path, not a full client-to-client live session takeover.'
    };
  }finally{
    await Promise.allSettled([first?.close(),second?.close()]);
    await fs.rm(base,{recursive:true,force:true});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.length!==1||!['--preview','--run'].includes(args[0])){
    process.stderr.write('Usage: node scripts/gcf-isolated-live-acceptance.mjs --preview | --run\n');
    process.exitCode=2;
  }else{
    isolatedLiveAcceptance({run:args[0]==='--run'})
      .then(v=>{process.stdout.write(JSON.stringify(v,null,2)+'\n');})
      .catch(err=>{process.stderr.write('ISOLATED_LIVE_ACCEPTANCE_REFUSED: '+String(err.message??err)+'\n');process.exitCode=2;});
  }
}
