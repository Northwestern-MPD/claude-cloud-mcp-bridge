import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { policyFixture, POLICY_NOW } from '../support/policy.js';
import { verifyAccessToken } from '../../packages/auth/verifier.js';
import { signingFixture } from '../support/auth.js';
import type { CredentialStore } from '../../packages/credentials/keychain.js';

const devices = await import('../../packages/storage/devices.js').catch(() => null);
const grants = await import('../../packages/storage/grants.js').catch(() => null);
const keychain = await import('../../packages/credentials/keychain.js').catch(() => null);
const absent = async (): Promise<never> => { throw new Error('DURABLE_POLICY_IMPLEMENTATION_MISSING'); };
const enrollDevice: typeof import('../../packages/storage/devices.js').enrollDevice = devices?.enrollDevice ?? absent;
const authenticateDevice: typeof import('../../packages/storage/devices.js').authenticateDevice = devices?.authenticateDevice ?? absent;
const rotateDeviceCredential: typeof import('../../packages/storage/devices.js').rotateDeviceCredential = devices?.rotateDeviceCredential ?? absent;
const createPairing: typeof import('../../packages/storage/grants.js').createPairing = grants?.createPairing ?? absent;
const approvePairing: typeof import('../../packages/storage/grants.js').approvePairing = grants?.approvePairing ?? absent;
const unavailableCredentialStore: typeof import('../../packages/credentials/keychain.js').unavailableCredentialStore = keychain?.unavailableCredentialStore ?? (() => ({ save: absent, load: absent, remove: absent }));
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');

