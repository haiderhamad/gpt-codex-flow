import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {isolatedLiveAcceptance} from './gcf-isolated-live-acceptance.mjs';

const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-isolated-acceptance-smoke-'));
const bin=path.join(tmp,'bin'),sentinel=path.join(tmp,'model-would-run');
try{
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin,'codex'),
    '#!/bin/sh\ntouch "'+sentinel+'"\nexit 98\n',{mode:0o755});
  const preview=await isolatedLiveAcceptance({searchPath:bin,run:false});
  assert.equal(preview.mode,'PREVIEW_ONLY');
  assert.equal(preview.model_invoked,false);
  assert.ok(preview.command_argv.includes('--ignore-user-config'));
  assert.ok(preview.command_argv.includes('--ephemeral'));
  assert.ok(preview.command_argv.includes('sandbox_workspace_write.network_access=false'));
  assert.equal(preview.git_fixture_disposable,true);
  await assert.rejects(fs.access(sentinel),{code:'ENOENT'});
  const nonTTY=spawnSync(process.execPath,['scripts/gcf-isolated-live-acceptance.mjs','--run'],
    {cwd:process.cwd(),encoding:'utf8',timeout:10000,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH}});
  assert.equal(nonTTY.status,2);
  assert.match(nonTTY.stderr,/owner-attended local Terminal/);
  await assert.rejects(fs.access(sentinel),{code:'ENOENT'});
  console.log('PASS: disposable GCF native accepted transfer, exact isolated production argv and no model invocation in preview; non-TTY cannot run');
}finally{await fs.rm(tmp,{recursive:true,force:true})}
