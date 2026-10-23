// Owner-only LOCAL Terminal inspection of a validated accepted Codex handoff.
// Never executes the Codex CLI, writes files or approves anything.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { previewNativeTransfer } from './gcf-native-transfer-preview.mjs';

export async function reviewOwnerHandoff({ worktree, searchPath }) {
  const result = await previewNativeTransfer({
    worktree, searchPath, includeLocalPlan: true
  });
  const { _local_plan, _local_codex_binary, ...safe } = result;
  if (safe.status !== 'READY_FOR_OWNER_REVIEW')
    throw new Error('Transfer is not ready for owner review.');
  return {
    ...safe,
    local_codex_detected: Boolean(_local_codex_binary),
    plan_for_owner_review: _local_plan,
    native_execution_performed: false,
    next_step: 'Explicit owner-operated execution is not implemented for accepted transfer.'
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--worktree')
      throw new Error('Usage: node scripts/gcf-native-transfer-owner-review.mjs --worktree ABS_PATH');
    console.log(JSON.stringify(await reviewOwnerHandoff({
      worktree: process.argv[3]
    }), null, 2));
  } catch (error) {
    console.error('Owner handoff review REFUSED: ' + (error?.message ?? String(error)));
    process.exitCode = 2;
  }
}
