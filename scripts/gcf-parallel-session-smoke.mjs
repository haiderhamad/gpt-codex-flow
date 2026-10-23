// GPT Codex Flow: two real MCP clients with role CLAIMS, not native AI clients.
// Both independently write into disposable Git worktrees; coordinator waits for
// results and generates a non-destructive synchronization preview.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  createParallelSession, readParallelSession, reportParallelRole, previewParallelSession
} from './gcf-parallel-session.mjs';
import { exportParallelReviewBundle } from './gcf-parallel-review.mjs';
import { verifyParallelReviewBundle } from './gcf-parallel-verify.mjs';
import { previewParallelNativeCodex } from './gcf-parallel-native-preflight.mjs';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gcf-parallel-coordinator-'));
const base = path.join(temp, 'base');
const chatRoot = path.join(temp, 'chatgpt');
const codexRoot = path.join(temp, 'codex');
const stateRoot = path.join(base, '.ai-bridge');
const extraChat = path.join(temp, 'chatgpt-negative');
const extraCodex = path.join(temp, 'codex-negative');
const clients = [];
function git(dir, ...args) {
  const r = spawnSync('git', args, {cwd:dir,encoding:'utf8',timeout:12000});
  assert.equal(r.status, 0, r.stderr || r.stdout);
}
async function connect(root, role) {
  const client = new Client({ name: role + '-simulated-mcp-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['dist/stdio.js', '--root', root, '--allow-root', root,
      '--write', 'workspace', '--bash', 'off', '--tool-mode', 'standard'],
    cwd: process.cwd(),
    env: {
      PATH:process.env.PATH ?? '/usr/bin:/bin', HOME:temp, TMPDIR:temp,
      CODEXBRIDGE_ROOT:root, CODEXBRIDGE_ALLOWED_ROOTS:root,
      CODEXBRIDGE_BASH_MODE:'off', CODEXBRIDGE_WRITE_MODE:'workspace',
      NO_COLOR:'1'
    }
  }));
  clients.push(client);
  return client;
}
const call = (client, name, args) => client.callTool({name,arguments:args});
const tasks = {
  chatgpt: {task:'Update UI copy', target_paths:['src/ui.txt']},
  codex: {task:'Update API contract', target_paths:['src/api.txt']}
};
try {
  await fs.mkdir(path.join(base, 'src'), {recursive:true});
  await fs.writeFile(path.join(base,'.gitignore'),'.ai-bridge/\n');
  await fs.writeFile(path.join(base,'src','ui.txt'),'ui base\n');
  await fs.writeFile(path.join(base,'src','api.txt'),'api base\n');
  git(base,'init','-q');
  git(base,'add','.gitignore','src');
  git(base,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
    'commit','-q','-m','fixture baseline');
  git(base,'worktree','add','-q','-b','gcf-coord-chatgpt',chatRoot,'HEAD');
  git(base,'worktree','add','-q','-b','gcf-coord-codex',codexRoot,'HEAD');

  const session = await createParallelSession({
    dir:stateRoot, base, chatgpt:chatRoot, codex:codexRoot,
    goal:'Independent ChatGPT and Codex changes with coordinated review', assignments:tasks
  });
  assert.equal(session.status,'planned');
  assert.ok(session.paths_redacted);
  assert.equal(session.worktrees, undefined);

  // Non-executing native Codex preflight before independent MCP role edits.
  const fakeBin = path.join(temp, 'fake-native-bin');
  const sentinel = path.join(temp, 'NATIVE_CODEX_RAN');
  await fs.mkdir(fakeBin);
  await fs.writeFile(path.join(fakeBin, 'codex'),
    '#!/bin/sh\ntouch "' + sentinel + '"\nexit 99\n', {mode:0o755});
  const parallelNative = await previewParallelNativeCodex({
    dir:stateRoot,session_id:session.session_id,searchPath:fakeBin
  });
  assert.equal(parallelNative.status,'READY_FOR_OWNER_REVIEW');
  assert.deepEqual(parallelNative.owned_paths,['src/api.txt']);
  assert.deepEqual(parallelNative.peer_owned_paths,['src/ui.txt']);
  assert.equal(parallelNative.native_codex_invoked,false);
  assert.equal(parallelNative.role_identity_verified,false);
  assert.equal(parallelNative.os_sandbox_enforcement_verified,false);
  assert.equal(Object.hasOwn(parallelNative,'_local_plan'),false);
  const localPlan = await previewParallelNativeCodex({
    dir:stateRoot,session_id:session.session_id,searchPath:fakeBin,includeLocalPlan:true
  });
  assert.match(localPlan._local_plan,/Only edit the following tracked files:/);
  assert.equal(createHash('sha256').update(localPlan._local_plan).digest('hex'),
    localPlan.plan_sha256);
  const missingBinary = await previewParallelNativeCodex({
    dir:stateRoot,session_id:session.session_id,searchPath:path.join(temp,'absent-bin')
  });
  assert.equal(missingBinary.status,'BLOCKED');
  assert.equal(missingBinary.native_codex_invoked,false);
  await assert.rejects(fs.stat(sentinel),{code:'ENOENT'});
  const cliArgs=['scripts/gcf-parallel-native-preflight.mjs','--state-dir',stateRoot,
    '--session-id',session.session_id];
  const runCli=(extra=[])=>spawnSync(process.execPath,[...cliArgs,...extra],{
    cwd:process.cwd(),encoding:'utf8',timeout:15000,
    env:{...process.env,PATH:fakeBin+path.delimiter+(process.env.PATH??'')}
  });
  const cliPreview=runCli();
  assert.equal(cliPreview.status,0,cliPreview.stderr);
  assert.equal(JSON.parse(cliPreview.stdout).status,'READY_FOR_OWNER_REVIEW');
  assert.equal(Object.hasOwn(JSON.parse(cliPreview.stdout),'_local_plan'),false);
  const cliReview=runCli(['--show-plan']);
  assert.equal(cliReview.status,0,cliReview.stderr);
  assert.equal(JSON.parse(cliReview.stdout).plan_sha256,localPlan.plan_sha256);
  assert.equal(JSON.parse(cliReview.stdout)._local_plan,localPlan._local_plan);
  await assert.rejects(fs.stat(sentinel),{code:'ENOENT'});
  const savedSession=await fs.readFile(path.join(stateRoot,'parallel-session.json'),'utf8');
  const conflicting=JSON.parse(savedSession);
  conflicting.roles.codex.target_paths=['src/ui.txt'];
  await fs.writeFile(path.join(stateRoot,'parallel-session.json'),JSON.stringify(conflicting,null,2)+'\n');
  await assert.rejects(previewParallelNativeCodex({
    dir:stateRoot,session_id:session.session_id,searchPath:fakeBin
  }),/Disjoint safe owned file/);
  await fs.writeFile(path.join(stateRoot,'parallel-session.json'),savedSession);
  await assert.rejects(previewParallelNativeCodex({
    dir:stateRoot,session_id:'parallel_'+ '0'.repeat(36),searchPath:fakeBin
  }),/matching planned/);
  await fs.appendFile(path.join(codexRoot,'src/api.txt'),'unsanctioned premature edit\n');
  await assert.rejects(previewParallelNativeCodex({
    dir:stateRoot,session_id:session.session_id,searchPath:fakeBin
  }),/clean independent worktrees/);
  await fs.writeFile(path.join(codexRoot,'src/api.txt'),'api base\n');
  console.log('PASS: native Codex role preflight verifies assigned clean worktrees and never runs a model');

  const [chat, cod, watcher] = await Promise.all([
    connect(chatRoot,'chatgpt'), connect(codexRoot,'codex'), connect(base,'coordinator-observer')
  ]);
  const statusTool = (await watcher.listTools()).tools.find(x => x.name === 'parallel_session_status');
  assert.equal(statusTool?.annotations?.readOnlyHint, true);
  const statusBefore = await call(watcher, 'parallel_session_status', {});
  assert.ok(!statusBefore.isError, JSON.stringify(statusBefore));
  assert.equal(statusBefore.structuredContent.session_id, session.session_id);
  assert.equal(statusBefore.structuredContent.status, 'planned');
  assert.equal(statusBefore.structuredContent.client_identity_verified, false);
  assert.equal(statusBefore.structuredContent.merged_into_original, false);
  assert.equal(JSON.stringify(statusBefore.structuredContent).includes(chatRoot), false,
    'MCP must not leak absolute worker locations');
  const initial = await Promise.all([
    call(chat,'read',{path:'src/ui.txt'}),
    call(cod,'read',{path:'src/api.txt'})
  ]);
  assert.ok(initial.every((v)=>!v.isError), JSON.stringify(initial));
  const [editChat, editCod] = await Promise.all([
    call(chat,'edit',{path:'src/ui.txt',old_text:'ui base',new_text:'chatgpt updated UI'}),
    call(cod,'edit',{path:'src/api.txt',old_text:'api base',new_text:'codex updated API'})
  ]);
  assert.ok(!editChat.isError,JSON.stringify(editChat));
  assert.ok(!editCod.isError,JSON.stringify(editCod));
  await assert.rejects(previewParallelSession({dir:stateRoot,session_id:session.session_id}),
    /Both roles must report/);
  const earlyBundle = path.join(temp, 'bundle-before-reports');
  await assert.rejects(exportParallelReviewBundle({
    dir:stateRoot, session_id:session.session_id, outputDir:earlyBundle
  }), /Only a verified, successful review preview/);
  await assert.rejects(fs.stat(earlyBundle), {code:'ENOENT'});

  await Promise.all([
    reportParallelRole({dir:stateRoot,session_id:session.session_id,
      role:'chatgpt', evidence:'MCP changed src/ui.txt; review pending'}),
    reportParallelRole({dir:stateRoot,session_id:session.session_id,
      role:'codex', evidence:'MCP changed src/api.txt; review pending'})
  ]);
  // Both reporting calls are serialized through the on-disk lock. If they race,
  // one is intentionally denied and must reload; this is NOT a queue.
  const prepared = await readParallelSession(stateRoot);
  assert.equal(prepared.status,'ready_to_preview');
  const statusDuring = await call(watcher, 'parallel_session_status', {});
  assert.ok(!statusDuring.isError, JSON.stringify(statusDuring));
  assert.equal(statusDuring.structuredContent.status, 'ready_to_preview');
  assert.equal(statusDuring.structuredContent.roles.chatgpt.evidence_submitted, true);
  assert.equal(statusDuring.structuredContent.roles.codex.evidence_submitted, true);
  assert.equal(JSON.stringify(statusDuring.structuredContent).includes('review pending'), false,
    'Raw evidence must remain private');
  const preview = await previewParallelSession({dir:stateRoot,session_id:session.session_id});
  assert.equal(preview.status,'PASS',JSON.stringify(preview));
  assert.deepEqual(preview.paths,['src/api.txt','src/ui.txt']);
  assert.equal(preview.applied_to_original,false);
  assert.equal(preview.requires_owner_merge_approval,true);
  const statusAfter = await call(watcher, 'parallel_session_status', {});
  assert.ok(!statusAfter.isError, JSON.stringify(statusAfter));
  assert.equal(statusAfter.structuredContent.status, 'preview_verified');
  assert.equal(statusAfter.structuredContent.preview.status, 'PASS');
  assert.deepEqual(statusAfter.structuredContent.preview.paths, ['src/api.txt', 'src/ui.txt']);
  assert.equal(statusAfter.structuredContent.merged_into_original, false);
  const reviewRoot = path.join(temp, 'integration-review');
  const exported = await exportParallelReviewBundle({
    dir:stateRoot, session_id:session.session_id, outputDir:reviewRoot
  });
  assert.equal(exported.merged, false);
  assert.equal(exported.requires_owner_merge_approval, true);
  const patchText = await fs.readFile(exported.patch_file, 'utf8');
  const manifest = JSON.parse(await fs.readFile(exported.manifest_file, 'utf8'));
  assert.match(patchText, /chatgpt updated UI/);
  assert.match(patchText, /codex updated API/);
  assert.deepEqual(manifest.combined_paths, ['src/api.txt','src/ui.txt']);
  assert.equal(manifest.combined_patch_sha256,
    createHash('sha256').update(patchText).digest('hex'));
  assert.equal(manifest.worker_identity_verified, false);
  assert.equal(manifest.post_merge_tests_executed, false);
  assert.equal(manifest.owner_merge_approval_required, true);
  assert.equal(JSON.stringify(manifest).includes(chatRoot), false);
  assert.equal(JSON.stringify(manifest).includes(codexRoot), false);
  assert.equal(JSON.stringify(manifest).includes(base), false);
  // Complete the same dual-MCP-client session with a *separate* local bundle verifier:
  // replay both role patches into an isolated clone, never into base.
  const verified = await verifyParallelReviewBundle({base, reviewDir:reviewRoot});
  assert.equal(verified.status, 'PASS');
  assert.equal(verified.patch_replay_verified, true);
  assert.equal(verified.source_repo_modified, false);
  assert.equal(verified.merge_performed, false);
  assert.equal(verified.worker_identity_verified, false);
  assert.equal(verified.owner_merge_approval_required, true);
  assert.deepEqual(verified.reviewed_paths, ['src/api.txt', 'src/ui.txt']);
  assert.equal(verified.combined_patch_sha256, manifest.combined_patch_sha256);
  assert.equal(await fs.readFile(path.join(base,'src/ui.txt'),'utf8'),'ui base\n');
  assert.equal(await fs.readFile(path.join(base,'src/api.txt'),'utf8'),'api base\n');
  console.log('PASS: two real MCP worker connections -> verified role reports -> exported review bundle -> isolated premerge patch replay');
  const intactPatch = await fs.readFile(exported.patch_file);
  await fs.appendFile(exported.patch_file, '\n#tampered-review');
  await assert.rejects(verifyParallelReviewBundle({base,reviewDir:reviewRoot}), /integrity/);
  await fs.writeFile(exported.patch_file, intactPatch);
  await fs.writeFile(path.join(base,'src/ui.txt'), 'tampered base\n');
  await assert.rejects(verifyParallelReviewBundle({base,reviewDir:reviewRoot}), /dirty/);
  await fs.writeFile(path.join(base,'src/ui.txt'), 'ui base\n');
  assert.equal((await verifyParallelReviewBundle({base,reviewDir:reviewRoot})).status,'PASS');
  console.log('PASS: tampered review and dirty original are rejected after real MCP reports');
  await assert.rejects(exportParallelReviewBundle({
    dir:stateRoot, session_id:session.session_id, outputDir:reviewRoot
  }), {code:'EEXIST'});
  await assert.rejects(exportParallelReviewBundle({
    dir:stateRoot, session_id:session.session_id,
    outputDir:path.join(chatRoot, 'review-in-worktree')
  }), /outside all project and agent worktrees/);
  const cliRoot = path.join(temp, 'integration-review-cli');
  const cli = spawnSync(process.execPath, [
    'scripts/gcf-parallel-review.mjs', '--state-dir', stateRoot,
    '--session-id', session.session_id, '--out', cliRoot
  ], {cwd:process.cwd(), encoding:'utf8',timeout:20000});
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  const cliResult = JSON.parse(cli.stdout);
  assert.equal(cliResult.merged, false);
  assert.equal((await fs.readFile(cliResult.patch_file)).equals(
    await fs.readFile(exported.patch_file)), true);
  console.log('PASS: explicit local CLI produces identical, reviewable patch without source changes');
  console.log('PASS: independent local review bundle exports verified combined patch + SHA-256 only outside source worktrees');
  await fs.appendFile(path.join(chatRoot, 'src/ui.txt'), 'edit after review preview\n');
  const outdatedReview = path.join(temp,'outdated-review');
  await assert.rejects(exportParallelReviewBundle({
    dir:stateRoot, session_id:session.session_id, outputDir:outdatedReview
  }), /Git changes differ from the verified session/);
  await assert.rejects(fs.stat(outdatedReview), {code:'ENOENT'});
  console.log('PASS: review export refuses modified role patch after verified preview');
  assert.equal(await fs.readFile(path.join(base,'src','ui.txt'),'utf8'),'ui base\n');
  assert.equal(await fs.readFile(path.join(base,'src','api.txt'),'utf8'),'api base\n');
  await assert.rejects(reportParallelRole({
    dir:stateRoot,session_id:session.session_id,role:'codex',evidence:'replay'
  }),/closed for reports/);
  console.log('PASS: two independent real MCP connections update separate worktrees');
  console.log('PASS: coordinator role reports + live read-only MCP status across planned/ready/verified states; no original merge');

  git(base,'worktree','add','-q','-b','gcf-negative-chat',extraChat,'HEAD');
  git(base,'worktree','add','-q','-b','gcf-negative-cod',extraCodex,'HEAD');
  const badDir = path.join(temp,'negative-state');
  const negative = await createParallelSession({
    dir:badDir,base,chatgpt:extraChat,codex:extraCodex,
    goal:'Reject edits outside assigned role paths',assignments:tasks
  });
  await assert.rejects(reportParallelRole({
    dir:badDir,session_id:negative.session_id,role:'chatgpt',evidence:'no edit yet'
  }), /no verified changes/);
  await fs.appendFile(path.join(extraChat,'src/api.txt'),'unauthorized UI worker touched API\n');
  await fs.appendFile(path.join(extraCodex,'src/api.txt'),'assigned API edit\n');
  await assert.rejects(reportParallelRole({
    dir:badDir,session_id:negative.session_id,role:'chatgpt',evidence:'wrong path'
  }), /unassigned file|Unsafe or stale Git baseline/);
  await fs.writeFile(path.join(extraChat,'src/api.txt'),'api base\n');
  await fs.appendFile(path.join(extraChat,'src/ui.txt'),'assigned UI edit\n');
  await reportParallelRole({dir:badDir,session_id:negative.session_id,role:'chatgpt',evidence:'real UI edit'});
  await reportParallelRole({dir:badDir,session_id:negative.session_id,role:'codex',evidence:'real API edit'});
  await fs.appendFile(path.join(extraChat,'src/ui.txt'),'modified after reporting\n');
  const denied = await previewParallelSession({dir:badDir,session_id:negative.session_id});
  assert.equal(denied.status,'BLOCKED');
  assert.ok(denied.reasons.includes('ROLE_CHANGED_AFTER_REPORT'));
  await assert.rejects(previewParallelSession({dir:badDir,session_id:negative.session_id}),
    /Both roles must report/);
  console.log('PASS: empty/out-of-scope reports rejected; edits after report invalidate preview');
  console.log('NOTE: role names are unauthenticated claims; no AI agents or actual merge ran');
} finally {
  await Promise.allSettled(clients.map((c)=>c.close()));
  await fs.rm(temp,{recursive:true,force:true});
}
