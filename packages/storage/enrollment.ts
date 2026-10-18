import { randomUUID } from 'node:crypto';
import type { VerifiedPrincipal } from '../auth/types.js';
import { PolicyError, policyError } from '../authorization/errors.js';
import type { Store, Transaction } from './types.js';

export type InvitationInput = Readonly<{
  id: string; email: string; issuer: string; subject: string;
  courseId: string; teamId: string; role: 'student' | 'instructor'; expiresAt: number;
}>;
const INVITATION_LIFETIME_MS = 604_800_000;

function normalizedEmail(email: string): string {
  const value = email.trim();
  const parts = value.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1] || /\s/.test(value)) throw new PolicyError('INVALID_INVITATION');
  return `${parts[0]}@${parts[1].toLowerCase()}`;
}

export async function enrollInvitation(store: Store, input: InvitationInput, clock: () => number): Promise<void> {
  try {
    const email = normalizedEmail(input.email);
    if (!input.issuer.trim() || !input.subject.trim() || !['student', 'instructor'].includes(input.role)) throw new PolicyError('INVALID_INVITATION');
    await store.transaction(async tx => {
      // Serialize first-time provisioning before a user row exists; subsequent work locks that user.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([input.issuer, input.subject])]);
      const previous = await tx.query('SELECT * FROM mpd_identity.invitations WHERE id=$1 FOR UPDATE', [input.id]);
      const existing = previous.rows[0];
      if (existing) {
        if (existing.email !== email || existing.issuer !== input.issuer || existing.subject !== input.subject ||
          existing.course_id !== input.courseId || existing.team_id !== input.teamId || existing.role !== input.role || Number(existing.expires_at) !== input.expiresAt) {
          throw new PolicyError('INVITATION_CONFLICT');
        }
        return;
      }
      const userResult = await tx.query('SELECT u.id,u.status FROM mpd_identity.users u JOIN mpd_identity.identities i ON i.user_id=u.id WHERE i.issuer=$1 AND i.subject=$2 FOR UPDATE OF u', [input.issuer, input.subject]);
      const user = userResult.rows[0];
      if (user && !['pending', 'active'].includes(user.status)) throw new PolicyError('USER_DISABLED');
      const target = await tx.query("SELECT t.id FROM mpd_identity.teams t JOIN mpd_identity.courses c ON c.id=t.course_id WHERE t.id=$1 AND c.id=$2 AND t.status='active' AND c.status='active'", [input.teamId, input.courseId]);
      const now = clock();
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + INVITATION_LIFETIME_MS || target.rowCount !== 1) throw new PolicyError('INVALID_INVITATION');
      const userId = user?.id ?? randomUUID();
      if (!user) {
        await tx.query("INSERT INTO mpd_identity.users(id,status,created_at,updated_at) VALUES ($1,'pending',$2,$2)", [userId, now]);
        await tx.query("INSERT INTO mpd_identity.identities(id,user_id,issuer,subject,connection,provider) VALUES ($1,$2,$3,$4,'email','auth0')", [randomUUID(), userId, input.issuer, input.subject]);
      }
      await tx.query("INSERT INTO mpd_identity.invitations(id,email,issuer,subject,course_id,team_id,user_id,role,status,expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10)", [input.id, email, input.issuer, input.subject, input.courseId, input.teamId, userId, input.role, input.expiresAt, now]);
      await tx.query("INSERT INTO mpd_identity.audit_events(id,occurred_at,actor_id,action,outcome) VALUES ($1,$2,$3,'invitation_created','allowed')", [randomUUID(), now, userId]);
    });
  } catch (error) { throw policyError(error); }
}

/** Caller owns the transaction. Lock order is user, memberships, then invitations. */
export async function activateEnrollmentInTransaction(tx: Transaction, principal: VerifiedPrincipal, clock: () => number): Promise<string> {
  if (principal.emailVerified !== true) throw new PolicyError('EMAIL_NOT_VERIFIED');
  const userResult = await tx.query('SELECT u.id,u.status FROM mpd_identity.users u JOIN mpd_identity.identities i ON i.user_id=u.id WHERE i.issuer=$1 AND i.subject=$2 FOR UPDATE OF u', [principal.issuer, principal.subject]);
  const user = userResult.rows[0];
  if (!user) throw new PolicyError('NOT_ENROLLED');
  if (!['pending', 'active'].includes(user.status)) throw new PolicyError('USER_DISABLED');
  const memberships = await tx.query('SELECT id,team_id,status FROM mpd_identity.memberships WHERE user_id=$1 ORDER BY id FOR UPDATE', [user.id]);
  const invitations = await tx.query("SELECT i.* FROM mpd_identity.invitations i JOIN mpd_identity.teams t ON t.id=i.team_id AND t.course_id=i.course_id JOIN mpd_identity.courses c ON c.id=i.course_id WHERE i.issuer=$1 AND i.subject=$2 AND i.user_id=$3 AND i.status='pending' AND t.status='active' AND c.status='active' ORDER BY i.id FOR UPDATE OF i", [principal.issuer, principal.subject, user.id]);
  const now = clock();
  if (!Number.isFinite(now) || !Number.isFinite(principal.expiresAt) || principal.expiresAt <= now) throw new PolicyError('TOKEN_EXPIRED');
  let accepted = false;
  let expired = false;
  for (const invitation of invitations.rows) {
    if (Number(invitation.expires_at) <= now) { expired = true; continue; }
    const membership = memberships.rows.find(row => row.team_id === invitation.team_id);
    // Suspended or removed authority requires explicit operator reconciliation.
    if (membership && membership.status !== 'active' && membership.status !== 'pending') continue;
    await tx.query("UPDATE mpd_identity.invitations SET status='accepted',accepted_at=$2 WHERE id=$1", [invitation.id, now]);
    if (!membership) {
      await tx.query("INSERT INTO mpd_identity.memberships(id,user_id,team_id,status,role,created_at,updated_at) VALUES ($1,$2,$3,'active',$4,$5,$5)", [randomUUID(), user.id, invitation.team_id, invitation.role, now]);
      memberships.rows.push({ team_id: invitation.team_id, status: 'active' });
    } else if (membership.status === 'pending') {
      await tx.query("UPDATE mpd_identity.memberships SET status='active',role=$2,version=version+1,updated_at=$3 WHERE id=$1", [membership.id, invitation.role, now]);
      membership.status = 'active';
    }
    await tx.query("INSERT INTO mpd_identity.audit_events(id,occurred_at,actor_id,action,outcome) VALUES ($1,$2,$3,'invitation_accepted','allowed')", [randomUUID(), now, user.id]);
    accepted = true;
  }
  if (user.status === 'pending' && !accepted) throw new PolicyError(expired ? 'INVITATION_EXPIRED' : 'NOT_ENROLLED');
  if (user.status === 'pending') await tx.query("UPDATE mpd_identity.users SET status='active',authorization_version=authorization_version+1,updated_at=$2 WHERE id=$1", [user.id, now]);
  return user.id;
}

export async function activateEnrollment(store: Store, principal: VerifiedPrincipal, clock: () => number): Promise<string> {
  try {
    if (!await store.ready()) throw new PolicyError('STORE_UNAVAILABLE');
    return await store.transaction(tx => activateEnrollmentInTransaction(tx, principal, clock));
  } catch (error) { throw policyError(error); }
}
