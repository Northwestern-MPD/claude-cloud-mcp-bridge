import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as nodeRequest } from 'node:http';
import { test } from 'node:test';
import { identityFixture } from '../support/identity.js';

const rpc = (id: number, method: string, params = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const jsonHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' };

// Break caught: health/discovery accidentally require auth or include internal credentials.
test('public health and discovery are safe while readiness reflects maintenance', async t => {
  const f = await identityFixture(t, { maintenance: true });
  const health = await f.request('/health', { headers: { Authorization: '' } });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal((await f.request('/ready')).status, 503);
  const metadata = await f.request('/.well-known/oauth-protected-resource/mcp', { headers: { Authorization: '' } });
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).resource, 'https://bridge.example/mcp');
  assert.equal((await f.request('/mcp', { method: 'POST', body: '{}', headers: jsonHeaders })).status, 503);
  await f.store.setMaintenance(false);
  assert.equal((await f.request('/ready')).status, 200);
});

// Break caught: cookie, absent bearer, malformed token or repeated Authorization authorizes a request.
test('missing, malformed and oversized bearer credentials return controlled discovery challenges', async t => {
  const f = await identityFixture(t);
  for (const authorization of ['', 'Bearer fake-canary-SECRET', `Bearer ${'a'.repeat(16_385)}`]) {
    const response = await f.request('/mcp', { method: 'POST', body: '{', headers: { ...jsonHeaders, Authorization: authorization, Cookie: 'authorization=Bearer-canary' } });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate') ?? '', /resource_metadata="https:\/\/bridge.example\/.well-known\/oauth-protected-resource\/mcp"/);
    assert.equal((await response.text()).includes('SECRET'), false);
  }
});

// Break caught: signature validity bypasses local enrollment or insufficient scopes return generic bad-request.
test('uninvited identity and insufficient scope are denied with distinct responses', async t => {
  const f = await identityFixture(t, { enrolled: false });
  assert.equal((await f.request('/mcp', { method: 'POST', headers: jsonHeaders, body: '{}' })).status, 403);
  const response = await f.request('/mcp', { method: 'POST', headers: { ...jsonHeaders, Authorization: `Bearer ${await f.signing.mint({ scope: 'other:read' })}` }, body: '{}' });
  assert.equal(response.status, 403);
  assert.match(response.headers.get('www-authenticate') ?? '', /error="insufficient_scope"/);
  assert.match(response.headers.get('www-authenticate') ?? '', /scope="identity:read"/);
});

// Break caught: catalogue includes desktop tools, class_identity accepts authority arguments or exposes claims.
test('real SDK exposes only no-argument class_identity with desktop access disabled', async t => {
  const f = await identityFixture(t);
  const { client } = await f.sdk();
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['class_identity']);
  const result = await client.callTool({ name: 'class_identity', arguments: {} });
  assert.deepEqual(result.structuredContent, { userId: (await f.db.admin.query('SELECT id FROM mpd_identity.users')).rows[0].id, resource: f.config.auth.resource, courseIds: [f.courseId], teamIds: [f.teamId], desktop_access: false });
  assert.equal((await client.callTool({ name: 'blender_execute_code', arguments: {} })).isError, true);
  assert.equal((await client.callTool({ name: 'class_identity', arguments: { subject: 'auth0|attacker' } })).isError, true);
  const contexts = await f.db.admin.query('SELECT binding_provenance,binding_id FROM mpd_identity.work_contexts');
  assert.equal(contexts.rows.length, 1);
  assert.equal(contexts.rows[0].binding_provenance, null);
  assert.equal(contexts.rows[0].binding_id, null);
});

// Break caught: a copied MCP handle bypasses principal/client binding or continued methods omit auth.
test('continued GET POST DELETE requests require a bearer and immutable session owner', async t => {
  const f = await identityFixture(t);
  const { transport } = await f.sdk();
  const session = transport.sessionId!;
  for (const method of ['GET', 'POST', 'DELETE']) {
    const response = await f.request('/mcp', { method, headers: { ...jsonHeaders, 'mcp-session-id': session, Authorization: '' }, ...(method === 'POST' ? { body: rpc(40, 'tools/list') } : {}) });
    assert.equal(response.status, 401);
  }
  for (const overrides of [{ sub: 'auth0|another-user' }, { azp: 'other-client' }]) {
    const response = await f.request('/mcp', { method: 'POST', headers: { ...jsonHeaders, 'mcp-session-id': session, Authorization: `Bearer ${await f.signing.mint(overrides)}` }, body: rpc(41, 'tools/list') });
    assert.equal(response.status, 403);
  }
});

