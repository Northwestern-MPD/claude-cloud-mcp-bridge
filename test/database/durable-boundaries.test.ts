import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { dispatchFixture } from '../support/dispatch.js';
import { policyFixture, POLICY_NOW } from '../support/policy.js';
import { enrollDevice, authenticateDevice, rotateDeviceCredential } from '../../packages/storage/devices.js';
import { createPairing, approvePairing } from '../../packages/storage/grants.js';
import { admitOperation, completeOperation, dispatchAuthorized } from '../../packages/storage/operations.js';
import { revokeAuthorization } from '../../packages/storage/revocations.js';
import type { Store } from '../../packages/storage/types.js';

test('device issuance rejects invalid display names without creating credentials', async t => {
  const f = await policyFixture(t);
  for (const name of ['', '   ', 'x'.repeat(201), 42 as unknown as string]) {
    await assert.rejects(enrollDevice(f.store, { ownerId: f.userId, name }, f.clock), /INVALID_DEVICE/);
  }
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.devices')).rows[0].count, '0');
});

test('unknown well-formed credentials and missing or disabled rotation targets stay denied', async t => {
  const f = await policyFixture(t);
  await assert.rejects(authenticateDevice(f.store, `mpd_device_${randomBytes(32).toString('base64url')}`, f.clock), /INVALID_DEVICE_CREDENTIAL/);
  await assert.rejects(rotateDeviceCredential(f.store, randomUUID(), f.clock), /DEVICE_REVOKED/);
  const device = await enrollDevice(f.store, { ownerId: f.userId, name: 'Lost laptop' }, f.clock);
  await f.db.admin.query('UPDATE mpd_identity.devices SET disabled=true WHERE id=$1', [device.deviceId]);
  await assert.rejects(rotateDeviceCredential(f.store, device.deviceId, f.clock), /DEVICE_REVOKED/);
});

test('pairing approval rejects nonexistent requests and currently disabled devices', async t => {
  const f = await dispatchFixture(t);
  await assert.rejects(approvePairing(f.store, { pairingId: randomUUID(), deviceId: f.device.deviceId, capabilities: ['read'] }, f.clock), /PAIRING_NOT_FOUND/);
  const pair = await createPairing(f.store, { context: f.context, teamId: f.teamId, capabilities: ['read'] }, f.clock);
  await f.db.admin.query('UPDATE mpd_identity.devices SET disabled=true WHERE id=$1', [f.device.deviceId]);
  await assert.rejects(approvePairing(f.store, { pairingId: pair.pairingId, deviceId: f.device.deviceId, capabilities: ['read'] }, f.clock), /DEVICE_REVOKED/);
});

test('a context deadline rejects new pairing requests and pending approvals', async t => {
  const f = await dispatchFixture(t);
  const pair = await createPairing(f.store, { context: f.context, teamId: f.teamId, capabilities: ['read'] }, f.clock);
  await f.db.admin.query('UPDATE mpd_identity.work_contexts SET expires_at=$1 WHERE id=$2', [POLICY_NOW, f.context.id]);
  await assert.rejects(createPairing(f.store, { context: f.context, teamId: f.teamId, capabilities: ['read'] }, f.clock), /STALE_CONTEXT/);
  await assert.rejects(approvePairing(f.store, { pairingId: pair.pairingId, deviceId: f.device.deviceId, capabilities: ['read'] }, f.clock), /STALE_CONTEXT/);
});

test('admission rejects nonexistent leases, offline devices and a released lease', async t => {
  const f = await dispatchFixture(t);
  await assert.rejects(admitOperation(f.store, { ...f.input, leaseId: randomUUID() }), /NOT_PAIRED/);
  await f.db.admin.query('UPDATE mpd_identity.devices SET online=false WHERE id=$1', [f.device.deviceId]);
  await assert.rejects(admitOperation(f.store, f.input), /DEVICE_OFFLINE/);
  await f.db.admin.query('UPDATE mpd_identity.devices SET online=true WHERE id=$1', [f.device.deviceId]);
  await f.db.admin.query("UPDATE mpd_identity.leases SET state='released' WHERE id=$1", [f.lease.id]);
  await assert.rejects(admitOperation(f.store, f.input), /NOT_PAIRED/);
  assert.equal(f.sent.length, 0);
});

