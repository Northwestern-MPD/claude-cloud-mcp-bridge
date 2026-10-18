import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { policyFixture, POLICY_NOW } from '../support/policy.js';
import { signingFixture } from '../support/auth.js';
import { executeAdmin } from '../../apps/operator/commands.js';
import { createIdentityRuntime } from '../../packages/authorization/runtime.js';
import { authorizeIdentity } from '../../packages/authorization/identity.js';
import { enrollInvitation } from '../../packages/storage/enrollment.js';
import { verifyAccessToken } from '../../packages/auth/verifier.js';

async function verifiedRequest(subject: string) {
  const f = await signingFixture(POLICY_NOW);
  const token = await f.mint({ sub: subject });
  return Object.freeze({ principal: await verifyAccessToken(token, f.config, f), resource: f.config.resource,
    tokenFingerprint: createHash('sha256').update(token).digest('hex') });
}

test('acknowledged removal revokes an invitation before the first verified login creates a membership', async t => {
  const f = await policyFixture(t);
  const subject = 'auth0|invited-not-yet-logged-in', invitationId = randomUUID();
  await enrollInvitation(f.store, { id: invitationId, email: 'Pending@example.edu', issuer: f.auth.principal.issuer,
    subject, courseId: f.courseId, teamId: f.teamId, role: 'student', expiresAt: POLICY_NOW + 604_800_000 }, f.clock);
  const userId = (await f.db.admin.query('SELECT user_id FROM mpd_identity.identities WHERE issuer=$1 AND subject=$2', [f.auth.principal.issuer, subject])).rows[0].user_id;
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.memberships WHERE user_id=$1', [userId])).rows[0].count, '0');
  const runtime = createIdentityRuntime(f.store); t.after(() => runtime.close());
  assert.deepEqual(await executeAdmin({ kind: 'remove-membership', userId, teamId: f.teamId, reason: 'operator_removal' },
    { store: f.store, runtime, coordinator: runtime.coordinator, now: f.clock }), { ok: true, affected: 1 });
  const auth = await verifiedRequest(subject);
  await assert.rejects(authorizeIdentity(f.store, auth, { clock: f.clock }), /NOT_ENROLLED/);
  assert.equal((await f.db.admin.query('SELECT status FROM mpd_identity.invitations WHERE id=$1', [invitationId])).rows[0].status, 'revoked');
  assert.equal((await f.db.admin.query("SELECT count(*) FROM mpd_identity.memberships WHERE user_id=$1 AND status='active'", [userId])).rows[0].count, '0');
  assert.equal((await f.db.admin.query('SELECT status FROM mpd_identity.users WHERE id=$1', [userId])).rows[0].status, 'pending');
});

test('removing an additional pending team prevents activation and preserves an existing team and context', async t => {
  const f = await policyFixture(t);
  const removedTeamId = randomUUID(), invitationId = randomUUID();
  await f.db.admin.query("INSERT INTO mpd_identity.teams(id,course_id,name,status) VALUES ($1,$2,'Pending additional team','active')", [removedTeamId, f.courseId]);
  await enrollInvitation(f.store, { id: invitationId, email: 'Existing@example.edu', issuer: f.auth.principal.issuer,
    subject: f.auth.principal.subject, courseId: f.courseId, teamId: removedTeamId, role: 'student', expiresAt: POLICY_NOW + 604_800_000 }, f.clock);
  const runtime = createIdentityRuntime(f.store); t.after(() => runtime.close());
  let closed = false; runtime.registerContext(f.context, [f.teamId], () => { closed = true; });
  const command = { kind: 'remove-membership' as const, userId: f.userId, teamId: removedTeamId, reason: 'operator_removal' };
  const deps = { store: f.store, runtime, coordinator: runtime.coordinator, now: f.clock };
  assert.deepEqual(await executeAdmin(command, deps), { ok: true, affected: 1 });
  const auth = await verifiedRequest(f.auth.principal.subject);
  const view = await authorizeIdentity(f.store, auth, { clock: f.clock });
  assert.deepEqual(view.teamIds, [f.teamId]); assert.equal(view.userId, f.userId);
  assert.equal(closed, false); assert.equal(runtime.isActive(f.context.id), true);
  assert.equal((await f.db.admin.query('SELECT status FROM mpd_identity.invitations WHERE id=$1', [invitationId])).rows[0].status, 'revoked');
  assert.equal((await f.db.admin.query("SELECT count(*) FROM mpd_identity.memberships WHERE user_id=$1 AND team_id=$2 AND status='active'", [f.userId, removedTeamId])).rows[0].count, '0');
  await executeAdmin(command, deps);
  assert.deepEqual((await authorizeIdentity(f.store, auth, { clock: f.clock })).teamIds, [f.teamId]);
});
