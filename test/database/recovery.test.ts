import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, chmod, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import pg from 'pg';
import { createTestDatabase } from '../support/storage.js';
import { runPostgresTool } from '../support/postgres-tools.js';
import { signingFixture } from '../support/auth.js';
import { verifyAccessToken } from '../../packages/auth/index.js';
import type { VerifiedRequestAuth } from '../../packages/auth/types.js';
import { authorizeIdentity } from '../../packages/authorization/identity.js';
import { createIdentityRuntime } from '../../packages/authorization/runtime.js';
import { migrateAuthorizationStore } from '../../packages/storage/migrations.js';
import { openAuthorizationStore } from '../../packages/storage/database.js';
import { enrollInvitation } from '../../packages/storage/enrollment.js';
import { parseRecoveryManifest, reconcileRoster, validateRestoredStore, type RecoveryManifest } from '../../packages/storage/recovery.js';
import { closeCourse, runRetention } from '../../packages/storage/retention.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
async function fixture(t: TestContext) {
  const db = await createTestDatabase();
  const stores: { close(): Promise<void> }[] = [];
  const directories: string[] = [];
  t.after(async () => { for (const store of stores.reverse()) await store.close(); for (const directory of directories) await rm(directory, { recursive: true, force: true }); await db.close(); });
  await db.provisionRoles();
  const storeId = randomUUID();
  await migrateAuthorizationStore({ migrationUrl: db.migrationUrl, transportMode: 'local-test', initialize: true, maintenance: true, expectedStoreId: storeId, deploymentEpoch: 'before-restore' });
  let nowMs = NOW;
  const clock = () => nowMs;
  async function open(database = db, epoch = 'before-restore', cutoff = 0, maintenance = false) {
    const store = await openAuthorizationStore({ connectionString: database.appUrl, transportMode: 'local-test', expectedStoreId: storeId, maintenance, deploymentEpoch: epoch, tokenIatAfter: cutoff, now: clock });
    stores.push(store);
    return store;
  }
  const store = await open();
  await store.setMaintenance(false);
  const courseId = randomUUID(), teamId = randomUUID();
  await db.admin.query("INSERT INTO mpd_identity.courses(id,name,status) VALUES($1,'Recovery course','active')", [courseId]);
  await db.admin.query("INSERT INTO mpd_identity.teams(id,course_id,name,status) VALUES($1,$2,'Recovery team','active')", [teamId, courseId]);
  const signing = await signingFixture(NOW);
  async function auth(subject = 'auth0|student-1', iat = NOW / 1000): Promise<VerifiedRequestAuth> {
    const token = await signing.mint({ sub: subject, iat });
    const principal = await verifyAccessToken(token, signing.config, { ...signing, now: clock });
    return Object.freeze({ principal, resource: signing.config.resource, tokenFingerprint: createHash('sha256').update(token).digest('hex') });
  }
  async function enrolled(subject = 'auth0|student-1') {
    await enrollInvitation(store, { id: randomUUID(), email: `${subject.slice(6)}@example.edu`, issuer: signing.config.issuer, subject, courseId, teamId, role: 'student', expiresAt: NOW + DAY }, clock);
    return authorizeIdentity(store, await auth(subject), { clock });
  }
  async function dump() {
    const directory = await mkdtemp(join(tmpdir(), 'mpd-recovery-')); directories.push(directory); await chmod(directory, 0o700);
    const path = join(directory, 'authority.dump');
    await runPostgresTool('pg_dump', ['--format=custom', '--schema=mpd_identity', '--no-owner', '--no-privileges', `--file=${path}`], { connectionString: db.backupUrl });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    return path;
  }
  async function restore(path: string) {
    const target = await createTestDatabase(); t.after(() => target.close()); await target.provisionRoles();
    await runPostgresTool('pg_restore', ['--exit-on-error', '--no-owner', '--no-privileges', '--role=mpd_identity_owner', path], { connectionString: target.migrationUrl });
    await target.admin.query('GRANT USAGE ON SCHEMA mpd_identity TO mpd_identity_app,mpd_identity_backup; GRANT SELECT ON ALL TABLES IN SCHEMA mpd_identity TO mpd_identity_backup; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA mpd_identity TO mpd_identity_app; REVOKE INSERT,UPDATE,DELETE ON mpd_identity.schema_migrations FROM mpd_identity_app; REVOKE INSERT,UPDATE,DELETE ON mpd_identity.service_state FROM mpd_identity_app; GRANT UPDATE(deployment_epoch,token_iat_after,maintenance,boot_id,updated_at) ON mpd_identity.service_state TO mpd_identity_app');
    return target;
  }
  return { db, store, stores, storeId, courseId, teamId, clock, open, auth, enrolled, dump, restore, advance(ms: number) { nowMs += ms; } };
}
function manifest(f: Awaited<ReturnType<typeof fixture>>, epoch: string, cutoff: number, approvedMemberships: RecoveryManifest['approvedMemberships'] = []): RecoveryManifest {
  return { storeId: f.storeId, deploymentEpoch: epoch, tokenIatAfter: cutoff, reviewedAt: f.clock(), sourceRefs: ['operator-record:current-roster', 'operator-record:current-revocations'], revocationsVerified: true, approvedMemberships, disabledUserIds: [], removedMemberships: [], resourceBlocks: [] };
}
const connection = (db: Awaited<ReturnType<typeof createTestDatabase>>) => ({ connectionString: db.migrationUrl, transportMode: 'local-test' as const });

