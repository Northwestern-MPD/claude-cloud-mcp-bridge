import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import pg from 'pg';
import { createTestDatabase } from '../support/storage.js';
import { signingFixture } from '../support/auth.js';
import { verifyAccessToken } from '../../packages/auth/verifier.js';
import type { VerifiedPrincipal, VerifiedRequestAuth } from '../../packages/auth/types.js';
import { migrateAuthorizationStore } from '../../packages/storage/migrations.js';
import { openAuthorizationStore } from '../../packages/storage/database.js';

const enrollment = await import('../../packages/storage/enrollment.js').catch(() => null);
const identity = await import('../../packages/authorization/identity.js').catch(() => null);
const enrollInvitation: typeof import('../../packages/storage/enrollment.js').enrollInvitation = enrollment?.enrollInvitation ?? (async () => { throw new Error('ENROLLMENT_IMPLEMENTATION_MISSING'); });
const activateEnrollment: typeof import('../../packages/storage/enrollment.js').activateEnrollment = enrollment?.activateEnrollment ?? (async () => { throw new Error('ENROLLMENT_IMPLEMENTATION_MISSING'); });
const authorizeIdentity: typeof import('../../packages/authorization/identity.js').authorizeIdentity = identity?.authorizeIdentity ?? (async () => { throw new Error('IDENTITY_IMPLEMENTATION_MISSING'); });

const NOW = 1_800_000_000_000;
const WEEK = 604_800_000;

async function fixture(t: TestContext, cutoff = 0) {
  const db = await createTestDatabase();
  let closeStore = async () => {};
  t.after(async () => { await closeStore(); await db.close(); });
  await db.provisionRoles();
  const storeId = randomUUID();
  await migrateAuthorizationStore({ migrationUrl: db.migrationUrl, transportMode: 'local-test', initialize: true,
    maintenance: true, expectedStoreId: storeId, deploymentEpoch: 'enrollment-test' });
  let nowMs = NOW;
  const clock = () => nowMs;
  const store = await openAuthorizationStore({ connectionString: db.appUrl, transportMode: 'local-test',
    expectedStoreId: storeId, maintenance: false, deploymentEpoch: 'enrollment-test', tokenIatAfter: cutoff, now: clock });
  closeStore = () => store.close();
  await store.setMaintenance(false);
  const courseId = randomUUID(), teamId = randomUUID();
  await db.admin.query("INSERT INTO mpd_identity.courses(id,name,status) VALUES ($1,'Test course','active')", [courseId]);
  await db.admin.query("INSERT INTO mpd_identity.teams(id,course_id,name,status) VALUES ($1,$2,'Test team','active')", [teamId, courseId]);
  const signing = await signingFixture(NOW);
  async function request(overrides: Record<string, unknown> = {}, resource = signing.config.resource): Promise<VerifiedRequestAuth> {
    const token = await signing.mint({ ...overrides, aud: resource });
    const principal = await verifyAccessToken(token, { ...signing.config, resource }, signing);
    return Object.freeze({ principal, resource, tokenFingerprint: createHash('sha256').update(token).digest('hex') });
  }
  const auth = await request();
  const input = { id: randomUUID(), email: 'Student+section@Example.EDU', issuer: auth.principal.issuer,
    subject: auth.principal.subject, courseId, teamId, role: 'student' as const, expiresAt: NOW + WEEK };
  return { db, store, clock, advance: (ms: number) => { nowMs += ms; }, auth, request, input, courseId, teamId };
}

test('exact invited subject activates once and returns only immutable current identity metadata', async t => {
  const f = await fixture(t);
  await enrollInvitation(f.store, f.input, f.clock);
  const view = await authorizeIdentity(f.store, f.auth, { clock: f.clock });
  const row = (await f.db.admin.query('SELECT id,status FROM mpd_identity.users')).rows[0];
  assert.deepEqual(view, { userId: row.id, resource: 'https://bridge.example/mcp', courseIds: [f.courseId], teamIds: [f.teamId], desktop_access: false });
  assert.equal(row.status, 'active');
  assert.ok(Object.isFrozen(view)); assert.ok(Object.isFrozen(view.courseIds)); assert.ok(Object.isFrozen(view.teamIds));
  assert.equal(await activateEnrollment(f.store, f.auth.principal, f.clock), row.id);
  await authorizeIdentity(f.store, f.auth, { clock: f.clock });
  assert.equal((await f.db.admin.query("SELECT count(*) FROM mpd_identity.memberships WHERE status='active'")).rows[0].count, '1');
  assert.equal((await f.db.admin.query('SELECT status FROM mpd_identity.invitations')).rows[0].status, 'accepted');
});

