import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPair, SignJWT } from 'jose';
import { AuthError, requireScopes, VERIFIED_EMAIL_CLAIM, verifyAccessToken } from '../packages/auth/index.js';
import { signingFixture } from './support/auth.js';

const NOW = 1_800_000_000_000;
const SECONDS = 1_800_000_000;
const CLAIM = 'https://github.com/Northwestern-MPD/claims/email_verified';

test('normalizes a verified access token into frozen identity evidence with millisecond times', async () => {
  const f = await signingFixture(NOW);
  const token = await f.mint({ scope: 'identity:read assignments:read identity:read', email: 'private@example.edu', arbitrary: 'secret' });
  const principal = await verifyAccessToken(token, f.config, f);
  assert.deepEqual(principal, {
    issuer: 'https://class.example.auth0.com/', subject: 'auth0|student-1', clientId: 'claude-client',
    scopes: ['identity:read', 'assignments:read'], issuedAt: 1_800_000_000_000,
    expiresAt: 1_800_000_600_000, emailVerified: true,
  });
  assert.ok(Object.isFrozen(principal));
  assert.ok(Object.isFrozen(principal.scopes));
  assert.equal(VERIFIED_EMAIL_CLAIM, CLAIM);
});

test('rejects an access token for another resource', async () => {
  const f = await signingFixture(1_800_000_000_000);
  const token = await f.mint({ aud: 'https://other.example/mcp' });
  await assert.rejects(verifyAccessToken(token, f.config, f), /INVALID_TOKEN/);
});

for (const [name, overrides] of [
  ['ID token client audience', { aud: 'claude-client' }],
  ['issuer without canonical trailing slash', { iss: 'https://class.example.auth0.com' }],
  ['another issuer', { iss: 'https://attacker.example/' }],
  ['missing issuer', { iss: undefined }],
  ['missing audience', { aud: undefined }],
  ['missing subject', { sub: undefined }], ['empty subject', { sub: '' }],
  ['whitespace subject', { sub: '  ' }], ['numeric subject', { sub: 42 }],
  ['missing azp', { azp: undefined }], ['empty azp', { azp: '' }],
  ['whitespace azp', { azp: ' ' }], ['numeric azp', { azp: 42 }],
  ['unapproved client', { azp: 'other-client' }],
  ['conflicting client_id', { client_id: 'other-client' }],
  ['nonstring client_id', { client_id: 42 }],
  ['null client_id', { client_id: null }], ['empty client_id', { client_id: '' }],
  ['missing verified email', { [CLAIM]: undefined }],
  ['false verified email', { [CLAIM]: false }],
  ['string verified email', { [CLAIM]: 'true' }],
  ['object verified email', { [CLAIM]: { verified: true } }],
  ['untrusted default email verification', { [CLAIM]: undefined, email_verified: true }],
  ['missing expiry', { exp: undefined }], ['string expiry', { exp: '1800000600' }],
  ['missing issuance', { iat: undefined }], ['string issuance', { iat: '1800000000' }],
  ['invalid not-before', { nbf: '1800000000' }],
  ['missing scope', { scope: undefined }], ['empty scope', { scope: '' }],
  ['array scope', { scope: ['identity:read'] }], ['tab-delimited scope', { scope: 'identity:read\tassignments:read' }],
  ['scope with control character', { scope: 'identity:read\n' }],
] as const) {
  test(`rejects ${name}`, async () => {
    const f = await signingFixture(NOW);
    await assert.rejects(verifyAccessToken(await f.mint(overrides), f.config, f), /INVALID_TOKEN/);
  });
}

test('accepts audience membership and agreeing client_id', async () => {
  const f = await signingFixture(NOW);
  const principal = await verifyAccessToken(await f.mint({ aud: ['https://bridge.example/mcp', 'https://class.example.auth0.com/userinfo'], client_id: 'claude-client' }), f.config, f);
  assert.equal(principal.clientId, 'claude-client');
});

test('rejects a signature from an untrusted key', async () => {
  const f = await signingFixture(NOW);
  const wrongKeys = await generateKeyPair('RS256');
  await assert.rejects(verifyAccessToken(await f.mint(), f.config, { ...f, resolveKey: async () => wrongKeys.publicKey }), /INVALID_TOKEN/);
});

