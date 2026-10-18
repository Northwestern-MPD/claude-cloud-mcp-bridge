import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readIdentityConfig } from '../apps/identity/config.js';
import { authenticationChallenge, protectedResourceMetadata, createJwksResolver } from '../packages/auth/index.js';
import type { AuthConfig } from '../packages/auth/types.js';

const env: NodeJS.ProcessEnv = {
  AUTH0_ISSUER: 'https://class.example.auth0.com/', AUTH0_JWKS_URI: 'https://class.example.auth0.com/.well-known/jwks.json',
  MCP_RESOURCE_URI: 'https://bridge.example/mcp', MCP_EXTERNAL_ORIGIN: 'https://bridge.example', AUTH0_ALLOWED_CLIENT_IDS: 'claude-client',
  DATABASE_URL: 'postgresql://mpd_identity_app:fixture-only@db.railway.internal/identity', DB_TRANSPORT_MODE: 'railway-private',
  AUTHZ_STORE_ID: '7e49f98a-2bf3-4df6-811f-b5dfe78aa74a', AUTHZ_DEPLOY_EPOCH: 'initial', AUTHZ_TOKEN_IAT_AFTER: '0', AUTHZ_MAINTENANCE: 'true', PORT: '3000',
};

// Break caught: explicit TLS, browser/client allowlists and maintenance settings disappear or silently widen.
test('identity configuration preserves explicit verified TLS and deduplicates trusted clients and browser origins', () => {
  const config = readIdentityConfig({ ...env, DB_TRANSPORT_MODE: 'verify-full', DB_CA_CERT: 'operator-provided-root-ca', DATABASE_URL: 'postgresql://mpd_identity_app:fixture-only@private.example/identity', AUTH0_ALLOWED_CLIENT_IDS: 'claude-client, another_client,claude-client', MCP_ALLOWED_ORIGINS: 'https://bridge.example,https://client.example,https://bridge.example', AUTHZ_MAINTENANCE: 'false', HOST: '::1', PORT: '65535', AUTHZ_ADMIN_SOCKET: '/tmp/private-identity/admin.sock' });
  assert.deepEqual(config.auth.allowedClientIds, ['claude-client', 'another_client']);
  assert.deepEqual(config.allowedOrigins, ['https://bridge.example', 'https://client.example']);
  assert.equal(config.database.ca, 'operator-provided-root-ca');
  assert.equal(config.database.transportMode, 'verify-full');
  assert.equal(config.maintenance, false);
  assert.equal(config.host, '::1'); assert.equal(config.port, 65535);
  assert.equal(config.adminSocketPath, '/tmp/private-identity/admin.sock');
});

for (const [name, overrides] of [
  ['embedded client whitespace', { AUTH0_ALLOWED_CLIENT_IDS: 'bad client' }],
  ['empty client list entry', { AUTH0_ALLOWED_CLIENT_IDS: 'good,,other' }],
  ['browser origin path', { MCP_ALLOWED_ORIGINS: 'https://client.example/extra' }],
  ['credential-bearing issuer', { AUTH0_ISSUER: 'https://operator:secret@class.example.auth0.com/' }],
  ['issuer query', { AUTH0_ISSUER: 'https://class.example.auth0.com/?query=unexpected' }],
  ['required value whitespace', { AUTHZ_DEPLOY_EPOCH: ' initial' }],
  ['epoch whitespace', { AUTHZ_DEPLOY_EPOCH: 'initial epoch' }],
  ['unsafe integer issuance cutoff', { AUTHZ_TOKEN_IAT_AFTER: '9007199254740992' }],
  ['ambiguous maintenance switch', { AUTHZ_MAINTENANCE: 'yes' }],
  ['unapproved bind host', { HOST: '127.0.0.2' }],
  ['zero listen port', { PORT: '0' }],
  ['out-of-range listen port', { PORT: '65536' }],
  ['oversized admin socket', { AUTHZ_ADMIN_SOCKET: '/tmp/' + 'x'.repeat(100) }],
  ['admin socket control byte', { AUTHZ_ADMIN_SOCKET: '/tmp/identity\nadmin.sock' }],
  ['missing external TLS root', { DB_TRANSPORT_MODE: 'verify-full', DATABASE_URL: 'postgresql://mpd_identity_app:fixture-only@private.example/identity' }],
] as const) test(`identity deployment rejects ${name} with controlled diagnostics`, () => {
  assert.throws(() => readIdentityConfig({ ...env, ...overrides }), (error: unknown) => error instanceof Error && error.message === 'INVALID_IDENTITY_CONFIG');
});

const auth: AuthConfig = { issuer: 'https://class.example/', jwksUri: 'https://class.example/.well-known/jwks.json', resource: 'https://bridge.example/mcp', allowedClientIds: ['client'], requiredScopes: [] };
// Break caught: reusable metadata advertises an empty scope array or invents scopes for a scope-free resource.
test('scope-free resource metadata omits optional empty scope fields', () => {
  assert.deepEqual(protectedResourceMetadata(auth), { resource: 'https://bridge.example/mcp', authorization_servers: ['https://class.example/'], bearer_methods_supported: ['header'] });
  assert.equal(authenticationChallenge(auth, 'insufficient_scope'), 'Bearer resource_metadata="https://bridge.example/.well-known/oauth-protected-resource/mcp", error="insufficient_scope"');
});

// Break caught: trusted JWKS configuration accepts URL credentials, fragments, HTTP or malformed URLs.
test('JWKS configuration rejects unsafe URI forms before issuing network requests', () => {
  let calls = 0;
  const deps = { now: Date.now, fetch: async () => { calls++; throw new Error('must not fetch'); } };
  for (const jwksUri of ['http://class.example/keys', 'https://operator:secret@class.example/keys', 'https://class.example/keys#fragment', 'not-a-url']) assert.throws(() => createJwksResolver({ ...auth, jwksUri }, deps), /INVALID_TOKEN/);
  assert.equal(calls, 0);
});

// Break caught: an advertised oversized key set is buffered instead of rejected before reading its body.
test('JWKS declared content-length above 64KiB is rejected and its fetch is aborted', async () => {
  let signal: AbortSignal | undefined;
  const resolve = createJwksResolver(auth, { now: Date.now, fetch: async (_uri, init) => { signal = init?.signal ?? undefined; return new Response('{}', { headers: { 'Content-Length': '65537' } }); } });
  await assert.rejects(async () => { await resolve({ alg: 'RS256', kid: 'current' }, { payload: '', signature: '', protected: '' }); }, /INVALID_TOKEN/);
  assert.equal(signal?.aborted, true);
});
