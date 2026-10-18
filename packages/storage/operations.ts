import { randomUUID } from 'node:crypto';
import type { Tool } from '../protocol.js';
import type { VerifiedRequestAuth } from '../auth/types.js';
import type { DispatchCoordinator } from '../authorization/runtime.js';
import { PolicyError, policyError } from '../authorization/errors.js';
import { assertPolicyStore, lockPolicyContext, lockPolicyMembership, lockPolicyOwner, policyNow, policyTransaction } from '../authorization/policy.js';
import type { ContextRef } from './contexts.js';
import type { Store } from './types.js';

export type OperationInput = Readonly<{ auth: VerifiedRequestAuth; context: ContextRef; leaseId: string; tool: Tool; write: boolean; clock: () => number }>;
export type OperationRef = Readonly<{ requestId: string; deviceId: string; leaseId: string; contextId: string; epoch: number; deadline: number; write: boolean }>;
/** Enqueue synchronously accepts metadata into the injected local harness; it never awaits execution. */
export type LocalTestTransport = Readonly<{ enqueue(operation: OperationRef): void }>;
const deadlines = new WeakMap<Store, Map<string, ReturnType<typeof setTimeout>>>();
function clearDeadline(store: Store, requestId: string): void {
  const timer = deadlines.get(store)?.get(requestId);
  if (timer) clearTimeout(timer);
  deadlines.get(store)?.delete(requestId);
}
function classification(input: OperationInput): void {
  const remote = ['blender_get_scene_info', 'blender_get_object_info', 'blender_get_viewport_screenshot', 'blender_execute_code'];
  if (!remote.includes(input.tool) || input.write !== (input.tool === 'blender_execute_code')) throw new PolicyError('INVALID_OPERATION');
}

