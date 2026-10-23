import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadAgentProfile, searchAgentProfiles } from '../dist/agentProfilesOps.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-profiles-'));
try {
  const profiles = path.join(root, '.codex', 'agents');
  await fs.mkdir(profiles, { recursive: true });
  for (const [name, description] of [['backend', 'TypeScript API engineering'], ['frontend', 'TypeScript UI engineering'], ['reviewer', 'Security code review']]) {
    await fs.writeFile(path.join(profiles, `${name}.md`),
      `---\nname: ${name}\ndescription: ${description}\n---\n# Instructions for ${name}\n`);
  }
  await fs.writeFile(path.join(profiles, 'AGENTS.md'), 'Instructions file, not a profile.');
  await fs.writeFile(path.join(profiles, 'README.md'), 'Not a profile.');
  const outside = path.join(root, 'secret-agent.md');
  await fs.writeFile(outside, '---\nname: forbidden\n---\n');
  await fs.symlink(outside, path.join(profiles, 'escape.md'));
  const workspace = { id: 'agent-profile-test', root };

  const page1 = await searchAgentProfiles(workspace, { query: 'typescript', includeGlobal: false, limit: 1 });
  assert.equal(page1.total_matches, 2);
  assert.equal(page1.profiles.length, 1);
  assert.equal(page1.next_offset, 1);
  assert.equal(page1.profiles[0].kind, 'agent_profile');
  assert.equal(page1.profiles[0].executable, false);
  const page2 = await searchAgentProfiles(workspace, { query: 'typescript', includeGlobal: false, offset: 1, limit: 1 });
  assert.equal(page2.profiles.length, 1);
  assert.equal(page2.next_offset, null);
  assert.notEqual(page1.profiles[0].name, page2.profiles[0].name);
  assert.equal((await searchAgentProfiles(workspace, { includeGlobal: false })).total_matches, 3);
  assert.equal((await searchAgentProfiles(workspace, { query: 'forbidden', includeGlobal: false })).total_matches, 0);
  assert.equal((await searchAgentProfiles(workspace, { query: 'nonexistent', includeGlobal: false })).total_matches, 0);
  await assert.rejects(searchAgentProfiles(workspace, { query: 'x'.repeat(201), includeGlobal: false }), /200/);
  const capped = await searchAgentProfiles(workspace, { includeGlobal: false, maxProfiles: 1 });
  assert.equal(capped.inspected, 1);
  assert.equal(capped.scan_limit_reached, true);
  const loaded = await loadAgentProfile(workspace, { name: 'backend', includeGlobal: false });
  assert.match(loaded.text, /Instructions for backend/);
  assert.equal(loaded.profile.executable, false);
  await assert.rejects(loadAgentProfile(workspace, { name: 'forbidden', includeGlobal: false }), /not found/);

  await fs.mkdir(path.join(root, 'agents'), { recursive: true });
  await fs.writeFile(path.join(root, 'agents', 'duplicate.md'),
    '---\nname: backend\ndescription: Second profile\n---\n# Duplicate\n');
  await assert.rejects(loadAgentProfile(workspace, { name: 'backend', includeGlobal: false }), /Multiple/);
  const chosen = await loadAgentProfile(workspace, {
    name: 'backend', source: 'workspace', path: '$WORKSPACE/.codex/agents/backend.md', includeGlobal: false
  });
  assert.match(chosen.text, /Instructions for backend/);

  const client = new Client({ name: 'agent-profile-smoke', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/stdio.js', '--root', root, '--allow-root', root, '--tool-mode', 'standard', '--bash', 'off'],
    cwd: process.cwd(),
    env: { ...process.env, CODEXBRIDGE_ROOT: root, CODEXBRIDGE_ALLOWED_ROOTS: root }
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    for (const name of ['search_agent_profiles', 'load_agent_profile']) {
      const tool = listed.tools.find((entry) => entry.name === name);
      assert.ok(tool, `${name} should be listed`);
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.ok(tool._meta?.ui?.resourceUri || tool._meta?.['openai/outputTemplate'], `${name} widget metadata missing`);
    }
    const result = await client.callTool({ name: 'search_agent_profiles',
      arguments: { query: 'typescript', include_global_profiles: false } });
    assert.ok(!result.isError);
    assert.equal(result.structuredContent.total_matches, 2);
    const details = await client.callTool({ name: 'load_agent_profile',
      arguments: { name: 'reviewer', include_global_profiles: false } });
    assert.ok(!details.isError);
    assert.equal(details.structuredContent.profile.kind, 'agent_profile');
    assert.match(details.structuredContent.text, /Instructions for reviewer/);
  } finally { await client.close(); }
  console.log('Agent profile discovery and MCP integration tests passed');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
