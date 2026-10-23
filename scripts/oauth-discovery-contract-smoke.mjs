import assert from 'node:assert/strict';
import http from 'node:http';
import { createOAuthDiscoveryContract } from '../dist/oauthDiscoveryContract.js';

const input = {
  expectedResource: 'https://bridge.example/mcp',
  initialScope: 'workspace:read',
  protectedResource: {
    resource: 'https://bridge.example/mcp',
    authorization_servers: ['https://identity.example'],
    scopes_supported: ['workspace:read', 'handoff:write']
  },
  authorizationServer: {
    issuer: 'https://identity.example',
    authorization_endpoint: 'https://identity.example/authorize',
    token_endpoint: 'https://identity.example/token',
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ['private_key_jwt'],
    token_endpoint_auth_signing_alg_values_supported: ['RS256'],
    authorization_response_iss_parameter_supported: true
  }
};

const contract = createOAuthDiscoveryContract(input);
assert.equal(contract.protectedResourcePath, '/.well-known/oauth-protected-resource/mcp');
assert.equal(contract.protectedResourceUrl,
  'https://bridge.example/.well-known/oauth-protected-resource/mcp');
assert.equal(contract.protectedResourceMetadata.resource, input.expectedResource);
assert.equal(contract.authenticated, false);
assert.equal(contract.challenge,
  'Bearer resource_metadata="https://bridge.example/.well-known/oauth-protected-resource/mcp", scope="workspace:read"');

for (const scope of ['workspace:write', 'workspace:read write', 'workspace:read\r\nX-Forged: 1']) {
  assert.throws(
    () => createOAuthDiscoveryContract({ ...input, initialScope: scope }),
    /scope/
  );
}
assert.throws(() => createOAuthDiscoveryContract({
  ...input, expectedResource: 'http://bridge.example/mcp'
}), /preflight failed/);
assert.throws(() => createOAuthDiscoveryContract({
  ...input, authorizationServer: {
    ...input.authorizationServer, code_challenge_methods_supported: ['plain']
  }
}), /preflight failed/);

const srv = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === contract.protectedResourcePath) {
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify(contract.protectedResourceMetadata));
    return;
  }
  res.writeHead(401, {
    'WWW-Authenticate': contract.challenge,
    'cache-control': 'no-store'
  });
  res.end('Unauthorized: disposable wire contract only');
});
await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
try {
  const address = srv.address();
  assert.ok(address && typeof address !== 'string');
  const root = 'http://127.0.0.1:' + address.port;
  const discovery = await fetch(root + contract.protectedResourcePath);
  assert.equal(discovery.status, 200);
  assert.equal(discovery.headers.get('content-type'), 'application/json');
  const metadata = await discovery.json();
  assert.equal(metadata.resource, input.expectedResource);
  assert.deepEqual(metadata.authorization_servers, ['https://identity.example']);

  for (const options of [{}, { headers: { Authorization: 'Bearer not-a-token' } }]) {
    const denied = await fetch(root + '/mcp', options);
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('www-authenticate'), contract.challenge);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  }
  const rootResource = createOAuthDiscoveryContract({
    ...input,
    expectedResource: 'https://bridge.example',
    protectedResource: { ...input.protectedResource, resource: 'https://bridge.example' }
  });
  assert.equal(rootResource.protectedResourcePath, '/.well-known/oauth-protected-resource');
  console.log('Disposable HTTP OAuth discovery contract passed: metadata, 401 challenge, and scope validation');
  console.log('Fixture only: no OAuth issuer reached, no tokens validated, no live MCP auth changed');
} finally {
  await new Promise((resolve, reject) =>
    srv.close(error => error ? reject(error) : resolve()));
}
