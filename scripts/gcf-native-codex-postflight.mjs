// Fail-closed Git/file-system inspection AFTER native Codex, BEFORE running tests.
// This checks a disposable worktree; it does not prove OS sandbox isolation.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX = 1024 * 1024;
// Exact MCP-managed fixture files produced by the trusted local bridge process.
// Never trust arbitrary ignored files or apply this exception to Native Codex.
const MCP_METADATA = new Set([
  'README.md', 'current-plan.md', 'agent-status.md', 'implementation-diff.patch',
  'codex-status.md', 'decisions.md', 'open-questions.md', 'execution-log.jsonl',
  'session-log.jsonl', 'operation-journal.jsonl', 'continuity-checkpoint.json'
].map(name => '.ai-bridge/' + name));
const knownMcpMetadata = name => MCP_METADATA.has(name) ||
  /^\.ai-bridge\/task-inbox\/inbox_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.test(name);
const sha = (data) => createHash('sha256').update(data).digest('hex');
function git(root, args) {
  // Postflight must not run repository-controlled fsmonitor hooks or external
  // diff helpers while inspecting potentially untrusted agent output.
  const result = spawnSync('git', [
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'diff.external=', ...args
  ], {
    cwd: root, encoding: null, maxBuffer: MAX, timeout: 10000, shell: false,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM:'1',
      GIT_CONFIG_GLOBAL:'/dev/null', GIT_OPTIONAL_LOCKS:'0',
      GIT_TERMINAL_PROMPT:'0', GIT_EXTERNAL_DIFF:'', GIT_PAGER:'cat' }
  });
  if (result.status !== 0 || result.error)
    throw new Error('Postflight Git inspection failed (' + args[0] + ').');
  return result.stdout;
}
const names = (value) => value.toString('utf8').split('\0').filter(Boolean);
function inside(root, filename) {
  const rel = path.relative(root, filename);
  return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
async function regularInside(root, name) {
  const absolute = path.resolve(root, name);
  if (!inside(root, absolute)) return false;
  const components = path.relative(root, absolute).split(path.sep);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    let stat;
    try { stat = await fs.lstat(current); } catch { return false; }
    if (stat.isSymbolicLink()) return false;
    if (component === components.at(-1) && current === absolute) {
      if (!stat.isFile()) return false;
    } else if (!stat.isDirectory()) return false;
  }
  return inside(root, await fs.realpath(absolute));
}
export async function snapshotProtectedNativeFiles({worktree, paths}) {
  const root = await fs.realpath(worktree);
  const result = {};
  for (const name of paths) {
    if (typeof name !== 'string' || !name.startsWith('.ai-bridge/') ||
        !await regularInside(root, name))
      throw new Error('Unsafe or missing protected handoff record.');
    const contents = await fs.readFile(path.join(root, name));
    if (contents.length > 32000) throw new Error('Oversized protected handoff record.');
    result[name] = sha(contents);
  }
  return result;
}
// Take a bounded inventory only after the trusted local MCP fixture client
// finishes. This is not safe evidence if the peer itself is untrusted.
export async function snapshotManagedMcpMetadata({worktree, protectedHashes = {}}) {
  const root = await fs.realpath(worktree);
  const ignored = names(git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']));
  if(ignored.length>2000)throw new Error('Managed MCP metadata inventory exceeds bounded capacity.');
  const hashes = Object.create(null);
  for (const name of ignored) {
    if (Object.hasOwn(protectedHashes, name)) continue;
    if (!knownMcpMetadata(name) || !await regularInside(root, name))
      throw new Error('Unexpected or unsafe ignored MCP metadata.');
    const filename = path.join(root, name);
    const stat = await fs.lstat(filename);
    if (stat.size > 262144) throw new Error('Oversized managed MCP metadata.');
    hashes[name] = sha(await fs.readFile(filename));
  }
  return hashes;
}
export async function inspectNativeCodexPostflight({
  worktree, expectedHead, allowedPaths, protectedHashes = {},
  managedMcpHashes = {}
}) {
  const root = await fs.realpath(worktree);
  const reasons = [];
  const head = git(root, ['rev-parse', 'HEAD']).toString('utf8').trim();
  if (head !== expectedHead) reasons.push('CHANGED_GIT_HEAD');
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0 ||
      allowedPaths.length > 25 || allowedPaths.some((p) =>
        typeof p !== 'string' || !p || path.isAbsolute(p) ||
        p.split('/').some((v) => !v || v === '.' || v === '..' || v === '.git')) ||
      new Set(allowedPaths).size !== allowedPaths.length)
    reasons.push('INVALID_ALLOWED_PATHS');
  const untracked = names(git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  if (untracked.length) reasons.push('UNTRACKED_FILES');
  // Git status omits ignored files. Only files with a previously captured
  // trusted SHA-256 inventory are accepted. A familiar filename is insufficient.
  const ignored = names(git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']));
  if (ignored.some(name => !Object.hasOwn(protectedHashes, name) &&
      !Object.hasOwn(managedMcpHashes, name)))
    reasons.push('UNEXPECTED_IGNORED_FILES');
  for (const name of ignored) {
    if (Object.hasOwn(managedMcpHashes, name) &&
        (!knownMcpMetadata(name) || !await regularInside(root, name)))
      reasons.push('UNSAFE_MCP_METADATA');
  }
  const staged = names(git(root, ['diff', '--cached', '--name-only', '-z', '--']));
  if (staged.length) reasons.push('STAGED_CHANGES');
  const fields = names(git(root, ['diff', '--name-status', '-z', '--no-renames',
    '--no-ext-diff', '--no-textconv', 'HEAD', '--']));
  const changes = [];
  if (fields.length % 2 !== 0) reasons.push('MALFORMED_GIT_STATUS');
  else for (let i = 0; i < fields.length; i += 2) {
    const [status, name] = [fields[i], fields[i + 1]];
    changes.push(name);
    if (status !== 'M') reasons.push('UNSUPPORTED_CHANGE_TYPE');
    if (!allowedPaths?.includes(name)) reasons.push('OUT_OF_SCOPE_CHANGE');
    if (!await regularInside(root, name)) reasons.push('UNSAFE_FILE_PATH');
  }
  const summary = git(root, ['diff', '--summary', '--no-renames', 'HEAD', '--']);
  if (summary.length) reasons.push('MODE_OR_TYPE_CHANGE');
  if (changes.length === 0) reasons.push('NO_SOURCE_CHANGE');
  for (const [name, digest] of Object.entries(protectedHashes)) {
    if (!await regularInside(root, name)) {
      reasons.push('PROTECTED_RECORD_UNSAFE');
      continue;
    }
    const contents = await fs.readFile(path.join(root, name));
    if (sha(contents) !== digest) reasons.push('PROTECTED_RECORD_CHANGED');
  }
  for (const [name, expected] of Object.entries(managedMcpHashes)) {
    if (!knownMcpMetadata(name) || !/^[a-f0-9]{64}$/.test(expected) ||
        !ignored.includes(name) || !await regularInside(root, name)) {
      reasons.push('MANAGED_MCP_METADATA_CHANGED');
      continue;
    }
    const filename = path.join(root, name);
    const stat = await fs.lstat(filename);
    if (stat.size > 262144 || sha(await fs.readFile(filename)) !== expected)
      reasons.push('MANAGED_MCP_METADATA_CHANGED');
  }
  return {
    passed: reasons.length === 0,
    reasons: [...new Set(reasons)],
    changed_paths: changes,
    only_allowed_file_changed: reasons.length === 0,
    fixture_git_head_unchanged: head === expectedHead,
    protected_records_intact: !reasons.some((r) => r.startsWith('PROTECTED_')),
    ignored_outputs_rejected: reasons.includes('UNEXPECTED_IGNORED_FILES')
  };
}
