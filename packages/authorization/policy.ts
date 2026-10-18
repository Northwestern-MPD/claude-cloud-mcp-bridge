import type { Capability } from '../protocol.js';
import type { ContextRef } from '../storage/contexts.js';
import type { Store, Transaction } from '../storage/types.js';
import { PolicyError, policyError } from './errors.js';

export function policyNow(clock: () => number): number {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw new PolicyError('INVALID_CLOCK');
  return now;
}

export function policyCapabilities(values: readonly Capability[]): Capability[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 2 || values.some(value => value !== 'read' && value !== 'execute')) throw new PolicyError('CAPABILITY_DENIED');
  return [...new Set(values)];
}

export async function policyTransaction<T>(store: Store, action: (tx: Transaction) => Promise<T>): Promise<T> {
  try {
    if (!await store.ready()) throw new PolicyError('STORE_UNAVAILABLE');
    return await store.transaction(action);
  } catch (error) { throw policyError(error); }
}

export async function assertPolicyStore(tx: Transaction, store: Store): Promise<void> {
  const result = await tx.query('SELECT maintenance,boot_id,deployment_epoch,store_id FROM mpd_identity.service_state WHERE singleton=true');
  const row = result.rows[0];
  if (!row || row.maintenance || row.boot_id !== store.bootId || row.deployment_epoch !== store.deploymentEpoch || row.store_id !== store.expectedStoreId) throw new PolicyError('STORE_UNAVAILABLE');
}

/** Lock order for all local grant mutations: user, membership, device, context, pairing, lease. */
export async function lockPolicyOwner(tx: Transaction, ownerId: string): Promise<void> {
  const user = await tx.query('SELECT status FROM mpd_identity.users WHERE id=$1 FOR UPDATE', [ownerId]);
  if (user.rows[0]?.status !== 'active') throw new PolicyError('USER_DISABLED');
}

export async function lockPolicyMembership(tx: Transaction, ownerId: string, teamId: string): Promise<void> {
  const result = await tx.query("SELECT m.status,t.status AS team_status,c.status AS course_status FROM mpd_identity.memberships m JOIN mpd_identity.teams t ON t.id=m.team_id JOIN mpd_identity.courses c ON c.id=t.course_id WHERE m.user_id=$1 AND m.team_id=$2 AND m.status<>'removed' ORDER BY m.id FOR UPDATE OF m", [ownerId, teamId]);
  if (!result.rows.some(row => row.status === 'active' && row.team_status === 'active' && row.course_status === 'active')) throw new PolicyError('NOT_ENROLLED');
}

export async function lockPolicyContext(tx: Transaction, store: Store, context: ContextRef): Promise<{ expiresAt: number }> {
  const result = await tx.query('SELECT * FROM mpd_identity.work_contexts WHERE id=$1 FOR UPDATE', [context.id]);
  const row = result.rows[0];
  if (!row || row.state !== 'active' || row.user_id !== context.userId || row.resource !== context.resource || row.client_id !== context.clientId ||
    row.boot_id !== context.bootId || row.boot_id !== store.bootId || row.deployment_epoch !== context.deploymentEpoch || row.deployment_epoch !== store.deploymentEpoch) throw new PolicyError('STALE_CONTEXT');
  const block = await tx.query('SELECT 1 FROM mpd_identity.user_resource_blocks WHERE user_id=$1 AND resource=$2', [context.userId, context.resource]);
  if (block.rowCount) throw new PolicyError('RESOURCE_BLOCKED');
  return { expiresAt: Number(row.expires_at) };
}
