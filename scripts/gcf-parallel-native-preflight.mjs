// LOCAL-only advisory preflight for a proposed Native Codex participant in a
// two-worktree GPT Codex Flow session. No agent invocation or ownership enforcement.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readParallelSession } from './gcf-parallel-session.mjs';
import { inspectParallelWorktrees } from './gcf-parallel-sync.mjs';
import { inspectNativeCodex } from './gcf-native-codex-preflight.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const allowedName = name => typeof name === 'string' && name.length > 0 &&
  name.length <= 240 && !path.isAbsolute(name) && !name.includes('\\') &&
  !/[\0\r\n]/.test(name) &&
  name.split('/').every(part => part && part !== '.' && part !== '..' &&
    part !== '.git' && part !== '.ai-bridge');
function git(root, args) {
  const result = spawnSync('git', args, {
    cwd:root, shell:false, encoding:null, timeout:10000, maxBuffer:1024*1024
  });
  if (result.error || result.status !== 0)
    throw new Error('Native parallel Git validation refused (' + args[0] + ').');
  return result.stdout;
}
function snapshot(root) {
  return {
    head:git(root,['rev-parse','HEAD']).toString('utf8').trim(),
    status:sha256(git(root,['status','--porcelain=v1','-z','--untracked-files=all'])),
    staged:sha256(git(root,['diff','--cached','--binary','HEAD','--'])),
    diff:sha256(git(root,['diff','--binary','HEAD','--']))
  };
}
function sameSnapshot(a,b) {
  return a.head===b.head && a.status===b.status &&
    a.staged===b.staged && a.diff===b.diff;
}
async function requireTrackedRegular(root, relative) {
  if (!allowedName(relative)) throw new Error('Invalid owned file name.');
  let current = root;
  const segments = relative.split('/');
  for (let i=0; i<segments.length; i++) {
    current=path.join(current,segments[i]);
    const stat=await fs.lstat(current);
    if (stat.isSymbolicLink() ||
        (i===segments.length-1 ? !stat.isFile() : !stat.isDirectory()))
      throw new Error('Owned path has symlink or nonregular component.');
  }
  const real=await fs.realpath(current);
  if (!real.startsWith(root+path.sep))
    throw new Error('Owned path escapes worktree.');
  git(root,['ls-files','--error-unmatch','--',relative]);
}
export async function previewParallelNativeCodex({
  dir, session_id, searchPath=process.env.PATH??'', includeLocalPlan=false
}) {
  if (typeof dir!=='string' || !path.isAbsolute(dir) ||
      typeof session_id!=='string' ||
      !/^parallel_[a-f0-9-]{36}$/.test(session_id))
    throw new Error('Absolute state directory and valid session ID required.');
  const stateFile=path.join(dir,'parallel-session.json');
  const stateBefore=await fs.readFile(stateFile);
  if(stateBefore.length>32_000)throw new Error('Oversized parallel session record.');
  const session = await readParallelSession(dir);
  if (session.session_id!==session_id || session.status!=='planned' ||
      session.roles?.codex?.state!=='assigned' ||
      session.roles?.chatgpt?.state!=='assigned')
    throw new Error('Native Codex requires a matching planned, unstarted session.');
  const nativePaths=session.roles.codex.target_paths;
  const otherPaths=session.roles.chatgpt.target_paths;
  if (!Array.isArray(nativePaths) || nativePaths.length<1 || nativePaths.length>25 ||
      !Array.isArray(otherPaths) || otherPaths.length<1 || otherPaths.length>25 ||
      ![...nativePaths,...otherPaths].every(allowedName) ||
      new Set([...nativePaths,...otherPaths]).size!==nativePaths.length+otherPaths.length)
    throw new Error('Disjoint safe owned file paths required.');
  if (typeof session.roles.codex.task!=='string' ||
      !session.roles.codex.task.trim() || session.roles.codex.task.length>1500)
    throw new Error('Bounded Codex task required.');

  const inspection=await inspectParallelWorktrees({
    base:session.base,...session.worktrees
  });
  if (inspection.baseHead!==session.base_head ||
      inspection.reasons.some(reason=>reason!=='EMPTY_WORKER_PATCH') ||
      inspection.participants.codex.changedPaths.length ||
      inspection.participants.chatgpt.changedPaths.length)
    throw new Error('Native worker requires two clean independent worktrees at original Git HEAD.');
  const root=inspection._roots.codexRoot;
  const peers=[inspection._roots.baseRoot,inspection._roots.chatgptRoot,root];
  // Reject worktree *subdirectories* and validate owned paths in all participants.
  for(const peer of peers) {
    const top=await fs.realpath(git(peer,['rev-parse','--show-toplevel']).toString('utf8').trim());
    if(top!==peer)throw new Error('Each participant must use its Git worktree root.');
    for(const rel of [...nativePaths,...otherPaths]) {
      await requireTrackedRegular(peer,rel);
    }
  }
  const before=peers.map(snapshot);
  const plan=[
    'GPT Codex Flow: native Codex worker PREVIEW for parallel Git worktree.',
    'Assigned role: codex (advisory label, not verified identity).',
    'Task: '+session.roles.codex.task,
    'Only edit the following tracked files:',
    ...nativePaths.map(name=>'- '+name),
    'Never edit other files, install dependencies, commit, merge, push, or access the network.',
    'A separate peer owns: '+otherPaths.join(', '),
    'Do not modify the peer worktree or original repository.',
    'If the task cannot be achieved within the allowed files, stop and report.'
  ].join('\n');
  const native=await inspectNativeCodex({
    worktree:root,planText:plan,searchPath
  });
  const after=peers.map(snapshot);
  const stateAfter=await fs.readFile(stateFile);
  if (sha256(stateBefore)!==sha256(stateAfter))
    throw new Error('Parallel session changed during native Codex preflight.');
  if (!after.every((item,i)=>sameSnapshot(item,before[i])) ||
      native.git_head!==session.base_head || !native.git_clean)
    throw new Error('Parallel worktrees changed during native Codex preflight.');
  return {
    status:native.ready_for_owner_review?'READY_FOR_OWNER_REVIEW':'BLOCKED',
    session_id,role:'codex',role_identity_verified:false,
    native_binary_detected:native.codex_binary_detected,
    ...(includeLocalPlan ? { _local_plan:plan } : {}),
    base_head:session.base_head,
    owned_paths:[...nativePaths],
    peer_owned_paths:[...otherPaths],
    plan_sha256:native.plan_sha256,
    sandbox_requested:'workspace-write',network_disabled_requested:true,
    owner_action_required:true,preview_only:true,
    native_codex_invoked:false,model_request_performed:false,
    original_repository_modified:false,merge_performed:false,
    native_worktree_isolated_from_peer_by_git:true,
    os_sandbox_enforcement_verified:false
  };
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2);
  try{
    if(![4,5].includes(args.length) || args[0]!=='--state-dir' || args[2]!=='--session-id' ||
        (args.length===5 && args[4]!=='--show-plan'))
      throw new Error('Usage: node scripts/gcf-parallel-native-preflight.mjs --state-dir ABS_PATH --session-id parallel_UUID [--show-plan]');
    const result=await previewParallelNativeCodex({
      dir:args[1],session_id:args[3],includeLocalPlan:args.length===5
    });
    console.log(JSON.stringify(result,null,2));
    if(result.status!=='READY_FOR_OWNER_REVIEW')process.exitCode=2;
  } catch(error) {
    console.error('Parallel Native Codex preflight REFUSED: '+(error?.message??String(error)));
    process.exitCode=2;
  }
}
