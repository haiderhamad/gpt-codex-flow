import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {verifyParallelReviewBundle} from './gcf-parallel-verify.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-premerge-test-'));
const base=path.join(temp,'base'),chat=path.join(temp,'chat'),cod=path.join(temp,'cod');
const clone=path.join(temp,'clone'),bundle=path.join(temp,'review');
function git(cwd,...args){const r=spawnSync('git',args,{cwd,encoding:null,timeout:15000});assert.equal(r.status,0,String(r.stderr));return r.stdout;}
const diff=cwd=>git(cwd,'diff','--binary','--no-ext-diff','--no-textconv','HEAD','--');
try{
 await fs.mkdir(path.join(base,'src'),{recursive:true});
 await fs.writeFile(path.join(base,'src/ui.txt'),'ui original\n');
 await fs.writeFile(path.join(base,'src/api.txt'),'api original\n');
 git(base,'init','-q');git(base,'add','.');
 git(base,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','fixture');
 const head=git(base,'rev-parse','HEAD').toString().trim();
 git(base,'worktree','add','-q','-b','test-chat',chat,'HEAD');
 git(base,'worktree','add','-q','-b','test-cod',cod,'HEAD');
 await fs.appendFile(path.join(chat,'src/ui.txt'),'chat change\n');
 await fs.appendFile(path.join(cod,'src/api.txt'),'codex change\n');
 git(base,'clone','-q','--no-local','--',base,clone);
 for(const root of [chat,cod]){const r=spawnSync('git',['apply','-'],{cwd:clone,input:diff(root)});assert.equal(r.status,0,String(r.stderr));}
 const patch=diff(clone);await fs.mkdir(bundle);
 await fs.writeFile(path.join(bundle,'combined.patch'),patch);
 const manifest={schema:1,session_id:'parallel_'+randomUUID(),base_head:head,preview_status:'PASS',original_modified:false,merge_performed:false,owner_merge_approval_required:true,combined_paths:['src/api.txt','src/ui.txt'],combined_patch_file:'combined.patch',combined_patch_sha256:sha(patch),combined_patch_bytes:patch.length,participants:{chatgpt:{completion_reported:true,changed_paths:['src/ui.txt'],patch_sha256:sha(diff(chat))},codex:{completion_reported:true,changed_paths:['src/api.txt'],patch_sha256:sha(diff(cod))}}};
 const save=m=>fs.writeFile(path.join(bundle,'manifest.json'),JSON.stringify(m,null,2));
 await save(manifest);
 const ok=await verifyParallelReviewBundle({base,reviewDir:bundle});
 assert.equal(ok.status,'PASS');assert.deepEqual(ok.reviewed_paths,manifest.combined_paths);
 assert.equal(ok.merge_performed,false);
 console.log('PASS: isolated patch replay and checksum, no source merge');
 await fs.appendFile(path.join(bundle,'combined.patch'),'\n#tamper');await assert.rejects(verifyParallelReviewBundle({base,reviewDir:bundle}),/integrity/);
 await fs.writeFile(path.join(bundle,'combined.patch'),patch);
 await save({...manifest,participants:{...manifest.participants,codex:{...manifest.participants.codex,changed_paths:['src/ui.txt']}}});
 await assert.rejects(verifyParallelReviewBundle({base,reviewDir:bundle}),/exclusively/);
 await save(manifest);
 await fs.appendFile(path.join(base,'src/ui.txt'),'dirty');await assert.rejects(verifyParallelReviewBundle({base,reviewDir:bundle}),/dirty/);
 await fs.writeFile(path.join(base,'src/ui.txt'),'ui original\n');
 await save({...manifest,base_head:'0'.repeat(40)});await assert.rejects(verifyParallelReviewBundle({base,reviewDir:bundle}),/HEAD/);
 await save(manifest);
 console.log('PASS: tamper, ownership conflict, dirty and stale base denied');
}finally{await fs.rm(temp,{recursive:true,force:true});}