export async function admitOperation(store: Store, input: OperationInput): Promise<OperationRef> {
  classification(input);
  if (input.context.bootId !== store.bootId || input.context.deploymentEpoch !== store.deploymentEpoch) throw new PolicyError('STALE_CONTEXT');
  let prepared: OperationRef | undefined;
  try {
    return await policyTransaction(store, async tx => {
      const route = (await tx.query('SELECT * FROM mpd_identity.leases WHERE id=$1', [input.leaseId])).rows[0];
      if (!route || route.context_id !== input.context.id || route.user_id !== input.context.userId) throw new PolicyError('NOT_PAIRED');
      const identity = (await tx.query('SELECT user_id FROM mpd_identity.identities WHERE issuer=$1 AND subject=$2', [input.auth.principal.issuer, input.auth.principal.subject])).rows[0];
      if (!identity || identity.user_id !== input.context.userId || input.auth.resource !== input.context.resource || input.auth.principal.clientId !== input.context.clientId || input.auth.principal.emailVerified !== true || !/^[a-f0-9]{64}$/.test(input.auth.tokenFingerprint)) throw new PolicyError('CONTEXT_DENIED');
      await lockPolicyOwner(tx, route.user_id);
      await lockPolicyMembership(tx, route.user_id, route.team_id);
      const device = (await tx.query('SELECT * FROM mpd_identity.devices WHERE id=$1 FOR UPDATE', [route.device_id])).rows[0];
      if (!device || device.disabled || device.owner_id !== route.user_id) throw new PolicyError('DEVICE_REVOKED');
      if (!device.online) throw new PolicyError('DEVICE_OFFLINE');
      const credential = (await tx.query('SELECT * FROM mpd_identity.device_credentials WHERE device_id=$1 ORDER BY generation DESC LIMIT 1 FOR UPDATE', [device.id])).rows[0];
      const context = await lockPolicyContext(tx, store, input.context);
      const lease = (await tx.query('SELECT * FROM mpd_identity.leases WHERE id=$1 FOR UPDATE', [input.leaseId])).rows[0];
      if (!lease || lease.state !== 'active' || lease.user_id !== route.user_id || lease.context_id !== input.context.id || lease.device_id !== device.id || lease.team_id !== route.team_id) throw new PolicyError('NOT_PAIRED');
      const pending = input.write ? await tx.query("SELECT id FROM mpd_identity.operation_attempts WHERE device_id=$1 AND classification='write' AND state IN ('admitted','dispatched','uncertain') ORDER BY id FOR UPDATE", [device.id]) : null;
      await assertPolicyStore(tx, store);
      const state = (await tx.query('SELECT token_iat_after FROM mpd_identity.service_state WHERE singleton=true')).rows[0];
      const denial = await tx.query('SELECT expires_at FROM mpd_identity.token_denials WHERE fingerprint=$1 AND (resource IS NULL OR resource=$2)', [input.auth.tokenFingerprint, input.auth.resource]);
      const now = policyNow(input.clock);
      if (!Number.isFinite(input.auth.principal.expiresAt) || input.auth.principal.expiresAt <= now) throw new PolicyError('TOKEN_EXPIRED');
      const cutoff = Math.max(store.tokenIatAfter, Number(state?.token_iat_after));
      if (!Number.isSafeInteger(cutoff) || !Number.isFinite(input.auth.principal.issuedAt) || input.auth.principal.issuedAt <= cutoff * 1000) throw new PolicyError('TOKEN_ISSUED_BEFORE_CUTOFF');
      if (denial.rows.some(row => Number(row.expires_at) > now)) throw new PolicyError('TOKEN_REVOKED');
      if (!credential || credential.revoked_at !== null || credential.deployment_epoch !== store.deploymentEpoch || Number(credential.expires_at) <= now) throw new PolicyError('INVALID_DEVICE_CREDENTIAL');
      if (context.expiresAt <= now) throw new PolicyError('STALE_CONTEXT');
      if (Number(lease.expires_at) <= now || Number(lease.idle_expires_at) <= now || Number(lease.epoch) !== Number(device.connection_epoch)) throw new PolicyError('NOT_PAIRED');
      if (!lease.capabilities.includes(input.write ? 'execute' : 'read')) throw new PolicyError('CAPABILITY_DENIED');
      if (pending?.rowCount) throw new PolicyError('DEVICE_BUSY');
      const epoch = Number(device.connection_epoch);
      if (!Number.isSafeInteger(epoch) || epoch < 0) throw new PolicyError('NOT_PAIRED');
      const idleExpiresAt = Math.min(now + 600_000, Number(lease.expires_at), context.expiresAt, Number(credential.expires_at));
      const operation: OperationRef = Object.freeze({ requestId: randomUUID(), deviceId: device.id, leaseId: lease.id, contextId: input.context.id, epoch,
        deadline: Math.min(now + 30_000, input.auth.principal.expiresAt, context.expiresAt, Number(lease.expires_at), idleExpiresAt, Number(credential.expires_at)), write: input.write });
      await tx.query('UPDATE mpd_identity.leases SET idle_expires_at=$2 WHERE id=$1', [lease.id, idleExpiresAt]);
      await tx.query("INSERT INTO mpd_identity.operation_attempts(id,request_id,lease_id,device_id,epoch,classification,state,created_at,token_fingerprint,deadline_at) VALUES ($1,$2,$3,$4,$5,$6,'admitted',$7,$8,$9)", [operation.requestId, operation.requestId, lease.id, device.id, epoch, input.write ? 'write' : 'read', now, input.auth.tokenFingerprint, operation.deadline]);
      await tx.query("INSERT INTO mpd_identity.audit_events(id,occurred_at,actor_id,resource,device_id,grant_id,action,outcome,correlation_id) VALUES ($1,$2,$3,$4,$5,$6,'operation_admitted','allowed',$7)", [randomUUID(), now, route.user_id, input.context.resource, device.id, lease.id, operation.requestId]);
      prepared = operation;
      return operation;
    });
  } catch (error) {
    if (prepared) {
      // The callback finished, but COMMIT acknowledgement did not. Never enqueue or retry.
      try { await store.transaction(tx => tx.query("UPDATE mpd_identity.operation_attempts SET state=$2,reason='commit_uncertain',completed_at=$3 WHERE request_id=$1 AND state='admitted'", [prepared!.requestId, prepared!.write ? 'uncertain' : 'denied', policyNow(input.clock)]).then(() => {})); } catch { /* Startup recovery retains uncertainty if storage is unavailable. */ }
      throw new PolicyError(prepared.write ? 'EXECUTION_UNCERTAIN' : 'REQUEST_UNCERTAIN');
    }
    throw policyError(error);
  }
}

