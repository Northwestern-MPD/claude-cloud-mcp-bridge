import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identityFixture } from '../support/identity.js';

// Railway's documented deployment prober uses this Host, not the public resource host.
test('Railway health hostname is accepted only for plain GET liveness and grants no protected route', async t => {
  const f = await identityFixture(t, { maintenance: true });
  const headers = { Host: 'healthcheck.railway.app' };
  const response = await f.request('/health', { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  for (const path of ['/ready', '/mcp', '/.well-known/oauth-protected-resource/mcp']) {
    assert.equal((await f.request(path, { headers })).status, 403);
  }
  assert.equal((await f.request('/health', { method: 'POST', headers })).status, 403);
  const extraHeaders: Record<string, string>[] = [{ Origin: 'https://attacker.invalid' }, { Forwarded: 'host=bridge.example' }, { 'X-Forwarded-Host': 'bridge.example' }, { 'X-Forwarded-Proto': 'https' }];
  for (const extra of extraHeaders) {
    assert.equal((await f.request('/health', { headers: { ...headers, ...extra } })).status, 403);
  }
  assert.equal((await f.request('/health', { headers: { Host: 'attacker.invalid' } })).status, 403);
});
