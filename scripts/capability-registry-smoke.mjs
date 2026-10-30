import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadSkill, searchSkills } from '../dist/capabilitiesOps.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'capability-registry-'));
try {
  for (const name of ['alpha', 'beta', 'gamma']) {
    const dir = path.join(root, '.codex', 'skills', name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'),
      ['---', 'name: ' + name, 'description: Security checks for TypeScript.', '---', '# ' + name].join('\n'));
  }
  const workspace = { id: 'test-workspace', root };
  const first = await searchSkills(workspace, { query: 'security typescript', includeGlobal: false, limit: 2 });
  assert.equal(first.total_matches, 3);
  assert.equal(first.skills.length, 2);
  assert.equal(first.next_offset, 2);
  const second = await searchSkills(workspace, { query: 'security typescript', includeGlobal: false, offset: 2, limit: 2 });
  assert.equal(second.skills.length, 1);
  assert.equal(second.next_offset, null);
  assert.notEqual(first.skills[0].path, second.skills[0].path);
  const none = await searchSkills(workspace, { query: 'python', includeGlobal: false });
  assert.equal(none.total_matches, 0);
  await assert.rejects(searchSkills(workspace, { query: 'a'.repeat(201), includeGlobal: false }), /200/);
  const capped = await searchSkills(workspace, { query: 'security', includeGlobal: false, maxSkills: 1 });
  assert.equal(capped.inspected, 1);
  assert.equal(capped.scan_limit_reached, true);

  // Search used to scan more skills than loadSkill, making some results
  // impossible to open. Verify a skill beyond the old 120-file cutoff.
  for (let index = 0; index < 130; index += 1) {
    const name = `overflow-${String(index).padStart(3, '0')}`;
    const dir = path.join(root, '.codex', 'skills', name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), [
      '---', `name: ${name}`, 'description: Deep catalog skill.', '---', `# ${name}`
    ].join('\n'));
  }
  const deep = await searchSkills(workspace, {
    query: 'overflow-129', includeGlobal: false
  });
  assert.equal(deep.total_matches, 1);
  const loadedDeep = await loadSkill(workspace, {
    name: 'overflow-129', source: 'workspace', path: deep.skills[0].path, includeGlobal: false
  });
  assert.match(loadedDeep.text, /# overflow-129/);

  // Verify the MCP tool is actually exposed to subscribed clients, not just
  // that the underlying in-process helper works.
  const client = new Client({ name: 'registry-smoke', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/stdio.js', '--root', root, '--allow-root', root, '--tool-mode', 'standard', '--bash', 'off'],
    cwd: process.cwd(),
    env: { ...process.env, GCF_ROOT: root, GCF_ALLOWED_ROOTS: root }
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tool = listed.tools.find((entry) => entry.name === 'search_skills');
    assert.ok(tool, 'search_skills must be registered in standard mode');
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.ok(tool._meta?.ui?.resourceUri || tool._meta?.['openai/outputTemplate'], 'widget metadata missing');
    const response = await client.callTool({
      name: 'search_skills',
      arguments: { query: 'typescript', include_global_skills: false, limit: 2 }
    });
    assert.equal(response.isError, undefined);
    assert.equal(response.structuredContent.total_matches, 3);
    assert.equal(response.structuredContent.skills.length, 2);
    assert.equal(response.structuredContent.next_offset, 2);
  } finally {
    await client.close();
  }
  console.log('Capability registry search and MCP integration tests passed');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
