// GPT Codex Flow — local-only verification of an exported parallel review bundle.
// Git replays the patch in a disposable clone. No source execution, merge, commit,
// native AI request, remote operation, or approval grant is performed.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants as fileConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PATCH_LIMIT = 8_000_000;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const asText = (bytes) => bytes.toString('utf8').trim();
const within = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);
function git(cwd, args, input) {
  const r = spawnSync('git', [
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args
  ], {
    cwd, input, shell: false, encoding: null, timeout: 20000,
    maxBuffer: PATCH_LIMIT + 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null',
      GIT_OPTIONAL_LOCKS:'0', GIT_TERMINAL_PROMPT:'0',
      GIT_EXTERNAL_DIFF:'', GIT_PAGER:'cat' }
  });
  if (r.error || r.status !== 0) throw new Error(
    'Git ' + args[0] + ' verification failed: ' + String(r.stderr ?? r.error?.message ?? '').slice(0, 180)
  );
  return r.stdout;
}
function validPath(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 250 &&
    !s.startsWith('/') && !s.includes('\\') && !/[\0\r\n]/.test(s) &&
    s.split('/').every(p => p !== '' && p !== '.' && p !== '..' && p !== '.git');
}
function paths(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 100 ||
      !values.every(validPath) || new Set(values).size !== values.length)
    throw new Error('Review manifest path list invalid.');
  return [...values].sort();
}
function same(a,b) { return a.length === b.length && a.every((v,i)=>v===b[i]); }
async function boundedFile(file, max) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size < 1 || stat.size > max)
    throw new Error('Review bundle file must be a bounded regular file.');
  const h = await fs.open(file, fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0));
  try {
    const s = await h.stat();
    if (!s.isFile() || s.size < 1 || s.size > max) throw new Error('File changed during opening.');
    const contents = await h.readFile();
    if (contents.length !== s.size) throw new Error('File changed during reading.');
    return contents;
  } finally { await h.close(); }
}
async function containedRegular(root, relative) {
  const candidate = path.resolve(root,relative);
  if (!within(root,candidate)) throw new Error('Path outside worktree.');
  const [real, stat] = await Promise.all([fs.realpath(candidate),fs.lstat(candidate)]);
  if (!within(root,real) || !stat.isFile()) throw new Error('Changed path is a symlink or nonregular file.');
}
function diffPaths(root) {
  return git(root,['diff','--name-only','-z','--no-renames','HEAD','--'])
    .toString('utf8').split('\0').filter(Boolean).sort();
}
function diffPatch(root) {
  return git(root,['diff','--binary','--no-ext-diff','--no-textconv','HEAD','--']);
}
export async function verifyParallelReviewBundle({base,reviewDir}) {
  if (typeof base !== 'string' || !path.isAbsolute(base) ||
      typeof reviewDir !== 'string' || !path.isAbsolute(reviewDir))
    throw new Error('Absolute base and bundle paths are required.');
  const [root,bundle] = await Promise.all([fs.realpath(base),fs.realpath(reviewDir)]);
  if (within(root,bundle) || within(bundle,root))
    throw new Error('Review bundle must be outside source worktree.');
  const [rawManifest,patch] = await Promise.all([
    boundedFile(path.join(bundle,'manifest.json'),24000),
    boundedFile(path.join(bundle,'combined.patch'),PATCH_LIMIT)
  ]);
  let manifest;
  try {manifest=JSON.parse(rawManifest.toString('utf8'));}
  catch {throw new Error('Invalid review manifest JSON.');}
  const expected=paths(manifest.combined_paths);
  if (manifest.schema!==1 || !/^parallel_[a-f0-9-]{36}$/.test(manifest.session_id??'') ||
      manifest.preview_status!=='PASS' || manifest.original_modified!==false ||
      manifest.merge_performed!==false || manifest.owner_merge_approval_required!==true ||
      manifest.combined_patch_file!=='combined.patch' ||
      !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(manifest.base_head??'') ||
      !/^[a-f0-9]{64}$/.test(manifest.combined_patch_sha256??'') ||
      manifest.combined_patch_bytes!==patch.length ||
      digest(patch)!==manifest.combined_patch_sha256)
    throw new Error('Review manifest/patch integrity check failed.');
  const claimed=[];
  for (const role of ['chatgpt','codex']) {
    const part=manifest.participants?.[role];
    const changed=paths(part?.changed_paths);
    if (part?.completion_reported!==true ||
        !/^[a-f0-9]{64}$/.test(part.patch_sha256??''))
      throw new Error('Invalid participant evidence.');
    claimed.push(...changed);
  }
  if (!same(claimed.sort(),expected)) throw new Error('Roles do not exclusively own all changed paths.');
  const gitRoot=await fs.realpath(asText(git(root,['rev-parse','--show-toplevel'])));
  if (root!==gitRoot) throw new Error('Base must equal Git worktree root.');
  const head=asText(git(root,['rev-parse','HEAD']));
  const baseline=git(root,['status','--porcelain=v1','-z','--untracked-files=all']);
  if (head!==manifest.base_head || baseline.length)
    throw new Error('Base Git HEAD changed or working tree is dirty.');
  for (const name of expected) await containedRegular(root,name);
  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'gcf-verify-review-'));
  const clone=path.join(scratch,'integration');
  try {
    git(root,['clone','-q','--no-local','--',root,clone]);
    if (asText(git(clone,['rev-parse','HEAD']))!==head) throw new Error('Clone HEAD changed.');
    git(clone,['apply','--check','-'],patch);
    git(clone,['apply','-'],patch);
    git(clone,['diff','--check','--']);
    const replayedPaths=diffPaths(clone), replayedPatch=diffPatch(clone);
    if (!same(replayedPaths,expected) || digest(replayedPatch)!==manifest.combined_patch_sha256)
      throw new Error('Replay mismatch with review bundle.');
    const realClone = await fs.realpath(clone);
    for (const name of expected) await containedRegular(realClone,name);
    if (asText(git(root,['rev-parse','HEAD']))!==head ||
        !git(root,['status','--porcelain=v1','-z','--untracked-files=all']).equals(baseline))
      throw new Error('Base changed during verification.');
    return {status:'PASS',session_id:manifest.session_id,base_head:head,
      reviewed_paths:replayedPaths,combined_patch_sha256:digest(replayedPatch),
      patch_replay_verified:true,git_diff_check_passed:true,
      source_code_executed:false,project_tests_executed:false,
      source_repo_modified:false,merge_performed:false,
      worker_identity_verified:false,owner_merge_approval_required:true};
  } finally {await fs.rm(scratch,{recursive:true,force:true});}
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2);
  try {
    if (args.length!==4 || args[0]!=='--base' || args[2]!=='--review')
      throw new Error('Usage: node scripts/gcf-parallel-verify.mjs --base ABS_ROOT --review ABS_BUNDLE_DIR');
    console.log(JSON.stringify(await verifyParallelReviewBundle({
      base:args[1],reviewDir:args[3]
    }),null,2));
  } catch(e) {
    console.error('Review verification REFUSED: '+(e instanceof Error?e.message:String(e)));
    process.exitCode=2;
  }
}