// Break caught: archive/restore is unvalidated or targets the active source instead of a separate database.
test('custom-format backup restores into an isolated target with validated constraints and runtime role privileges', async t => {
  const f = await fixture(t); await f.enrolled();
  const target = await f.restore(await f.dump());
  const report = await validateRestoredStore(connection(target), f.storeId);
  assert.equal(report.ok, true); assert.equal(report.schemaVersion, 2); assert.ok(report.constraints > 40);
  const app = new pg.Client({ connectionString: target.appUrl }); await app.connect();
  try { await assert.rejects(app.query('CREATE TABLE mpd_identity.forbidden(id integer)'), (error: unknown) => (error as { code?: string }).code === '42501'); } finally { await app.end(); }
  assert.notEqual(target.name, f.db.name);
});

// Break caught: migration rows alone pass even when constraints, indexes or identity invariants were changed.
test('restore validation rejects corrupt schema markers constraints indexes permissions and authorization invariants', async t => {
  const f = await fixture(t); await f.enrolled();
  const path = await f.dump();
  for (const [name, mutate] of [
    ['wrong-store', "UPDATE mpd_identity.service_state SET store_id='9f62b44b-3a11-4d3b-a711-f1a40412989a'"],
    ['checksum', "UPDATE mpd_identity.schema_migrations SET checksum='wrong' WHERE version=2"],
    ['missing-check', 'ALTER TABLE mpd_identity.users DROP CONSTRAINT users_status_check'],
    ['weakened-check', "ALTER TABLE mpd_identity.users DROP CONSTRAINT users_status_check; ALTER TABLE mpd_identity.users ADD CONSTRAINT users_status_check CHECK(length(status)>0)"],
    ['unvalidated-check', "ALTER TABLE mpd_identity.users DROP CONSTRAINT users_status_check; ALTER TABLE mpd_identity.users ADD CONSTRAINT users_status_check CHECK(status IN ('pending','active','suspended','disabled')) NOT VALID"],
    ['missing-index', 'DROP INDEX mpd_identity.leases_active_user'],
    ['missing-foreign-key', 'ALTER TABLE mpd_identity.identities DROP CONSTRAINT identities_user_id_fkey'],
    ['missing-not-null', 'ALTER TABLE mpd_identity.identities ALTER COLUMN subject DROP NOT NULL'],
    ['app-ddl', 'GRANT CREATE ON SCHEMA mpd_identity TO mpd_identity_app'],
    ['backup-write', 'GRANT DELETE ON mpd_identity.users TO mpd_identity_backup'],
    ['empty-subject', "UPDATE mpd_identity.identities SET subject=''"],
  ] as const) await t.test(name, async () => {
    const target = await f.restore(path); await target.admin.query(mutate);
    await assert.rejects(validateRestoredStore(connection(target), f.storeId));
  });
  await assert.rejects(validateRestoredStore(connection(f.db), f.storeId), /STORE_ALREADY_OWNED/);
});

