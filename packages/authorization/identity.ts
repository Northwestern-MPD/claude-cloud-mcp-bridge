import type { VerifiedRequestAuth } from '../auth/types.js';
import { activateEnrollmentInTransaction } from '../storage/enrollment.js';
import type { Store } from '../storage/types.js';
import { PolicyError, policyError } from './errors.js';

export type IdentityView = Readonly<{
  userId: string; resource: string; courseIds: readonly string[]; teamIds: readonly string[]; desktop_access: false;
}>;

export async function authorizeIdentity(store: Store, auth: VerifiedRequestAuth, input: { clock: () => number }): Promise<IdentityView> {
  try {
    if (!await store.ready()) throw new PolicyError('STORE_UNAVAILABLE');
    return await store.transaction(async tx => {
      const userId = await activateEnrollmentInTransaction(tx, auth.principal, input.clock);
      const state = await tx.query('SELECT maintenance,token_iat_after,boot_id,deployment_epoch FROM mpd_identity.service_state WHERE singleton=true');
      const authority = state.rows[0];
      if (!authority || authority.maintenance || authority.boot_id !== store.bootId || authority.deployment_epoch !== store.deploymentEpoch) throw new PolicyError('STORE_UNAVAILABLE');
      const memberships = await tx.query("SELECT m.team_id,t.course_id FROM mpd_identity.memberships m JOIN mpd_identity.teams t ON t.id=m.team_id JOIN mpd_identity.courses c ON c.id=t.course_id WHERE m.user_id=$1 AND m.status='active' AND t.status='active' AND c.status='active' ORDER BY m.team_id", [userId]);
      const blocks = await tx.query('SELECT 1 FROM mpd_identity.user_resource_blocks WHERE user_id=$1 AND resource=$2', [userId, auth.resource]);
      const denials = await tx.query('SELECT expires_at FROM mpd_identity.token_denials WHERE fingerprint=$1 AND (resource IS NULL OR resource=$2)', [auth.tokenFingerprint, auth.resource]);
      // Read the clock after all awaited row locks and policy reads.
      const now = input.clock();
      if (!Number.isFinite(now) || !Number.isFinite(auth.principal.expiresAt) || auth.principal.expiresAt <= now) throw new PolicyError('TOKEN_EXPIRED');
      const cutoff = Math.max(store.tokenIatAfter, Number(authority.token_iat_after));
      if (!Number.isSafeInteger(cutoff) || cutoff < 0 || !Number.isFinite(auth.principal.issuedAt) || auth.principal.issuedAt <= cutoff * 1000) throw new PolicyError('TOKEN_ISSUED_BEFORE_CUTOFF');
      if (blocks.rowCount) throw new PolicyError('RESOURCE_BLOCKED');
      if (denials.rows.some(row => Number(row.expires_at) > now)) throw new PolicyError('TOKEN_REVOKED');
      if (!memberships.rowCount) throw new PolicyError('NOT_ENROLLED');
      return Object.freeze({
        userId, resource: auth.resource,
        courseIds: Object.freeze([...new Set<string>(memberships.rows.map(row => row.course_id))].sort()),
        teamIds: Object.freeze(memberships.rows.map(row => row.team_id)), desktop_access: false,
      });
    });
  } catch (error) { throw policyError(error); }
}
