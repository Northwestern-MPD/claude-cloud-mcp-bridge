import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { request as nodeRequest } from 'node:http';
import { connect } from 'node:net';
import { test } from 'node:test';
import { identityFixture } from '../support/identity.js';
import { verifyAccessToken } from '../../packages/auth/index.js';
import { authorizeIdentity } from '../../packages/authorization/identity.js';
import { createIdentityRuntime } from '../../packages/authorization/runtime.js';
import { assertTransportContext, recordTransportContext } from '../../packages/storage/contexts.js';
import { startIdentityServer } from '../../apps/identity/server.js';

const jsonHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' };
const rpc = (id: number, method: string, params = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
async function evidence(f: Awaited<ReturnType<typeof identityFixture>>, overrides: Record<string, unknown> = {}) {
  const token = await f.signing.mint(overrides);
  const principal = await verifyAccessToken(token, f.config.auth, { resolveKey: f.signing.resolveKey, now: f.clock });
  return { principal, resource: f.config.auth.resource, tokenFingerprint: createHash('sha256').update(token).digest('hex') };
}
async function raw(url: string, method = 'POST', body = '{}', headers: Record<string, string> = {}) {
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = nodeRequest(`${url}/mcp`, { method, headers: { Host: 'bridge.example', ...headers } }, response => {
      let data = ''; response.setEncoding('utf8'); response.on('data', chunk => { data += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, body: data }));
    });
    request.on('error', reject); request.end(body);
  });
}

// Break caught: valid DELETE leaves a context reusable, or non-initialized methods create anonymous transports.
test('identity transport enforces method initialization and deletes an owned authenticated session', async t => {
  const f = await identityFixture(t);
  assert.equal((await f.request('/mcp', { method: 'PUT', headers: jsonHeaders, body: '{}' })).status, 405);
  assert.equal((await f.request('/mcp', { headers: { Accept: 'text/event-stream' } })).status, 400);
  assert.equal((await f.request('/mcp', { method: 'POST', headers: jsonHeaders, body: rpc(1, 'tools/list') })).status, 400);
  assert.equal((await f.request('/mcp', { method: 'POST', headers: { ...jsonHeaders, 'mcp-session-id': randomUUID() }, body: rpc(2, 'tools/list') })).status, 403);
  const { transport } = await f.sdk();
  const id = transport.sessionId!;
  assert.equal((await f.request('/mcp', { method: 'DELETE', headers: { ...jsonHeaders, 'mcp-session-id': id } })).status, 200);
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.work_contexts WHERE id=$1', [id])).rows[0].state, 'revoked');
  assert.equal((await f.request('/mcp', { method: 'POST', headers: { ...jsonHeaders, 'mcp-session-id': id }, body: rpc(3, 'tools/list') })).status, 403);
});