// Break caught: a restored snapshot resurrects a JWT denial absent from that snapshot or reactivates current local denials.
test('restore cutoff and external manifest deny old unexpired tokens and fresh tokens for currently blocked identities', async t => {
  const f = await fixture(t);
  const good = await f.enrolled();
  const disabled = await f.enrolled('auth0|disabled');
  const removed = await f.enrolled('auth0|removed');
  const blocked = await f.enrolled('auth0|blocked');
  const pendingId = randomUUID();
  await enrollInvitation(f.store, { id: pendingId, email: 'pending@example.edu', issuer: (await f.auth()).principal.issuer, subject: 'auth0|pending', courseId: f.courseId, teamId: f.teamId, role: 'student', expiresAt: NOW + DAY }, f.clock);
  const old = await f.auth();
  const deviceId = randomUUID(), credentialId = randomUUID(), contextId = randomUUID(), leaseId = randomUUID();
  await f.db.admin.query("INSERT INTO mpd_identity.devices(id,owner_id,name,online,connection_epoch) VALUES($1,$2,'local test device',true,1)", [deviceId, good.userId]);
  await f.db.admin.query("INSERT INTO mpd_identity.device_credentials(id,device_id,fingerprint,generation,deployment_epoch,expires_at) VALUES($1,$2,$3,1,'before-restore',$4)", [credentialId, deviceId, 'c'.repeat(64), NOW + DAY]);
  await f.db.admin.query("INSERT INTO mpd_identity.work_contexts(id,user_id,resource,client_id,binding_provenance,binding_id,boot_id,deployment_epoch,state,expires_at,created_at) VALUES($1,$2,$3,$4,'local-test','restore-fixture',$5,'before-restore','active',$6,$7)", [contextId, good.userId, old.resource, old.principal.clientId, f.store.bootId, NOW + DAY, NOW]);
  await f.db.admin.query("INSERT INTO mpd_identity.leases(id,context_id,user_id,device_id,team_id,capabilities,epoch,expires_at,idle_expires_at,state,created_at) VALUES($1,$2,$3,$4,$5,ARRAY['execute'],1,$6,$6,'active',$7)", [leaseId, contextId, good.userId, deviceId, f.teamId, NOW + 600_000, NOW]);
  const path = await f.dump();
  await f.db.admin.query("INSERT INTO mpd_identity.token_denials(fingerprint,user_id,resource,expires_at,reason) VALUES($1,$2,$3,$4,'after-snapshot')", [old.tokenFingerprint, good.userId, old.resource, NOW + 600_000]);
  const target = await f.restore(path); await validateRestoredStore(connection(target), f.storeId);
  assert.equal((await target.admin.query('SELECT count(*) FROM mpd_identity.token_denials')).rows[0].count, '0');
  await f.store.close();
  const cutoff = NOW / 1000 + 60;
  const recovery = await f.open(target, 'after-restore', cutoff, true);
  assert.equal((await target.admin.query('SELECT revoked_at FROM mpd_identity.device_credentials WHERE id=$1', [credentialId])).rows[0].revoked_at !== null, true);
  assert.equal((await target.admin.query('SELECT state FROM mpd_identity.work_contexts WHERE id=$1', [contextId])).rows[0].state, 'revoked');
  assert.equal((await target.admin.query('SELECT state FROM mpd_identity.leases WHERE id=$1', [leaseId])).rows[0].state, 'revoked');
  assert.equal((await target.admin.query('SELECT online,connection_epoch FROM mpd_identity.devices WHERE id=$1', [deviceId])).rows[0].online, false);
  const runtime = createIdentityRuntime(recovery); t.after(() => runtime.close());
  const recoveryManifest = { ...manifest(f, 'after-restore', cutoff, [good, disabled, removed, blocked].map(view => ({ userId: view.userId, teamId: f.teamId }))), disabledUserIds: [disabled.userId], removedMemberships: [{ userId: removed.userId, teamId: f.teamId }], resourceBlocks: [{ userId: blocked.userId, resource: old.resource }] };
  assert.deepEqual(await reconcileRoster(recovery, recoveryManifest, runtime, f.clock), { activated: 2 });
  assert.equal((await target.admin.query('SELECT status FROM mpd_identity.invitations WHERE id=$1', [pendingId])).rows[0].status, 'revoked');
  await recovery.close();
  // External maintenance is removed only on a fresh serving lifetime after reconciliation.
  const serving = await f.open(target, 'after-restore', cutoff, false); await serving.setMaintenance(false);
  f.advance(62_000);
  await assert.rejects(authorizeIdentity(serving, old, { clock: f.clock }), /TOKEN_ISSUED_BEFORE_CUTOFF/);
  await assert.rejects(authorizeIdentity(serving, await f.auth('auth0|student-1', cutoff), { clock: f.clock }), /TOKEN_ISSUED_BEFORE_CUTOFF/);
  assert.equal((await authorizeIdentity(serving, await f.auth('auth0|student-1', cutoff + 1), { clock: f.clock })).userId, good.userId);
  for (const subject of ['auth0|disabled', 'auth0|removed', 'auth0|blocked', 'auth0|pending']) await assert.rejects(authorizeIdentity(serving, await f.auth(subject, cutoff + 1), { clock: f.clock }));
  assert.ok(old.principal.expiresAt > f.clock());
  await serving.close();
  await assert.rejects(f.open(target, 'after-restore', cutoff - 1, true), /TOKEN_IAT_AFTER_DECREASE/);
  await assert.rejects(f.open(target, 'rollback-epoch', cutoff, true), /RECOVERY_TOKEN_IAT_AFTER_REQUIRED/);
});