test('invitation import retries reconcile exact identity without duplicate users or memberships', async t => {
  const f = await fixture(t);
  await enrollInvitation(f.store, f.input, f.clock);
  await enrollInvitation(f.store, f.input, f.clock);
  await activateEnrollment(f.store, f.auth.principal, f.clock);
  await enrollInvitation(f.store, f.input, f.clock);
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.users')).rows[0].count, '1');
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.identities')).rows[0].count, '1');
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.invitations')).rows[0].count, '1');
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.memberships')).rows[0].count, '1');
  await assert.rejects(enrollInvitation(f.store, { ...f.input, subject: 'auth0|another' }, f.clock), /INVITATION_CONFLICT/);
});

test('invitation normalization preserves distinct local parts, plus tags and dots', async t => {
  const f = await fixture(t);
  const addresses = ['  Student+section@Example.EDU  ', 'Student@section.example', 'student+section@example.edu', 'Stu.dent+section@example.edu'];
  for (const [i, email] of addresses.entries()) {
    await enrollInvitation(f.store, { ...f.input, id: randomUUID(), subject: `auth0|student-${i}`, email }, f.clock);
  }
  const rows = await f.db.admin.query('SELECT email FROM mpd_identity.invitations ORDER BY email');
  assert.deepEqual(rows.rows.map(row => row.email).sort(), ['Stu.dent+section@example.edu', 'Student+section@example.edu', 'Student@section.example', 'student+section@example.edu']);
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.users')).rows[0].count, '4');
});

for (const [name, expiry] of [['already expired', NOW - 1], ['equality with clock', NOW], ['beyond seven days', NOW + WEEK + 1]] as const) {
  test(`rejects invitation ${name} without creating local identity records`, async t => {
    const f = await fixture(t);
    await assert.rejects(enrollInvitation(f.store, { ...f.input, expiresAt: expiry }, f.clock), /INVALID_INVITATION/);
    assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.users')).rows[0].count, '0');
  });
}

test('invitation subject binding denies another signed subject despite identical display email', async t => {
  const f = await fixture(t);
  await enrollInvitation(f.store, f.input, f.clock);
  const authB = await f.request({ sub: 'auth0|student-b', email: f.input.email });
  await assert.rejects(authorizeIdentity(f.store, authB, { clock: f.clock }), /NOT_ENROLLED/);
  const count = await f.db.admin.query("SELECT count(*) FROM mpd_identity.memberships m JOIN mpd_identity.identities i ON i.user_id=m.user_id WHERE i.issuer=$1 AND i.subject=$2 AND m.status='active'", [authB.principal.issuer, authB.principal.subject]);
  assert.equal(count.rows[0].count, '0');
  const foreignIssuer = { ...f.auth.principal, issuer: 'https://other.example/' };
  await assert.rejects(activateEnrollment(f.store, foreignIssuer, f.clock), /NOT_ENROLLED/);
});

test('activation denies unverified evidence even for an invited subject', async t => {
  const f = await fixture(t);
  await enrollInvitation(f.store, f.input, f.clock);
  const unverified = { ...f.auth.principal, emailVerified: false } as unknown as VerifiedPrincipal;
  await assert.rejects(activateEnrollment(f.store, unverified, f.clock), /EMAIL_NOT_VERIFIED/);
  assert.equal((await f.db.admin.query('SELECT status FROM mpd_identity.invitations')).rows[0].status, 'pending');
});

for (const state of ['expired', 'revoked', 'disabled', 'suspended'] as const) {
  test(`denies ${state} enrollment`, async t => {
    const f = await fixture(t);
    await enrollInvitation(f.store, f.input, f.clock);
    if (state === 'expired') await f.db.admin.query('UPDATE mpd_identity.invitations SET expires_at=$1', [NOW]);
    if (state === 'revoked') await f.db.admin.query("UPDATE mpd_identity.invitations SET status='revoked'");
    if (state === 'disabled' || state === 'suspended') await f.db.admin.query('UPDATE mpd_identity.users SET status=$1', [state]);
    await assert.rejects(authorizeIdentity(f.store, f.auth, { clock: f.clock }), /NOT_ENROLLED|INVITATION_EXPIRED|USER_DISABLED/);
    assert.equal((await f.db.admin.query("SELECT count(*) FROM mpd_identity.memberships WHERE status='active'")).rows[0].count, '0');
  });
}

test('accepted invitation never recreates a removed membership on repeat login', async t => {
  const f = await fixture(t);
  await enrollInvitation(f.store, f.input, f.clock);
  await authorizeIdentity(f.store, f.auth, { clock: f.clock });
  await f.db.admin.query("UPDATE mpd_identity.memberships SET status='removed',version=version+1");
  await assert.rejects(authorizeIdentity(f.store, f.auth, { clock: f.clock }), /NOT_ENROLLED/);
  assert.equal((await f.db.admin.query("SELECT count(*) FROM mpd_identity.memberships WHERE status='active'")).rows[0].count, '0');
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.memberships')).rows[0].count, '1');
});

