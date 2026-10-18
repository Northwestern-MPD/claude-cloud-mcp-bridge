import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportJWK, generateKeyPair } from 'jose';
import type { JWK, JWTVerifyGetKey } from 'jose';
import type { AuthConfig } from '../packages/auth/types.js';
import { signingFixture } from './support/auth.js';
import { verifyAccessToken } from '../packages/auth/verifier.js';
import { createJwksResolver } from '../packages/auth/jwks.js';
import { authenticationChallenge, metadataPath, protectedResourceMetadata } from '../packages/auth/metadata.js';

const config: AuthConfig = {
  issuer: 'https://class.example/',
  jwksUri: 'https://class.example/.well-known/jwks.json',
  resource: 'https://bridge.example/mcp',
  allowedClientIds: ['claude'],
  requiredScopes: ['identity:read'],
};
const nowMs = 1_800_000_000_000;
const token = { payload: '', signature: '', protected: '' };
async function key(kid: string) {
  const pair = await generateKeyPair('RS256', { extractable: true });
  return { ...pair, jwk: { ...await exportJWK(pair.publicKey), kid, use: 'sig', alg: 'RS256' } };
}
function discoveryFixture(jwks: JWK[]) {
  let clock = nowMs;
  let reply: () => Response | Promise<Response> = () => Response.json({ keys: jwks });
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return reply();
  };
  const resolve = createJwksResolver(config, { fetch: fetcher, now: () => clock });
  return {
    resolve: async (...args: Parameters<JWTVerifyGetKey>) => await resolve(...args), requests,
    advance(ms: number) { clock += ms; },
    respond(fn: typeof reply) { reply = fn; },
  };
}

// Break caught: replacing trusted configuration with attacker-provided jku/x5u or allowing redirects.
test('JWKS only fetches the configured URI with redirects disabled', async () => {
  const k = await key('current');
  const f = discoveryFixture([k.jwk]);
  await f.resolve({ alg: 'RS256', kid: 'current', jku: 'https://attacker.invalid/keys', x5u: 'https://attacker.invalid/cert' }, token);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]?.url, 'https://class.example/.well-known/jwks.json');
  assert.equal(f.requests[0]?.init?.redirect, 'error');
});

// Break caught: fetching on every request or retaining fresh status beyond ten minutes.
test('known JWKS keys refresh exactly at ten minutes', async () => {
  const k = await key('current');
  const f = discoveryFixture([k.jwk]);
  await f.resolve({ alg: 'RS256', kid: 'current' }, token);
  f.advance(599_999);
  await f.resolve({ alg: 'RS256', kid: 'current' }, token);
  assert.equal(f.requests.length, 1);
  f.advance(1);
  await f.resolve({ alg: 'RS256', kid: 'current' }, token);
  assert.equal(f.requests.length, 2);
});

// Break caught: failed refresh resets successful-fetch age or rejects trusted keys too early.
test('known keys survive an outage only until one hour after last successful fetch', async () => {
  const k = await key('current');
  const f = discoveryFixture([k.jwk]);
  await f.resolve({ alg: 'RS256', kid: 'current' }, token);
  f.respond(() => { throw new Error('upstream secret'); });
  f.advance(600_000);
  await f.resolve({ alg: 'RS256', kid: 'current' }, token);
  f.advance(2_999_999);
  await f.resolve({ alg: 'RS256', kid: 'current' }, token);
  f.advance(1);
  await assert.rejects(f.resolve({ alg: 'RS256', kid: 'current' }, token), /INVALID_TOKEN/);
});

// Break caught: fetch failure permits initial or unknown key use, or leaks network error details.
test('unavailable first fetch and unknown keys fail closed with controlled errors', async () => {
  const k = await key('current');
  const f = discoveryFixture([k.jwk]);
  f.respond(() => { throw new Error('upstream secret'); });
  await assert.rejects(f.resolve({ alg: 'RS256', kid: 'current' }, token), (error: unknown) => error instanceof Error && error.message === 'INVALID_TOKEN');
  f.advance(60_000);
  f.respond(() => Response.json({ keys: [k.jwk] }));
  await assert.rejects(f.resolve({ alg: 'RS256', kid: 'missing' }, token), /INVALID_TOKEN/);
});

