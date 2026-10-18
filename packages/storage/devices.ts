import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PolicyError } from '../authorization/errors.js';
import { assertPolicyStore, lockPolicyOwner, policyNow, policyTransaction } from '../authorization/policy.js';
import type { Store, Transaction } from './types.js';

export type DeviceRef = Readonly<{ id: string; ownerId: string; epoch: number; deploymentEpoch: string; online: boolean }>;
const CREDENTIAL_LIFETIME_MS = 2_592_000_000;
const SECRET_FORMAT = /^mpd_device_[A-Za-z0-9_-]{43}$/;
const fingerprint = (secret: string) => createHash('sha256').update(secret).digest('hex');
const newSecret = () => `mpd_device_${randomBytes(32).toString('base64url')}`;

async function credential(tx: Transaction, store: Store, deviceId: string, generation: number, secret: string, now: number): Promise<void> {
  await tx.query('INSERT INTO mpd_identity.device_credentials(id,device_id,fingerprint,generation,deployment_epoch,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), deviceId, fingerprint(secret), generation, store.deploymentEpoch, now + CREDENTIAL_LIFETIME_MS, now]);
}

export async function enrollDevice(store: Store, input: { ownerId: string; name: string }, clock: () => number): Promise<{ deviceId: string; secret: string }> {
  return policyTransaction(store, async tx => {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) throw new PolicyError('INVALID_DEVICE');
    await lockPolicyOwner(tx, input.ownerId);
    await assertPolicyStore(tx, store);
    const now = policyNow(clock), deviceId = randomUUID(), secret = newSecret();
    await tx.query('INSERT INTO mpd_identity.devices(id,owner_id,name,created_at,updated_at) VALUES ($1,$2,$3,$4,$4)', [deviceId, input.ownerId, input.name.trim(), now]);
    await credential(tx, store, deviceId, 1, secret, now);
    await tx.query("INSERT INTO mpd_identity.audit_events(id,occurred_at,actor_id,device_id,action,outcome) VALUES ($1,$2,$3,$4,'device_enrolled','allowed')", [randomUUID(), now, input.ownerId, deviceId]);
    return { deviceId, secret };
  });
}

export async function rotateDeviceCredential(store: Store, deviceId: string, clock: () => number): Promise<{ secret: string }> {
  return policyTransaction(store, async tx => {
    const initial = (await tx.query('SELECT owner_id FROM mpd_identity.devices WHERE id=$1', [deviceId])).rows[0];
    if (!initial) throw new PolicyError('DEVICE_REVOKED');
    await lockPolicyOwner(tx, initial.owner_id);
    const device = (await tx.query('SELECT * FROM mpd_identity.devices WHERE id=$1 FOR UPDATE', [deviceId])).rows[0];
    if (!device || device.disabled || device.owner_id !== initial.owner_id) throw new PolicyError('DEVICE_REVOKED');
    const previous = await tx.query('SELECT generation FROM mpd_identity.device_credentials WHERE device_id=$1 ORDER BY generation FOR UPDATE', [deviceId]);
    await tx.query("SELECT id FROM mpd_identity.leases WHERE device_id=$1 AND state='active' ORDER BY id FOR UPDATE", [deviceId]);
    await assertPolicyStore(tx, store);
    const now = policyNow(clock), secret = newSecret();
    const generation = Math.max(0, ...previous.rows.map(row => Number(row.generation))) + 1;
    if (!Number.isSafeInteger(generation)) throw new PolicyError('AUTHORIZATION_CONFLICT');
    await tx.query('UPDATE mpd_identity.device_credentials SET revoked_at=$2 WHERE device_id=$1 AND revoked_at IS NULL', [deviceId, now]);
    await credential(tx, store, deviceId, generation, secret, now);
    await tx.query('UPDATE mpd_identity.devices SET online=false,connection_epoch=connection_epoch+1,updated_at=$2 WHERE id=$1', [deviceId, now]);
    await tx.query("UPDATE mpd_identity.leases SET state='revoked',reason='credential_rotation',terminated_at=$2 WHERE device_id=$1 AND state='active'", [deviceId, now]);
    await tx.query("INSERT INTO mpd_identity.audit_events(id,occurred_at,actor_id,device_id,action,outcome) VALUES ($1,$2,$3,$4,'device_credential_rotated','allowed')", [randomUUID(), now, initial.owner_id, deviceId]);
    return { secret };
  });
}

export async function authenticateDevice(store: Store, secret: string, clock: () => number): Promise<DeviceRef> {
  if (typeof secret !== 'string' || !SECRET_FORMAT.test(secret)) throw new PolicyError('INVALID_DEVICE_CREDENTIAL');
  return policyTransaction(store, async tx => {
    const digest = fingerprint(secret);
    const initial = (await tx.query('SELECT d.id,d.owner_id FROM mpd_identity.devices d JOIN mpd_identity.device_credentials c ON c.device_id=d.id WHERE c.fingerprint=$1', [digest])).rows[0];
    if (!initial) throw new PolicyError('INVALID_DEVICE_CREDENTIAL');
    await lockPolicyOwner(tx, initial.owner_id);
    const device = (await tx.query('SELECT * FROM mpd_identity.devices WHERE id=$1 FOR UPDATE', [initial.id])).rows[0];
    const row = (await tx.query('SELECT * FROM mpd_identity.device_credentials WHERE fingerprint=$1 FOR UPDATE', [digest])).rows[0];
    await assertPolicyStore(tx, store);
    const now = policyNow(clock);
    if (!device || device.disabled || device.owner_id !== initial.owner_id) throw new PolicyError('DEVICE_REVOKED');
    if (!row || row.device_id !== device.id || row.revoked_at !== null || Number(row.expires_at) <= now || row.deployment_epoch !== store.deploymentEpoch) throw new PolicyError('INVALID_DEVICE_CREDENTIAL');
    const epoch = Number(device.connection_epoch);
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new PolicyError('DEVICE_REVOKED');
    await tx.query('UPDATE mpd_identity.device_credentials SET last_used_at=$2 WHERE id=$1', [row.id, now]);
    return Object.freeze({ id: device.id, ownerId: device.owner_id, epoch, deploymentEpoch: store.deploymentEpoch, online: device.online });
  });
}
