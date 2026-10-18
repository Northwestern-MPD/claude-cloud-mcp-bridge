import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Capability } from '../protocol.js';
import { PolicyError } from '../authorization/errors.js';
import { assertPolicyStore, lockPolicyContext, lockPolicyMembership, lockPolicyOwner, policyCapabilities, policyNow, policyTransaction } from '../authorization/policy.js';
import type { ContextRef } from './contexts.js';
import type { Store } from './types.js';

/** Local policy harness only; a ContextRef is not per-request authentication or proof of native session isolation. */
export type PairingInput = Readonly<{ context: ContextRef; teamId: string; capabilities: readonly Capability[] }>;
export type LeaseRef = Readonly<{
  id: string; contextId: string; deviceId: string; teamId: string; capabilities: readonly Capability[];
  epoch: number; expiresAt: number; idleExpiresAt: number; state: 'active' | 'revoked' | 'expired' | 'released';
}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createPairing(store: Store, input: PairingInput, clock: () => number): Promise<{ pairingId: string; code: string }> {
  const capabilities = policyCapabilities(input.capabilities);
  return policyTransaction(store, async tx => {
    await lockPolicyOwner(tx, input.context.userId);
    await lockPolicyMembership(tx, input.context.userId, input.teamId);
    const context = await lockPolicyContext(tx, store, input.context);
    await assertPolicyStore(tx, store);
    const now = policyNow(clock);
    if (context.expiresAt <= now) throw new PolicyError('STALE_CONTEXT');
    const pairingId = randomUUID(), code = randomBytes(16).toString('base64url');
    await tx.query('INSERT INTO mpd_identity.pairings(id,context_id,owner_id,team_id,fingerprint,capabilities,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [pairingId, input.context.id, input.context.userId, input.teamId, createHash('sha256').update(code).digest('hex'), capabilities, Math.min(context.expiresAt, now + 300_000), now]);
    await tx.query("INSERT INTO mpd_identity.audit_events(id,occurred_at,actor_id,resource,action,outcome) VALUES ($1,$2,$3,$4,'pairing_requested','allowed')", [randomUUID(), now, input.context.userId, input.context.resource]);
    return { pairingId, code };
  });
}

export async function approvePairing(store: Store, input: { pairingId: string; deviceId: string; capabilities: readonly Capability[] }, clock: () => number): Promise<LeaseRef> {
  if (!UUID.test(input.pairingId)) throw new PolicyError('PAIRING_NOT_FOUND');
  const capabilities = policyCapabilities(input.capabilities);
  return policyTransaction(store, async tx => {
    // Initial routing reads confer no authority; every affected row is re-read under its lock below.
    const initial = (await tx.query('SELECT p.owner_id,p.team_id,p.context_id,c.resource,c.client_id,c.boot_id,c.deployment_epoch FROM mpd_identity.pairings p JOIN mpd_identity.work_contexts c ON c.id=p.context_id WHERE p.id=$1', [input.pairingId])).rows[0];
    if (!initial) throw new PolicyError('PAIRING_NOT_FOUND');
    await lockPolicyOwner(tx, initial.owner_id);
    await lockPolicyMembership(tx, initial.owner_id, initial.team_id);
    const device = (await tx.query('SELECT * FROM mpd_identity.devices WHERE id=$1 FOR UPDATE', [input.deviceId])).rows[0];
    if (!device || device.owner_id !== initial.owner_id) throw new PolicyError('WRONG_OWNER');
    if (device.disabled) throw new PolicyError('DEVICE_REVOKED');
    if (!device.online) throw new PolicyError('DEVICE_OFFLINE');
    const currentCredential = (await tx.query('SELECT expires_at,revoked_at,deployment_epoch FROM mpd_identity.device_credentials WHERE device_id=$1 ORDER BY generation DESC LIMIT 1 FOR UPDATE', [device.id])).rows[0];
    const contextRef: ContextRef = { id: initial.context_id, userId: initial.owner_id, resource: initial.resource, clientId: initial.client_id, bootId: initial.boot_id, deploymentEpoch: initial.deployment_epoch };
    const context = await lockPolicyContext(tx, store, contextRef);
    const pairing = (await tx.query('SELECT * FROM mpd_identity.pairings WHERE id=$1 FOR UPDATE', [input.pairingId])).rows[0];
    if (!pairing || pairing.owner_id !== initial.owner_id || pairing.context_id !== initial.context_id || pairing.team_id !== initial.team_id) throw new PolicyError('PAIRING_NOT_FOUND');
    if (pairing.state !== 'pending') throw new PolicyError('PAIRING_USED');
    if (capabilities.some(value => !pairing.capabilities.includes(value))) throw new PolicyError('CAPABILITY_DENIED');
    const existing = await tx.query("SELECT * FROM mpd_identity.leases WHERE state='active' AND (user_id=$1 OR device_id=$2) ORDER BY id FOR UPDATE", [initial.owner_id, input.deviceId]);
    await assertPolicyStore(tx, store);
    const now = policyNow(clock);
    if (!currentCredential || currentCredential.revoked_at !== null || currentCredential.deployment_epoch !== store.deploymentEpoch || Number(currentCredential.expires_at) <= now) throw new PolicyError('INVALID_DEVICE_CREDENTIAL');
    if (context.expiresAt <= now) throw new PolicyError('STALE_CONTEXT');
    if (Number(pairing.expires_at) <= now) throw new PolicyError('PAIRING_EXPIRED');
    for (const lease of existing.rows) {
      if (Number(lease.expires_at) > now && Number(lease.idle_expires_at) > now) throw new PolicyError('LEASE_CONFLICT');
      await tx.query("UPDATE mpd_identity.leases SET state='expired',reason='deadline',terminated_at=$2 WHERE id=$1", [lease.id, now]);
    }
    const epoch = Number(device.connection_epoch);
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new PolicyError('DEVICE_REVOKED');
    const lease: LeaseRef = Object.freeze({ id: randomUUID(), contextId: initial.context_id, deviceId: input.deviceId, teamId: initial.team_id,
      capabilities: Object.freeze(capabilities), epoch, expiresAt: Math.min(context.expiresAt, now + 3_600_000), idleExpiresAt: Math.min(context.expiresAt, now + 600_000), state: 'active' });
    await tx.query("UPDATE mpd_identity.pairings SET state='consumed',consumed_at=$2 WHERE id=$1", [pairing.id, now]);
    await tx.query("INSERT INTO mpd_identity.leases(id,context_id,user_id,device_id,team_id,capabilities,epoch,expires_at,idle_expires_at,state,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10)", [lease.id, lease.contextId, initial.owner_id, lease.deviceId, lease.teamId, lease.capabilities, lease.epoch, lease.expiresAt, lease.idleExpiresAt, now]);
    await tx.query("INSERT INTO mpd_identity.audit_events(id,occurred_at,actor_id,resource,device_id,grant_id,action,outcome) VALUES ($1,$2,$3,$4,$5,$6,'pairing_approved','allowed')", [randomUUID(), now, initial.owner_id, initial.resource, input.deviceId, lease.id]);
    return lease;
  });
}