// Break caught: unknown key spray fetches once per token or each new kid bypasses the cooldown.
test('unknown-key refresh is shared across kids and limited to once per minute', async () => {
  const k = await key('current');
  const rotated = await key('rotated');
  const f = discoveryFixture([k.jwk]);
  await f.resolve({ alg: 'RS256', kid: 'current' }, token);
  f.respond(() => Response.json({ keys: [k.jwk, rotated.jwk] }));
  await assert.rejects(f.resolve({ alg: 'RS256', kid: 'missing-a' }, token), /INVALID_TOKEN/);
  const afterRefresh = f.requests.length;
  await assert.rejects(f.resolve({ alg: 'RS256', kid: 'missing-b' }, token), /INVALID_TOKEN/);
  assert.equal(f.requests.length, afterRefresh);
  // The successful refresh above must have learned the newly rotated key.
  await f.resolve({ alg: 'RS256', kid: 'rotated' }, token);
  f.advance(59_999);
  await assert.rejects(f.resolve({ alg: 'RS256', kid: 'missing-c' }, token), /INVALID_TOKEN/);
  assert.equal(f.requests.length, afterRefresh);
  f.advance(1);
  await assert.rejects(f.resolve({ alg: 'RS256', kid: 'missing-d' }, token), /INVALID_TOKEN/);
  assert.equal(f.requests.length, afterRefresh + 1);
});

// Break caught: parallel requests each fetch their own keyset.
test('concurrent key requests share one in-flight fetch', async () => {
  const k = await key('current');
  const f = discoveryFixture([k.jwk]);
  await Promise.all(Array.from({ length: 10 }, () => f.resolve({ alg: 'RS256', kid: 'current' }, token)));
  assert.equal(f.requests.length, 1);
});

// Break caught: response size is checked only after buffering or reader is not cancelled on overflow.
test('JWKS streaming rejects and cancels a response above 64 KiB', async () => {
  const f = discoveryFixture([]);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(65_537)); },
    cancel() { cancelled = true; },
  });
  f.respond(() => new Response(stream));
  await assert.rejects(f.resolve({ alg: 'RS256', kid: 'current' }, token), /INVALID_TOKEN/);
  assert.equal(cancelled, true);
  assert.equal(f.requests[0]?.init?.signal?.aborted, true);
});