test('device enrollment persists only a 256-bit purpose-separated secret fingerprint', async t => {
  const f = await policyFixture(t);
  const device = await enrollDevice(f.store, { ownerId: f.userId, name: 'My laptop' }, f.clock);
  assert.match(device.secret, /^mpd_device_[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(device.secret.slice('mpd_device_'.length), 'base64url').length, 32);
  const ref = await authenticateDevice(f.store, device.secret, f.clock);
  assert.deepEqual(ref, { id: device.deviceId, ownerId: f.userId, epoch: 0, deploymentEpoch: 'durable-policy-test', online: false });
  assert.ok(Object.isFrozen(ref));
  const credential = (await f.db.admin.query('SELECT * FROM mpd_identity.device_credentials')).rows[0];
  assert.equal(credential.fingerprint, fingerprint(device.secret));
  assert.equal(Number(credential.expires_at), POLICY_NOW + 2_592_000_000);
  const records = await f.db.admin.query('SELECT row_to_json(c)::text AS value FROM mpd_identity.device_credentials c');
  assert.ok(!records.rows.some(row => row.value.includes(device.secret)));
  const signing = await signingFixture(POLICY_NOW);
  await assert.rejects(verifyAccessToken(device.secret, signing.config, signing), /INVALID_TOKEN/);
  await assert.rejects(authenticateDevice(f.store, f.token, f.clock), /INVALID_DEVICE_CREDENTIAL/);
});

test('credential rotation atomically invalidates old secrets, advances device epoch and revokes leases', async t => {
  const f = await policyFixture(t);
  const device = await enrollDevice(f.store, { ownerId: f.userId, name: 'Laptop' }, f.clock);
  await f.online(device.deviceId);
  const pair = await createPairing(f.store, { context: f.context, teamId: f.teamId, capabilities: ['read'] }, f.clock);
  const lease = await approvePairing(f.store, { pairingId: pair.pairingId, deviceId: device.deviceId, capabilities: ['read'] }, f.clock);
  const rotated = await rotateDeviceCredential(f.store, device.deviceId, f.clock);
  assert.notEqual(rotated.secret, device.secret);
  await assert.rejects(authenticateDevice(f.store, device.secret, f.clock), /INVALID_DEVICE_CREDENTIAL/);
  const ref = await authenticateDevice(f.store, rotated.secret, f.clock);
  assert.equal(ref.epoch, 2); assert.equal(ref.online, false);
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.leases WHERE id=$1', [lease.id])).rows[0].state, 'revoked');
  const credentials = await f.db.admin.query('SELECT generation,revoked_at FROM mpd_identity.device_credentials ORDER BY generation');
  assert.deepEqual(credentials.rows.map(row => Number(row.generation)), [1, 2]);
  assert.equal(Number(credentials.rows[0].revoked_at), POLICY_NOW);
});

for (const condition of ['revoked', 'expired', 'deployment epoch', 'disabled device', 'disabled owner'] as const) {
  test(`device authentication denies ${condition}`, async t => {
    const f = await policyFixture(t);
    const device = await enrollDevice(f.store, { ownerId: f.userId, name: 'Laptop' }, f.clock);
    if (condition === 'revoked') await f.db.admin.query('UPDATE mpd_identity.device_credentials SET revoked_at=$1', [POLICY_NOW]);
    if (condition === 'expired') await f.db.admin.query('UPDATE mpd_identity.device_credentials SET expires_at=$1', [POLICY_NOW]);
    if (condition === 'deployment epoch') await f.db.admin.query("UPDATE mpd_identity.device_credentials SET deployment_epoch='old-deployment'");
    if (condition === 'disabled device') await f.db.admin.query('UPDATE mpd_identity.devices SET disabled=true');
    if (condition === 'disabled owner') await f.db.admin.query("UPDATE mpd_identity.users SET status='disabled'");
    await assert.rejects(authenticateDevice(f.store, device.secret, f.clock), /INVALID_DEVICE_CREDENTIAL|DEVICE_REVOKED|USER_DISABLED/);
  });
}

test('unavailable secure storage fails closed and an injected test storage can supply a real credential', async t => {
  const unavailable = unavailableCredentialStore();
  await assert.rejects(unavailable.save('device', 'secret'), /KEYCHAIN_UNAVAILABLE/);
  await assert.rejects(unavailable.load('device'), /KEYCHAIN_UNAVAILABLE/);
  await assert.rejects(unavailable.remove('device'), /KEYCHAIN_UNAVAILABLE/);
  const f = await policyFixture(t);
  const device = await enrollDevice(f.store, { ownerId: f.userId, name: 'Laptop' }, f.clock);
  const entries = new Map<string, string>();
  const injected: CredentialStore = { async save(id, value) { entries.set(id, value); }, async load(id) { return entries.get(id) ?? null; }, async remove(id) { entries.delete(id); } };
  await injected.save(device.deviceId, device.secret);
  assert.equal((await authenticateDevice(f.store, (await injected.load(device.deviceId))!, f.clock)).ownerId, f.userId);
  await injected.remove(device.deviceId);
  assert.equal(await injected.load(device.deviceId), null);
});

test('pairing codes have 128 bits, persist only a fingerprint, and owner approval narrows capabilities', async t => {
  const f = await policyFixture(t);
  const device = await enrollDevice(f.store, { ownerId: f.userId, name: 'Laptop' }, f.clock);
  await f.online(device.deviceId);
  const pair = await createPairing(f.store, { context: f.context, teamId: f.teamId, capabilities: ['read', 'execute'] }, f.clock);
  assert.equal(Buffer.from(pair.code, 'base64url').length, 16);
  const row = (await f.db.admin.query('SELECT * FROM mpd_identity.pairings WHERE id=$1', [pair.pairingId])).rows[0];
  assert.equal(row.fingerprint, fingerprint(pair.code)); assert.equal(Number(row.expires_at), POLICY_NOW + 300_000);
  assert.ok(!JSON.stringify(row).includes(pair.code));
  const lease = await approvePairing(f.store, { pairingId: pair.pairingId, deviceId: device.deviceId, capabilities: ['read'] }, f.clock);
  assert.deepEqual(lease, { id: lease.id, contextId: f.context.id, deviceId: device.deviceId, teamId: f.teamId,
    capabilities: ['read'], epoch: 1, expiresAt: POLICY_NOW + 3_600_000, idleExpiresAt: POLICY_NOW + 600_000, state: 'active' });
  assert.ok(Object.isFrozen(lease)); assert.ok(Object.isFrozen(lease.capabilities));
  await assert.rejects(approvePairing(f.store, { pairingId: pair.pairingId, deviceId: device.deviceId, capabilities: ['read'] }, f.clock), /PAIRING_USED/);
});

test('same-team devices owned by another user cannot approve; the code alone is not approval authority', async t => {
  const f = await policyFixture(t);
  const other = await f.owner('auth0|other-owner');
  const wrongDevice = await enrollDevice(f.store, { ownerId: other.userId, name: 'Same name' }, f.clock);
  await f.online(wrongDevice.deviceId);
  const pair = await createPairing(f.store, { context: f.context, teamId: f.teamId, capabilities: ['read'] }, f.clock);
  await assert.rejects(approvePairing(f.store, { pairingId: pair.pairingId, deviceId: wrongDevice.deviceId, capabilities: ['read'] }, f.clock), /WRONG_OWNER/);
  await assert.rejects(approvePairing(f.store, { pairingId: pair.code, deviceId: wrongDevice.deviceId, capabilities: ['read'] }, f.clock), /PAIRING_NOT_FOUND/);
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.leases')).rows[0].count, '0');
});

test('capability escalation and empty capability grants cannot consume a pairing', async t => {
  const f = await policyFixture(t);
  const device = await enrollDevice(f.store, { ownerId: f.userId, name: 'Laptop' }, f.clock);
  await f.online(device.deviceId);
  const pair = await createPairing(f.store, { context: f.context, teamId: f.teamId, capabilities: ['read'] }, f.clock);
  await assert.rejects(approvePairing(f.store, { pairingId: pair.pairingId, deviceId: device.deviceId, capabilities: ['execute'] }, f.clock), /CAPABILITY_DENIED/);
  await assert.rejects(approvePairing(f.store, { pairingId: pair.pairingId, deviceId: device.deviceId, capabilities: [] }, f.clock), /CAPABILITY_DENIED/);
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.pairings')).rows[0].state, 'pending');
});

for (const condition of ['expiry', 'removed membership', 'disabled owner', 'offline device', 'stale context', 'forged client'] as const) {
  test(`pairing approval denies ${condition}`, async t => {
    const f = await policyFixture(t);
    const device = await enrollDevice(f.store, { ownerId: f.userId, name: 'Laptop' }, f.clock);
    await f.online(device.deviceId);
    const context = condition === 'forged client' ? { ...f.context, clientId: 'forged-client' } : f.context;
    if (condition === 'forged client') {
      await assert.rejects(createPairing(f.store, { context, teamId: f.teamId, capabilities: ['read'] }, f.clock), /STALE_CONTEXT/);
      return;
    }
    const pair = await createPairing(f.store, { context, teamId: f.teamId, capabilities: ['read'] }, f.clock);
    if (condition === 'expiry') f.advance(300_000);
    if (condition === 'removed membership') await f.db.admin.query("UPDATE mpd_identity.memberships SET status='removed'");
    if (condition === 'disabled owner') await f.db.admin.query("UPDATE mpd_identity.users SET status='disabled'");
    if (condition === 'offline device') await f.db.admin.query('UPDATE mpd_identity.devices SET online=false');
    if (condition === 'stale context') await f.db.admin.query("UPDATE mpd_identity.work_contexts SET state='revoked'");
    await assert.rejects(approvePairing(f.store, { pairingId: pair.pairingId, deviceId: device.deviceId, capabilities: ['read'] }, f.clock), /PAIRING_EXPIRED|NOT_ENROLLED|USER_DISABLED|DEVICE_OFFLINE|STALE_CONTEXT/);
  });
}

test('two independent PostgreSQL approval clients consume one pairing exactly once', async t => {
  const f = await policyFixture(t);
  const device = await enrollDevice(f.store, { ownerId: f.userId, name: 'Laptop' }, f.clock);
  await f.online(device.deviceId);
  const pair = await createPairing(f.store, { context: f.context, teamId: f.teamId, capabilities: ['read'] }, f.clock);
  const a = await f.independentStore(), b = await f.independentStore();
  assert.notEqual((await a.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, (await b.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  const results = await Promise.allSettled([a, b].map(({ store }) => approvePairing(store, { pairingId: pair.pairingId, deviceId: device.deviceId, capabilities: ['read'] }, f.clock)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const denied = results.find(result => result.status === 'rejected');
  assert.ok(denied?.status === 'rejected'); assert.match(String(denied.reason), /PAIRING_USED|AUTHORIZATION_CONFLICT/);
  assert.equal((await f.db.admin.query("SELECT count(*) FROM mpd_identity.leases WHERE state='active'")).rows[0].count, '1');
});

test('different pairings racing for one user cannot produce two active device leases', async t => {
  const f = await policyFixture(t);
  const first = await enrollDevice(f.store, { ownerId: f.userId, name: 'Same name' }, f.clock);
  const second = await enrollDevice(f.store, { ownerId: f.userId, name: 'Same name' }, f.clock);
  await f.online(first.deviceId); await f.online(second.deviceId);
  const pairs = await Promise.all([1, 2].map(() => createPairing(f.store, { context: f.context, teamId: f.teamId, capabilities: ['read'] }, f.clock)));
  const clients = [await f.independentStore(), await f.independentStore()];
  const results = await Promise.allSettled(clients.map(({ store }, i) => approvePairing(store, { pairingId: pairs[i]!.pairingId, deviceId: [first, second][i]!.deviceId, capabilities: ['read'] }, f.clock)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await f.db.admin.query("SELECT count(*) FROM mpd_identity.leases WHERE state='active'")).rows[0].count, '1');
});

test('expired idle lease transitions before a new owner-approved lease is created', async t => {
  const f = await policyFixture(t);
  const device = await enrollDevice(f.store, { ownerId: f.userId, name: 'Laptop' }, f.clock);
  await f.online(device.deviceId);
  const firstPair = await createPairing(f.store, { context: f.context, teamId: f.teamId, capabilities: ['read'] }, f.clock);
  const firstLease = await approvePairing(f.store, { pairingId: firstPair.pairingId, deviceId: device.deviceId, capabilities: ['read'] }, f.clock);
  f.advance(600_000);
  const secondPair = await createPairing(f.store, { context: f.context, teamId: f.teamId, capabilities: ['read'] }, f.clock);
  const secondLease = await approvePairing(f.store, { pairingId: secondPair.pairingId, deviceId: device.deviceId, capabilities: ['read'] }, f.clock);
  assert.notEqual(secondLease.id, firstLease.id);
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.leases WHERE id=$1', [firstLease.id])).rows[0].state, 'expired');
});

test('approval expiry is checked again after a real device row lock wait', async t => {
  const f = await policyFixture(t);
  const device = await enrollDevice(f.store, { ownerId: f.userId, name: 'Laptop' }, f.clock);
  await f.online(device.deviceId);
  const pair = await createPairing(f.store, { context: f.context, teamId: f.teamId, capabilities: ['read'] }, f.clock);
  const blocker = await f.client();
  await blocker.query('BEGIN'); await blocker.query('SELECT id FROM mpd_identity.devices WHERE id=$1 FOR UPDATE', [device.deviceId]);
  const outcome = assert.rejects(approvePairing(f.store, { pairingId: pair.pairingId, deviceId: device.deviceId, capabilities: ['read'] }, f.clock), /PAIRING_EXPIRED/);
  for (let i = 0; i < 100; i++) {
    const waiting = await f.db.admin.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
    if (Number(waiting.rows[0].count) > 0) break;
    if (i === 99) assert.fail('Approval did not wait on device lock');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  f.advance(300_000); await blocker.query('COMMIT'); await outcome;
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.leases')).rows[0].count, '0');
});

test('restart preserves device credentials/revocation but invalidates live local authority', async t => {
  const f = await policyFixture(t);
  const device = await enrollDevice(f.store, { ownerId: f.userId, name: 'Laptop' }, f.clock);
  const revokedDevice = await enrollDevice(f.store, { ownerId: f.userId, name: 'Lost laptop' }, f.clock);
  await f.db.admin.query('UPDATE mpd_identity.device_credentials SET revoked_at=$1 WHERE device_id=$2', [POLICY_NOW, revokedDevice.deviceId]);
  await f.online(device.deviceId);
  const pair = await createPairing(f.store, { context: f.context, teamId: f.teamId, capabilities: ['read'] }, f.clock);
  const lease = await approvePairing(f.store, { pairingId: pair.pairingId, deviceId: device.deviceId, capabilities: ['read'] }, f.clock);
  await f.reopen();
  const ref = await authenticateDevice(f.store, device.secret, f.clock);
  assert.equal(ref.online, false); assert.equal(ref.epoch, 2);
  await assert.rejects(authenticateDevice(f.store, revokedDevice.secret, f.clock), /INVALID_DEVICE_CREDENTIAL/);
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.leases WHERE id=$1', [lease.id])).rows[0].state, 'revoked');
  await assert.rejects(createPairing(f.store, { context: f.context, teamId: f.teamId, capabilities: ['read'] }, f.clock), /STALE_CONTEXT/);
});

for (const condition of ['revoked', 'expired'] as const) {
  test(`online device with ${condition} credential cannot approve a fresh lease`, async t => {
    const f = await policyFixture(t);
    const device = await enrollDevice(f.store, { ownerId: f.userId, name: 'Laptop' }, f.clock);
    await f.online(device.deviceId);
    const pair = await createPairing(f.store, { context: f.context, teamId: f.teamId, capabilities: ['read'] }, f.clock);
    if (condition === 'revoked') await f.db.admin.query('UPDATE mpd_identity.device_credentials SET revoked_at=$1', [POLICY_NOW]);
    else await f.db.admin.query('UPDATE mpd_identity.device_credentials SET expires_at=$1', [POLICY_NOW]);
    await assert.rejects(approvePairing(f.store, { pairingId: pair.pairingId, deviceId: device.deviceId, capabilities: ['read'] }, f.clock), /INVALID_DEVICE_CREDENTIAL/);
  });
}

test('local resource block denies creating a desktop pairing even for a current context', async t => {
  const f = await policyFixture(t);
  await f.db.admin.query("INSERT INTO mpd_identity.user_resource_blocks(user_id,resource,reason,created_at) VALUES ($1,$2,'test',$3)", [f.userId, f.context.resource, POLICY_NOW]);
  await assert.rejects(createPairing(f.store, { context: f.context, teamId: f.teamId, capabilities: ['read'] }, f.clock), /RESOURCE_BLOCKED/);
});

test('credential authentication rechecks expiry after waiting on its device lock', async t => {
  const f = await policyFixture(t);
  const device = await enrollDevice(f.store, { ownerId: f.userId, name: 'Laptop' }, f.clock);
  const blocker = await f.client();
  await blocker.query('BEGIN'); await blocker.query('SELECT id FROM mpd_identity.devices WHERE id=$1 FOR UPDATE', [device.deviceId]);
  const denied = assert.rejects(authenticateDevice(f.store, device.secret, f.clock), /INVALID_DEVICE_CREDENTIAL/);
  for (let i = 0; i < 100; i++) {
    const waiting = await f.db.admin.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
    if (Number(waiting.rows[0].count) > 0) break;
    if (i === 99) assert.fail('Authentication did not wait on device lock');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  f.advance(2_592_000_000); await blocker.query('COMMIT'); await denied;
});

test('approval audit failure rolls back lease creation and pairing consumption', async t => {
  const f = await policyFixture(t);
  const device = await enrollDevice(f.store, { ownerId: f.userId, name: 'Laptop' }, f.clock);
  await f.online(device.deviceId);
  const pair = await createPairing(f.store, { context: f.context, teamId: f.teamId, capabilities: ['read'] }, f.clock);
  await f.db.admin.query("CREATE FUNCTION mpd_identity.reject_policy_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='pairing_approved' THEN RAISE EXCEPTION 'private-audit-canary'; END IF; RETURN NEW; END $$");
  await f.db.admin.query('CREATE TRIGGER reject_policy_audit BEFORE INSERT ON mpd_identity.audit_events FOR EACH ROW EXECUTE FUNCTION mpd_identity.reject_policy_audit()');
  await assert.rejects(approvePairing(f.store, { pairingId: pair.pairingId, deviceId: device.deviceId, capabilities: ['read'] }, f.clock), /^PolicyError: STORE_UNAVAILABLE$/);
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.pairings')).rows[0].state, 'pending');
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.leases')).rows[0].count, '0');
  await f.db.admin.query('DROP TRIGGER reject_policy_audit ON mpd_identity.audit_events');
  await approvePairing(f.store, { pairingId: pair.pairingId, deviceId: device.deviceId, capabilities: ['read'] }, f.clock);
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.leases')).rows[0].count, '1');
});

test('pairing and lease deadlines cannot extend past the local context expiry', async t => {
  const f = await policyFixture(t);
  await f.db.admin.query('UPDATE mpd_identity.work_contexts SET expires_at=$1 WHERE id=$2', [POLICY_NOW + 60_000, f.context.id]);
  const device = await enrollDevice(f.store, { ownerId: f.userId, name: 'Laptop' }, f.clock);
  await f.online(device.deviceId);
  const pair = await createPairing(f.store, { context: f.context, teamId: f.teamId, capabilities: ['read'] }, f.clock);
  assert.equal(Number((await f.db.admin.query('SELECT expires_at FROM mpd_identity.pairings')).rows[0].expires_at), POLICY_NOW + 60_000);
  const lease = await approvePairing(f.store, { pairingId: pair.pairingId, deviceId: device.deviceId, capabilities: ['read'] }, f.clock);
  assert.equal(lease.expiresAt, POLICY_NOW + 60_000);
  assert.equal(lease.idleExpiresAt, POLICY_NOW + 60_000);
});
