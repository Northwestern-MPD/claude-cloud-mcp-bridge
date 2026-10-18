import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { dispatchFixture, gate } from '../support/dispatch.js';
import { POLICY_NOW } from '../support/policy.js';
import { executeAdmin } from '../../apps/operator/commands.js';
import type { Store } from '../../packages/storage/types.js';

const operations = await import('../../packages/storage/operations.js').catch(() => null);
const revocations = await import('../../packages/storage/revocations.js').catch(() => null);
const absent = async (): Promise<never> => { throw new Error('DURABLE_DISPATCH_IMPLEMENTATION_MISSING'); };
const admitOperation: typeof import('../../packages/storage/operations.js').admitOperation = operations?.admitOperation ?? absent;
const dispatchAuthorized: typeof import('../../packages/storage/operations.js').dispatchAuthorized = operations?.dispatchAuthorized ?? absent;
const completeOperation: typeof import('../../packages/storage/operations.js').completeOperation = operations?.completeOperation ?? absent;
const revokeAuthorization: typeof import('../../packages/storage/revocations.js').revokeAuthorization = revocations?.revokeAuthorization ?? absent;

async function waitForLock(f: Awaited<ReturnType<typeof dispatchFixture>>) {
  for (let i = 0; i < 200; i++) {
    const waiting = await f.db.admin.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
    if (Number(waiting.rows[0].count) > 0) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Expected a real PostgreSQL row lock wait');
}

test('durable intent contains only authentication/operation metadata and precedes synchronous enqueue', async t => {
  const f = await dispatchFixture(t);
  const operation = await dispatchAuthorized(f.deps, f.input);
  assert.deepEqual(operation, { requestId: operation.requestId, deviceId: f.device.deviceId, leaseId: f.lease.id,
    contextId: f.context.id, epoch: 1, deadline: POLICY_NOW + 30_000, write: true });
  assert.ok(Object.isFrozen(operation)); assert.deepEqual(f.sent, [operation]);
  const row = (await f.db.admin.query('SELECT * FROM mpd_identity.operation_attempts')).rows[0];
  assert.equal(row.state, 'dispatched'); assert.equal(row.token_fingerprint, f.auth.tokenFingerprint);
  assert.equal(Number(row.deadline_at), POLICY_NOW + 30_000); assert.equal(row.classification, 'write');
  assert.ok(!JSON.stringify(row).includes(f.token));
  await completeOperation(f.store, { requestId: operation.requestId, deviceId: operation.deviceId, leaseId: operation.leaseId, epoch: operation.epoch, outcome: 'completed', clock: f.clock });
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.operation_attempts')).rows[0].state, 'completed');
});

test('admission alone commits intent without sending and a crash never resends it', async t => {
  const f = await dispatchFixture(t);
  const operation = await admitOperation(f.store, f.input);
  assert.equal(f.sent.length, 0);
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.operation_attempts')).rows[0].state, 'admitted');
  await f.reopen();
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.operation_attempts WHERE request_id=$1', [operation.requestId])).rows[0].state, 'uncertain');
  assert.equal(f.sent.length, 0);
  await assert.rejects(admitOperation(f.store, f.input), /STALE_CONTEXT|NOT_PAIRED/);
});

for (const [tool, write] of [['blender_execute_code', false], ['blender_get_scene_info', true], ['request_blender_pairing', false], ['disconnect_blender', false], ['bridge_status', false]] as const) {
  test(`denies invalid remote classification ${tool}/${write}`, async t => {
    const f = await dispatchFixture(t);
    await assert.rejects(dispatchAuthorized(f.deps, { ...f.input, tool, write }), /INVALID_OPERATION/);
    assert.equal(f.sent.length, 0);
  });
}

for (const field of ['subject', 'client', 'resource'] as const) {
  test(`fresh request ${field} must match the durable context`, async t => {
    const f = await dispatchFixture(t);
    const auth = field === 'subject' ? await f.request({ sub: 'auth0|another-student' }) : field === 'client' ? { ...f.auth, principal: { ...f.auth.principal, clientId: 'other-client' } } : { ...f.auth, resource: 'https://assignments.example/mcp' };
    await assert.rejects(dispatchAuthorized(f.deps, { ...f.input, auth }), /CONTEXT_DENIED/);
    assert.equal(f.sent.length, 0);
  });
}

test('private admin token denial commits before a queued dispatch and fresh token B remains usable', async t => {
  const f = await dispatchFixture(t);
  const entered = gate(), release = gate();
  const blocker = f.runtime.coordinator.withFence(async () => { entered.release(); await release.promise; });
  await entered.promise;
  const admin = executeAdmin({ kind: 'deny-token', fingerprint: f.auth.tokenFingerprint, userId: f.userId, resource: f.auth.resource, expiresAt: f.auth.principal.expiresAt, reason: 'test' }, { store: f.store, runtime: f.runtime, coordinator: f.runtime.coordinator, now: f.clock });
  const denied = assert.rejects(dispatchAuthorized(f.deps, f.input), /TOKEN_REVOKED/);
  release.release(); await blocker; await admin; await denied;
  assert.equal(f.sent.length, 0); assert.equal(f.runtime.isActive(f.context.id), true);
  assert.equal(Number((await f.db.admin.query('SELECT expires_at FROM mpd_identity.token_denials')).rows[0].expires_at), POLICY_NOW + 660_000);
  const authB = await f.request({ sub: f.auth.principal.subject, iat: 1_800_000_001 });
  await dispatchAuthorized(f.deps, { ...f.input, auth: authB, tool: 'blender_get_scene_info', write: false });
  assert.equal(f.sent.length, 1);
});

test('expiry while waiting for the runtime fence prevents enqueue', async t => {
  const f = await dispatchFixture(t);
  const entered = gate(), release = gate();
  const blocker = f.runtime.coordinator.withFence(async () => { entered.release(); await release.promise; });
  await entered.promise;
  const denied = assert.rejects(dispatchAuthorized(f.deps, f.input), /TOKEN_EXPIRED/);
  f.advance(600_001); release.release(); await blocker; await denied;
  assert.equal(f.sent.length, 0);
});

test('expiry during a real user row lock wait prevents durable admission', async t => {
  const f = await dispatchFixture(t);
  const blocker = await f.client(); await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM mpd_identity.users WHERE id=$1 FOR UPDATE', [f.userId]);
  const denied = assert.rejects(dispatchAuthorized(f.deps, f.input), /TOKEN_EXPIRED/);
  await waitForLock(f); f.advance(600_001); await blocker.query('COMMIT'); await denied;
  assert.equal(f.sent.length, 0);
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.operation_attempts')).rows[0].count, '0');
});

for (const [iat, allowed] of [[1_799_999_999, false], [1_800_000_000, false], [1_800_000_001, true]] as const) {
  test(`strict recovery issuance cutoff for signed iat ${iat}`, async t => {
    const f = await dispatchFixture(t, 1_800_000_000);
    const auth = await f.request({ sub: f.auth.principal.subject, iat });
    if (allowed) { await dispatchAuthorized(f.deps, { ...f.input, auth }); assert.equal(f.sent.length, 1); }
    else { await assert.rejects(dispatchAuthorized(f.deps, { ...f.input, auth }), /TOKEN_ISSUED_BEFORE_CUTOFF/); assert.equal(f.sent.length, 0); }
  });
}

test('concurrent writers admit one intent and one frame until the first operation completes', async t => {
  const f = await dispatchFixture(t);
  const results = await Promise.allSettled([dispatchAuthorized(f.deps, f.input), dispatchAuthorized(f.deps, f.input)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.sent.length, 1);
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.operation_attempts')).rows[0].count, '1');
  const operation = f.sent[0]!;
  await completeOperation(f.store, { requestId: operation.requestId, deviceId: operation.deviceId, leaseId: operation.leaseId, epoch: operation.epoch, outcome: 'completed', clock: f.clock });
  await dispatchAuthorized(f.deps, f.input); assert.equal(f.sent.length, 2);
});

for (const kind of ['disable-user', 'remove-membership', 'block-resource', 'revoke-device'] as const) {
  test(`durable ${kind} invalidates matching runtime authority before acknowledgement`, async t => {
    const f = await dispatchFixture(t);
    const other = await f.owner('auth0|unrelated-student');
    let otherClosed = false; f.runtime.registerContext(other.context, [f.teamId], () => { otherClosed = true; });
    const command = kind === 'disable-user' ? { kind, userId: f.userId, reason: 'test' } : kind === 'remove-membership' ? { kind, userId: f.userId, teamId: f.teamId, reason: 'test' } : kind === 'block-resource' ? { kind, userId: f.userId, resource: f.auth.resource, reason: 'test' } : { kind, deviceId: f.device.deviceId, reason: 'test' };
    await revokeAuthorization(f.store, command, f.runtime, f.runtime.coordinator, f.clock);
    assert.equal(f.runtime.isActive(f.context.id), false); assert.equal(otherClosed, false);
    assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.leases WHERE id=$1', [f.lease.id])).rows[0].state, 'revoked');
    await assert.rejects(dispatchAuthorized(f.deps, f.input), /USER_DISABLED|NOT_ENROLLED|RESOURCE_BLOCKED|DEVICE_REVOKED|STALE_CONTEXT|NOT_PAIRED/);
    assert.equal(f.sent.length, 0);
  });
}

test('token-only revoke marks only token A pending operation uncertain while token B reads remain usable', async t => {
  const f = await dispatchFixture(t);
  const operation = await dispatchAuthorized(f.deps, f.input);
  await revokeAuthorization(f.store, { kind: 'deny-token', fingerprint: f.auth.tokenFingerprint, userId: f.userId, expiresAt: f.auth.principal.expiresAt, reason: 'test' }, f.runtime, f.runtime.coordinator, f.clock);
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.operation_attempts WHERE request_id=$1', [operation.requestId])).rows[0].state, 'uncertain');
  assert.equal(f.runtime.isActive(f.context.id), true);
  const authB = await f.request({ sub: f.auth.principal.subject, iat: 1_800_000_001 });
  await dispatchAuthorized(f.deps, { ...f.input, auth: authB, tool: 'blender_get_scene_info', write: false });
  assert.equal(f.sent.length, 2);
});

test('wrong device, lease or epoch response cannot complete an operation and terminal uncertainty cannot be overwritten', async t => {
  const f = await dispatchFixture(t);
  const operation = await dispatchAuthorized(f.deps, f.input);
  for (const overrides of [{ deviceId: randomUUID() }, { leaseId: randomUUID() }, { epoch: operation.epoch + 1 }]) {
    await completeOperation(f.store, { requestId: operation.requestId, deviceId: operation.deviceId, leaseId: operation.leaseId, epoch: operation.epoch, outcome: 'completed', clock: f.clock, ...overrides });
    assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.operation_attempts')).rows[0].state, 'dispatched');
  }
  f.advance(30_000);
  await completeOperation(f.store, { requestId: operation.requestId, deviceId: operation.deviceId, leaseId: operation.leaseId, epoch: operation.epoch, outcome: 'completed', clock: f.clock });
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.operation_attempts')).rows[0].state, 'uncertain');
  await completeOperation(f.store, { requestId: operation.requestId, deviceId: operation.deviceId, leaseId: operation.leaseId, epoch: operation.epoch, outcome: 'completed', clock: f.clock });
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.operation_attempts')).rows[0].state, 'uncertain');
});

test('interrupted synchronous enqueue produces execution uncertainty and never retries', async t => {
  const f = await dispatchFixture(t); let sends = 0;
  await assert.rejects(dispatchAuthorized({ ...f.deps, transport: { enqueue() { sends++; throw new Error('private-send-canary'); } } }, f.input), /^PolicyError: EXECUTION_UNCERTAIN$/);
  assert.equal(sends, 1);
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.operation_attempts')).rows[0].state, 'uncertain');
  await f.reopen(); assert.equal(sends, 1);
});

test('lost COMMIT acknowledgement never enqueues or retries an already durable intent', async t => {
  const f = await dispatchFixture(t); let calls = 0;
  const ambiguous: Store = { ...f.store, async transaction(fn) { const result = await f.store.transaction(fn); if (++calls === 1) throw new Error('lost COMMIT acknowledgement'); return result; } };
  await assert.rejects(dispatchAuthorized({ ...f.deps, store: ambiguous }, f.input), /EXECUTION_UNCERTAIN/);
  assert.equal(f.sent.length, 0);
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.operation_attempts')).rows[0].count, '1');
  await f.reopen();
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.operation_attempts')).rows[0].state, 'uncertain');
  assert.equal(f.sent.length, 0);
});

test('token expires after committed admission but before enqueue: no frame is sent', async t => {
  const f = await dispatchFixture(t); let calls = 0;
  const advancing: Store = { ...f.store, async transaction(fn) { const result = await f.store.transaction(fn); if (++calls === 1) f.advance(600_001); return result; } };
  await assert.rejects(dispatchAuthorized({ ...f.deps, store: advancing }, f.input), /TOKEN_EXPIRED|EXECUTION_UNCERTAIN/);
  assert.equal(f.sent.length, 0);
});

test('SQL lock timeout is a controlled denial and never sends a frame', async t => {
  const f = await dispatchFixture(t);
  const blocker = await f.client(); await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM mpd_identity.users WHERE id=$1 FOR UPDATE', [f.userId]);
  const denied = assert.rejects(dispatchAuthorized(f.deps, f.input), /^PolicyError: AUTHORIZATION_CONFLICT$/);
  await denied; await blocker.query('ROLLBACK'); assert.equal(f.sent.length, 0);
});

test('token denial cannot be narrowed when an operator later denies it for every resource', async t => {
  const f = await dispatchFixture(t);
  await revokeAuthorization(f.store, { kind: 'deny-token', fingerprint: f.auth.tokenFingerprint, expiresAt: f.auth.principal.expiresAt, resource: 'https://different.example/mcp', reason: 'scoped' }, f.runtime, f.runtime.coordinator, f.clock);
  await revokeAuthorization(f.store, { kind: 'deny-token', fingerprint: f.auth.tokenFingerprint, expiresAt: f.auth.principal.expiresAt, reason: 'all-resources' }, f.runtime, f.runtime.coordinator, f.clock);
  assert.equal((await f.db.admin.query('SELECT resource FROM mpd_identity.token_denials')).rows[0].resource, null);
  await assert.rejects(dispatchAuthorized(f.deps, f.input), /TOKEN_REVOKED/);
  assert.equal(f.sent.length, 0);
});

test('revocation refuses a different coordinator from the supplied runtime', async t => {
  const f = await dispatchFixture(t);
  const { createDispatchCoordinator } = await import('../../packages/authorization/runtime.js');
  await assert.rejects(revokeAuthorization(f.store, { kind: 'disable-user', userId: f.userId, reason: 'test' }, f.runtime, createDispatchCoordinator(), f.clock), /COORDINATOR_MISMATCH/);
  assert.equal((await f.db.admin.query('SELECT status FROM mpd_identity.users WHERE id=$1', [f.userId])).rows[0].status, 'active');
});

test('finite RPC deadline settles an unanswered write without holding the fence for execution', { timeout: 5000 }, async t => {
  const f = await dispatchFixture(t);
  const auth = await f.request({ sub: f.auth.principal.subject, exp: 1_800_000_000.05 });
  const operation = await dispatchAuthorized(f.deps, { ...f.input, auth });
  assert.equal(operation.deadline, POLICY_NOW + 50);
  assert.equal(await f.runtime.coordinator.withFence(async () => 'released'), 'released');
  f.advance(50);
  let state = '';
  for (let i = 0; i < 100; i++) {
    state = (await f.db.admin.query('SELECT state FROM mpd_identity.operation_attempts WHERE request_id=$1', [operation.requestId])).rows[0].state;
    if (state === 'uncertain') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(state, 'uncertain'); assert.equal(f.sent.length, 1);
});

test('real PostgreSQL deadlock yields a controlled denial without enqueue or mutation retry', async t => {
  const f = await dispatchFixture(t);
  await f.db.admin.query('BEGIN');
  await f.db.admin.query("SET LOCAL deadlock_timeout='10s'");
  await f.db.admin.query('SELECT id FROM mpd_identity.devices WHERE id=$1 FOR UPDATE', [f.device.deviceId]);
  try {
    const denied = assert.rejects(dispatchAuthorized(f.deps, f.input), /^PolicyError: AUTHORIZATION_CONFLICT$/);
    await waitForLock(f);
    const blocker = f.db.admin.query('SELECT id FROM mpd_identity.users WHERE id=$1 FOR UPDATE', [f.userId]);
    await denied; await blocker;
  } finally { await f.db.admin.query('ROLLBACK'); }
  assert.equal(f.sent.length, 0);
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.operation_attempts')).rows[0].count, '0');
});

test('local operation authorization succeeds with every provider HTTP call disabled', async t => {
  const f = await dispatchFixture(t);
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('PROVIDER_CALL_FORBIDDEN'); };
  try { await dispatchAuthorized(f.deps, f.input); assert.equal(f.sent.length, 1); }
  finally { globalThis.fetch = original; }
});

test('independent PostgreSQL admission clients cannot overlap durable writes on one device', async t => {
  const f = await dispatchFixture(t);
  const clients = [await f.independentStore(), await f.independentStore()];
  const results = await Promise.allSettled(clients.map(({ store }) => admitOperation(store, f.input)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected'); assert.match(String(rejected.reason), /DEVICE_BUSY|AUTHORIZATION_CONFLICT/);
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.operation_attempts')).rows[0].count, '1');
  assert.equal(f.sent.length, 0);
});

test('revocation waits through admission SQL awaits and reports an already dispatched write uncertain', async t => {
  const f = await dispatchFixture(t);
  const blocker = await f.client(); await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM mpd_identity.users WHERE id=$1 FOR UPDATE', [f.userId]);
  const dispatch = dispatchAuthorized(f.deps, f.input);
  await waitForLock(f);
  let acknowledged = false;
  const revoke = revokeAuthorization(f.store, { kind: 'disable-user', userId: f.userId, reason: 'test' }, f.runtime, f.runtime.coordinator, f.clock).then(() => { acknowledged = true; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(acknowledged, false);
  await blocker.query('COMMIT'); await dispatch; await revoke;
  assert.equal(f.sent.length, 1);
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.operation_attempts')).rows[0].state, 'uncertain');
  assert.equal(f.runtime.isActive(f.context.id), false);
});

test('device revocation settles in-flight operations even if their lease deadline already changed state', async t => {
  const f = await dispatchFixture(t);
  await dispatchAuthorized(f.deps, f.input);
  await f.db.admin.query("UPDATE mpd_identity.leases SET state='expired' WHERE id=$1", [f.lease.id]);
  await revokeAuthorization(f.store, { kind: 'revoke-device', deviceId: f.device.deviceId, reason: 'test' }, f.runtime, f.runtime.coordinator, f.clock);
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.operation_attempts')).rows[0].state, 'uncertain');
  assert.equal(f.runtime.isActive(f.context.id), false);
});