// Break caught: missing/current-evidence assertions or stale manifests reopen suspended authority.
test('reconciliation rejects missing stale unverified or mismatched evidence without activating users', async t => {
  const f = await fixture(t); const user = await f.enrolled(); await f.store.close();
  const cutoff = NOW / 1000 + 60;
  const store = await f.open(f.db, 'after-restore', cutoff, true); const runtime = createIdentityRuntime(store); t.after(() => runtime.close());
  const valid = manifest(f, 'after-restore', cutoff, [{ userId: user.userId, teamId: f.teamId }]);
  for (const overrides of [{ sourceRefs: [] }, { revocationsVerified: false }, { reviewedAt: NOW - 900_001 }, { reviewedAt: NOW + 1 }, { storeId: randomUUID() }, { deploymentEpoch: 'wrong' }, { tokenIatAfter: cutoff - 1 }]) await assert.rejects(reconcileRoster(store, { ...valid, ...overrides } as RecoveryManifest, runtime, f.clock));
  assert.equal((await f.db.admin.query('SELECT status FROM mpd_identity.users WHERE id=$1', [user.userId])).rows[0].status, 'suspended');
  assert.throws(() => parseRecoveryManifest({ ...valid, arbitrarySql: 'DROP' }));
  assert.deepEqual(await reconcileRoster(store, valid, runtime, f.clock), { activated: 1 });
});