test('rejects RS384 even when its signature can be verified with the supplied RSA key', async () => {
  const f = await signingFixture(NOW);
  const keys = await generateKeyPair('RS384');
  const token = await new SignJWT({ iss: f.config.issuer, aud: f.config.resource, sub: 'auth0|student-1', azp: 'claude-client', scope: 'identity:read', iat: SECONDS, exp: SECONDS + 600, [CLAIM]: true })
    .setProtectedHeader({ alg: 'RS384' }).sign(keys.privateKey);
  await assert.rejects(verifyAccessToken(token, f.config, { ...f, resolveKey: async () => keys.publicKey }), /INVALID_TOKEN/);
});

test('rejects HS256 even with otherwise valid signed claims', async () => {
  const f = await signingFixture(NOW);
  const token = await new SignJWT({ iss: f.config.issuer, aud: f.config.resource, sub: 'auth0|student-1', azp: 'claude-client', scope: 'identity:read', iat: SECONDS, exp: SECONDS + 600, [CLAIM]: true })
    .setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32).fill(17));
  await assert.rejects(verifyAccessToken(token, f.config, f), /INVALID_TOKEN/);
});

test('rejects malformed compact JWT and local fixture credentials with sanitized errors', async () => {
  const f = await signingFixture(NOW);
  for (const token of ['secret-canary', 'Bearer eyJsecret', '', 'a.b.c']) {
    await assert.rejects(verifyAccessToken(token, f.config, f), error => {
      assert.ok(error instanceof AuthError);
      assert.equal(error.code, 'INVALID_TOKEN');
      assert.equal(error.message, 'INVALID_TOKEN');
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('key resolution failure denies authentication without exposing provider diagnostics', async () => {
  const f = await signingFixture(NOW);
  await assert.rejects(verifyAccessToken(await f.mint(), f.config, { ...f, resolveKey: async () => { throw new Error('secret-token-canary'); } }), /^AuthError: INVALID_TOKEN$/);
});

for (const [name, overrides, accepted] of [
  ['expiry inside tolerance', { exp: SECONDS - 59 }, true],
  ['expiry at tolerance', { exp: SECONDS - 60 }, false],
  ['expiry beyond tolerance', { exp: SECONDS - 61 }, false],
  ['issuance at tolerance', { iat: SECONDS + 60 }, true],
  ['issuance beyond tolerance', { iat: SECONDS + 61 }, false],
  ['not-before at tolerance', { nbf: SECONDS + 60 }, true],
  ['not-before beyond tolerance', { nbf: SECONDS + 61 }, false],
] as const) {
  test(`enforces ${name}`, async () => {
    const f = await signingFixture(NOW);
    const token = await f.mint(overrides);
    if (accepted) {
      assert.equal((await verifyAccessToken(token, f.config, f)).subject, 'auth0|student-1');
    } else {
      await assert.rejects(verifyAccessToken(token, f.config, f), /INVALID_TOKEN/);
    }
  });
}

test('requires every configured scope without accepting unsigned permission claims', async () => {
  const f = await signingFixture(NOW);
  await assert.rejects(verifyAccessToken(await f.mint({ scope: 'assignments:read', permissions: ['identity:read'] }), f.config, f), error => {
    assert.ok(error instanceof AuthError);
    assert.equal(error.code, 'INSUFFICIENT_SCOPE');
    return true;
  });
  await assert.rejects(verifyAccessToken(await f.mint(), { ...f.config, requiredScopes: ['identity:read', 'assignments:read'] }, f), /INSUFFICIENT_SCOPE/);
});

test('scope checks require all exact scopes and deny an empty principal scope set', async () => {
  const f = await signingFixture(NOW);
  const principal = await verifyAccessToken(await f.mint({ scope: 'identity:read assignments:read' }), f.config, f);
  assert.doesNotThrow(() => requireScopes(principal, ['identity:read', 'assignments:read']));
  assert.throws(() => requireScopes(principal, ['identity:read', 'desktop:write']), /INSUFFICIENT_SCOPE/);
  assert.throws(() => requireScopes(principal, ['identity']), /INSUFFICIENT_SCOPE/);
  assert.throws(() => requireScopes({ ...principal, scopes: [] }, ['identity:read']), /INSUFFICIENT_SCOPE/);
});
