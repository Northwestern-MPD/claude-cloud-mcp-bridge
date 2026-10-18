import { randomUUID } from 'node:crypto';
import type { VerifiedPrincipal, VerifiedRequestAuth } from '../auth/types.js';
import { PolicyError, policyError } from '../authorization/errors.js';
import type { Store } from './types.js';

export type ContextRef = Readonly<{ id: string; userId: string; resource: string; clientId: string; bootId: string; deploymentEpoch: string }>;
const CONTEXT_LIFETIME_MS = 3_600_000;

/** A transport context is a routing record; it conveys no verified independent work binding. */
export async function recordTransportContext(store: Store, principal: VerifiedPrincipal, resource: string, clock: () => number): Promise<ContextRef> {
  try {
    return await store.transaction(async tx => {
      const user = await tx.query("SELECT u.id FROM mpd_identity.users u JOIN mpd_identity.identities i ON i.user_id=u.id WHERE i.issuer=$1 AND i.subject=$2 AND u.status='active' FOR UPDATE OF u", [principal.issuer, principal.subject]);
      if (!user.rows[0]) throw new PolicyError('NOT_ENROLLED');
      const state = (await tx.query('SELECT maintenance,boot_id,deployment_epoch,token_iat_after FROM mpd_identity.service_state WHERE singleton=true')).rows[0];
      if (!state || state.maintenance || state.boot_id !== store.bootId || state.deployment_epoch !== store.deploymentEpoch) throw new PolicyError('STORE_UNAVAILABLE');
      const now = clock();
      if (!Number.isFinite(now) || principal.expiresAt <= now) throw new PolicyError('TOKEN_EXPIRED');
      if (principal.issuedAt <= Math.max(store.tokenIatAfter, Number(state.token_iat_after)) * 1000) throw new PolicyError('TOKEN_ISSUED_BEFORE_CUTOFF');
      const context = Object.freeze({ id: randomUUID(), userId: String(user.rows[0].id), resource, clientId: principal.clientId, bootId: store.bootId, deploymentEpoch: store.deploymentEpoch });
      await tx.query("INSERT INTO mpd_identity.work_contexts(id,user_id,resource,client_id,boot_id,deployment_epoch,state,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,'active',$7,$8)", [context.id, context.userId, resource, principal.clientId, store.bootId, store.deploymentEpoch, now + CONTEXT_LIFETIME_MS, now]);
      return context;
    });
  } catch (error) { throw policyError(error); }
}

export async function assertTransportContext(store: Store, context: ContextRef, auth: VerifiedRequestAuth, clock: () => number): Promise<void> {
  try {
    await store.transaction(async tx => {
      const row = (await tx.query('SELECT c.*,i.issuer,i.subject FROM mpd_identity.work_contexts c JOIN mpd_identity.identities i ON i.user_id=c.user_id WHERE c.id=$1 AND i.issuer=$2 AND i.subject=$3', [context.id, auth.principal.issuer, auth.principal.subject])).rows[0];
      if (!row || row.state !== 'active' || row.boot_id !== store.bootId || row.deployment_epoch !== store.deploymentEpoch || row.user_id !== context.userId || row.client_id !== auth.principal.clientId || row.resource !== auth.resource || Number(row.expires_at) <= clock()) throw new PolicyError('CONTEXT_DENIED');
    });
  } catch (error) { throw policyError(error); }
}

export async function revokeTransportContext(store: Store, id: string, clock: () => number): Promise<void> {
  await store.transaction(async tx => { await tx.query("UPDATE mpd_identity.work_contexts SET state='revoked',revoked_at=$2 WHERE id=$1 AND state='active'", [id, clock()]); });
}
