import { randomUUID } from 'node:crypto';
import type { Store } from './types.js';
import type { DispatchCoordinator, RuntimeInvalidator } from '../authorization/runtime.js';
import { PolicyError, policyError } from '../authorization/errors.js';
import { policyNow } from '../authorization/policy.js';
export type RevocationCommand =
  | Readonly<{ kind: 'disable-user'; userId: string; reason: string }>
  | Readonly<{ kind: 'remove-membership'; userId: string; teamId: string; reason: string }>
  | Readonly<{ kind: 'block-resource'; userId: string; resource: string; reason: string }>
  | Readonly<{ kind: 'deny-token'; fingerprint: string; expiresAt: number; reason: string; userId?: string; resource?: string }>
  | Readonly<{ kind: 'revoke-device'; deviceId: string; reason: string }>;

/** Owns the shared fence; administrative callers must delegate without acquiring it again. */
export async function revokeAuthorization(store: Store, command: RevocationCommand, runtime: RuntimeInvalidator, coordinator: DispatchCoordinator, clock: () => number): Promise<void> {
  const configuredCoordinator = (runtime as RuntimeInvalidator & { coordinator?: DispatchCoordinator }).coordinator;
  if (configuredCoordinator && configuredCoordinator !== coordinator) throw new PolicyError('COORDINATOR_MISMATCH');
  return coordinator.withFence(async () => {
    try {
      const contexts = await store.transaction(async tx => {
        let userId = 'userId' in command ? command.userId : undefined;
        if (command.kind === 'revoke-device') {
          const device = (await tx.query('SELECT owner_id FROM mpd_identity.devices WHERE id=$1', [command.deviceId])).rows[0];
          if (!device) throw new PolicyError('DEVICE_REVOKED');
          userId = device.owner_id;
        }
        const ownerIds: string[] = userId ? [userId] : [];
        if (command.kind === 'deny-token') {
          if (!/^[a-f0-9]{64}$/.test(command.fingerprint)) throw new PolicyError('INVALID_ADMIN_COMMAND');
          const owners = await tx.query('SELECT DISTINCT l.user_id FROM mpd_identity.operation_attempts o JOIN mpd_identity.leases l ON l.id=o.lease_id WHERE o.token_fingerprint=$1', [command.fingerprint]);
          ownerIds.push(...owners.rows.map(row => String(row.user_id)));
        }
        const ids = [...new Set(ownerIds)].sort();
        const users = await tx.query('SELECT id FROM mpd_identity.users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
        if (userId && !users.rows.some(row => row.id === userId)) throw new PolicyError('USER_NOT_FOUND');
        const teamId = command.kind === 'remove-membership' ? command.teamId : null;
        await tx.query('SELECT id FROM mpd_identity.memberships WHERE user_id=ANY($1::uuid[]) AND ($2::uuid IS NULL OR team_id=$2) ORDER BY id FOR UPDATE', [ids, teamId]);
        await tx.query('SELECT id FROM mpd_identity.devices WHERE owner_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
        const resource = command.kind === 'block-resource' || command.kind === 'deny-token' ? command.resource ?? null : null;
        let effectiveTokenResource = resource;
        let affectedContextIds: string[] = [];
        if (command.kind !== 'deny-token') {
          const selected = await tx.query(`SELECT c.id FROM mpd_identity.work_contexts c WHERE c.user_id=ANY($1::uuid[]) AND ($2::text IS NULL OR c.resource=$2)
            AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM mpd_identity.leases l WHERE l.context_id=c.id AND l.device_id=$3 AND (l.state='active' OR EXISTS(SELECT 1 FROM mpd_identity.operation_attempts o WHERE o.lease_id=l.id AND o.state IN ('admitted','dispatched')))))
            AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM mpd_identity.leases l WHERE l.context_id=c.id AND l.team_id=$4 AND (l.state='active' OR EXISTS(SELECT 1 FROM mpd_identity.operation_attempts o WHERE o.lease_id=l.id AND o.state IN ('admitted','dispatched')))) OR EXISTS(SELECT 1 FROM mpd_identity.pairings p WHERE p.context_id=c.id AND p.team_id=$4 AND p.state='pending')) ORDER BY c.id FOR UPDATE`, [ids, resource, command.kind === 'revoke-device' ? command.deviceId : null, teamId]);
          affectedContextIds = selected.rows.map(row => String(row.id));
        }
        await tx.query('SELECT id FROM mpd_identity.pairings WHERE context_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [affectedContextIds]);
        const leases = command.kind === 'deny-token' ? await tx.query('SELECT l.id FROM mpd_identity.leases l WHERE EXISTS(SELECT 1 FROM mpd_identity.operation_attempts o WHERE o.lease_id=l.id AND o.token_fingerprint=$1) ORDER BY l.id FOR UPDATE', [command.fingerprint]) : await tx.query('SELECT id FROM mpd_identity.leases WHERE context_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [affectedContextIds]);
        const leaseIds = leases.rows.map(row => String(row.id));
        await tx.query('SELECT id FROM mpd_identity.operation_attempts WHERE lease_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [leaseIds]);
        const now = policyNow(clock);
        switch (command.kind) {
          case 'disable-user':
            await tx.query("UPDATE mpd_identity.users SET status='disabled',authorization_version=authorization_version+1,updated_at=$2 WHERE id=$1", [command.userId, now]); break;
          case 'remove-membership':
            await tx.query("UPDATE mpd_identity.memberships SET status='removed',version=version+1,updated_at=$3 WHERE user_id=$1 AND team_id=$2 AND status<>'removed'", [command.userId, command.teamId, now]); break;
          case 'block-resource':
            await tx.query('INSERT INTO mpd_identity.user_resource_blocks(user_id,resource,reason,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT(user_id,resource) DO UPDATE SET reason=EXCLUDED.reason', [command.userId, command.resource, command.reason, now]); break;
          case 'revoke-device':
            await tx.query('UPDATE mpd_identity.devices SET disabled=true,online=false,connection_epoch=connection_epoch+1,updated_at=$2 WHERE id=$1', [command.deviceId, now]);
            await tx.query('UPDATE mpd_identity.device_credentials SET revoked_at=$2 WHERE device_id=$1 AND revoked_at IS NULL', [command.deviceId, now]); break;
          case 'deny-token':
            if (!Number.isSafeInteger(command.expiresAt) || command.expiresAt <= now) throw new PolicyError('INVALID_ADMIN_COMMAND');
            const denial = await tx.query('INSERT INTO mpd_identity.token_denials(fingerprint,user_id,resource,expires_at,reason,created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(fingerprint) DO UPDATE SET expires_at=GREATEST(mpd_identity.token_denials.expires_at,EXCLUDED.expires_at),reason=EXCLUDED.reason,resource=CASE WHEN mpd_identity.token_denials.resource IS NULL OR EXCLUDED.resource IS NULL OR mpd_identity.token_denials.resource<>EXCLUDED.resource THEN NULL ELSE EXCLUDED.resource END RETURNING resource', [command.fingerprint, command.userId ?? null, command.resource ?? null, command.expiresAt + 60_000, command.reason, now]);
            effectiveTokenResource = denial.rows[0].resource; break;
        }
        if (command.kind === 'deny-token') {
          await tx.query("UPDATE mpd_identity.operation_attempts o SET state=CASE WHEN classification='write' THEN 'uncertain' ELSE 'denied' END,reason='token_revoked',completed_at=$2 FROM mpd_identity.leases l,mpd_identity.work_contexts c WHERE o.lease_id=l.id AND l.context_id=c.id AND o.token_fingerprint=$1 AND ($3::text IS NULL OR c.resource=$3) AND o.state IN ('admitted','dispatched')", [command.fingerprint, now, effectiveTokenResource]);
        } else {
          await tx.query("UPDATE mpd_identity.work_contexts SET state='revoked',revoked_at=$2 WHERE id=ANY($1::uuid[]) AND state='active'", [affectedContextIds, now]);
          await tx.query("UPDATE mpd_identity.pairings SET state='revoked',revoked_at=$2 WHERE context_id=ANY($1::uuid[]) AND state='pending'", [affectedContextIds, now]);
          await tx.query("UPDATE mpd_identity.leases SET state='revoked',reason=$3,terminated_at=$2 WHERE id=ANY($1::uuid[]) AND state='active'", [leaseIds, now, command.kind]);
          await tx.query("UPDATE mpd_identity.operation_attempts SET state=CASE WHEN classification='write' THEN 'uncertain' ELSE 'denied' END,reason=$3,completed_at=$2 WHERE lease_id=ANY($1::uuid[]) AND state IN ('admitted','dispatched')", [leaseIds, now, command.kind]);
        }
        await tx.query("INSERT INTO mpd_identity.audit_events(id,occurred_at,actor_id,resource,action,outcome,reason) VALUES ($1,$2,$3,$4,$5,'allowed',$6)", [randomUUID(), now, userId ?? null, resource, command.kind, command.reason]);
        return affectedContextIds;
      });
      // Durable denial precedes synchronous runtime invalidation and acknowledgement.
      for (const contextId of contexts) runtime.invalidate({ contextId });
    } catch (error) { throw policyError(error); }
  });
}
