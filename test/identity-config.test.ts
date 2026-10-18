import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readIdentityConfig } from '../apps/identity/config.js';

const env = {
  AUTH0_ISSUER: 'https://class.example.auth0.com/', AUTH0_JWKS_URI: 'https://class.example.auth0.com/.well-known/jwks.json',
  MCP_RESOURCE_URI: 'https://bridge.example/mcp', MCP_EXTERNAL_ORIGIN: 'https://bridge.example', AUTH0_ALLOWED_CLIENT_IDS: 'claude-client',
  DATABASE_URL: 'postgresql://mpd_identity_app:example-secret@db.railway.internal/identity', DB_TRANSPORT_MODE: 'railway-private',
  AUTHZ_STORE_ID: '7e49f98a-2bf3-4df6-811f-b5dfe78aa74a', AUTHZ_DEPLOY_EPOCH: 'initial', AUTHZ_TOKEN_IAT_AFTER: '0', AUTHZ_MAINTENANCE: 'true', PORT: '3000',
};

// Break caught: config silently defaults security authority or admits incomplete deployment inputs.
test('identity config validates explicit deployment authority with safe defaults', () => {
  const config = readIdentityConfig(env);
  assert.equal(config.auth.resource, 'https://bridge.example/mcp');
  assert.deepEqual(config.auth.requiredScopes, ['identity:read']);
  assert.deepEqual(config.allowedOrigins, ['https://bridge.example']);
  assert.equal(config.adminSocketPath, '/tmp/mpd-identity/admin.sock');
  assert.equal(config.maintenance, true);
  assert.equal(config.database.transportMode, 'railway-private');
  assert.equal(Object.isFrozen(config.auth.allowedClientIds), true);
});

for (const [name, overrides] of [
  ['issuer trailing slash', { AUTH0_ISSUER: 'https://class.example.auth0.com' }],
  ['issuer HTTPS', { AUTH0_ISSUER: 'http://class.example.auth0.com/' }],
  ['resource origin', { MCP_EXTERNAL_ORIGIN: 'https://attacker.invalid' }],
  ['public plaintext database', { DATABASE_URL: 'postgresql://mpd_identity_app:secret@db.public.example/identity' }],
  ['migration role', { DATABASE_URL: 'postgresql://mpd_identity_migrator:secret@db.railway.internal/identity' }],
  ['missing store', { AUTHZ_STORE_ID: '' }],
  ['negative cutoff', { AUTHZ_TOKEN_IAT_AFTER: '-1' }],
  ['fractional cutoff', { AUTHZ_TOKEN_IAT_AFTER: '1.5' }],
  ['missing maintenance', { AUTHZ_MAINTENANCE: undefined }],
  ['invalid port', { PORT: '3000oops' }],
  ['relative admin socket', { AUTHZ_ADMIN_SOCKET: 'admin.sock' }],
] as const) {
  test(`identity config rejects ${name} without exposing credentials`, () => {
    assert.throws(() => readIdentityConfig({ ...env, ...overrides }), (error: unknown) => error instanceof Error && error.message === 'INVALID_IDENTITY_CONFIG');
  });
}