// Break caught: retention purges at the boundary, discards enforcement IDs or infers course closure from token expiry.
test('retention keeps boundary records and enforcement while redacting course roster email after 30 days', async t => {
  const f = await fixture(t); const user = await f.enrolled();
  await f.db.admin.query('DELETE FROM mpd_identity.audit_events');
  for (const age of [30 * DAY + 1, 30 * DAY, 30 * DAY - 1]) await f.db.admin.query("INSERT INTO mpd_identity.audit_events(id,occurred_at,actor_id,action,outcome) VALUES($1,$2,$3,'test','allowed')", [randomUUID(), NOW - age, user.userId]);
  for (const [index, age] of [60_001, 60_000, 59_999].entries()) await f.db.admin.query("INSERT INTO mpd_identity.token_denials(fingerprint,user_id,expires_at,reason) VALUES($1,$2,$3,'test')", [String(index).repeat(64), user.userId, NOW - age]);
  await f.db.admin.query('UPDATE mpd_identity.courses SET closed_at=$1,status=\'disabled\' WHERE id=$2', [NOW - 30 * DAY, f.courseId]);
  assert.deepEqual(await runRetention(f.store, f.clock), { auditEvents: 1, tokenDenials: 1, rosterEmails: 0 });
  f.advance(1);
  assert.equal((await runRetention(f.store, f.clock)).rosterEmails, 1);
  assert.equal((await f.db.admin.query('SELECT email FROM mpd_identity.invitations')).rows[0].email, '');
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.identities')).rows[0].count, '1');
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.memberships')).rows[0].count, '1');
  assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.token_denials')).rows[0].count, '1');
});

// Break caught: retention makes an unbounded transaction or close-course bypasses a durable closure timestamp.
test('retention batches at 500 records and close-course persists a timestamp without deleting enrollment', async t => {
  const f = await fixture(t); await f.enrolled(); await f.db.admin.query('DELETE FROM mpd_identity.audit_events');
  await f.db.admin.query("INSERT INTO mpd_identity.audit_events(id,occurred_at,action,outcome) SELECT gen_random_uuid(),$1,'retention','allowed' FROM generate_series(1,501)", [NOW - 31 * DAY]);
  assert.equal((await runRetention(f.store, f.clock)).auditEvents, 500);
  assert.equal((await runRetention(f.store, f.clock)).auditEvents, 1);
  const runtime = createIdentityRuntime(f.store); t.after(() => runtime.close());
  const closed = await runtime.coordinator.withFence(() => closeCourse(f.store, f.courseId, f.clock));
  assert.deepEqual(closed, { affected: 1, teamIds: [f.teamId] });
  assert.equal(Number((await f.db.admin.query('SELECT closed_at FROM mpd_identity.courses WHERE id=$1', [f.courseId])).rows[0].closed_at), NOW);
  await assert.rejects(authorizeIdentity(f.store, await f.auth(), { clock: f.clock }));
});

