import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function runCase(mode) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-write-mode-'));
  let client;
  try {
    await fs.writeFile(path.join(root, 'source.txt'), 'before\n');
    await fs.mkdir(path.join(root, '.ai-bridge'), { recursive: true });
    await fs.writeFile(path.join(root, '.ai-bridge', 'context.txt'), 'before\n');
    client = new Client({ name: 'write-mode-smoke', version: '1.0.0' }, { capabilities: {} });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ['dist/stdio.js', '--root', root, '--allow-root', root, '--tool-mode', 'standard', '--write', mode, '--bash', 'off'],
      cwd: process.cwd(),
      env: { ...process.env, CODEXBRIDGE_ROOT: root, CODEXBRIDGE_ALLOWED_ROOTS: root, CODEXBRIDGE_WRITE_MODE: mode }
    }));
    const call = (name, args) => client.callTool({ name, arguments: args });
    const source = { path: 'source.txt', old_text: 'before', new_text: 'after', expected_replacements: 1 };
    const context = { path: '.ai-bridge/context.txt', old_text: 'before', new_text: 'after', expected_replacements: 1 };
    const preview = await call('preview_change_set', { changes: [source] });
    assert.equal(preview.isError, undefined, JSON.stringify(preview));
    assert.equal(preview.structuredContent.changed, true);
    assert.equal(await fs.readFile(path.join(root, 'source.txt'), 'utf8'), 'before\n');
    const denied = mode !== 'workspace';
    const sourceApply = await call('apply_change_set', { changes: [source] });
    assert.equal(Boolean(sourceApply.isError), denied, JSON.stringify(sourceApply));
    assert.equal(await fs.readFile(path.join(root, 'source.txt'), 'utf8'), denied ? 'before\n' : 'after\n');
    // If a batch includes one out-of-scope path, NONE may be applied.
    const mixed = await call('apply_change_set', { changes: [
      { path: '.ai-bridge/context.txt', content: 'MUTATED\n' },
      { path: 'not-a-context.txt', content: 'MUTATED\n' }
    ] });
    assert.equal(Boolean(mixed.isError), denied, JSON.stringify(mixed));
    if (denied) {
      assert.equal(await fs.readFile(path.join(root, '.ai-bridge/context.txt'), 'utf8'), 'before\n');
      await assert.rejects(fs.stat(path.join(root, 'not-a-context.txt')), { code: 'ENOENT' });
    }
    const contextApply = await call('apply_change_set', { changes: [mode === 'workspace' ? { ...context, old_text: 'MUTATED' } : context] });
    assert.equal(Boolean(contextApply.isError), mode === 'off', JSON.stringify(contextApply));
    assert.equal(await fs.readFile(path.join(root, '.ai-bridge/context.txt'), 'utf8'), mode === 'off' ? 'before\n' : 'after\n');
    const direct = await call('write', { path: 'source-new.txt', content: 'hello\n' });
    assert.equal(Boolean(direct.isError), denied);
    const prefix = await call('apply_change_set', { changes: [{ path: '.ai-bridge-not/context.txt', content: 'no\n', create_dirs: true }] });
    assert.equal(Boolean(prefix.isError), denied);
    if (denied) await assert.rejects(fs.stat(path.join(root, '.ai-bridge-not')), { code: 'ENOENT' });
    console.log('write-mode ' + mode + ' MCP checks passed');
  } finally {
    if (client) await client.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
for (const mode of ['off', 'handoff', 'workspace']) await runCase(mode);