test('admission rechecks credential revocation, expiry and restored deployment epoch after connection', async t => {
  const f = await dispatchFixture(t);
  await f.db.admin.query('UPDATE mpd_identity.device_credentials SET revoked_at=$1', [POLICY_NOW]);
  await assert.rejects(admitOperation(f.store, f.input), /INVALID_DEVICE_CREDENTIAL/);
  await f.db.admin.query('UPDATE mpd_identity.device_credentials SET revoked_at=NULL,expires_at=$1', [POLICY_NOW]);
  await assert.rejects(admitOperation(f.store, f.input), /INVALID_DEVICE_CREDENTIAL/);
  await f.db.admin.query("UPDATE mpd_identity.device_credentials SET expires_at=$1,deployment_epoch='restored-old-epoch'", [POLICY_NOW + 2_592_000_000]);
  await assert.rejects(admitOperation(f.store, f.input), /INVALID_DEVICE_CREDENTIAL/);
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.operation_attempts')).rows[0].count, '0');
});

test('admission denies an expired context, hard lease deadline and idle deadline independently', async t => {
  const f = await dispatchFixture(t);
  await f.db.admin.query('UPDATE mpd_identity.work_contexts SET expires_at=$1', [POLICY_NOW]);
  await assert.rejects(admitOperation(f.store, f.input), /STALE_CONTEXT/);
  await f.db.admin.query('UPDATE mpd_identity.work_contexts SET expires_at=$1', [POLICY_NOW + 7_200_000]);
  await f.db.admin.query('UPDATE mpd_identity.leases SET expires_at=$1', [POLICY_NOW]);
  await assert.rejects(admitOperation(f.store, f.input), /NOT_PAIRED/);
  await f.db.admin.query('UPDATE mpd_identity.leases SET expires_at=$1,idle_expires_at=$2', [POLICY_NOW + 3_600_000, POLICY_NOW]);
  await assert.rejects(admitOperation(f.store, f.input), /NOT_PAIRED/);
});

test('a reconnected device epoch cannot reuse its previous lease or response authority', async t => {
  const f = await dispatchFixture(t);
  const operation = await dispatchAuthorized(f.deps, f.input);
  await f.online(f.device.deviceId);
  await assert.rejects(admitOperation(f.store, f.input), /NOT_PAIRED/);
  await completeOperation(f.store, { ...operation, outcome: 'completed', clock: f.clock });
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.operation_attempts')).rows[0].state, 'uncertain');
});

test('lease capabilities independently deny writes and reads without widening a grant', async t => {
  const f = await dispatchFixture(t);
  await f.db.admin.query("UPDATE mpd_identity.leases SET capabilities=ARRAY['read'] WHERE id=$1", [f.lease.id]);
  await assert.rejects(admitOperation(f.store, f.input), /CAPABILITY_DENIED/);
  await f.db.admin.query("UPDATE mpd_identity.leases SET capabilities=ARRAY['execute'] WHERE id=$1", [f.lease.id]);
  await assert.rejects(admitOperation(f.store, { ...f.input, tool: 'blender_get_scene_info', write: false }), /CAPABILITY_DENIED/);
  assert.equal(f.sent.length, 0);
});

test('read intents cannot complete before dispatch but a correlated dispatched read can complete', async t => {
  const f = await dispatchFixture(t);
  const read = { ...f.input, tool: 'blender_get_scene_info' as const, write: false };
  const intent = await admitOperation(f.store, read);
  await completeOperation(f.store, { ...intent, outcome: 'completed', clock: f.clock });
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.operation_attempts WHERE request_id=$1', [intent.requestId])).rows[0].state, 'admitted');
  const operation = await dispatchAuthorized(f.deps, read);
  await completeOperation(f.store, { ...operation, outcome: 'completed', clock: f.clock });
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.operation_attempts WHERE request_id=$1', [operation.requestId])).rows[0].state, 'completed');
});