// Break caught: a positive auth cache ignores membership removal and token revocation on existing sessions.
test('continued requests check fresh membership token denial and token expiry', async t => {
  const f = await identityFixture(t);
  const { client } = await f.sdk();
  await f.db.admin.query("UPDATE mpd_identity.memberships SET status='removed'");
  await assert.rejects(client.listTools(), (error: unknown) => (error as { code?: number }).code === 403);
  await f.db.admin.query("UPDATE mpd_identity.memberships SET status='active'");
  await f.db.admin.query("INSERT INTO mpd_identity.token_denials(fingerprint,expires_at,reason) VALUES($1,$2,'test')", [createHash('sha256').update(f.bearer).digest('hex'), f.clock() + 600_000]);
  await assert.rejects(client.listTools(), (error: unknown) => (error as { code?: number }).code === 401);
  await f.db.admin.query('DELETE FROM mpd_identity.token_denials');
  f.advance(601_000);
  await assert.rejects(client.listTools(), (error: unknown) => (error as { code?: number }).code === 401);
});

// Break caught: parser consumes unauthenticated requests or omits continued/chunked body byte bounds.
test('every POST enforces byte bounds malformed JSON and approved origins/hosts', async t => {
  const f = await identityFixture(t);
  const { transport } = await f.sdk();
  for (const extra of [{}, { 'mcp-session-id': transport.sessionId! }] as Record<string, string>[]) {
    const oversize = await f.request('/mcp', { method: 'POST', headers: { ...jsonHeaders, ...extra }, body: JSON.stringify({ padding: 'é'.repeat(33_000) }) });
    assert.equal(oversize.status, 413);
    assert.equal((await f.request('/mcp', { method: 'POST', headers: { ...jsonHeaders, ...extra }, body: '{' })).status, 400);
  }
  for (const extra of [{ Origin: 'https://attacker.invalid' }, { 'X-Forwarded-Host': 'attacker.invalid' }, { Host: 'attacker.invalid' }] as Record<string, string>[]) {
    assert.equal((await f.request('/mcp', { method: 'POST', body: '{}', headers: { ...jsonHeaders, ...extra } })).status, 403);
  }
});

// Break caught: duplicate bearer headers are merged and accepted; chunked requests bypass content-length checks.
test('raw duplicate bearer and oversized chunked body requests are rejected', async t => {
  const f = await identityFixture(t);
  async function raw(headers: Record<string, string | string[]>, chunks: string[]) {
    return await new Promise<number>((resolve, reject) => {
      const req = nodeRequest(`${f.server.url}/mcp`, { method: 'POST', headers: { Host: 'bridge.example', ...jsonHeaders, ...headers } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject);
      for (const chunk of chunks) req.write(chunk);
      req.end();
    });
  }
  assert.equal(await raw({ Authorization: [`Bearer ${f.bearer}`, `Bearer ${f.bearer}`] }, ['{}']), 401);
  assert.equal(await raw({ Authorization: `Bearer ${f.bearer}` }, ['{"padding":"', 'x'.repeat(40_000), 'x'.repeat(30_000), '"}']), 413);
});

// Break caught: maintenance or lost ownership continues accepting transport requests.
test('maintenance denies continued sessions and owner loss ends admission without replay', async t => {
  const f = await identityFixture(t);
  const { client } = await f.sdk();
  await f.store.setMaintenance(true);
  await assert.rejects(client.listTools(), (error: unknown) => (error as { code?: number }).code === 503);
  await f.store.setMaintenance(false);
  await client.listTools();
  await f.db.admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='mpd_identity_owner_connection'");
  await new Promise(resolve => setTimeout(resolve, 50));
  await assert.rejects(client.listTools());
  assert.equal(await f.store.ready(), false);
});

// Break caught: a continued transport reuses initial token evidence or shares one mutable last-token slot.
test('concurrent continued requests use their own current token fingerprint', async t => {
  const f = await identityFixture(t);
  const { transport } = await f.sdk();
  const refreshed = await f.signing.mint({ iat: Math.floor(f.clock() / 1000) + 1 });
  await f.db.admin.query("INSERT INTO mpd_identity.token_denials(fingerprint,expires_at,reason) VALUES($1,$2,'test')", [createHash('sha256').update(f.bearer).digest('hex'), f.clock() + 600_000]);
  const results = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    const response = await f.request('/mcp', { method: 'POST', headers: { ...jsonHeaders, 'mcp-session-id': transport.sessionId!, Authorization: `Bearer ${i % 2 ? refreshed : f.bearer}` }, body: rpc(100 + i, 'tools/call', { name: 'class_identity', arguments: {} }) });
    const data = await response.json();
    return { status: response.status, data };
  }));
  results.forEach((result, i) => {
    assert.equal(result.status, i % 2 ? 200 : 401);
    if (i % 2) assert.equal(result.data.result.structuredContent.desktop_access, false);
  });
});