// Break caught: timeout covers headers but permits a stalled body to hang indefinitely.
test('JWKS request aborts stalled body reads after five seconds', async () => {
  const f = discoveryFixture([]);
  let cancelled = false;
  f.respond(() => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const started = performance.now();
  await assert.rejects(f.resolve({ alg: 'RS256', kid: 'current' }, token), /INVALID_TOKEN/);
  assert.ok(performance.now() - started >= 4_900);
  assert.ok(performance.now() - started < 6_500);
  assert.equal(f.requests[0]?.init?.signal?.aborted, true);
  assert.equal(cancelled, true);
});

// Break caught: unbounded or malformed key sets are used as trusted key material.
test('JWKS rejects more than 32 keys and malformed or redirect responses', async (t) => {
  const k = await key('current');
  for (const [name, response] of [
    ['33 keys', () => Response.json({ keys: Array.from({ length: 33 }, (_, i) => ({ ...k.jwk, kid: String(i) })) })],
    ['malformed JSON', () => new Response('{')],
    ['missing keys', () => Response.json({ nope: [] })],
    ['empty keys', () => Response.json({ keys: [] })],
    ['error status', () => new Response('no', { status: 500 })],
    ['redirect', () => new Response(null, { status: 302, headers: { Location: 'https://attacker.invalid/keys' } })],
  ] as const) {
    await t.test(name, async () => {
      const f = discoveryFixture([k.jwk]);
      f.respond(response);
      await assert.rejects(f.resolve({ alg: 'RS256', kid: 'current' }, token), /INVALID_TOKEN/);
    });
  }
});

// Break caught: implicit key selection or token-selected algorithm bypasses the resolver policy.
test('JWKS rejects missing kid and non-RS256 headers before fetching', async () => {
  const k = await key('current');
  const f = discoveryFixture([k.jwk]);
  await assert.rejects(f.resolve({ alg: 'RS256' }, token), /INVALID_TOKEN/);
  await assert.rejects(f.resolve({ alg: 'HS256', kid: 'current' }, token), /INVALID_TOKEN/);
  assert.equal(f.requests.length, 0);
});

// Break caught: metadata uses JWKS issuer keys as resource keys or changes canonical audience.
test('resource metadata advertises configured audience, issuer, scopes and header bearer transport', () => {
  assert.deepEqual(protectedResourceMetadata(config), {
    resource: 'https://bridge.example/mcp',
    authorization_servers: ['https://class.example/'],
    scopes_supported: ['identity:read'],
    bearer_methods_supported: ['header'],
  });
});

// Break caught: well-known path is appended after /mcp or loses deeper resource paths.
test('resource metadata paths insert well-known before the configured resource path', () => {
  assert.equal(metadataPath('https://bridge.example/mcp'), '/.well-known/oauth-protected-resource/mcp');
  assert.equal(metadataPath('https://bridge.example/course/mcp'), '/.well-known/oauth-protected-resource/course/mcp');
  assert.equal(metadataPath('https://bridge.example'), '/.well-known/oauth-protected-resource');
});

// Break caught: discovery points to request-controlled origin or missing scope challenge omits required scope.
test('authentication challenges advertise configured discovery and sufficient-scope retry information', () => {
  assert.equal(authenticationChallenge(config, 'invalid_token'), 'Bearer resource_metadata="https://bridge.example/.well-known/oauth-protected-resource/mcp", error="invalid_token"');
  assert.equal(authenticationChallenge(config, 'insufficient_scope'), 'Bearer resource_metadata="https://bridge.example/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", scope="identity:read"');
  assert.equal(authenticationChallenge(config, 'insufficient_scope', ['assignments:read']), 'Bearer resource_metadata="https://bridge.example/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", scope="assignments:read"');
});

// Break caught: quotes or CRLF in supplied scope values can inject another response header.
test('authentication challenges reject invalid scope values and resource URIs', () => {
  assert.throws(() => authenticationChallenge(config, 'insufficient_scope', ['identity:read\r\nX-Injected: yes']), /INVALID_TOKEN/);
  assert.throws(() => metadataPath('https://bridge.example/mcp#fragment'), /INVALID_TOKEN/);
  assert.throws(() => metadataPath('http://bridge.example/mcp'), /INVALID_TOKEN/);
});

// Break caught: the resolver returns unusable verification keys or audience/scope policy leaks across servers.
test('two resources reuse trusted JWKS while enforcing their own audience and scope policy', async () => {
  const f = await signingFixture(nowMs);
  let requests = 0;
  const resolveKey = createJwksResolver(f.config, {
    now: f.now,
    fetch: async (uri) => {
      assert.equal(uri, f.config.jwksUri);
      requests++;
      return Response.json({ keys: [f.publicJwk] });
    },
  });
  const deps = { resolveKey, now: f.now };
  const bridgeToken = await f.mint({}, { jku: 'https://attacker.invalid/keys', x5u: 'https://attacker.invalid/cert' });
  assert.equal((await verifyAccessToken(bridgeToken, f.config, deps)).subject, 'auth0|student-1');
  const assignments = { ...f.config, resource: 'https://assignments.example/mcp', requiredScopes: ['assignments:read'] };
  await assert.rejects(verifyAccessToken(bridgeToken, assignments, deps), /INVALID_TOKEN/);
  const assignmentsToken = await f.mint({ aud: assignments.resource, scope: 'assignments:read' });
  assert.deepEqual((await verifyAccessToken(assignmentsToken, assignments, deps)).scopes, ['assignments:read']);
  await assert.rejects(verifyAccessToken(assignmentsToken, f.config, deps), /INVALID_TOKEN/);
  await assert.rejects(verifyAccessToken(await f.mint({ aud: assignments.resource }), assignments, deps), /INSUFFICIENT_SCOPE/);
  assert.equal(requests, 1);
});

// Break caught: implementations reject the documented upper bounds instead of only exceeding values.
test('JWKS permits 32 keys and an exactly 64 KiB response', async () => {
  const k = await key('current');
  const data = JSON.stringify({ keys: Array.from({ length: 32 }, (_, i) => ({ ...k.jwk, kid: i === 0 ? 'current' : String(i) })) });
  const f = discoveryFixture([]);
  f.respond(() => new Response(data.padEnd(65_536, ' ')));
  await f.resolve({ alg: 'RS256', kid: 'current' }, token);
});

// Break caught: failures to refresh an unknown key bypass cooldown or extend cached-key lifetime.
test('failed unknown-key refresh is rate limited while known keys remain usable', async () => {
  const k = await key('current');
  const f = discoveryFixture([k.jwk]);
  await f.resolve({ alg: 'RS256', kid: 'current' }, token);
  f.respond(() => { throw new Error('outage'); });
  await assert.rejects(f.resolve({ alg: 'RS256', kid: 'unknown' }, token), /INVALID_TOKEN/);
  const attempts = f.requests.length;
  await assert.rejects(f.resolve({ alg: 'RS256', kid: 'another-unknown' }, token), /INVALID_TOKEN/);
  assert.equal(f.requests.length, attempts);
  await f.resolve({ alg: 'RS256', kid: 'current' }, token);
  f.advance(60_000);
  await assert.rejects(f.resolve({ alg: 'RS256', kid: 'unknown' }, token), /INVALID_TOKEN/);
  assert.equal(f.requests.length, attempts + 1);
});

// Break caught: a failed refresh is silently treated as trusted or a removed key remains cached forever.
test('successful refresh removes retired keys and replaces the trusted key set', async () => {
  const old = await key('old');
  const next = await key('next');
  const f = discoveryFixture([old.jwk]);
  await f.resolve({ alg: 'RS256', kid: 'old' }, token);
  f.respond(() => Response.json({ keys: [next.jwk] }));
  f.advance(600_000);
  await assert.rejects(f.resolve({ alg: 'RS256', kid: 'old' }, token), /INVALID_TOKEN/);
  await f.resolve({ alg: 'RS256', kid: 'next' }, token);
});

// Break caught: a fetch waiting for response headers can bypass the whole-request deadline.
test('JWKS request aborts a stalled fetch after five seconds', async () => {
  const f = discoveryFixture([]);
  f.respond(() => new Promise<Response>(() => undefined));
  await assert.rejects(f.resolve({ alg: 'RS256', kid: 'current' }, token), /INVALID_TOKEN/);
  assert.equal(f.requests[0]?.init?.signal?.aborted, true);
});

// Break caught: failed first fetches retry unboundedly before any trusted cache exists.
test('an unavailable first fetch has a shared one-minute retry cooldown', async () => {
  const f = discoveryFixture([]);
  f.respond(() => { throw new Error('offline'); });
  await assert.rejects(f.resolve({ alg: 'RS256', kid: 'first' }, token), /INVALID_TOKEN/);
  await assert.rejects(f.resolve({ alg: 'RS256', kid: 'second' }, token), /INVALID_TOKEN/);
  assert.equal(f.requests.length, 1);
  f.advance(60_000);
  await assert.rejects(f.resolve({ alg: 'RS256', kid: 'third' }, token), /INVALID_TOKEN/);
  assert.equal(f.requests.length, 2);
});

// Break caught: cached-key age is calculated before a failed asynchronous refresh instead of after it.
test('JWKS checks the one-hour trust bound after a pending refresh fails', async () => {
  const k = await key('current');
  const f = discoveryFixture([k.jwk]);
  await f.resolve({ alg: 'RS256', kid: 'current' }, token);
  f.advance(3_599_999);
  f.respond(async () => {
    await Promise.resolve();
    f.advance(1);
    throw new Error('outage');
  });
  await assert.rejects(f.resolve({ alg: 'RS256', kid: 'current' }, token), /INVALID_TOKEN/);
});
