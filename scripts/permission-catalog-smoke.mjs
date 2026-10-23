import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  TOOL_PERMISSION_CATALOG,
  permissionEntryForTool
} from '../dist/permissionCatalog.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-permission-audit-'));

async function inspectMode(mode, codexSessions = 'off') {
  const client = new Client({ name: 'permission-audit-fixture', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      'dist/stdio.js', '--root', root, '--allow-root', root,
      '--tool-mode', mode, '--bash', 'off',
      '--codex-sessions', codexSessions,
      '--write', 'off'
    ],
    cwd: process.cwd(),
    env: { ...process.env, CODEXBRIDGE_ROOT: root, CODEXBRIDGE_ALLOWED_ROOTS: root }
  });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const names = tools.map(tool => tool.name);
    assert.equal(names.length, new Set(names).size, 'No duplicate tool names');
    for (const name of names) {
      const entry = permissionEntryForTool(name);
      assert.ok(entry.proposedGrants.length > 0, 'Missing audit grant: ' + name);
      assert.ok(entry.effect.length > 0);
    }
    return new Set(names);
  } finally {
    await client.close();
  }
}

try {
  const modes = await Promise.all([
    inspectMode('minimal'),
    inspectMode('standard'),
    inspectMode('full', 'read')
  ]);
  for (const name of modes[0]) assert.ok(modes[1].has(name));
  for (const name of modes[1]) assert.ok(modes[2].has(name));
  const allCataloged = Object.keys(TOOL_PERMISSION_CATALOG);
  assert.deepEqual([...modes[2]].sort(), allCataloged.sort(), 'Catalog must exactly match fully exposed MCP tool surface');
  assert.equal(permissionEntryForTool('read').effect, 'read');
  assert.equal(permissionEntryForTool('open_workspace').effect, 'session-state');
  assert.equal(permissionEntryForTool('list_projects').effect, 'read');
  assert.equal(permissionEntryForTool('find_project').effect, 'read');
  assert.equal(permissionEntryForTool('select_project').effect, 'session-state');
  assert.equal(permissionEntryForTool('project_summary').effect, 'read');
  assert.equal(permissionEntryForTool('shared_project_state').effect, 'read');
  assert.deepEqual(permissionEntryForTool('shared_project_state').proposedGrants, ['workspace:read']);
  assert.equal(permissionEntryForTool('task_inbox_list').effect, 'read');
  assert.equal(permissionEntryForTool('task_inbox_read').effect, 'read');
  assert.equal(permissionEntryForTool('set_project_alias').effect, 'handoff-state-write');
  assert.equal(permissionEntryForTool('recover_project_alias').effect, 'handoff-state-write');
  for (const name of ['write', 'edit', 'apply_change_set']) {
    assert.equal(permissionEntryForTool(name).effect, 'path-dependent-write');
  }
  for (const name of ['request_transfer', 'accept_transfer', 'cancel_transfer', 'task_inbox_post', 'task_plan', 'task_report']) {
    assert.equal(permissionEntryForTool(name).effect, 'handoff-state-write');
  }
  assert.equal(permissionEntryForTool('codexbridge_self_test').effect, 'diagnostic-mixed');
  assert.equal(permissionEntryForTool('task_verify').effect, 'execution');
  assert.equal(permissionEntryForTool('ssh_exec').effect, 'execution');
  for (const invalid of ['unknown_future_tool', 'constructor', 'toString', '__proto__']) {
    assert.throws(() => permissionEntryForTool(invalid), /Unclassified MCP tool/);
  }
  assert.ok(Object.isFrozen(permissionEntryForTool('read').proposedGrants));
  console.log('Permission effect catalog covers the minimal, standard, and full MCP tool surfaces');
  console.log('Catalog entries: ' + allCataloged.length + ' (audit only; no grant enforcement)');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