// Break caught: continued requests rely only on copied memory metadata after durable context revocation.
test('durably revoked contexts are denied and local invalidation closes their transport', async t => {
  const f = await identityFixture(t);
  const { client, transport } = await f.sdk();
  const context = transport.sessionId!;
  await f.db.admin.query("UPDATE mpd_identity.work_contexts SET state='revoked' WHERE id=$1", [context]);
  await assert.rejects(client.listTools(), (error: unknown) => (error as { code?: number }).code === 403);
  f.runtime.invalidate({ contextId: context });
  assert.equal(f.runtime.isActive(context), false);
});

// Break caught: opening arbitrarily many transports exhausts memory despite authenticated identity.
test('a student cannot exceed eight simultaneous sessions', async t => {
  const f = await identityFixture(t);
  for (let i = 0; i < 8; i++) await f.sdk();
  await assert.rejects(f.sdk(), (error: unknown) => (error as { code?: number }).code === 429);
  assert.equal((await f.db.admin.query("SELECT count(*) FROM mpd_identity.work_contexts WHERE state='active'")).rows[0].count, '8');
});

// Break caught: startup admits a listener against a mismatched durable store authority.
test('identity server refuses a mismatched store before opening another listener', async t => {
  const f = await identityFixture(t);
  const { startIdentityServer } = await import('../../apps/identity/server.js');
  await assert.rejects(startIdentityServer({ config: { ...f.config, database: { ...f.config.database, expectedStoreId: '83f94dd7-b154-4e10-9c88-84ef9a6e1c9d' } }, store: f.store, runtime: f.runtime, verify: token => verifyToken(f, token) }), /STORE_UNAVAILABLE/);
});
async function verifyToken(f: Awaited<ReturnType<typeof identityFixture>>, token: string) {
  const { verifyAccessToken } = await import('../../packages/auth/index.js');
  return verifyAccessToken(token, f.config.auth, f.signing);
}

// Break caught: valid token signatures evade the restore issuance cutoff at HTTP admission.
test('HTTP admission enforces the strict persisted issuance cutoff', async t => {
  const cutoff = Math.floor(Date.now() / 1000) - 120;
  const f = await identityFixture(t, { cutoff });
  const response = await f.request('/mcp', { method: 'POST', body: '{}', headers: { ...jsonHeaders, Authorization: `Bearer ${await f.signing.mint({ iat: cutoff })}` } });
  assert.equal(response.status, 401);
  await f.sdk();
});

// Break caught: session ownership denial is only an accidental result of the other student being uninvited.
test('another enrolled student cannot use a copied session handle', async t => {
  const f = await identityFixture(t);
  const { transport } = await f.sdk();
  const { enrollInvitation } = await import('../../packages/storage/enrollment.js');
  const { randomUUID } = await import('node:crypto');
  await enrollInvitation(f.store, { id: randomUUID(), email: 'another@example.edu', issuer: f.signing.config.issuer, subject: 'auth0|another-enrolled', courseId: f.courseId, teamId: f.teamId, role: 'student', expiresAt: f.clock() + 86_400_000 }, f.clock);
  const response = await f.request('/mcp', { method: 'POST', headers: { ...jsonHeaders, 'mcp-session-id': transport.sessionId!, Authorization: `Bearer ${await f.signing.mint({ sub: 'auth0|another-enrolled' })}` }, body: rpc(140, 'tools/list') });
  assert.equal(response.status, 403);
  assert.equal((await f.db.admin.query("SELECT count(*) FROM mpd_identity.users WHERE status='active'")).rows[0].count, '2');
});

// Break caught: repeated valid requests have no finite per-student admission budget.
test('authenticated requests are limited to 120 per student per minute', async t => {
  const f = await identityFixture(t);
  for (let i = 0; i < 120; i++) assert.equal((await f.request('/unknown')).status, 404);
  assert.equal((await f.request('/unknown')).status, 429);
  f.advance(60_000);
  assert.equal((await f.request('/unknown')).status, 404);
});

