import { randomUUID } from 'node:crypto';
import { PolicyError, policyError } from '../authorization/errors.js';
import type { Store } from './types.js';

export type RetentionReport = Readonly<{ auditEvents: number; tokenDenials: number; rosterEmails: number }>;
const RETENTION_MS = 30 * 86_400_000;
const BATCH_SIZE = 500;
function nowFrom(clock: () => number): number { const now = clock(); if (!Number.isSafeInteger(now) || now < 0) throw new PolicyError('INVALID_CLOCK'); return now; }

/** Bounded metadata-only retention; enforcement identities and foreign-key records remain. */
export async function runRetention(store: Store, clock: () => number): Promise<RetentionReport> {
  try {
    return await store.transaction(async tx => {
      const state = (await tx.query('SELECT boot_id,deployment_epoch FROM mpd_identity.service_state WHERE singleton=true')).rows[0];
      if (!state || state.boot_id !== store.bootId || state.deployment_epoch !== store.deploymentEpoch) throw new PolicyError('STORE_UNAVAILABLE');
      const now = nowFrom(clock);
      const audit = await tx.query(`WITH expired AS (SELECT id FROM mpd_identity.audit_events WHERE occurred_at<$1 ORDER BY occurred_at,id LIMIT $2 FOR UPDATE SKIP LOCKED) DELETE FROM mpd_identity.audit_events a USING expired e WHERE a.id=e.id`, [now - RETENTION_MS, BATCH_SIZE]);
      const tokens = await tx.query(`WITH expired AS (SELECT fingerprint FROM mpd_identity.token_denials WHERE expires_at<$1 ORDER BY expires_at,fingerprint LIMIT $2 FOR UPDATE SKIP LOCKED) DELETE FROM mpd_identity.token_denials t USING expired e WHERE t.fingerprint=e.fingerprint`, [now - 60_000, BATCH_SIZE]);
      const pii = await tx.query(`WITH expired AS (SELECT i.id FROM mpd_identity.invitations i JOIN mpd_identity.courses c ON c.id=i.course_id WHERE c.status='disabled' AND c.closed_at<$1 AND i.email<>'' ORDER BY c.closed_at,i.id LIMIT $2 FOR UPDATE OF i SKIP LOCKED) UPDATE mpd_identity.invitations i SET email='' FROM expired e WHERE i.id=e.id`, [now - RETENTION_MS, BATCH_SIZE]);
      return Object.freeze({ auditEvents: audit.rowCount ?? 0, tokenDenials: tokens.rowCount ?? 0, rosterEmails: pii.rowCount ?? 0 });
    });
  } catch (error) { throw policyError(error); }
}

/** The private admin handler holds its shared admission fence across commit and invalidation. */
export async function closeCourse(store: Store, courseId: string, clock: () => number): Promise<{ affected: number; teamIds: readonly string[] }> {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(courseId)) throw new PolicyError('INVALID_COURSE');
    return await store.transaction(async tx => {
      // Acquire users before their memberships/grants, matching admission lock order.
      await tx.query('SELECT u.id FROM mpd_identity.users u WHERE EXISTS(SELECT 1 FROM mpd_identity.memberships m JOIN mpd_identity.teams t ON t.id=m.team_id WHERE m.user_id=u.id AND t.course_id=$1) ORDER BY u.id FOR UPDATE', [courseId]);
      const course = (await tx.query('SELECT id,closed_at FROM mpd_identity.courses WHERE id=$1 FOR UPDATE', [courseId])).rows[0];
      if (!course) throw new PolicyError('COURSE_NOT_FOUND');
      const teams = await tx.query('SELECT id FROM mpd_identity.teams WHERE course_id=$1 ORDER BY id FOR UPDATE', [courseId]);
      const now = nowFrom(clock);
      await tx.query("UPDATE mpd_identity.courses SET status='disabled',closed_at=COALESCE(closed_at,$2) WHERE id=$1", [courseId, now]);
      await tx.query("UPDATE mpd_identity.teams SET status='disabled' WHERE course_id=$1", [courseId]);
      await tx.query("UPDATE mpd_identity.memberships SET status='removed',version=version+1,updated_at=$2 WHERE team_id IN(SELECT id FROM mpd_identity.teams WHERE course_id=$1) AND status<>'removed'", [courseId, now]);
      await tx.query("UPDATE mpd_identity.invitations SET status='revoked' WHERE course_id=$1 AND status='pending'", [courseId]);
      await tx.query("UPDATE mpd_identity.pairings SET state='revoked',revoked_at=$2 WHERE team_id IN(SELECT id FROM mpd_identity.teams WHERE course_id=$1) AND state='pending'", [courseId, now]);
      await tx.query("UPDATE mpd_identity.operation_attempts SET state=CASE WHEN classification='write' THEN 'uncertain' ELSE 'denied' END,reason='course_closed',completed_at=$2 WHERE lease_id IN(SELECT l.id FROM mpd_identity.leases l JOIN mpd_identity.teams t ON t.id=l.team_id WHERE t.course_id=$1) AND state IN('admitted','dispatched')", [courseId, now]);
      await tx.query("UPDATE mpd_identity.leases SET state='revoked',reason='course_closed',terminated_at=$2 WHERE team_id IN(SELECT id FROM mpd_identity.teams WHERE course_id=$1) AND state='active'", [courseId, now]);
      await tx.query("INSERT INTO mpd_identity.audit_events(id,occurred_at,action,outcome,reason) VALUES($1,$2,'course_closed','allowed','operator')", [randomUUID(), now]);
      return { affected: course.closed_at === null ? 1 : 0, teamIds: Object.freeze(teams.rows.map(row => String(row.id))) };
    });
  } catch (error) { throw policyError(error); }
}