// Break caught: missing/incorrect media type bypasses the protected parser or harmless no-argument requests are rejected.
test('identity rejects missing or unsupported media types while accepting omitted empty tool arguments', async t => {
  const f = await identityFixture(t);
  const authorization = `Bearer ${f.bearer}`;
  for (const headers of [{ Authorization: authorization }, { Authorization: authorization, 'Content-Type': 'text/plain' }] as Record<string, string>[]) assert.equal((await raw(f.server.url, 'POST', '{}', headers)).status, 415);
  const { transport } = await f.sdk();
  const response = await f.request('/mcp', { method: 'POST', headers: { ...jsonHeaders, 'mcp-session-id': transport.sessionId! }, body: rpc(4, 'tools/call', { name: 'class_identity' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.structuredContent.desktop_access, false);
});

// Break caught: forwarded headers can select trust or matching explicitly configured browser/proxy fields are denied.
test('identity accepts configured origin/proxy metadata and denies forwarded authority spoofing', async t => {
  const f = await identityFixture(t);
  const { transport } = await f.sdk();
  const common = { ...jsonHeaders, 'mcp-session-id': transport.sessionId! };
  assert.equal((await f.request('/mcp', { method: 'POST', body: rpc(5, 'tools/list'), headers: { ...common, Origin: 'https://bridge.example', 'X-Forwarded-Host': 'bridge.example', 'X-Forwarded-Proto': 'https' } })).status, 200);
  for (const headers of [{ Forwarded: 'host=attacker.invalid;proto=https' }, { 'X-Forwarded-Proto': 'http' }] as Record<string, string>[]) assert.equal((await f.request('/mcp', { method: 'POST', body: rpc(6, 'tools/list'), headers: { ...common, ...headers } })).status, 403);
});

// Break caught: context creation accepts an unknown user, maintenance, expired evidence or a token at the issuance cutoff.
test('durable transport creation checks current user maintenance expiry and strict issuance cutoff', async t => {
  const f = await identityFixture(t);
  const auth = await evidence(f); await authorizeIdentity(f.store, auth, { clock: f.clock });
  await assert.rejects(recordTransportContext(f.store, (await evidence(f, { sub: 'auth0|unknown' })).principal, auth.resource, f.clock), /NOT_ENROLLED/);
  await f.store.setMaintenance(true);
  await assert.rejects(recordTransportContext(f.store, auth.principal, auth.resource, f.clock), /STORE_UNAVAILABLE/);
  await f.store.setMaintenance(false);
  await assert.rejects(recordTransportContext(f.store, auth.principal, auth.resource, () => NaN), /TOKEN_EXPIRED/);
  const atCutoff = await evidence(f, { iat: 0 });
  await assert.rejects(recordTransportContext(f.store, atCutoff.principal, auth.resource, f.clock), /TOKEN_ISSUED_BEFORE_CUTOFF/);
  f.advance(601_000);
  await assert.rejects(recordTransportContext(f.store, auth.principal, auth.resource, f.clock), /TOKEN_EXPIRED/);
});

// Break caught: a valid copied context object overrides its durable boot/client/resource/owner/expiry binding.
test('durable transport checks reject missing mismatched and expired persisted bindings', async t => {
  const f = await identityFixture(t);
  const auth = await evidence(f); await authorizeIdentity(f.store, auth, { clock: f.clock });
  const context = await recordTransportContext(f.store, auth.principal, auth.resource, f.clock);
  await assertTransportContext(f.store, context, auth, f.clock);
  await assert.rejects(assertTransportContext(f.store, { ...context, id: randomUUID() }, auth, f.clock), /CONTEXT_DENIED/);
  await assert.rejects(assertTransportContext(f.store, { ...context, userId: randomUUID() }, auth, f.clock), /CONTEXT_DENIED/);
  for (const [column, value] of [['boot_id', randomUUID()], ['deployment_epoch', 'other-epoch'], ['client_id', 'other-client'], ['resource', 'https://assignments.example/mcp']] as const) {
    const previous = (await f.db.admin.query(`SELECT ${column} AS value FROM mpd_identity.work_contexts WHERE id=$1`, [context.id])).rows[0].value;
    await f.db.admin.query(`UPDATE mpd_identity.work_contexts SET ${column}=$2 WHERE id=$1`, [context.id, value]);
    await assert.rejects(assertTransportContext(f.store, context, auth, f.clock), /CONTEXT_DENIED/);
    await f.db.admin.query(`UPDATE mpd_identity.work_contexts SET ${column}=$2 WHERE id=$1`, [context.id, previous]);
  }
  f.advance(3_600_000);
  const now = Math.floor(f.clock() / 1000);
  await assert.rejects(assertTransportContext(f.store, context, await evidence(f, { iat: now, exp: now + 600 }), f.clock), /CONTEXT_DENIED/);
});

// Break caught: selective invalidation removes unrelated contexts or a transport-close failure retains authority/poisons invalidation.
test('runtime invalidation filters real context registrations and survives a close callback failure', async t => {
  const f = await identityFixture(t);
  const auth = await evidence(f); const view = await authorizeIdentity(f.store, auth, { clock: f.clock });
  const first = await recordTransportContext(f.store, auth.principal, auth.resource, f.clock);
  const second = await recordTransportContext(f.store, auth.principal, auth.resource, f.clock);
  const third = await recordTransportContext(f.store, auth.principal, auth.resource, f.clock);
  const runtime = createIdentityRuntime(f.store); t.after(() => runtime.close());
  const closed: string[] = [];
  runtime.registerContext(first, [f.teamId], () => { closed.push(first.id); throw new Error('transport failed to close'); });
  runtime.registerContext(second, [f.teamId], () => { closed.push(second.id); });
  const unregister = runtime.registerContext(third, [f.teamId], () => { closed.push(third.id); });
  runtime.invalidate({ contextId: randomUUID() }); runtime.invalidate({ userId: randomUUID() }); runtime.invalidate({ teamId: randomUUID() });
  assert.deepEqual(closed, []); assert.equal(runtime.isActive(first.id), true);
  unregister();
  runtime.invalidate({ userId: view.userId, teamId: f.teamId });
  assert.deepEqual(closed, [first.id, second.id]);
  assert.equal(runtime.isActive(first.id), false); assert.equal(runtime.isActive(second.id), false);
  runtime.close();
  assert.throws(() => runtime.registerContext(third, [f.teamId], () => undefined), /STORE_UNAVAILABLE/);
});

// Break caught: a normal bind collision leaks the new server lifetime or shuts down the incumbent's runtime.
test('identity startup rejects an occupied bind port while the incumbent stays ready', async t => {
  const f = await identityFixture(t);
  const runtime = createIdentityRuntime(f.store); t.after(() => runtime.close());
  await assert.rejects(startIdentityServer({ config: { ...f.config, port: Number(new URL(f.server.url).port) }, store: f.store, runtime, verify: async token => (await evidenceFromToken(f, token)).principal }), (error: unknown) => (error as { code?: string }).code === 'EADDRINUSE');
  assert.equal((await f.request('/ready')).status, 200);
});
async function evidenceFromToken(f: Awaited<ReturnType<typeof identityFixture>>, token: string) { return { principal: await verifyAccessToken(token, f.config.auth, f.signing) }; }

// Break caught: a provider/network exception exposes credential diagnostics instead of a controlled service failure.
test('IPv6 identity listener hides unexpected verification errors', async t => {
  const f = await identityFixture(t);
  const runtime = createIdentityRuntime(f.store); t.after(() => runtime.close());
  const server = await startIdentityServer({ config: { ...f.config, host: '::1' }, store: f.store, runtime, verify: async () => { throw new Error('CANARY provider credential diagnostic'); } });
  t.after(() => server.close());
  assert.match(server.url, /^http:\/\/\[::1\]:\d+$/);
  const response = await raw(server.url, 'POST', '{}', { ...jsonHeaders, Authorization: `Bearer ${f.bearer}` });
  assert.equal(response.status, 503); assert.equal(response.body, '{"error":"SERVICE_UNAVAILABLE"}');
});

// Break caught: identity unexpectedly accepts an upgrade into a production desktop/agent socket.
test('identity HTTP listener closes WebSocket upgrades without granting a transport', async t => {
  const f = await identityFixture(t);
  const url = new URL(f.server.url);
  const received = await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) }); let data = '';
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('upgrade was not closed')); });
    socket.on('connect', () => socket.write(`GET /agent HTTP/1.1\r\nHost: bridge.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer ${f.bearer}\r\n\r\n`));
    socket.on('data', chunk => { data += chunk.toString(); }); socket.on('error', reject); socket.on('close', () => resolve(data));
  });
  assert.equal(received, '');
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.work_contexts')).rows[0].count, '0');
});