// Break caught: repeated uninvited requests bypass the IP budget before an internal user exists.
test('IP admission is bounded even for an uninvited signed identity', async t => {
  const f = await identityFixture(t, { enrolled: false });
  for (let i = 0; i < 240; i++) assert.equal((await f.request('/mcp', { method: 'POST', body: '{}', headers: jsonHeaders })).status, 403);
  assert.equal((await f.request('/mcp', { method: 'POST', body: '{}', headers: jsonHeaders })).status, 429);
});

// Break caught: a request that waited behind an administrative fence uses its earlier authorization time.
test('expiry is checked after waiting for the shared admission fence', async t => {
  const f = await identityFixture(t);
  const { transport } = await f.sdk();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const held = f.runtime.coordinator.withFence(async () => { await barrier; });
  const waiting = f.request('/mcp', { method: 'POST', headers: { ...jsonHeaders, 'mcp-session-id': transport.sessionId! }, body: rpc(200, 'tools/list') });
  await new Promise(resolve => setTimeout(resolve, 20));
  f.advance(601_000);
  release(); await held;
  assert.equal((await waiting).status, 401);
});

// Break caught: response/log diagnostics or durable contexts expose bearer strings and raw claims.
test('HTTP errors and identity results do not leak canary credentials or token claims', async t => {
  const f = await identityFixture(t);
  const captured: unknown[][] = [];
  const previousError = console.error, previousLog = console.log, previousWarn = console.warn;
  console.error = (...args) => { captured.push(args); };
  console.log = (...args) => { captured.push(args); };
  console.warn = (...args) => { captured.push(args); };
  try {
    const { client } = await f.sdk();
    const result = await client.callTool({ name: 'class_identity', arguments: {} });
    const invalid = await f.request('/mcp', { method: 'POST', headers: { ...jsonHeaders, Authorization: 'Bearer CANARY-do-not-log-secret' }, body: '{"raw_claim":"CANARY"}' });
    const exposed = JSON.stringify(result) + await invalid.text() + JSON.stringify(captured);
    assert.equal(exposed.includes(f.bearer), false);
    assert.equal(exposed.includes('CANARY'), false);
    assert.equal(exposed.includes('auth0|student-1'), false);
    const contexts = JSON.stringify((await f.db.admin.query('SELECT * FROM mpd_identity.work_contexts')).rows);
    assert.equal(contexts.includes(f.bearer), false);
  } finally { console.error = previousError; console.log = previousLog; console.warn = previousWarn; }
});

// Break caught: the global transport bound can be bypassed by opening sessions under additional students.
test('identity service cannot exceed 64 simultaneous sessions across students', async t => {
  const f = await identityFixture(t);
  const { enrollInvitation } = await import('../../packages/storage/enrollment.js');
  const { randomUUID } = await import('node:crypto');
  for (let user = 1; user <= 9; user++) {
    const subject = `auth0|student-${user}`;
    if (user !== 1) await enrollInvitation(f.store, { id: randomUUID(), email: `student${user}@example.edu`, issuer: f.signing.config.issuer, subject, courseId: f.courseId, teamId: f.teamId, role: 'student', expiresAt: f.clock() + 86_400_000 }, f.clock);
    const token = await f.signing.mint({ sub: subject });
    if (user === 9) { await assert.rejects(f.sdk(token), (error: unknown) => (error as { code?: number }).code === 429); break; }
    for (let session = 0; session < 8; session++) await f.sdk(token);
  }
  assert.equal((await f.db.admin.query("SELECT count(*) FROM mpd_identity.work_contexts WHERE state='active'")).rows[0].count, '64');
});

// Break caught: a less-than-or-equal overflow check rejects a valid body at the documented byte limit.
test('continued POST accepts a valid JSON body at exactly 65,536 bytes', async t => {
  const f = await identityFixture(t);
  const { transport } = await f.sdk();
  const response = await f.request('/mcp', { method: 'POST', headers: { ...jsonHeaders, 'mcp-session-id': transport.sessionId! }, body: rpc(210, 'tools/list').padEnd(65_536, ' ') });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result.tools.map((tool: { name: string }) => tool.name), ['class_identity']);
});

// Break caught: ownership lost while subscribing at startup leaves a closed-lifetime listener open.
test('owner loss during startup refuses the listener before admission', async t => {
  const f = await identityFixture(t);
  const { startIdentityServer } = await import('../../apps/identity/server.js');
  const unavailableStore = { ...f.store, onUnavailable(listener: () => void) { listener(); return () => undefined; } };
  await assert.rejects(startIdentityServer({ config: f.config, store: unavailableStore, runtime: f.runtime, verify: token => verifyToken(f, token) }), /STORE_UNAVAILABLE/);
});