test('membership role comes from explicit invitation and changes are read on every request', async t => {
  const f = await fixture(t);
  await enrollInvitation(f.store, { ...f.input, role: 'instructor' }, f.clock);
  await authorizeIdentity(f.store, f.auth, { clock: f.clock });
  assert.equal((await f.db.admin.query('SELECT role FROM mpd_identity.memberships')).rows[0].role, 'instructor');
  await f.db.admin.query("UPDATE mpd_identity.users SET status='disabled'");
  await assert.rejects(authorizeIdentity(f.store, f.auth, { clock: f.clock }), /USER_DISABLED/);
});

test('disabled courses and teams cannot grant current roster access', async t => {
  const f = await fixture(t);
  await enrollInvitation(f.store, f.input, f.clock);
  await authorizeIdentity(f.store, f.auth, { clock: f.clock });
  await f.db.admin.query("UPDATE mpd_identity.teams SET status='disabled'");
  await assert.rejects(authorizeIdentity(f.store, f.auth, { clock: f.clock }), /NOT_ENROLLED/);
  await f.db.admin.query("UPDATE mpd_identity.teams SET status='active'");
  await f.db.admin.query("UPDATE mpd_identity.courses SET status='disabled'");
  await assert.rejects(authorizeIdentity(f.store, f.auth, { clock: f.clock }), /NOT_ENROLLED/);
});

test('membership failure rolls back consumed invitation and user activation before a safe retry', async t => {
  const f = await fixture(t);
  await enrollInvitation(f.store, f.input, f.clock);
  await f.db.admin.query("CREATE FUNCTION mpd_identity.reject_test_membership() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-sql-canary'; END $$");
  await f.db.admin.query('CREATE TRIGGER reject_test_membership BEFORE INSERT ON mpd_identity.memberships FOR EACH ROW EXECUTE FUNCTION mpd_identity.reject_test_membership()');
  await assert.rejects(activateEnrollment(f.store, f.auth.principal, f.clock), /^PolicyError: STORE_UNAVAILABLE$/);
  assert.equal((await f.db.admin.query('SELECT status FROM mpd_identity.invitations')).rows[0].status, 'pending');
  assert.equal((await f.db.admin.query('SELECT status FROM mpd_identity.users')).rows[0].status, 'pending');
  await f.db.admin.query('DROP TRIGGER reject_test_membership ON mpd_identity.memberships');
  await activateEnrollment(f.store, f.auth.principal, f.clock);
  assert.equal((await f.db.admin.query("SELECT count(*) FROM mpd_identity.memberships WHERE status='active'")).rows[0].count, '1');
});

for (const [name, iat, allowed] of [['before', 1_799_999_999, false], ['equal', 1_800_000_000, false], ['after', 1_800_000_001, true]] as const) {
  test(`token issuance ${name} recovery cutoff uses strict seconds-to-milliseconds comparison`, async t => {
    const f = await fixture(t, 1_800_000_000);
    await enrollInvitation(f.store, f.input, f.clock);
    const auth = await f.request({ iat });
    if (allowed) assert.equal((await authorizeIdentity(f.store, auth, { clock: f.clock })).desktop_access, false);
    else await assert.rejects(authorizeIdentity(f.store, auth, { clock: f.clock }), /TOKEN_ISSUED_BEFORE_CUTOFF/);
  });
}

test('token expiry has no JWT clock-tolerance grace at local policy admission', async t => {
  const f = await fixture(t);
  await enrollInvitation(f.store, f.input, f.clock);
  const expired = await f.request({ exp: 1_800_000_000 });
  await assert.rejects(authorizeIdentity(f.store, expired, { clock: f.clock }), /TOKEN_EXPIRED/);
});

test('local token denials deny the next request while another fresh token can authenticate', async t => {
  const f = await fixture(t);
  await enrollInvitation(f.store, f.input, f.clock);
  const view = await authorizeIdentity(f.store, f.auth, { clock: f.clock });
  await f.db.admin.query("INSERT INTO mpd_identity.token_denials(fingerprint,user_id,resource,expires_at,reason,created_at) VALUES ($1,$2,$3,$4,'test',$5)", [f.auth.tokenFingerprint, view.userId, f.auth.resource, NOW + 660_000, NOW]);
  await assert.rejects(authorizeIdentity(f.store, f.auth, { clock: f.clock }), /TOKEN_REVOKED/);
  const fresh = await f.request({ iat: 1_800_000_001 });
  assert.equal((await authorizeIdentity(f.store, fresh, { clock: f.clock })).userId, view.userId);
});

