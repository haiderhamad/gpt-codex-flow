import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {inspectNativeCodexPostflight,snapshotProtectedNativeFiles,snapshotManagedMcpMetadata} from './gcf-native-codex-postflight.mjs';
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-postflight-'));
const root=path.join(tmp,'repo');
const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
try{
 await fs.mkdir(path.join(root,'src'),{recursive:true});
 await fs.mkdir(path.join(root,'.ai-bridge'));
 await fs.writeFile(path.join(root,'.gitignore'),'.ai-bridge/\n');
 await fs.writeFile(path.join(root,'src/message.mjs'),'before\n');
 await fs.writeFile(path.join(root,'src/other.txt'),'keep\n');
 await fs.writeFile(path.join(root,'.ai-bridge/current-task.json'),'{"task":"fixture"}\n');
 git('init','-q');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-q','-m','baseline');
 const head=git('rev-parse','HEAD'),allowedPaths=['src/message.mjs'];
 const hashes=await snapshotProtectedNativeFiles({worktree:root,paths:['.ai-bridge/current-task.json']});
 const check=()=>inspectNativeCodexPostflight({worktree:root,expectedHead:head,allowedPaths,protectedHashes:hashes});
 await fs.writeFile(path.join(root,'src/message.mjs'),'after\n');
 assert.equal((await check()).passed,true);
 // A Git fsmonitor configured inside an agent-controlled repository must not
 // execute while the postflight inspector gathers its read-only Git evidence.
 const monitor=path.join(tmp,'fsmonitor-canary.sh'),marker=path.join(tmp,'FSMONITOR_INVOKED');
 await fs.writeFile(monitor,'#!/bin/sh\ntouch "'+marker+'"\nexit 3\n',{mode:0o755});
 git('config','core.fsmonitor',monitor);
 assert.equal((await check()).passed,true);
 await assert.rejects(fs.access(marker),{code:'ENOENT'});
 git('config','--unset','core.fsmonitor');
 await fs.writeFile(path.join(root,'src/other.txt'),'tampered\n');
 assert.ok((await check()).reasons.includes('OUT_OF_SCOPE_CHANGE'));
 await fs.writeFile(path.join(root,'src/other.txt'),'keep\n');
 await fs.rm(path.join(root,'src/message.mjs'));
 assert.ok((await check()).reasons.includes('UNSUPPORTED_CHANGE_TYPE'));
 await fs.symlink('other.txt',path.join(root,'src/message.mjs'));
 const symlink=await check();assert.equal(symlink.passed,false);
 assert.ok(symlink.reasons.includes('UNSAFE_FILE_PATH'));
 await fs.rm(path.join(root,'src/message.mjs'));
 await fs.writeFile(path.join(root,'src/message.mjs'),'after\n');
 // Ignored files are invisible to ordinary git status but must never be accepted.
 await fs.writeFile(path.join(root,'.ai-bridge/hidden-agent-output.log'),'not permitted\n');
 const hidden=await check();
 assert.equal(hidden.passed,false);
 assert.ok(hidden.reasons.includes('UNEXPECTED_IGNORED_FILES'));
 assert.equal(hidden.ignored_outputs_rejected,true);
 await fs.rm(path.join(root,'.ai-bridge/hidden-agent-output.log'));
 assert.equal((await check()).passed,true);
 // Only the trusted bridge fixture's *known* metadata filenames are exempted.
 await fs.writeFile(path.join(root,'.ai-bridge/agent-status.md'),'bridge fixture metadata\n');
 assert.ok((await check()).reasons.includes('UNEXPECTED_IGNORED_FILES'));
 const managedHashes=await snapshotManagedMcpMetadata({worktree:root,protectedHashes:hashes});
 const managed=()=>inspectNativeCodexPostflight({worktree:root,expectedHead:head,
   allowedPaths,protectedHashes:hashes,managedMcpHashes:managedHashes});
 assert.equal((await managed()).passed,true);
 await fs.writeFile(path.join(root,'.ai-bridge/agent-status.md'),'tampered metadata\n');
 assert.ok((await managed()).reasons.includes('MANAGED_MCP_METADATA_CHANGED'));
 await fs.writeFile(path.join(root,'.ai-bridge/agent-status.md'),'bridge fixture metadata\n');
 assert.equal((await managed()).passed,true);
 await fs.writeFile(path.join(root,'.ai-bridge/sneaky.txt'),'hidden extra\n');
 assert.ok((await managed()).reasons.includes('UNEXPECTED_IGNORED_FILES'));
 await assert.rejects(snapshotManagedMcpMetadata({worktree:root,protectedHashes:hashes}),/Unexpected or unsafe/);
 await fs.rm(path.join(root,'.ai-bridge/sneaky.txt'));
 await fs.rm(path.join(root,'.ai-bridge/agent-status.md'));
 await fs.symlink(path.join(root,'src/other.txt'),path.join(root,'.ai-bridge/agent-status.md'));
 assert.ok((await managed()).reasons.includes('UNSAFE_MCP_METADATA'));
 await assert.rejects(snapshotManagedMcpMetadata({worktree:root,protectedHashes:hashes}),/Unexpected or unsafe/);
 await fs.rm(path.join(root,'.ai-bridge/agent-status.md'));
 await fs.mkdir(path.join(root,'.ai-bridge/hidden-dir'));
 await fs.writeFile(path.join(root,'.ai-bridge/hidden-dir/secret.txt'),'unexpected\n');
 assert.ok((await managed()).reasons.includes('UNEXPECTED_IGNORED_FILES'));
 await fs.rm(path.join(root,'.ai-bridge/hidden-dir'),{recursive:true,force:true});
 assert.equal((await check()).passed,true);
 // The journal's exact observed-checkpoint sibling is managed only when a
 // trusted inventory captures it. Native workers still receive no exemption.
 const checkpoint=path.join(root,'.ai-bridge/continuity-checkpoint.json');
 const checkpointBody=JSON.stringify({schema_version:1,evidence:'gcf_operation_journal'});
 await fs.writeFile(checkpoint,checkpointBody);
 assert.ok((await check()).reasons.includes('UNEXPECTED_IGNORED_FILES'));
 const checkpointHashes=await snapshotManagedMcpMetadata({worktree:root,protectedHashes:hashes});
 assert.ok(Object.hasOwn(checkpointHashes,'.ai-bridge/continuity-checkpoint.json'));
 const checkpointCheck=()=>inspectNativeCodexPostflight({worktree:root,expectedHead:head,
   allowedPaths,protectedHashes:hashes,managedMcpHashes:checkpointHashes});
 assert.equal((await checkpointCheck()).passed,true);
 await fs.writeFile(checkpoint,'tampered checkpoint');
 assert.ok((await checkpointCheck()).reasons.includes('MANAGED_MCP_METADATA_CHANGED'));
 await fs.unlink(checkpoint);
 assert.ok((await checkpointCheck()).reasons.includes('MANAGED_MCP_METADATA_CHANGED'));
 await fs.symlink(path.join(root,'src/other.txt'),checkpoint);
 assert.ok((await checkpointCheck()).reasons.includes('UNSAFE_MCP_METADATA'));
 await assert.rejects(snapshotManagedMcpMetadata({worktree:root,protectedHashes:hashes}),/Unexpected or unsafe/);
 await fs.unlink(checkpoint);
 await fs.writeFile(checkpoint,checkpointBody);
 const checkpointTemp=path.join(root,'.ai-bridge/.gcf-checkpoint-11111111-1111-4111-8111-111111111111.tmp');
 await fs.writeFile(checkpointTemp,'unapproved temporary output');
 assert.ok((await checkpointCheck()).reasons.includes('UNEXPECTED_IGNORED_FILES'));
 await assert.rejects(snapshotManagedMcpMetadata({worktree:root,protectedHashes:hashes}),/Unexpected or unsafe/);
 await fs.unlink(checkpointTemp);await fs.unlink(checkpoint);
 assert.equal((await check()).passed,true);
 // Earlier durable Inbox receipts are immutable baseline metadata, permitting
 // the next accepted task without allowing the native child to add/modify notes.
 const inboxDir=path.join(root,'.ai-bridge/task-inbox');
 await fs.mkdir(inboxDir);
 const oldNote=path.join(inboxDir,'inbox_11111111-1111-4111-8111-111111111111.json');
 await fs.writeFile(oldNote,'{"fixture":"prior receipt"}');
 const inboxHashes=await snapshotManagedMcpMetadata({worktree:root,protectedHashes:hashes});
 const inboxCheck=()=>inspectNativeCodexPostflight({worktree:root,expectedHead:head,
   allowedPaths,protectedHashes:hashes,managedMcpHashes:inboxHashes});
 assert.equal((await inboxCheck()).passed,true);
 await fs.writeFile(oldNote,'{"fixture":"forged receipt"}');
 assert.ok((await inboxCheck()).reasons.includes('MANAGED_MCP_METADATA_CHANGED'));
 await fs.writeFile(oldNote,'{"fixture":"prior receipt"}');
 const newNote=path.join(inboxDir,'inbox_22222222-2222-4222-8222-222222222222.json');
 await fs.writeFile(newNote,'{}');
 assert.ok((await inboxCheck()).reasons.includes('UNEXPECTED_IGNORED_FILES'));
 await fs.unlink(newNote);await fs.unlink(oldNote);
 await fs.writeFile(path.join(inboxDir,'arbitrary.json'),'{}');
 await assert.rejects(snapshotManagedMcpMetadata({worktree:root,protectedHashes:hashes}),/Unexpected or unsafe/);
 await fs.unlink(path.join(inboxDir,'arbitrary.json'));
 await fs.writeFile(path.join(root,'new.txt'),'untracked');
 assert.ok((await check()).reasons.includes('UNTRACKED_FILES'));
 await fs.rm(path.join(root,'new.txt'));
 git('add','src/message.mjs');
 assert.ok((await check()).reasons.includes('STAGED_CHANGES'));
 git('reset','-q','HEAD','--','src/message.mjs');
 await fs.writeFile(path.join(root,'.ai-bridge/current-task.json'),'{"task":"changed"}\n');
 assert.ok((await check()).reasons.includes('PROTECTED_RECORD_CHANGED'));
 await fs.writeFile(path.join(root,'.ai-bridge/current-task.json'),'{"task":"fixture"}\n');
 await fs.chmod(path.join(root,'src/message.mjs'),0o755);
 assert.ok((await check()).reasons.includes('MODE_OR_TYPE_CHANGE'));
 console.log('PASS: clean allowed change; out-of-scope, deletion, symlink, untracked, staged, protected mutation and mode changes refused');
 console.log('PASS: ignored metadata inventory, SHA-256 tamper, ignored symlink and nested-file denial; fsmonitor canary NOT invoked');
}finally{await fs.rm(tmp,{recursive:true,force:true});}