// Break caught: a server restart returns 403 for a stale handle, preventing client reinitialization.
test('restart returns 404 for the old session and permits a fresh SDK session with the same bearer', async t => {
  const f = await identityFixture(t);
  const { transport } = await f.sdk();
  const oldSession = transport.sessionId!;
  const oldBoot = f.store.bootId;
  const restarted = await f.restart();
  assert.notEqual(restarted.store.bootId, oldBoot);
  for (const method of ['GET', 'POST', 'DELETE']) {
    const response = await f.request('/mcp', { method, headers: { ...jsonHeaders, 'mcp-session-id': oldSession }, ...(method === 'POST' ? { body: rpc(300, 'tools/list') } : {}) });
    assert.equal(response.status, 404);
  }
  // Even initialize cannot silently adopt the obsolete handle.
  const staleInitialize = await f.request('/mcp', { method: 'POST', headers: { ...jsonHeaders, 'mcp-session-id': oldSession }, body: rpc(301, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'restart-test', version: '1' } }) });
  assert.equal(staleInitialize.status, 404);
  const fresh = await f.sdk();
  assert.notEqual(fresh.transport.sessionId, oldSession);
  const result = await fresh.client.callTool({ name: 'class_identity', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { userId: (await f.db.admin.query('SELECT id FROM mpd_identity.users')).rows[0].id, resource: f.config.auth.resource, courseIds: [f.courseId], teamIds: [f.teamId], desktop_access: false });
  const contexts = await f.db.admin.query("SELECT id FROM mpd_identity.work_contexts WHERE state='active'");
  assert.deepEqual(contexts.rows.map(row => row.id), [fresh.transport.sessionId]);
});

// Break caught: missing sessions bypass authentication, enrollment or token revocation checks.
test('unknown sessions require current bearer authority before returning 404', async t => {
  const f = await identityFixture(t);
  const headers = { ...jsonHeaders, 'mcp-session-id': 'unknown-session' };
  assert.equal((await f.request('/mcp', { method: 'POST', headers, body: rpc(310, 'tools/list') })).status, 404);
  for (const [authorization, status] of [
    ['', 401],
    [`Bearer ${await f.signing.mint({ sub: 'auth0|uninvited' })}`, 403],
    [`Bearer ${await f.signing.mint({ exp: Math.floor(f.clock() / 1000) - 1 })}`, 401],
  ] as const) {
    assert.equal((await f.request('/mcp', { method: 'POST', headers: { ...headers, Authorization: authorization }, body: rpc(311, 'tools/list') })).status, status);
  }
  await f.db.admin.query("INSERT INTO mpd_identity.token_denials(fingerprint,expires_at,reason) VALUES($1,$2,'test')", [createHash('sha256').update(f.bearer).digest('hex'), f.clock() + 600_000]);
  assert.equal((await f.request('/mcp', { method: 'POST', headers, body: rpc(312, 'tools/list') })).status, 401);
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.work_contexts')).rows[0].count, '0');
});

// Break caught: expiry returns 403 until the sweeper runs or another client can retire the owner's handle.
test('expired sessions require owner binding then retire with 404 before the sweeper runs', async t => {
  const f = await identityFixture(t);
  const longBearer = await f.signing.mint({ exp: Math.floor(f.clock() / 1000) + 7200 });
  // Raw initialize avoids the SDK opening a concurrent owner GET as the clock advances.
  const initialized = await f.request('/mcp', { method: 'POST', headers: { ...jsonHeaders, Authorization: `Bearer ${longBearer}` }, body: rpc(319, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'expiry-test', version: '1' } }) });
  assert.equal(initialized.status, 200);
  const session = initialized.headers.get('mcp-session-id')!;
  await initialized.json();
  f.advance(3_600_000);
  const wrongClient = await f.signing.mint({ azp: 'other-client', exp: Math.floor(f.clock() / 1000) + 7200 });
  const denied = await f.request('/mcp', { method: 'POST', headers: { ...jsonHeaders, 'mcp-session-id': session, Authorization: `Bearer ${wrongClient}` }, body: rpc(320, 'tools/list') });
  assert.equal(denied.status, 403);
  assert.equal(f.runtime.isActive(session), true);
  const expired = await f.request('/mcp', { method: 'POST', headers: { ...jsonHeaders, 'mcp-session-id': session, Authorization: `Bearer ${longBearer}` }, body: rpc(321, 'tools/list') });
  assert.equal(expired.status, 404);
  assert.equal(f.runtime.isActive(session), false);
  const fresh = await f.sdk(longBearer);
  assert.equal((await fresh.client.callTool({ name: 'class_identity', arguments: {} })).isError, undefined);
});
