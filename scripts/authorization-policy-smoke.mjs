import assert from 'node:assert/strict';
import { simulateAuthorization } from '../dist/authorizationPolicy.js';

const makeActor = grants => ({ principalId: 'fixture-owner', grants });
const read = { toolName: 'read', writeMode: 'off' };

function check(request, expected) {
  const result = simulateAuthorization(request);
  assert.equal(result.code, expected);
  assert.equal(result.wouldAllow, expected === 'allow');
}

check({ ...read, principal: null }, 'unverified-principal');
check({ ...read, principal: makeActor([]) }, 'missing-grant');
check({ ...read, principal: makeActor(['workspace:read']) }, 'allow');
check({ ...read, toolName: 'unknown_future_tool',
  principal: makeActor(['workspace:read']) }, 'unknown-tool');
check({ toolName: 'task_plan', writeMode: 'off',
  principal: makeActor(['handoff:write']) }, 'allow');
check({ toolName: 'accept_transfer', writeMode: 'off',
  principal: makeActor(['handoff:write']) }, 'approval-not-implemented');
check({ toolName: 'bash', writeMode: 'workspace',
  principal: makeActor(['execution:run']) }, 'execution-unconfined');
check({ toolName: 'codexbridge_self_test', writeMode: 'workspace',
  principal: makeActor(['workspace:read', 'handoff:write', 'execution:run']) },
  'mixed-diagnostic-unconfined');

console.log('Authorization policy simulation basic checks passed');

const source = {
  toolName: 'apply_change_set',
  writeMode: 'workspace',
  mutationScopes: ['source'],
  workspaceId: 'repo-fixture',
  taskId: 'task-fixture',
  expectedLeaseRevision: 3
};
const activeLease = {
  ownerPrincipalId: 'fixture-owner',
  workspaceId: 'repo-fixture',
  taskId: 'task-fixture',
  revision: 3,
  expiresAtMs: 2_000,
  transferPending: false
};
const author = makeActor(['workspace:write']);
check({ ...source, principal: author }, 'missing-lease');
check({ ...source, principal: author, lease: activeLease, nowMs: 1_000 }, 'allow');
check({ ...source, principal: makeActor(['handoff:write']),
  lease: activeLease, nowMs: 1_000 }, 'missing-grant');
check({ ...source, principal: author, lease: { ...activeLease, revision: 2 },
  nowMs: 1_000 }, 'lease-mismatch');
check({ ...source, principal: author,
  lease: { ...activeLease, expiresAtMs: 1_000 }, nowMs: 1_000 }, 'lease-expired');
check({ ...source, principal: author,
  lease: { ...activeLease, transferPending: true }, nowMs: 1_000 }, 'transfer-pending');
check({ ...source, principal: author, lease: activeLease,
  mutationScopes: [], nowMs: 1_000 }, 'missing-resolved-paths');
check({ ...source, principal: author, lease: activeLease,
  writeMode: 'off', nowMs: 1_000 }, 'write-mode-denied');
check({ ...source, principal: author, lease: activeLease,
  writeMode: 'handoff', nowMs: 1_000 }, 'write-mode-denied');
check({ toolName: 'edit', writeMode: 'handoff',
  mutationScopes: ['handoff'],
  principal: makeActor(['handoff:write']) }, 'allow');
check({ ...source, principal: author,
  lease: { ...activeLease, ownerPrincipalId: 'another-owner' },
  nowMs: 1_000 }, 'lease-mismatch');
check({ ...source, principal: author,
  lease: { ...activeLease, taskId: 'stale-task' },
  nowMs: 1_000 }, 'lease-mismatch');
check({ ...source, principal: author,
  lease: { ...activeLease, transferPending: undefined },
  nowMs: 1_000 }, 'transfer-pending');
check({ ...source, principal: author,
  lease: { ...activeLease, expiresAtMs: Number.NaN },
  nowMs: 1_000 }, 'lease-expired');
check({ ...source, principal: author,
  mutationScopes: ['invalid-scope'], lease: activeLease,
  nowMs: 1_000 }, 'missing-resolved-paths');
check({ ...source, principal: author, lease: activeLease,
  mutationScopes: ['source', 'handoff'], nowMs: 1_000 }, 'missing-grant');
check({ ...source, principal: makeActor(['workspace:write', 'handoff:write']),
  lease: activeLease, mutationScopes: ['source', 'handoff'],
  nowMs: 1_000 }, 'allow');
console.log('Authorization policy simulation path, grant and lease checks passed');