test('resource block persists across fresh tokens and does not apply to a different resource', async t => {
  const f = await fixture(t);
  await enrollInvitation(f.store, f.input, f.clock);
  const view = await authorizeIdentity(f.store, f.auth, { clock: f.clock });
  await f.db.admin.query("INSERT INTO mpd_identity.user_resource_blocks(user_id,resource,reason,created_at) VALUES ($1,$2,'test',$3)", [view.userId, f.auth.resource, NOW]);
  const fresh = await f.request({ iat: 1_800_000_001 });
  await assert.rejects(authorizeIdentity(f.store, fresh, { clock: f.clock }), /RESOURCE_BLOCKED/);
  const otherResource = await f.request({ iat: 1_800_000_001 }, 'https://assignments.example/mcp');
  assert.equal((await authorizeIdentity(f.store, otherResource, { clock: f.clock })).userId, view.userId);
});

test('policy checks time again after waiting on a real user row lock', async t => {
  const f = await fixture(t);
  await enrollInvitation(f.store, f.input, f.clock);
  await authorizeIdentity(f.store, f.auth, { clock: f.clock });
  const locker = new pg.Client({ connectionString: f.db.adminUrl });
  await locker.connect();
  try {
  await locker.query('BEGIN');
  await locker.query('SELECT id FROM mpd_identity.users FOR UPDATE');
  const result = authorizeIdentity(f.store, f.auth, { clock: f.clock });
  const denied = assert.rejects(result, /TOKEN_EXPIRED/);
  for (let i = 0; i < 100; i++) {
    const waiting = await f.db.admin.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
    if (Number(waiting.rows[0].count) > 0) break;
    if (i === 99) assert.fail('Authorization never waited on user lock');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  f.advance(600_001);
  await locker.query('COMMIT');
  await denied;
  } finally { await locker.end(); }
});

test('maintenance and closed stores cannot admit a previously authorized principal', async t => {
  const f = await fixture(t);
  await enrollInvitation(f.store, f.input, f.clock);
  await authorizeIdentity(f.store, f.auth, { clock: f.clock });
  await f.store.setMaintenance(true);
  await assert.rejects(authorizeIdentity(f.store, f.auth, { clock: f.clock }), /STORE_UNAVAILABLE|MAINTENANCE/);
  await f.store.close();
  await assert.rejects(authorizeIdentity(f.store, f.auth, { clock: f.clock }), /STORE_UNAVAILABLE/);
});

test('blocked first login rolls back invitation consumption and user activation', async t => {
  const f = await fixture(t);
  await enrollInvitation(f.store, f.input, f.clock);
  const userId = (await f.db.admin.query('SELECT id FROM mpd_identity.users')).rows[0].id;
  await f.db.admin.query("INSERT INTO mpd_identity.user_resource_blocks(user_id,resource,reason,created_at) VALUES ($1,$2,'test',$3)", [userId, f.auth.resource, NOW]);
  await assert.rejects(authorizeIdentity(f.store, f.auth, { clock: f.clock }), /RESOURCE_BLOCKED/);
  assert.equal((await f.db.admin.query('SELECT status FROM mpd_identity.invitations')).rows[0].status, 'pending');
  assert.equal((await f.db.admin.query('SELECT status FROM mpd_identity.users')).rows[0].status, 'pending');
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.memberships')).rows[0].count, '0');
});

test('concurrent first requests activate one membership and repeat requests reflect multiple current teams', async t => {
  const f = await fixture(t);
  await enrollInvitation(f.store, f.input, f.clock);
  const [first, second] = await Promise.all([
    authorizeIdentity(f.store, f.auth, { clock: f.clock }),
    authorizeIdentity(f.store, f.auth, { clock: f.clock }),
  ]);
  assert.equal(first.userId, second.userId);
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.memberships')).rows[0].count, '1');
  const secondTeamId = randomUUID();
  await f.db.admin.query("INSERT INTO mpd_identity.teams(id,course_id,name,status) VALUES ($1,$2,'Another team','active')", [secondTeamId, f.courseId]);
  await enrollInvitation(f.store, { ...f.input, id: randomUUID(), teamId: secondTeamId }, f.clock);
  const view = await authorizeIdentity(f.store, f.auth, { clock: f.clock });
  assert.deepEqual(view.courseIds, [f.courseId]);
  assert.deepEqual(view.teamIds, [f.teamId, secondTeamId].sort());
  await f.db.admin.query("UPDATE mpd_identity.memberships SET status='suspended' WHERE team_id=$1", [f.teamId]);
  assert.deepEqual((await authorizeIdentity(f.store, f.auth, { clock: f.clock })).teamIds, [secondTeamId]);
});
