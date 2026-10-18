import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, before } from 'node:test';
import pg from 'pg';
import { createTestDatabase, disposableCluster, type TestDatabase } from '../support/storage.js';
import type { Store } from '../../packages/storage/types.js';

import { openAuthorizationStore } from '../../packages/storage/database.js';
import { migrateAuthorizationStore } from '../../packages/storage/migrations.js';

before(async () => { const cluster = await disposableCluster(); await cluster.query('SELECT 1'); await cluster.end(); });
const storeId = '89dcbb2b-4e4c-491b-a911-d3448941d173';
const epoch = 'test-deployment-1';
function options(db: TestDatabase) {
  return { connectionString: db.appUrl, transportMode: 'local-test' as const, expectedStoreId: storeId,
    maintenance: false, deploymentEpoch: epoch, tokenIatAfter: 0, now: () => 1_800_000_000_000 };
}
function migrationOptions(db: TestDatabase) {
  return { migrationUrl: db.migrationUrl, transportMode: 'local-test' as const, initialize: true,
    maintenance: true, expectedStoreId: storeId, deploymentEpoch: epoch };
}
async function initialized() { const db = await createTestDatabase(); try { await db.provisionRoles(); await migrateAuthorizationStore(migrationOptions(db)); return db; } catch (error) { await db.close(); throw error; } }
async function client(url: string) { const result = new pg.Client({ connectionString: url }); await result.connect(); return result; }

test('runtime refuses an absent schema instead of initializing it', async () => {
  const db = await createTestDatabase();
  try { await assert.rejects(openAuthorizationStore({ ...options(db), connectionString: db.adminUrl }), /STORE_NOT_INITIALIZED/); }
  finally { await db.close(); }
});

test('explicit initialization requires maintenance and schema owner credentials', async () => {
  const db = await createTestDatabase();
  try {
    await db.provisionRoles();
    await assert.rejects(migrateAuthorizationStore({ ...migrationOptions(db), maintenance: false }), /MAINTENANCE_REQUIRED/);
    await assert.rejects(migrateAuthorizationStore({ ...migrationOptions(db), initialize: false }), /STORE_NOT_INITIALIZED/);
    await migrateAuthorizationStore(migrationOptions(db));
    const marker = await db.admin.query('SELECT store_id, maintenance FROM mpd_identity.service_state');
    assert.deepEqual(marker.rows, [{ store_id: storeId, maintenance: true }]);
    const app = await client(db.appUrl); const backup = await client(db.backupUrl);
    try {
      await assert.rejects(app.query('CREATE TABLE mpd_identity.forbidden(id int)'), /permission denied/);
      await assert.rejects(app.query('CREATE SCHEMA forbidden'), /permission denied/);
      await assert.rejects(backup.query("INSERT INTO mpd_identity.users(id,status) VALUES ($1,'pending')", [randomUUID()]), /permission denied/);
      assert.equal((await backup.query('SELECT count(*) FROM mpd_identity.users')).rows[0].count, '0');
    } finally { await app.end(); await backup.end(); }
  } finally { await db.close(); }
});

test('startup refuses wrong marker, absent marker, newer schema and checksum drift', async () => {
  const db = await initialized();
  try {
    await assert.rejects(openAuthorizationStore({ ...options(db), expectedStoreId: randomUUID() }), /STORE_ID_MISMATCH/);
    await db.admin.query('UPDATE mpd_identity.schema_migrations SET checksum=$1', ['tampered']);
    await assert.rejects(openAuthorizationStore(options(db)), /MIGRATION_CHECKSUM_MISMATCH/);
    await db.admin.query("INSERT INTO mpd_identity.schema_migrations(version,checksum) VALUES (999,'future')");
    await assert.rejects(openAuthorizationStore(options(db)), /UNSUPPORTED_SCHEMA/);
    await db.admin.query('DELETE FROM mpd_identity.service_state');
    await assert.rejects(openAuthorizationStore(options(db)), /STORE_NOT_INITIALIZED/);
  } finally { await db.close(); }
});

