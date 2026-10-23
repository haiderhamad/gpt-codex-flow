import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { isAllowedHttpOrigin } from '../dist/httpOriginPolicy.js';

assert.equal(isAllowedHttpOrigin(undefined, ['https://example.com']), true);
assert.equal(isAllowedHttpOrigin('https://example.com', ['https://example.com']), true);
for (const rejected of ['null', 'https://evil.example', 'https://example.com.evil.net',
  'https://example.com/path', 'https://example.com/', 'https://example.com:443/other',
  'http://example.com', 'https://example.com?x=1']) {
  assert.equal(isAllowedHttpOrigin(rejected, ['https://example.com']), false, rejected);
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-origin-'));
const port = await freePort();
const credential = randomUUID();
const url = 'http://127.0.0.1:' + port;
const env = {
  ...process.env, CODEXBRIDGE_ROOT: root, CODEXBRIDGE_ALLOWED_ROOTS: root,
  CODEXBRIDGE_HOST: '127.0.0.1', CODEXBRIDGE_PORT: String(port),
  CODEXBRIDGE_HTTP_TOKEN: credential, CODEXBRIDGE_HTTP_AUTH_MODE: 'header-only',
  CODEXBRIDGE_HTTP_ALLOWED_ORIGINS: 'https://approved.example',
  CODEXBRIDGE_BASH_MODE: 'off', CODEXBRIDGE_WRITE_MODE: 'off'
};
const child = spawn(process.execPath, ['dist/http.js'], {
  cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe']
});
let errors = '';
child.stderr.on('data', data => { errors += String(data); });
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(url + '/healthz', { headers: { Authorization: 'Bearer ' + credential } });
      if (response.status === 200) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, errors);
  const target = url + '/healthz';
  const auth = { Authorization: 'Bearer ' + credential };
  const allowed = await fetch(target, { headers: { ...auth, Origin: 'https://approved.example' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://approved.example');
  const local = await fetch(target, { headers: { ...auth, Origin: url } });
  assert.equal(local.status, 200);
  const missing = await fetch(target, { headers: auth });
  assert.equal(missing.status, 200);
  for (const origin of ['https://evil.example', 'null', 'https://approved.example.evil.net']) {
    const response = await fetch(target, { headers: { ...auth, Origin: origin } });
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  const preflight = await fetch(url + '/mcp', {
    method: 'OPTIONS', headers: { Origin: 'https://evil.example',
      'Access-Control-Request-Method': 'POST' }
  });
  assert.equal(preflight.status, 403);
  console.log('HTTP Origin policy integration passed: allowed, rejected, headerless and preflight');
} finally {
  child.kill('SIGTERM');
  await rm(root, { recursive: true, force: true });
}