test('read COMMIT uncertainty and interrupted enqueue deny without pretending execution completed', async t => {
  const f = await dispatchFixture(t); let calls = 0;
  const ambiguous: Store = { ...f.store, async transaction(fn) { const result = await f.store.transaction(fn); if (++calls === 1) throw new Error('lost COMMIT acknowledgement'); return result; } };
  const read = { ...f.input, tool: 'blender_get_scene_info' as const, write: false };
  await assert.rejects(dispatchAuthorized({ ...f.deps, store: ambiguous }, read), /REQUEST_UNCERTAIN/);
  assert.equal(f.sent.length, 0);
  await assert.rejects(dispatchAuthorized({ ...f.deps, transport: { enqueue() { throw new Error('interrupted read enqueue'); } } }, read), /REQUEST_UNCERTAIN/);
  assert.deepEqual((await f.db.admin.query('SELECT state FROM mpd_identity.operation_attempts')).rows.map(row => row.state), ['denied', 'denied']);
});

test('an elapsed RPC deadline after admission denies before enqueue even while the token remains valid', async t => {
  const f = await dispatchFixture(t); let calls = 0;
  const delayed: Store = { ...f.store, async transaction(fn) { const result = await f.store.transaction(fn); if (++calls === 1) f.advance(30_000); return result; } };
  await assert.rejects(dispatchAuthorized({ ...f.deps, store: delayed }, f.input), /EXECUTION_UNCERTAIN/);
  assert.equal(f.sent.length, 0);
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.operation_attempts')).rows[0].state, 'uncertain');
});

test('owner connection loss after dispatched metadata commits prevents synchronous enqueue', async t => {
  const f = await dispatchFixture(t); let calls = 0;
  const lostOwner: Store = { ...f.store, async transaction(fn) {
    const result = await f.store.transaction(fn);
    if (++calls === 2) await f.db.admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='mpd_identity_owner_connection'");
    return result;
  } };
  await assert.rejects(dispatchAuthorized({ ...f.deps, store: lostOwner }, f.input), /EXECUTION_UNCERTAIN/);
  assert.equal(f.sent.length, 0);
  await f.reopen();
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.operation_attempts')).rows[0].state, 'uncertain');
});

test('revocation rejects absent targets and malformed or expired fingerprint denials atomically', async t => {
  const f = await dispatchFixture(t);
  const run = (command: Parameters<typeof revokeAuthorization>[1]) => revokeAuthorization(f.store, command, f.runtime, f.runtime.coordinator, f.clock);
  await assert.rejects(run({ kind: 'revoke-device', deviceId: randomUUID(), reason: 'test' }), /DEVICE_REVOKED/);
  await assert.rejects(run({ kind: 'disable-user', userId: randomUUID(), reason: 'test' }), /USER_NOT_FOUND/);
  await assert.rejects(run({ kind: 'deny-token', fingerprint: 'Bearer invalid', expiresAt: POLICY_NOW + 600_000, reason: 'test' }), /INVALID_ADMIN_COMMAND/);
  await assert.rejects(run({ kind: 'deny-token', fingerprint: f.auth.tokenFingerprint, expiresAt: POLICY_NOW, reason: 'test' }), /INVALID_ADMIN_COMMAND/);
  await assert.rejects(run({ kind: 'deny-token', fingerprint: f.auth.tokenFingerprint, expiresAt: POLICY_NOW + 0.5, reason: 'test' }), /INVALID_ADMIN_COMMAND/);
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.token_denials')).rows[0].count, '0');
  assert.equal(f.runtime.isActive(f.context.id), true);
});

test('maintenance and an invalid injected clock cannot issue device authority', async t => {
  const f = await policyFixture(t);
  for (const clock of [() => -1, () => Number.NaN]) await assert.rejects(enrollDevice(f.store, { ownerId: f.userId, name: 'Laptop' }, clock), /INVALID_CLOCK/);
  await f.store.setMaintenance(true);
  await assert.rejects(enrollDevice(f.store, { ownerId: f.userId, name: 'Laptop' }, f.clock), /STORE_UNAVAILABLE/);
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.devices')).rows[0].count, '0');
});