test('two migration clients contend and failed migration rolls back all DDL', async () => {
  const db = await createTestDatabase();
  try {
    await db.provisionRoles();
    const locker = await client(db.migrationUrl);
    await locker.query('SELECT pg_advisory_lock(1297105993,1)');
    let done = false;
    const migration = migrateAuthorizationStore(migrationOptions(db)).finally(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(done, false);
    await locker.query('SELECT pg_advisory_unlock(1297105993,1)'); await locker.end(); await migration;
    await migrateAuthorizationStore({ ...migrationOptions(db), initialize: false });
    assert.equal((await db.admin.query('SELECT count(*) FROM mpd_identity.schema_migrations')).rows[0].count, '2');
  } finally { await db.close(); }
  const broken = await createTestDatabase();
  try {
    await broken.provisionRoles();
    await broken.admin.query('CREATE SCHEMA mpd_identity AUTHORIZATION mpd_identity_owner');
    await broken.admin.query('CREATE TABLE mpd_identity.users(conflict int)');
    await assert.rejects(migrateAuthorizationStore(migrationOptions(broken)));
    assert.equal((await broken.admin.query("SELECT to_regclass('mpd_identity.service_state') AS table_name")).rows[0].table_name, null);
  } finally { await broken.close(); }
});

test('second owner cannot invalidate incumbent grants; migration cannot disturb an owner', async () => {
  const db = await initialized(); let store: Store | undefined;
  try {
    store = await openAuthorizationStore(options(db));
    const firstBoot = store.bootId;
    await assert.rejects(openAuthorizationStore(options(db)), /STORE_ALREADY_OWNED/);
    await assert.rejects(migrateAuthorizationStore({ ...migrationOptions(db), initialize: false }), /STORE_ALREADY_OWNED/);
    assert.equal((await db.admin.query('SELECT boot_id FROM mpd_identity.service_state')).rows[0].boot_id, firstBoot);
    assert.equal(await store.ready(), false); // Stored maintenance survives startup.
    await store.setMaintenance(false);
    assert.equal(await store.ready(), true);
  } finally { await store?.close(); await db.close(); }
});

test('issuance cutoff must be safe integer seconds and can only increase', async () => {
  const db = await initialized(); let store: Store | undefined;
  try {
    for (const invalid of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(openAuthorizationStore({ ...options(db), tokenIatAfter: invalid }), /INVALID_TOKEN_IAT_AFTER/);
    }
    store = await openAuthorizationStore({ ...options(db), tokenIatAfter: 1700000000 });
    assert.equal(store.tokenIatAfter, 1700000000);
    assert.equal((await db.admin.query('SELECT token_iat_after FROM mpd_identity.service_state')).rows[0].token_iat_after, '1700000000');
    await store.close(); store = undefined;
    await assert.rejects(openAuthorizationStore({ ...options(db), tokenIatAfter: 1699999999 }), /TOKEN_IAT_AFTER_DECREASE/);
    store = await openAuthorizationStore({ ...options(db), tokenIatAfter: 1700000001 });
  } finally { await store?.close(); await db.close(); }
});

test('transaction keeps one backend, rolls back, releases on error and bounds lock waits', async () => {
  const db = await initialized(); let store: Store | undefined;
  try {
    store = await openAuthorizationStore(options(db));
    await store.transaction(async (tx) => {
      const before = await tx.query('SELECT pg_backend_pid() AS pid');
      const after = await tx.query('SELECT pg_backend_pid() AS pid');
      assert.equal(before.rows[0].pid, after.rows[0].pid);
    });
    await assert.rejects(store.transaction(async (tx) => {
      await tx.query("INSERT INTO mpd_identity.users(id,status) VALUES ($1,'pending')", [randomUUID()]);
      throw new Error('application error');
    }), /application error/);
    assert.equal((await store.transaction((tx) => tx.query('SELECT count(*) FROM mpd_identity.users'))).rows[0].count, '0');
    await store.transaction(async (tx) => {
      const settings = await tx.query("SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock, current_setting('idle_in_transaction_session_timeout') AS idle");
      assert.deepEqual(settings.rows[0], { statement: '5s', lock: '2s', idle: '10s' });
    });
    const lock = await client(db.appUrl); await lock.query('BEGIN'); await lock.query('LOCK TABLE mpd_identity.users IN ACCESS EXCLUSIVE MODE');
    const start = Date.now();
    await assert.rejects(store.transaction((tx) => tx.query('SELECT * FROM mpd_identity.users')), /lock timeout/);
    assert.ok(Date.now() - start < 4000); await lock.query('ROLLBACK'); await lock.end();
  } finally { await store?.close(); await db.close(); }
});

test('owner connection loss permanently disables transactions and readiness', async () => {
  const db = await initialized(); let store: Store | undefined;
  try {
    store = await openAuthorizationStore(options(db)); await store.setMaintenance(false);
    let unavailable = false; store.onUnavailable(() => { unavailable = true; });
    await db.admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='mpd_identity_owner_connection'");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(unavailable, true); assert.equal(await store.ready(), false);
    await assert.rejects(store.transaction((tx) => tx.query('SELECT 1')), /STORE_UNAVAILABLE/);
  } finally { await store?.close(); await db.close(); }
});

test('restart preserves enrollment and denials, revokes transient authority and marks writes uncertain', async () => {
  const db = await initialized(); let store: Store | undefined;
  const user = randomUUID(), team = randomUUID(), course = randomUUID(), device = randomUUID(), context = randomUUID(), lease = randomUUID();
  try {
    store = await openAuthorizationStore(options(db));
    await db.admin.query("INSERT INTO mpd_identity.users(id,status) VALUES ($1,'active')", [user]);
    await db.admin.query("INSERT INTO mpd_identity.identities(id,user_id,issuer,subject,connection) VALUES ($1,$2,'https://issuer/','student','email')", [randomUUID(), user]);
    await db.admin.query("INSERT INTO mpd_identity.courses(id,name) VALUES ($1,'class')", [course]);
    await db.admin.query("INSERT INTO mpd_identity.teams(id,course_id,name) VALUES ($1,$2,'team')", [team, course]);
    await db.admin.query("INSERT INTO mpd_identity.memberships(id,user_id,team_id,status) VALUES ($1,$2,$3,'active')", [randomUUID(), user, team]);
    await db.admin.query("INSERT INTO mpd_identity.devices(id,owner_id,name,online,connection_epoch) VALUES ($1,$2,'laptop',true,7)", [device,user]);
    await db.admin.query("INSERT INTO mpd_identity.device_credentials(id,device_id,fingerprint,generation,deployment_epoch,expires_at) VALUES ($1,$2,'credential',1,$3,2000000000000)", [randomUUID(),device,epoch]);
    await db.admin.query("INSERT INTO mpd_identity.work_contexts(id,user_id,resource,client_id,boot_id,deployment_epoch,state,expires_at) VALUES ($1,$2,'resource','client',$3,$4,'active',2000000000000)", [context,user,store.bootId,epoch]);
    await db.admin.query("INSERT INTO mpd_identity.leases(id,context_id,user_id,device_id,team_id,capabilities,epoch,expires_at,idle_expires_at,state) VALUES ($1,$2,$3,$4,$5,ARRAY['read'],7,2000000000000,2000000000000,'active')", [lease,context,user,device,team]);
    await db.admin.query("INSERT INTO mpd_identity.operation_attempts(id,request_id,lease_id,device_id,epoch,classification,state) VALUES ($1,'request',$2,$3,7,'write','dispatched')", [randomUUID(),lease,device]);
    await db.admin.query("INSERT INTO mpd_identity.token_denials(fingerprint,expires_at,reason) VALUES ('denied',2000000000000,'operator')");
    await db.admin.query("INSERT INTO mpd_identity.user_resource_blocks(user_id,resource,reason) VALUES ($1,'resource','operator')",[user]);
    await db.admin.query("INSERT INTO mpd_identity.pairings(id,context_id,owner_id,team_id,fingerprint,capabilities,expires_at,state) VALUES ($1,$2,$3,$4,'pairing',ARRAY['read'],2000000000000,'pending')",[randomUUID(),context,user,team]);
    await db.admin.query("INSERT INTO mpd_identity.invitations(id,email,issuer,subject,course_id,team_id,status,expires_at) VALUES ($1,'invited@example.edu','https://issuer/','invited',$2,$3,'pending',2000000000000)",[randomUUID(),course,team]);
    await store.close(); store = await openAuthorizationStore(options(db));
    assert.equal((await db.admin.query('SELECT status FROM mpd_identity.users WHERE id=$1',[user])).rows[0].status,'active');
    assert.equal((await db.admin.query('SELECT count(*) FROM mpd_identity.token_denials')).rows[0].count,'1');
    assert.deepEqual((await db.admin.query('SELECT online,connection_epoch FROM mpd_identity.devices')).rows[0],{ online:false,connection_epoch:'8' });
    assert.equal((await db.admin.query('SELECT state FROM mpd_identity.work_contexts')).rows[0].state,'revoked');
    assert.equal((await db.admin.query('SELECT state FROM mpd_identity.leases')).rows[0].state,'revoked');
    assert.equal((await db.admin.query('SELECT state FROM mpd_identity.pairings')).rows[0].state,'revoked');
    assert.equal((await db.admin.query('SELECT status FROM mpd_identity.invitations')).rows[0].status,'pending');
    assert.equal((await db.admin.query('SELECT state FROM mpd_identity.operation_attempts')).rows[0].state,'uncertain');
    assert.equal((await db.admin.query('SELECT revoked_at FROM mpd_identity.device_credentials')).rows[0].revoked_at,null);
    await store.close(); store = undefined;
    await assert.rejects(openAuthorizationStore({ ...options(db), deploymentEpoch:'restored',maintenance:false }),/RECOVERY_MAINTENANCE_REQUIRED/);
    store = await openAuthorizationStore({ ...options(db),deploymentEpoch:'restored',maintenance:true,tokenIatAfter:1800000060 });
    assert.equal((await db.admin.query('SELECT status FROM mpd_identity.users')).rows[0].status,'suspended');
    assert.equal((await db.admin.query('SELECT status FROM mpd_identity.memberships')).rows[0].status,'suspended');
    assert.ok((await db.admin.query('SELECT revoked_at FROM mpd_identity.device_credentials')).rows[0].revoked_at);
    assert.equal((await db.admin.query('SELECT status FROM mpd_identity.invitations')).rows[0].status,'revoked');
    assert.equal((await db.admin.query('SELECT count(*) FROM mpd_identity.user_resource_blocks')).rows[0].count,'1');
    await assert.rejects(store.setMaintenance(false),/EXTERNAL_MAINTENANCE/);
  } finally { await store?.close(); await db.close(); }
});

test('foreign keys and partial uniqueness prevent orphan grants and simultaneous active leases', async () => {
  const db = await initialized();
  try {
    await assert.rejects(db.admin.query("INSERT INTO mpd_identity.devices(id,owner_id,name) VALUES ($1,$2,'orphan')",[randomUUID(),randomUUID()]),/foreign key/);
    const user=randomUUID(), course=randomUUID(), team=randomUUID(), context=randomUUID(), device=randomUUID();
    await db.admin.query("INSERT INTO mpd_identity.users(id,status) VALUES ($1,'active')",[user]);
    await db.admin.query("INSERT INTO mpd_identity.courses(id,name) VALUES ($1,'class')",[course]);
    await db.admin.query("INSERT INTO mpd_identity.teams(id,course_id,name) VALUES ($1,$2,'team')",[team,course]);
    await db.admin.query("INSERT INTO mpd_identity.devices(id,owner_id,name) VALUES ($1,$2,'laptop')",[device,user]);
    await db.admin.query("INSERT INTO mpd_identity.work_contexts(id,user_id,resource,client_id,boot_id,deployment_epoch,state,expires_at) VALUES ($1,$2,'resource','client',$3,$4,'active',2000000000000)",[context,user,randomUUID(),epoch]);
    const insert = () => db.admin.query("INSERT INTO mpd_identity.leases(id,context_id,user_id,device_id,team_id,capabilities,epoch,expires_at,idle_expires_at,state) VALUES ($1,$2,$3,$4,$5,ARRAY['read'],1,2000000000000,2000000000000,'active')",[randomUUID(),context,user,device,team]);
    await insert(); await assert.rejects(insert(),/unique constraint/);
  } finally { await db.close(); }
});

test('missing database fails closed without creating a database', async () => {
  const db = await initialized();
  try {
    const url = new URL(db.appUrl); url.pathname='/mpd_identity_absent';
    await assert.rejects(openAuthorizationStore({ ...options(db),connectionString:url.href }), /does not exist/);
    assert.equal((await db.admin.query("SELECT count(*) FROM pg_database WHERE datname='mpd_identity_absent'")).rows[0].count,'0');
  } finally { await db.close(); }
});

test('transport validation refuses URL overrides, external plaintext and TLS without a CA', async () => {
  const { databaseClientConfig } = await import('../../packages/storage/database.js');
  assert.throws(()=>databaseClientConfig('postgresql://app:secret@db.railway.internal/identity?host=evil.example',{transportMode:'railway-private'}),/DATABASE_URL_PARAMETERS_FORBIDDEN/);
  assert.throws(()=>databaseClientConfig('postgresql://app:secret@evil.example/identity',{transportMode:'railway-private'}),/PRIVATE_DATABASE_HOST_REQUIRED/);
  assert.throws(()=>databaseClientConfig('postgresql://app:secret@evil.example/identity',{transportMode:'verify-full'}),/DATABASE_CA_REQUIRED/);
  assert.throws(()=>databaseClientConfig('postgresql://app:secret@evil.example/mpd_identity_test',{transportMode:'local-test'}),/DISPOSABLE_LOCAL_DATABASE_REQUIRED/);
});

test('pool exhaustion fails within five seconds and permanently closes authority', async () => {
  const db=await initialized(); let store:Store|undefined;
  let release!:()=>void;
  const held=new Promise<void>((resolve)=>{release=resolve;});
  let entered=0;
  let allEntered!:()=>void;
  const acquired=new Promise<void>((resolve)=>{allEntered=resolve;});
  let transactions:Promise<unknown>[]=[];
  try {
    store=await openAuthorizationStore(options(db));
    transactions=Array.from({length:5},()=>store!.transaction(async(tx)=>{
      await tx.query('SELECT 1'); entered++; if(entered===5) allEntered(); await held;
    }));
    // Handle rejections immediately; assertions below inspect all outcomes after releasing checkouts.
    const settled=Promise.allSettled(transactions);
    await acquired;
    const start=Date.now();
    await assert.rejects(store.transaction((tx)=>tx.query('SELECT 1')),/STORE_UNAVAILABLE/);
    assert.ok(Date.now()-start>=4500 && Date.now()-start<6500);
    assert.equal(await store.ready(),false);
    release();
    assert.ok((await settled).every((result)=>result.status==='rejected'));
  } finally {release();await Promise.allSettled(transactions);await store?.close();await db.close();}
});

test('request connection termination rolls back and disables later work', async () => {
  const db=await initialized(); let store:Store|undefined;
  try {
    store=await openAuthorizationStore(options(db));
    await assert.rejects(store.transaction(async(tx)=>{
      const pid=(await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await db.admin.query('SELECT pg_terminate_backend($1)',[pid]);
      await tx.query('SELECT 1');
    }),/STORE_UNAVAILABLE/);
    assert.equal(await store.ready(),false);
    await assert.rejects(store.transaction((tx)=>tx.query('SELECT 1')),/STORE_UNAVAILABLE/);
  } finally {await store?.close();await db.close();}
});

test('runtime refuses even indirect role memberships that permit privilege escalation', async () => {
  const db=await initialized();
  try {
    await db.admin.query('GRANT mpd_identity_backup TO mpd_identity_app');
    await assert.rejects(openAuthorizationStore(options(db)),/UNSAFE_RUNTIME_DATABASE_ROLE/);
  } finally {await db.admin.query('REVOKE mpd_identity_backup FROM mpd_identity_app');await db.close();}
});

test('recovery epoch requires an externally advanced issuance cutoff before changing authority', async () => {
  const db=await initialized();
  try {
    await assert.rejects(openAuthorizationStore({ ...options(db),deploymentEpoch:'restore',maintenance:true }),/RECOVERY_TOKEN_IAT_AFTER_REQUIRED/);
    assert.equal((await db.admin.query('SELECT deployment_epoch,token_iat_after FROM mpd_identity.service_state')).rows[0].deployment_epoch,epoch);
  } finally {await db.close();}
});

test('concurrent readiness uses no overlapping dedicated owner client queries',async()=>{
  const db=await initialized();let store:Store|undefined;const warnings:Error[]=[];
  const capture=(warning:Error)=>{if(warning.message.includes('already executing a query'))warnings.push(warning);};
  process.on('warning',capture);
  try{store=await openAuthorizationStore(options(db));await store.setMaintenance(false);assert.ok((await Promise.all(Array.from({length:8},()=>store!.ready()))).every(Boolean));await new Promise(resolve=>setImmediate(resolve));assert.equal(warnings.length,0);}
  finally{process.off('warning',capture);await store?.close();await db.close();}
});

test('parallel disposable fixtures serialize cluster-wide role provisioning',async()=>{
  const databases=await Promise.all(Array.from({length:4},()=>createTestDatabase()));
  try{const provisioned=await Promise.allSettled(databases.map(db=>db.provisionRoles()));assert.deepEqual(provisioned.map(result=>result.status),['fulfilled','fulfilled','fulfilled','fulfilled']);}
  finally{await Promise.all(databases.map(db=>db.close()));}
});

test('operator upgrades an existing version-one store before runtime opens it', async () => {
  const db = await createTestDatabase();
  const { AUTHORIZATION_MIGRATIONS } = await import('../../packages/storage/migrations.js');
  try {
    await db.provisionRoles();
    const migrator = await client(db.migrationUrl);
    try {
      await migrator.query('BEGIN');
      await migrator.query('SET LOCAL ROLE mpd_identity_owner');
      await migrator.query('CREATE SCHEMA mpd_identity AUTHORIZATION mpd_identity_owner');
      await migrator.query(AUTHORIZATION_MIGRATIONS[0]!.sql);
      await migrator.query('INSERT INTO mpd_identity.schema_migrations(version,checksum) VALUES(1,$1)', [AUTHORIZATION_MIGRATIONS[0]!.checksum]);
      await migrator.query('INSERT INTO mpd_identity.service_state(store_id,deployment_epoch) VALUES($1,$2)', [storeId, epoch]);
      await migrator.query('COMMIT');
    } finally { await migrator.end(); }
    await migrateAuthorizationStore({ ...migrationOptions(db), initialize: false });
    const columns = await db.admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='mpd_identity' AND column_name IN ('token_fingerprint','deadline_at','closed_at') ORDER BY column_name");
    assert.deepEqual(columns.rows, [
      { table_name: 'courses', column_name: 'closed_at' },
      { table_name: 'operation_attempts', column_name: 'deadline_at' },
      { table_name: 'operation_attempts', column_name: 'token_fingerprint' },
    ]);
    const store = await openAuthorizationStore(options(db));
    await store.close();
  } finally { await db.close(); }
});
