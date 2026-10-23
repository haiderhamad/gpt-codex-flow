import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const number = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return number;
}

async function test(mode, provided) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-auth-'));
  const number = await freePort();
  const authValue = randomUUID();
  const env = { ...process.env, CODEXBRIDGE_ROOT: root,
    CODEXBRIDGE_HOME: root + '/owner-state',
    CODEXBRIDGE_ALLOWED_ROOTS: root, CODEXBRIDGE_HOST: '127.0.0.1',
    CODEXBRIDGE_PORT: String(number), CODEXBRIDGE_HTTP_AUTH_MODE: mode,
    CODEXBRIDGE_BASH_MODE: 'off', CODEXBRIDGE_WRITE_MODE: 'off' };
  delete env.CODEXBRIDGE_HTTP_TOKEN;
  delete env.CODEBASE_BRIDGE_HTTP_TOKEN;
  if (provided) env.CODEXBRIDGE_HTTP_TOKEN = authValue;
  const child = spawn(process.execPath, ['dist/http.js'], {
    cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', part => { stderr += String(part); });
  try {
    if (!provided) {
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('startup timeout')), 7000))
      ]);
      assert.match(stderr, /required for this HTTP binding/);
      return;
    }
    const url = 'http://127.0.0.1:' + number + '/healthz';
    const headers = { Authorization: 'Bearer ' + authValue };
    let ready = false;
    for (let attempt = 0; attempt < 70; attempt++) {
      try { if ((await fetch(url, { headers })).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, stderr);
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.httpAuthMode, mode);
    assert.equal(health.clientIdentityVerified, false);
    for (const payload of [{bash:'full'}, {write:'workspace'}, {codexSessions:'read'},
      {codexDir:'/unapproved/private'}, {cloudflareTokenFile:'/unapproved/credential'}]) {
      const widened = await fetch(url.replace('healthz','admin/profile'), {
        method:'POST', headers:{...headers,'content-type':'application/json'},
        body:JSON.stringify(payload)
      });
      assert.equal(widened.status,403,'HTTP bearer must not persist broader owner policy');
      assert.equal((await widened.json()).error.code,'owner_local_policy_required');
    }
    const equivalent = await fetch(url.replace('healthz','admin/profile'), {
      method:'POST', headers:{...headers,'content-type':'application/json'},
      body:JSON.stringify({tunnel:'none',write:'off',bash:'off'})
    });
    assert.equal(equivalent.status,403,'HTTP credentials cannot save even equivalent owner settings');
    assert.equal((await equivalent.json()).error.code,'owner_local_policy_required');
    for (const route of ['owner/status','owner/session','owner/preview']) {
      for (const method of ['GET','POST']) {
        const denied = await fetch(url.replace('healthz',route), {method,headers});
        assert.equal(denied.status,403,method+' '+route+' must never reach the MCP data plane');
      }
    }
    for (const method of ['PUT','PATCH','DELETE']) {
      const denied = await fetch(url.replace('healthz','admin/profile'), {method,headers});
      assert.equal(denied.status,403,method+' admin must be denied');
      assert.equal((await denied.json()).error.code,'owner_local_policy_required');
    }
    const expected = mode === 'legacy' ? 200 : 401;
    assert.equal((await fetch(url + '?token=' + authValue)).status, expected);
    assert.equal((await fetch(url + '?codexbridge_token=' + authValue, { headers })).status, expected);
    assert.equal((await fetch(url.replace('healthz', 'admin/profile'))).status, 401);
    console.log('HTTP auth ' + mode + ' passed');
  } finally {
    child.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  }
}
await test('legacy', true);
await test('header-only', true);
await test('header-only', false);
