import assert from 'node:assert/strict';
import {
  isReadOnlyMcpPostAllowed,
  validateReadOnlyHttpToken
} from '../dist/readonlyHttpAccess.js';

const fixtureSecret = 'r'.repeat(48);
assert.equal(validateReadOnlyHttpToken('p'.repeat(48), fixtureSecret), fixtureSecret);
assert.equal(validateReadOnlyHttpToken('p'.repeat(48), undefined), undefined);
assert.throws(() => validateReadOnlyHttpToken(undefined, fixtureSecret), /requires/);
assert.throws(() => validateReadOnlyHttpToken(fixtureSecret, fixtureSecret), /differ/);
for (const invalid of ['short', 'x'.repeat(300), 'white space'.repeat(4)]) {
  assert.throws(() => validateReadOnlyHttpToken('p'.repeat(48), invalid));
}
const rpc = (method, params) => ({
  jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {})
});
for (const method of ['initialize', 'notifications/initialized', 'ping', 'tools/list']) {
  assert.equal(isReadOnlyMcpPostAllowed(rpc(method)), true, method);
}
for (const tool of ['read', 'tree', 'search', 'git_status', 'show_changes', 'read_handoff']) {
  assert.equal(isReadOnlyMcpPostAllowed(rpc('tools/call', { name: tool, arguments: {} })), true, tool);
}
for (const tool of ['write', 'edit', 'apply_change_set', 'bash', 'task_verify',
  'request_transfer', 'task_plan', 'gcf_self_test', 'open_workspace']) {
  assert.equal(isReadOnlyMcpPostAllowed(rpc('tools/call', { name: tool })), false, tool);
}
for (const malformed of [null, [], [rpc('tools/list')], {}, rpc('resources/read'),
  rpc('tools/call'), rpc('tools/call', { name: 'constructor' }),
  { method: 'tools/list' }]) {
  assert.equal(isReadOnlyMcpPostAllowed(malformed), false);
}
console.log('Read-only HTTP credential policy checks passed (offline only, no runtime gate)');
