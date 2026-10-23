// GPT Codex Flow: conservative, read-only parallel-worktree integration gate.
// A dry-run/preview only: never commit, cherry-pick, push, merge or update source branches.
// It does NOT authenticate ChatGPT/Codex clients, launch agents, or enforce writer locks.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BUFFER_LIMIT = 8 * 1024 * 1024;

function git(cwd, args, input) {
  const result = spawnSync('git', args, {
    cwd, input, encoding: null, maxBuffer: BUFFER_LIMIT,
    timeout: 20000, shell: false
  });
  if (result.status !== 0 || result.error) {
    throw new Error('Git verification failed (' + args[0] + '): ' +
      String(result.stderr || result.error?.message || '').slice(0, 350));
  }
  return result.stdout;
}
const asText = (data) => data.toString('utf8').trim();
const digest = (data) => createHash('sha256').update(data).digest('hex');
function files(cwd) {
  return git(cwd, ['diff', '--name-only', '-z', '--no-renames', 'HEAD', '--'])
    .toString('utf8').split('\0').filter(Boolean).sort();
}
function status(cwd) {
  return git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
}
function patch(cwd) {
  return git(cwd, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--']);
}
function commit(cwd) {
  return asText(git(cwd, ['rev-parse', 'HEAD']));
}
function commonDir(cwd) {
  return asText(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}
function validateSnapshot(cwd, previous) {
  if (commit(cwd) !== previous.head ||
    digest(status(cwd)) !== previous.statusHash ||
    digest(patch(cwd)) !== previous.patchHash) {
    throw new Error('Changed Git state while integration preview was running.');
  }
}
function snapshot(cwd) {
  return {
    head: commit(cwd),
    statusHash: digest(status(cwd)),
    patchHash: digest(patch(cwd)),
    changedPaths: files(cwd),
    patch: patch(cwd)
  };
}
function statusHasUntracked(cwd) {
  return status(cwd).toString('utf8').split('\0').some((v) => v.startsWith('?? '));
}
function stablePaths(rootA, rootB) {
  if (rootA === rootB || rootA.startsWith(rootB + path.sep) || rootB.startsWith(rootA + path.sep)) {
    throw new Error('Parallel workers require distinct non-nested directories.');
  }
}
export async function inspectParallelWorktrees({ base, chatgpt, codex }) {
  if (![base, chatgpt, codex].every((x) => typeof x === 'string' && x.trim())) {
    throw new Error('base, chatgpt, and codex paths are required.');
  }
  const [baseRoot, chatgptRoot, codexRoot] =
    await Promise.all([base, chatgpt, codex].map((dir) => fs.realpath(dir)));
  stablePaths(baseRoot, chatgptRoot);
  stablePaths(baseRoot, codexRoot);
  stablePaths(chatgptRoot, codexRoot);
  const roots = [baseRoot, chatgptRoot, codexRoot];
  if (new Set(roots.map(commonDir)).size !== 1) {
    throw new Error('All participants must use worktrees of the same local Git repository.');
  }
  const [baseline, chat, cod] = roots.map(snapshot);
  const sameBaseline = baseline.head === chat.head && chat.head === cod.head;
  const baseClean = status(baseRoot).length === 0;
  const noUntracked = !statusHasUntracked(chatgptRoot) && !statusHasUntracked(codexRoot);
  const overlap = chat.changedPaths.filter((v) => cod.changedPaths.includes(v));
  // --name-status -z alternates STATUS and PATH fields. Inspect only STATUS:
  // names like Dashboard.txt or Agent.ts are not Git deletion/addition codes.
  // Disable rename detection consistently with files() and reject all but M.
  const unsupported = [chatgptRoot, codexRoot].some((cwd) => {
    const fields = git(cwd, ['diff', '--name-status', '-z', '--no-renames', 'HEAD', '--'])
      .toString('utf8').split('\0').filter(Boolean);
    if (fields.length % 2 !== 0) return true;
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i] !== 'M') return true;
    }
    return false;
  });
  // Do not preview a patch whose changed path resolves through a symlink, or
  // whose leaf is a symlink/non-regular file. Git's text patch format alone
  // does not provide an OS filesystem containment guarantee.
  async function unsafePaths(root, changedPaths) {
    for (const name of changedPaths) {
      const candidate = path.resolve(root, name);
      if (!candidate.startsWith(root + path.sep)) return true;
      try {
        const [real, stat] = await Promise.all([fs.realpath(candidate), fs.lstat(candidate)]);
        if (!real.startsWith(root + path.sep) || !stat.isFile()) return true;
      } catch { return true; }
    }
    return false;
  }
  const unsafeChangePath = await unsafePaths(chatgptRoot, chat.changedPaths) ||
    await unsafePaths(codexRoot, cod.changedPaths);
  const reasons = [
    ...(unsafeChangePath ? ['UNSAFE_WORKER_PATH'] : []),
    ...(unsupported ? ['UNSUPPORTED_CHANGE_TYPE'] : []),
    ...(!sameBaseline ? ['STALE_GIT_HEAD'] : []),
    ...(!baseClean ? ['BASE_WORKTREE_DIRTY'] : []),
    ...(!noUntracked ? ['UNTRACKED_WORKER_FILES'] : []),
    ...(overlap.length ? ['OVERLAPPING_FILES'] : []),
    ...(!chat.patch.length || !cod.patch.length ? ['EMPTY_WORKER_PATCH'] : [])
  ];
  return {
    ready: reasons.length === 0,
    reasons, overlap,
    baseHead: baseline.head,
    participants: {
      chatgpt: { changedPaths: chat.changedPaths, patchSha256: chat.patchHash },
      codex: { changedPaths: cod.changedPaths, patchSha256: cod.patchHash }
    },
    // Private to this module's integration function; never print changes to user logs.
    _snapshots: { baseline, chat, cod },
    _roots: { baseRoot, chatgptRoot, codexRoot }
  };
}