export async function dispatchAuthorized(deps: { store: Store; coordinator: DispatchCoordinator; transport: LocalTestTransport }, input: OperationInput): Promise<OperationRef> {
  return deps.coordinator.withFence(async () => {
    const operation = await admitOperation(deps.store, input);
    try {
      await deps.store.transaction(async tx => {
        const result = await tx.query("UPDATE mpd_identity.operation_attempts SET state='dispatched',dispatched_at=$2 WHERE request_id=$1 AND state='admitted'", [operation.requestId, policyNow(input.clock)]);
        if (result.rowCount !== 1) throw new PolicyError('NOT_PAIRED');
      });
      if (!await deps.store.ready()) throw new PolicyError('STORE_UNAVAILABLE');
      const now = policyNow(input.clock);
      if (input.auth.principal.expiresAt <= now) throw new PolicyError('TOKEN_EXPIRED');
      if (operation.deadline <= now) throw new PolicyError('REQUEST_TIMEOUT');
      // There must be no await between this fresh check and synchronous transport acceptance.
      deps.transport.enqueue(operation);
      const timer = setTimeout(() => { void completeOperation(deps.store, { ...operation, outcome: 'uncertain', clock: input.clock }).catch(() => {}); }, operation.deadline - now);
      timer.unref();
      let timers = deadlines.get(deps.store);
      if (!timers) { timers = new Map(); deadlines.set(deps.store, timers); }
      timers.set(operation.requestId, timer);
      return operation;
    } catch {
      try { await completeOperation(deps.store, { ...operation, outcome: 'uncertain', clock: input.clock }); } catch { /* Durable recovery closes unknown outcomes; dispatch is never retried. */ }
      throw new PolicyError(operation.write ? 'EXECUTION_UNCERTAIN' : 'REQUEST_UNCERTAIN');
    }
  });
}

export async function completeOperation(store: Store, input: { requestId: string; deviceId: string; leaseId: string; epoch: number; outcome: 'completed' | 'uncertain'; clock: () => number }): Promise<void> {
  try {
    const settled = await store.transaction(async tx => {
      const route = (await tx.query('SELECT lease_id,device_id,epoch FROM mpd_identity.operation_attempts WHERE request_id=$1', [input.requestId])).rows[0];
      if (!route || route.lease_id !== input.leaseId || route.device_id !== input.deviceId || Number(route.epoch) !== input.epoch) return false;
      const lease = (await tx.query('SELECT * FROM mpd_identity.leases WHERE id=$1 FOR UPDATE', [route.lease_id])).rows[0];
      const operation = (await tx.query('SELECT * FROM mpd_identity.operation_attempts WHERE request_id=$1 FOR UPDATE', [input.requestId])).rows[0];
      if (!operation || operation.lease_id !== input.leaseId || operation.device_id !== input.deviceId || Number(operation.epoch) !== input.epoch) return false;
      if (!['admitted', 'dispatched'].includes(operation.state)) return true;
      if (operation.state === 'admitted' && input.outcome === 'completed') return false;
      const device = (await tx.query('SELECT connection_epoch FROM mpd_identity.devices WHERE id=$1', [input.deviceId])).rows[0];
      const now = policyNow(input.clock);
      const uncertain = input.outcome === 'uncertain' || Number(operation.deadline_at ?? Number(operation.created_at) + 30_000) <= now || !lease || lease.state !== 'active' || Number(device?.connection_epoch) !== input.epoch;
      const state = uncertain ? operation.classification === 'write' ? 'uncertain' : 'denied' : 'completed';
      await tx.query('UPDATE mpd_identity.operation_attempts SET state=$2,completed_at=$3,reason=$4 WHERE request_id=$1', [input.requestId, state, now, uncertain ? 'execution_uncertain' : null]);
      if (uncertain) await tx.query("UPDATE mpd_identity.leases SET state='revoked',reason='operation_uncertain',terminated_at=$2 WHERE id=$1 AND state='active'", [input.leaseId, now]);
      return true;
    });
    if (settled) clearDeadline(store, input.requestId);
  } catch (error) { throw policyError(error); }
}
