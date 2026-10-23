import assert from 'node:assert/strict';
import { checkOAuthMetadata } from '../dist/oauthMetadataReadiness.js';

const base = {
  expectedResource: 'https://bridge.example/mcp',
  protectedResource: {
    resource: 'https://bridge.example/mcp',
    authorization_servers: ['https://auth.example'],
    scopes_supported: ['workspace:read']
  },
  authorizationServer: {
    issuer: 'https://auth.example',
    authorization_endpoint: 'https://auth.example/authorize',
    token_endpoint: 'https://auth.example/token',
    client_id_metadata_document_supported: true,
    code_challenge_methods_supported: ['S256'],
    response_types_supported: ['code'],
    token_endpoint_auth_methods_supported: ['private_key_jwt'],
    token_endpoint_auth_signing_alg_values_supported: ['RS256'],
    authorization_response_iss_parameter_supported: true
  }
};

function check(input, compatible, message) {
  const result = checkOAuthMetadata(input);
  assert.equal(result.metadataCompatible, compatible, message + ': ' + result.errors.join(', '));
  assert.equal(result.clientIdentityVerified, false);
  assert.equal(result.tokensValidated, false);
  assert.equal(result.runtimeEnforced, false);
  return result;
}

check(base, true, 'CIMD with signed client assertion');
check({ ...base, authorizationServer: { ...base.authorizationServer,
  issuer: 'https://auth.example/',
}, protectedResource: { ...base.protectedResource,
  authorization_servers: ['https://auth.example/'] } }, true, 'Issuer ending in slash');
check({ ...base, authorizationServer: { ...base.authorizationServer,
  token_endpoint_auth_signing_alg_values_supported: ['none'] } }, false, 'JWT signing algorithm not valid');
check({ ...base, authorizationServer: { ...base.authorizationServer,
  token_endpoint_auth_signing_alg_values_supported: [] } }, false, 'JWT signing algorithm missing');
check({ ...base, authorizationServer: { ...base.authorizationServer,
  response_types_supported: undefined } }, false, 'Code flow metadata absent');
check({ ...base, protectedResource: { ...base.protectedResource,
  resource: 'https://bridge.example/wrong' } }, false, 'Wrong resource');
check({ ...base, protectedResource: { ...base.protectedResource,
  authorization_servers: ['https://other.example'] } }, false, 'Issuer mismatch');
check({ ...base, authorizationServer: { ...base.authorizationServer,
  issuer: 'http://auth.example' } }, false, 'Insecure issuer');
check({ ...base, authorizationServer: { ...base.authorizationServer,
  code_challenge_methods_supported: ['plain'] } }, false, 'Missing PKCE S256');
check({ ...base, authorizationServer: { ...base.authorizationServer,
  authorization_endpoint: 'http://auth.example/authorize' } }, false, 'Insecure authorization endpoint');
check({ ...base, authorizationServer: { ...base.authorizationServer,
  response_types_supported: ['token'] } }, false, 'Missing code flow');
check({ ...base, authorizationServer: { ...base.authorizationServer,
  client_id_metadata_document_supported: true,
  token_endpoint_auth_methods_supported: ['client_secret_basic'] } }, false, 'Unsupported CIMD auth method');

const noRegistration = { ...base, authorizationServer: {
  ...base.authorizationServer, client_id_metadata_document_supported: false
} };
check(noRegistration, false, 'Missing registration options');
check({ ...noRegistration, hasPreRegisteredClient: true }, true, 'Pre-registered client');
check({ ...noRegistration, authorizationServer: {
  ...noRegistration.authorizationServer, registration_endpoint: 'https://auth.example/register'
} }, true, 'Dynamic registration');
const unsignedCimd = check({ ...base, authorizationServer: {
  ...base.authorizationServer, token_endpoint_auth_methods_supported: ['none'],
  authorization_response_iss_parameter_supported: false
} }, true, 'Public CIMD with callback warning');
assert.ok(unsignedCimd.warnings.some(message => message.includes('private_key_jwt')));
assert.ok(unsignedCimd.warnings.some(message => message.includes('RFC 9207')));
assert.ok(check(base, true, 'Safe metadata').warnings.some(message => message.includes('never proves')));
console.log('OAuth metadata compatibility checks passed; no real identity or token validation performed');