export async function previewParallelIntegration(args, { includeReviewPatch = false } = {}) {
  const inspection = await inspectParallelWorktrees(args);
  const { _snapshots, _roots, ...report } = inspection;
  if (!inspection.ready) return { ...report, preview: 'BLOCKED' };
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'gcf-integration-preview-'));
  const cloned = path.join(scratch, 'integration');
  try {
    // Git clone uses only a local worktree path; no fetch, push, merge or commits.
    git(_roots.baseRoot, ['clone', '-q', '--no-local', '--', _roots.baseRoot, cloned]);
    if (commit(cloned) !== report.baseHead) throw new Error('Preview clone has stale HEAD.');
    for (const sample of [_snapshots.chat, _snapshots.cod]) {
      git(cloned, ['apply', '--check', '-'], sample.patch);
      git(cloned, ['apply', '-'], sample.patch);
    }
    validateSnapshot(_roots.baseRoot, _snapshots.baseline);
    validateSnapshot(_roots.chatgptRoot, _snapshots.chat);
    validateSnapshot(_roots.codexRoot, _snapshots.cod);
    const combinedPatch = patch(cloned);
    return {
      ...report, preview: 'PASS',
      combinedPaths: files(cloned),
      combinedPatchSha256: digest(combinedPatch),
      // Only a trusted local review-export caller can request source contents.
      // The public CLI and MCP status never request or expose this field.
      ...(includeReviewPatch ? { _reviewPatch: combinedPatch } : {}),
      appliedToOriginal: false
    };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== '--base' ||
      args[2] !== '--chatgpt' || args[4] !== '--codex') {
    console.error('Usage: node scripts/gcf-parallel-sync.mjs --base <original> --chatgpt <worktree> --codex <worktree>');
    process.exitCode = 2;
  } else {
    try {
      const result = await previewParallelIntegration({
        base: args[1], chatgpt: args[3], codex: args[5]
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ready) process.exitCode = 2;
    } catch (error) {
      console.error('Synchronization preview refused: ' + (error?.message ?? String(error)));
      process.exitCode = 2;
    }
  }
}
