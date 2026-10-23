import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runDisposableTrial, classifyCodexExecution } from './gcf-native-codex-trial.mjs';

const binRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gcf-native-trial-test-'));
const bin = path.join(binRoot, 'bin');
const sentinel = path.join(binRoot, 'FAKE_AGENT_RAN');
try {
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'codex'),
    '#!/bin/sh\n' + 'touch "' + sentinel + '"\nexit 99\n', { mode: 0o755 });
  const preview = await runDisposableTrial({run:false, searchPath:bin});
  assert.equal(preview.ready_for_owner_review, true);
  assert.equal(preview.codex_binary_detected, true);
  assert.equal(preview.actual_codex_execution, false);
  assert.equal(preview.user_confirmed, false);
  assert.equal(preview.live_result, null);
  assert.ok(Number.isInteger(preview.trusted_mcp_metadata_count));
  assert.ok(preview.trusted_mcp_metadata_count >= 0);
  assert.equal(preview.handoff.status, 'READY_FOR_OWNER_REVIEW');
  assert.equal(preview.handoff.git_snapshot_matches_transfer, true);
  assert.deepEqual(preview.handoff.allowed_paths, ['src/message.mjs']);
  assert.equal(preview.handoff.model_called, false);
  assert.equal(Object.hasOwn(preview.handoff, '_local_plan'), false);
  assert.equal(preview.handoff.agent_started, false);
  assert.deepEqual(preview.command_argv.slice(0, 6),
    ['codex','exec','--sandbox','workspace-write','--config','approval_policy=never']);
  assert.equal(preview.command_argv.includes('--ask-for-approval'), false,
    'codex exec rejects the global approval flag after the subcommand');
  assert.ok(preview.command_argv.includes('sandbox_workspace_write.network_access=false'));
  await assert.rejects(fs.access(sentinel), { code:'ENOENT' });
  await assert.rejects(fs.stat(preview.worktree), { code:'ENOENT' });
  console.log('PASS: preview produces sandboxed argv, fake Codex never executed, temporary workspace removed');
  const rejected = classifyCodexExecution({ stderr: "error: unexpected argument '--ask-for-approval' found\nUsage: codex exec [OPTIONS]" }, false);
  assert.equal(rejected.cli_argument_rejected, true);
  assert.equal(rejected.agent_started, false);
  assert.equal(rejected.model_request_verified, false);
  const uncertain = classifyCodexExecution({ stderr: 'auth service unreachable' }, false);
  assert.equal(uncertain.cli_argument_rejected, false);
  assert.equal(uncertain.agent_started, null);
  console.log('PASS: CLI argument rejection is not misreported as a started AI agent');

  await assert.rejects(
    runDisposableTrial({run:true,interactive:false,searchPath:bin}),
    /interactive terminal/
  );
  await assert.rejects(fs.access(sentinel), { code:'ENOENT' });
  const denied = spawnSync(process.execPath,
    ['scripts/gcf-native-codex-trial.mjs','--run'], {
      cwd: process.cwd(), env: {...process.env, PATH:bin + path.delimiter + process.env.PATH},
      encoding: 'utf8', timeout:10000
    });
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /interactive terminal/);
  await assert.rejects(fs.access(sentinel), { code:'ENOENT' });
  console.log('PASS: live mode refuses noninteractive invocations before any model call');

  const withoutCli = await runDisposableTrial({
    run:false,searchPath:path.join(binRoot,'empty')
  });
  assert.equal(withoutCli.ready_for_owner_review,false);
  assert.equal(withoutCli.codex_binary_detected,false);
  await assert.rejects(fs.stat(withoutCli.worktree), {code:'ENOENT'});
  console.log('PASS: absent Codex stays unready, fixture cleaned after preflight');

  // This only checks the connected Mac's CLI search PATH and never launches it.
  const localPreview = await runDisposableTrial({run:false});
  assert.equal(localPreview.actual_codex_execution,false);
  console.log('CONNECTED MAC Codex executable candidate:',
    localPreview.codex_binary_detected ? 'detected (version/auth unverified)' : 'not found in connected PATH');
} finally {
  await fs.rm(binRoot, {recursive:true,force:true});
}