// Break caught: export lacks one consistent snapshot while another transaction commits related rows.
test('custom-format export stays consistent while related writes commit during the dump', async t => {
  const f = await fixture(t); await f.enrolled();
  const locker = new pg.Client({ connectionString: f.db.adminUrl }); await locker.connect();
  let dump: Promise<string> | undefined;
  try {
    await locker.query('BEGIN'); await locker.query('LOCK TABLE mpd_identity.audit_events IN ACCESS EXCLUSIVE MODE');
    dump = f.dump(); void dump.catch(() => undefined);
    let waiting = false;
    for (let i = 0; i < 200; i++) {
      if ((await f.db.admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='mpd_fixture_pg_dump' AND wait_event_type='Lock'")).rowCount) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, 'dump must hold its snapshot while waiting for the fixture table lock');
    const userId = randomUUID();
    await f.db.admin.query('BEGIN');
    await f.db.admin.query("INSERT INTO mpd_identity.users(id,status) VALUES($1,'active')", [userId]);
    await f.db.admin.query("INSERT INTO mpd_identity.identities(id,user_id,issuer,subject,connection) VALUES($1,$2,$3,'auth0|committed-during-dump','email')", [randomUUID(), userId, (await f.auth()).principal.issuer]);
    await f.db.admin.query('COMMIT');
    await locker.query('ROLLBACK');
    const target = await f.restore(await dump);
    await validateRestoredStore(connection(target), f.storeId);
    assert.equal((await target.admin.query('SELECT count(*) FROM mpd_identity.users')).rows[0].count, '1');
    assert.equal((await target.admin.query('SELECT count(*) FROM mpd_identity.identities')).rows[0].count, '1');
    assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.users')).rows[0].count, '2');
  } finally { await locker.query('ROLLBACK'); await locker.end(); if (dump) await dump.catch(() => undefined); }
});

// Break caught: a late invalid approval leaves earlier denials committed or creates an unknown membership.
test('reconciliation is atomic and conflicting approvals never override disabled users or removed memberships', async t => {
  const f = await fixture(t); const user = await f.enrolled(); await f.store.close();
  const cutoff = NOW / 1000 + 60;
  const store = await f.open(f.db, 'recovery-atomic', cutoff, true); const runtime = createIdentityRuntime(store); t.after(() => runtime.close());
  const input = { ...manifest(f, 'recovery-atomic', cutoff, [{ userId: randomUUID(), teamId: f.teamId }]), disabledUserIds: [user.userId] };
  await assert.rejects(reconcileRoster(store, input, runtime, f.clock), /RECOVERY_MEMBERSHIP_NOT_FOUND/);
  assert.equal((await f.db.admin.query('SELECT status FROM mpd_identity.users WHERE id=$1', [user.userId])).rows[0].status, 'suspended');
  const denied = { ...manifest(f, 'recovery-atomic', cutoff, [{ userId: user.userId, teamId: f.teamId }]), disabledUserIds: [user.userId], removedMemberships: [{ userId: user.userId, teamId: f.teamId }] };
  assert.deepEqual(await reconcileRoster(store, denied, runtime, f.clock), { activated: 0 });
  assert.equal((await f.db.admin.query('SELECT status FROM mpd_identity.users WHERE id=$1', [user.userId])).rows[0].status, 'disabled');
  assert.equal((await f.db.admin.query('SELECT status FROM mpd_identity.memberships WHERE user_id=$1', [user.userId])).rows[0].status, 'removed');
});

// Break caught: recovery uses evidence freshness captured before a row-lock wait.
test('reconciliation rechecks evidence freshness after waiting for user locks', async t => {
  const f = await fixture(t); const user = await f.enrolled(); await f.store.close();
  const cutoff = NOW / 1000 + 60;
  const store = await f.open(f.db, 'recovery-lock', cutoff, true); const runtime = createIdentityRuntime(store); t.after(() => runtime.close());
  await f.db.admin.query('BEGIN');
  await f.db.admin.query('SELECT id FROM mpd_identity.users WHERE id=$1 FOR UPDATE', [user.userId]);
  const reconcile = reconcileRoster(store, manifest(f, 'recovery-lock', cutoff, [{ userId: user.userId, teamId: f.teamId }]), runtime, f.clock);
  const rejected = assert.rejects(reconcile, /RECOVERY_EVIDENCE_STALE/);
  const observer = new pg.Client({ connectionString: f.db.adminUrl }); await observer.connect();
  try {
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      if ((await observer.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='mpd_identity_request_connection' AND wait_event_type='Lock'")).rowCount) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(waiting, true);
    f.advance(900_001);
  } finally { await f.db.admin.query('ROLLBACK'); await observer.end(); }
  await rejected;
  assert.equal((await f.db.admin.query('SELECT status FROM mpd_identity.users WHERE id=$1', [user.userId])).rows[0].status, 'suspended');
});

// Break caught: expiry or generic course disable is incorrectly treated as an approved course closure.
test('retention does not redact an open or untimestamped course roster', async t => {
  const f = await fixture(t); await f.enrolled(); f.advance(31 * DAY);
  assert.equal((await runRetention(f.store, f.clock)).rosterEmails, 0);
  await f.db.admin.query("UPDATE mpd_identity.courses SET status='disabled'");
  assert.equal((await runRetention(f.store, f.clock)).rosterEmails, 0);
  assert.notEqual((await f.db.admin.query('SELECT email FROM mpd_identity.invitations')).rows[0].email, '');
});

// Break caught: malformed operator evidence can reach a transaction with unknown fields, unsafe references or unbounded arrays.
test('manifest parsing rejects malformed identities resources references and oversized evidence', async t => {
  const f = await fixture(t); const base = manifest(f, 'before-restore', 0);
  for (const value of [
    null,
    { ...base, approvedMemberships: [{ userId: 'not-a-uuid', teamId: f.teamId }] },
    { ...base, removedMemberships: 'not-an-array' },
    { ...base, disabledUserIds: ['not-a-uuid'] },
    { ...base, resourceBlocks: [{ userId: randomUUID(), resource: 'not-a-url' }] },
    { ...base, resourceBlocks: [{ userId: randomUUID(), resource: 'http://unsafe.example/mcp' }] },
    { ...base, resourceBlocks: [{ userId: randomUUID(), resource: '' }] },
    { ...base, sourceRefs: ['https://operator:secret@example.invalid/record'] },
    { ...base, approvedMemberships: Array.from({ length: 501 }, () => ({ userId: randomUUID(), teamId: f.teamId })) },
    { ...base, approvedMemberships: Array.from({ length: 500 }, () => ({ userId: randomUUID(), teamId: f.teamId })), removedMemberships: Array.from({ length: 500 }, () => ({ userId: randomUUID(), teamId: f.teamId })) },
  ]) assert.throws(() => parseRecoveryManifest(value), /INVALID_RECOVERY_MANIFEST/);
});

// Break caught: reconciliation reopens admissions or overwrites a denial already present in current storage.
test('reconciliation requires maintenance and retains current disabled removed and resource-wide denials', async t => {
  const f = await fixture(t); const user = await f.enrolled();
  const runtime = createIdentityRuntime(f.store); t.after(() => runtime.close());
  const approval = [{ userId: user.userId, teamId: f.teamId }];
  await assert.rejects(reconcileRoster(f.store, manifest(f, 'before-restore', 0, approval), runtime, f.clock), /RECOVERY_MAINTENANCE_REQUIRED/);
  await f.store.setMaintenance(true);
  await f.db.admin.query("UPDATE mpd_identity.users SET status='disabled' WHERE id=$1", [user.userId]);
  assert.deepEqual(await reconcileRoster(f.store, manifest(f, 'before-restore', 0, approval), runtime, f.clock), { activated: 0 });
  await f.db.admin.query("UPDATE mpd_identity.users SET status='suspended' WHERE id=$1", [user.userId]);
  await f.db.admin.query("UPDATE mpd_identity.memberships SET status='removed' WHERE user_id=$1", [user.userId]);
  await f.db.admin.query("INSERT INTO mpd_identity.user_resource_blocks(user_id,resource,reason) VALUES($1,'https://bridge.example/mcp','current-denial')", [user.userId]);
  assert.deepEqual(await reconcileRoster(f.store, manifest(f, 'before-restore', 0, approval), runtime, f.clock), { activated: 0 });
  const missingDenial = { ...manifest(f, 'before-restore', 0), resourceBlocks: [{ userId: randomUUID(), resource: 'https://bridge.example/mcp' }] };
  assert.deepEqual(await reconcileRoster(f.store, missingDenial, runtime, f.clock), { activated: 0 });
  assert.equal((await f.db.admin.query('SELECT reason FROM mpd_identity.user_resource_blocks WHERE user_id=$1', [user.userId])).rows[0].reason, 'current-denial');
});

// Break caught: retention proceeds with stale store ownership or bad clocks; closure failures partially disable a course.
test('retention and course closure fail closed for stale authority invalid inputs and transaction failure', async t => {
  const f = await fixture(t); await f.enrolled();
  await assert.rejects(runRetention({ ...f.store, bootId: randomUUID() }, f.clock), /STORE_UNAVAILABLE/);
  await assert.rejects(runRetention(f.store, () => -1), /INVALID_CLOCK/);
  await assert.rejects(runRetention(f.store, () => NaN), /INVALID_CLOCK/);
  await assert.rejects(closeCourse(f.store, 'not-a-course-id', f.clock), /INVALID_COURSE/);
  await assert.rejects(closeCourse(f.store, randomUUID(), f.clock), /COURSE_NOT_FOUND/);
  await assert.rejects(closeCourse(f.store, f.courseId, () => -1), /INVALID_CLOCK/);
  await f.db.admin.query("CREATE FUNCTION mpd_identity.reject_close_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'protected diagnostic canary'; END $$; CREATE TRIGGER reject_close_audit BEFORE INSERT ON mpd_identity.audit_events FOR EACH ROW EXECUTE FUNCTION mpd_identity.reject_close_audit()");
  await assert.rejects(closeCourse(f.store, f.courseId, f.clock), (error: unknown) => error instanceof Error && error.message === 'STORE_UNAVAILABLE');
  assert.deepEqual((await f.db.admin.query('SELECT status,closed_at FROM mpd_identity.courses WHERE id=$1', [f.courseId])).rows[0], { status: 'active', closed_at: null });
  assert.equal((await f.db.admin.query('SELECT status FROM mpd_identity.memberships')).rows[0].status, 'active');
});

// Break caught: a repeated close command postpones the approved privacy cleanup date.
test('repeated course closure retains the original closure timestamp', async t => {
  const f = await fixture(t); await f.enrolled();
  assert.equal((await closeCourse(f.store, f.courseId, f.clock)).affected, 1);
  f.advance(DAY);
  assert.equal((await closeCourse(f.store, f.courseId, f.clock)).affected, 0);
  assert.equal(Number((await f.db.admin.query('SELECT closed_at FROM mpd_identity.courses')).rows[0].closed_at), NOW);
});

// Break caught: unsafe migration credentials, incomplete schema and public target access are treated as valid restores.
test('restore validation rejects unsafe credentials incomplete stores public grants and altered service-state columns', async t => {
  const f = await fixture(t); await f.enrolled();
  await assert.rejects(validateRestoredStore({ ...connection(f.db), connectionString: f.db.appUrl }, f.storeId), /RESTORE_MIGRATION_ROLE_REQUIRED/);
  await assert.rejects(validateRestoredStore({ ...connection(f.db), transportMode: 'railway-private' }, f.storeId), /RESTORE_VALIDATION_FAILED/);
  const empty = await createTestDatabase(); t.after(() => empty.close()); await empty.provisionRoles();
  await assert.rejects(validateRestoredStore(connection(empty), f.storeId), /STORE_NOT_INITIALIZED/);
  const path = await f.dump();
  for (const sql of [
    'GRANT USAGE ON SCHEMA mpd_identity TO PUBLIC',
    `GRANT CONNECT ON DATABASE "${empty.name}" TO PUBLIC`,
    'GRANT UPDATE(store_id) ON mpd_identity.service_state TO mpd_identity_app',
    'REVOKE SELECT ON mpd_identity.users FROM mpd_identity_app',
    "CREATE FUNCTION mpd_identity.unapproved() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
    "INSERT INTO mpd_identity.schema_migrations(version,checksum) VALUES(3,'unapproved')",
  ]) {
    const target = await f.restore(path);
    await target.admin.query(sql.replace(empty.name, target.name));
    await assert.rejects(validateRestoredStore(connection(target), f.storeId));
  }
});

// Break caught: the disposable tool harness accepts app credentials or restores into its live source.
test('backup tool harness requires the backup role and an empty isolated restore target', async t => {
  const f = await fixture(t); await f.enrolled();
  const path = await f.dump();
  await t.test('wrong export role', async () => {
    await assert.rejects(runPostgresTool('pg_dump', ['--format=custom', '--schema=mpd_identity', '--no-owner', '--no-privileges', `--file=${path}.unsafe`], { connectionString: f.db.appUrl }), /UNSAFE_TEST_TOOL_ROLE/);
  });
  await t.test('existing source schema', async () => {
    await assert.rejects(runPostgresTool('pg_restore', ['--exit-on-error', '--no-owner', '--no-privileges', '--role=mpd_identity_owner', path], { connectionString: f.db.migrationUrl }), /UNSAFE_TEST_RESTORE_TARGET/);
  });
});
