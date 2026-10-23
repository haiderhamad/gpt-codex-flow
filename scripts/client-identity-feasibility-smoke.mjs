import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function availablePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function connectAs(url, credential, claimedName) {
  const client = new Client({ name: claimedName, version: '0.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: 'Bearer ' + credential } }
  });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.ok(tools.some(item => item.name === 'server_config'));
    const response = await client.callTool({ name: 'server_config', arguments: {} });
    assert.notEqual(response.isError, true);
    assert.equal(response.structuredContent.codexbridge_tool, 'server_config');
    return { client, transport };
  } catch (error) {
    await client.close();
    throw error;
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-identity-spike-'));
const port = await availablePort();
const credential = randomUUID();
const base = 'http://127.0.0.1:' + port;
const env = {
  ...process.env,
  CODEXBRIDGE_ROOT: root,
  CODEXBRIDGE_ALLOWED_ROOTS: root,
  CODEXBRIDGE_HOST: '127.0.0.1',
  CODEXBRIDGE_PORT: String(port),
  CODEXBRIDGE_HTTP_TOKEN: credential,
  CODEXBRIDGE_HTTP_AUTH_MODE: 'header-only',
  CODEXBRIDGE_WRITE_MODE: 'off',
  CODEXBRIDGE_BASH_MODE: 'off',
  CODEXBRIDGE_TOOL_MODE: 'minimal'
};
const child = spawn(process.execPath, ['dist/http.js'], {
  cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe']
});
let diagnostics = '';
child.stderr.on('data', chunk => { diagnostics += String(chunk); });
const connections = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(base + '/healthz', {
        headers: { Authorization: 'Bearer ' + credential }
      });
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, diagnostics);
  assert.equal((await fetch(base + '/healthz')).status, 401);
  assert.equal((await fetch(base + '/healthz', {
    headers: { Authorization: 'Bearer ' + randomUUID() }
  })).status, 401);
  const health = await (await fetch(base + '/healthz', {
    headers: { Authorization: 'Bearer ' + credential }
  })).json();
  assert.equal(health.clientIdentityVerified, false);
  for (const name of ['claimed-chatgpt', 'claimed-codex']) {
    connections.push(await connectAs(base + '/mcp', credential, name));
  }
  assert.notEqual(connections[0].transport.sessionId, connections[1].transport.sessionId);
  assert.equal(typeof connections[0].transport.sessionId, 'string');
  console.log('Identity feasibility: separate claimed client names and MCP sessions share legacy credential authorization; neither is verified client identity');
} finally {
  for (const connection of connections) {
    await connection.client.close();
  }
  child.kill('SIGTERM');
  await rm(root, { recursive: true, force: true });
}
