import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {preparePublicSource} from './gcf-public-source-prepare.mjs';

const parent=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-release-prepare-smoke-'));
try{
  const preview=await preparePublicSource();
  assert.equal(preview.status,'READY_FOR_OWNER_PREPARATION');
  assert.equal(preview.commit_created,false);
  assert.equal(preview.push_performed,false);
  const destination=path.join(parent,'gcf-new');
  const prepared=await preparePublicSource({run:true,destination});
  assert.equal(prepared.status,'LOCAL_CLEAN_GIT_INDEX_PREPARED');
  assert.equal(prepared.files_staged,preview.selected_count);
  assert.equal(prepared.commit_created,false);
  assert.equal(prepared.push_performed,false);
  assert.equal(prepared.original_git_modified,false);
  const git=(...args)=>{
    const p=spawnSync('git',['-C',destination,...args],{encoding:'utf8',timeout:18000});
    assert.equal(p.status,0,'Git fixture command failed: '+args[0]);
    return p.stdout.trim();
  };
  assert.equal(git('rev-list','--all'),'');
  assert.equal(git('remote','-v'),'');
  assert.equal(git('branch','--show-current'),'main');
  assert.equal(git('diff','--cached','--check'),'');
  assert.equal(git('ls-files').split('\n').filter(Boolean).length,preview.selected_count);
  await assert.rejects(
    preparePublicSource({run:true,destination}),
    {code:'EEXIST'}
  );
  assert.equal(git('rev-list','--all'),'');
  console.log('PASS: independent '+preview.selected_count+
    '-file initial Git index prepared, no old commits/remote/push, existing destination refused.');
}finally{
  await fs.rm(parent,{recursive:true,force:true});
}
