import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, mkdir, rm, writeFile, copyFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../support/storage.js';
import { AUTHORIZATION_MIGRATIONS, LOCK_NAMESPACE, OWNER_LOCK, migrateAuthorizationStore } from '../../packages/storage/migrations.js';

const exec = promisify(execFile);
const root = resolve(new URL('../..', import.meta.url).pathname);
const image = 'mpd-identity-test:local';
const docker = (args: string[]) => exec('docker', args, { cwd: root, maxBuffer: 8 * 1024 * 1024, timeout: 240_000 });

test('identity Docker context includes build inputs and excludes nested private artifacts', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mpd-identity-context-'));
  const canary = join(root, 'apps/identity/.env.context-canary');
  const privateCanary = join(root, 'work/identity-context-canary.dump');
  await mkdir(join(root, 'apps/identity'), { recursive: true });
  await mkdir(join(root, 'work'), { recursive: true });
  await writeFile(canary, 'FAKE_PRIVATE_CANARY');
  await writeFile(privateCanary, 'FAKE_PRIVATE_CANARY');
  try {
    await copyFile(join(root, 'Dockerfile.identity.dockerignore'), join(temp, 'Dockerfile.identity.dockerignore'));
    await writeFile(join(temp, 'Dockerfile.identity'), 'FROM scratch\nCOPY . /\n');
    const output = join(temp, 'context');
    await docker(['build', '-f', join(temp, 'Dockerfile.identity'), '--output', `type=local,dest=${output}`, '.']);
    assert.ok(JSON.parse(await readFile(join(output, 'package.json'), 'utf8')).dependencies.pg);
    await access(join(output, 'package-lock.json'));
    await access(join(output, 'tsconfig.json'));
    await access(join(output, 'packages/auth/verifier.ts'));
    await access(join(output, 'scripts/migrate-identity.ts'));
    for (const path of ['apps/identity/.env.context-canary', 'work/identity-context-canary.dump', '.git', 'node_modules', '.env']) {
      await assert.rejects(access(join(output, path)), { code: 'ENOENT' });
    }
  } finally {
    await rm(canary, { force: true });
    await rm(privateCanary, { force: true });
    await rm(temp, { recursive: true, force: true });
  }
});

test('identity image has non-root production Node runtime with pure JavaScript database dependencies', async () => {
  await docker(['build', '-f', 'Dockerfile.identity', '-t', image, '.']);
  const { stdout } = await docker(['image', 'inspect', image, '--format', '{{.Config.User}}']);
  assert.equal(stdout.trim(), 'node');
  const inspect = `const fs=require('node:fs');if(process.getuid()===0)throw Error('ROOT');for(const p of ['/app/apps','/app/test','/app/node_modules/tsx','/app/node_modules/pg-native'])if(fs.existsSync(p))throw Error('UNEXPECTED_SOURCE_OR_DEV_DEP');require('pg');import('jose').then(()=>console.log('production-runtime-ok'));`;
  const runtime = await docker(['run', '--rm', '--entrypoint', 'node', image, '-e', inspect]);
  assert.equal(runtime.stdout.trim(), 'production-runtime-ok');
});

const lifecycleNetwork = 'mpd-m2-tests_default';
const externalHost = 'identity.example.test';
const deploymentEpoch = 'container-lifecycle-test';

async function containerFixture(t: TestContext, schema: 'current' | 'absent' | 'old' = 'current') {
  const db = await createTestDatabase();
  const owned = new Set<string>();
  t.after(async () => {
    for (const container of owned) {
      const logs = await docker(['logs', container]).catch(() => ({ stdout: '', stderr: 'CONTAINER_LOGS_UNAVAILABLE' }));
      await writeFile(join(tmpdir(), `mpd-identity-container-${container}.log`), logs.stdout + logs.stderr, { mode: 0o600 });
      await docker(['rm', '-f', container]).catch(() => undefined);
    }
    await db.close();
  });
  await db.provisionRoles();
  const storeId = randomUUID();
  if (schema === 'current') {
    await migrateAuthorizationStore({ migrationUrl: db.migrationUrl, transportMode: 'local-test', initialize: true,
      maintenance: true, expectedStoreId: storeId, deploymentEpoch });
  } else if (schema === 'old') {
    const first = AUTHORIZATION_MIGRATIONS[0]!;
    await db.admin.query('BEGIN');
    try {
      await db.admin.query('SET LOCAL ROLE mpd_identity_owner');
      await db.admin.query('CREATE SCHEMA mpd_identity AUTHORIZATION mpd_identity_owner');
      await db.admin.query(first.sql);
      await db.admin.query('INSERT INTO mpd_identity.schema_migrations(version,checksum) VALUES ($1,$2)', [first.version, first.checksum]);
      await db.admin.query('INSERT INTO mpd_identity.service_state(store_id,deployment_epoch,maintenance) VALUES ($1,$2,true)', [storeId, deploymentEpoch]);
      await db.admin.query('COMMIT');
    } catch (error) { await db.admin.query('ROLLBACK'); throw error; }
  }
  function containerUrl(value: string): string {
    const url = new URL(value); url.hostname = 'postgres'; url.port = '5432'; return url.href;
  }
  async function start(overrides: Record<string, string> = {}) {
    const env: Record<string, string> = {
      AUTH0_ISSUER: 'https://class.example.auth0.com/',
      AUTH0_JWKS_URI: 'https://class.example.auth0.com/.well-known/jwks.json',
      MCP_RESOURCE_URI: `https://${externalHost}/mcp`, MCP_EXTERNAL_ORIGIN: `https://${externalHost}`,
      AUTH0_ALLOWED_CLIENT_IDS: 'claude-client', DATABASE_URL: containerUrl(db.appUrl), DB_TRANSPORT_MODE: 'local-test',
      PG_TEST_DISPOSABLE: 'true', AUTHZ_STORE_ID: storeId, AUTHZ_DEPLOY_EPOCH: deploymentEpoch,
      AUTHZ_TOKEN_IAT_AFTER: '0', AUTHZ_MAINTENANCE: 'false', HOST: '0.0.0.0', PORT: '8080', ...overrides,
    };
    const args = ['run', '-d', '--name', `mpd-identity-lifecycle-${randomUUID()}`, '--network', lifecycleNetwork];
    for (const [name, value] of Object.entries(env)) args.push('--env', `${name}=${value}`);
    args.push(image);
    const id = (await docker(args)).stdout.trim(); owned.add(id); return id;
  }
  async function state(id: string): Promise<{ Running: boolean; ExitCode: number }> {
    return JSON.parse((await docker(['inspect', id, '--format', '{{json .State}}'])).stdout);
  }
  async function reply(id: string, path: string, method = 'GET'): Promise<{ status: number; body: unknown }> {
    const script = `const q=require('node:http').request({hostname:'127.0.0.1',port:8080,path:${JSON.stringify(path)},method:${JSON.stringify(method)},headers:{host:${JSON.stringify(externalHost)},'content-type':'application/json'}},r=>{let data='';r.on('data',c=>data+=c);r.on('end',()=>console.log(JSON.stringify({status:r.statusCode,body:JSON.parse(data)})));});q.setTimeout(2000,()=>q.destroy());q.on('error',()=>{process.stderr.write('HTTP_NOT_AVAILABLE');process.exitCode=1;});q.end(${method === 'POST' ? "'{}'" : 'undefined'});`;
    return JSON.parse((await docker(['exec', id, 'node', '-e', script])).stdout);
  }
  async function healthy(id: string) {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (!(await state(id)).Running) throw new Error('CONTAINER_EXITED_BEFORE_HEALTH');
      try {
        const result = await reply(id, '/health');
        if (result.status === 200) return result;
        throw new Error(`CONTAINER_HEALTH_HTTP_${result.status}`);
      } catch (error) {
        if ((error as Error).message.startsWith('CONTAINER_HEALTH_HTTP_')) throw error;
        // Poll only connection startup failures on this newly started owned container.
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('CONTAINER_HEALTH_TIMEOUT');
  }
  async function exited(id: string) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const result = await state(id); if (!result.Running) return result;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('CONTAINER_EXIT_TIMEOUT');
  }
  async function maintenance(id: string, enabled: boolean): Promise<{ ok: boolean; affected?: number; code?: string }> {
    const command = JSON.stringify({ kind: 'maintenance', enabled });
    const script = `const s=require('node:net').connect('/tmp/mpd-identity/admin.sock');let data='';s.setTimeout(5000,()=>s.destroy());s.on('connect',()=>s.write(${JSON.stringify(command + '\n')}));s.on('data',c=>data+=c);s.on('end',()=>process.stdout.write(data));s.on('error',()=>{process.stderr.write('ADMIN_REQUEST_FAILED');process.exitCode=1;});`;
    return JSON.parse((await docker(['exec', id, 'node', '-e', script])).stdout);
  }
  async function stop(id: string) { await docker(['stop', '--time', '5', id]); assert.equal((await exited(id)).ExitCode, 0); }
  async function released() {
    const result = await db.admin.query('SELECT pg_try_advisory_lock($1,$2) AS acquired', [LOCK_NAMESPACE, OWNER_LOCK]);
    assert.equal(result.rows[0].acquired, true);
    await db.admin.query('SELECT pg_advisory_unlock($1,$2)', [LOCK_NAMESPACE, OWNER_LOCK]);
  }
  async function seedGrant() {
    const now = Date.now(), userId = randomUUID(), deviceId = randomUUID(), courseId = randomUUID(), teamId = randomUUID(), contextId = randomUUID(), leaseId = randomUUID();
    const bootId = (await db.admin.query('SELECT boot_id FROM mpd_identity.service_state')).rows[0].boot_id;
    await db.admin.query("INSERT INTO mpd_identity.users(id,status) VALUES ($1,'active')", [userId]);
    await db.admin.query("INSERT INTO mpd_identity.courses(id,name) VALUES ($1,'Container test')", [courseId]);
    await db.admin.query("INSERT INTO mpd_identity.teams(id,course_id,name) VALUES ($1,$2,'Container team')", [teamId, courseId]);
    await db.admin.query("INSERT INTO mpd_identity.memberships(id,user_id,team_id,status) VALUES ($1,$2,$3,'active')", [randomUUID(), userId, teamId]);
    await db.admin.query("INSERT INTO mpd_identity.devices(id,owner_id,name,online,connection_epoch) VALUES ($1,$2,'Local test device',true,7)", [deviceId, userId]);
    await db.admin.query("INSERT INTO mpd_identity.work_contexts(id,user_id,resource,client_id,binding_provenance,boot_id,deployment_epoch,state,expires_at) VALUES ($1,$2,$3,'claude-client','local-test-harness',$4,$5,'active',$6)", [contextId, userId, `https://${externalHost}/mcp`, bootId, deploymentEpoch, now + 3_600_000]);
    await db.admin.query("INSERT INTO mpd_identity.leases(id,context_id,user_id,device_id,team_id,capabilities,epoch,expires_at,idle_expires_at,state) VALUES ($1,$2,$3,$4,$5,ARRAY['read'],7,$6,$7,'active')", [leaseId, contextId, userId, deviceId, teamId, now + 3_600_000, now + 600_000]);
    return { bootId, leaseId, deviceId, contextId };
  }
  return { db, storeId, start, state, reply, healthy, exited, maintenance, stop, released, seedGrant, containerUrl };
}

test('container service starts without volumes or privileged credentials and maintains health while admission is closed', async t => {
  const f = await containerFixture(t);
  const id = await f.start();
  assert.deepEqual(await f.healthy(id), { status: 200, body: { status: 'ok' } });
  assert.equal((await f.reply(id, '/ready')).status, 503);
  assert.equal((await f.reply(id, '/mcp', 'POST')).status, 503);
  const mounts = JSON.parse((await docker(['inspect', id, '--format', '{{json .Mounts}}'])).stdout);
  assert.deepEqual(mounts, []);
  const runtime = JSON.parse((await docker(['exec', id, 'node', '-e', "console.log(JSON.stringify({uid:process.getuid(),privileged:['MIGRATION_DATABASE_URL','BACKUP_DATABASE_URL','AUTH0_MANAGEMENT_CLIENT_SECRET'].filter(k=>k in process.env)}))"])).stdout);
  assert.notEqual(runtime.uid, 0); assert.deepEqual(runtime.privileged, []);
  assert.deepEqual(await f.maintenance(id, false), { ok: true, affected: 1 });
  assert.equal((await f.reply(id, '/ready')).status, 200);
  assert.equal((await f.reply(id, '/mcp', 'POST')).status, 401);
  assert.deepEqual(await f.maintenance(id, true), { ok: true, affected: 1 });
  assert.equal((await f.reply(id, '/health')).status, 200);
  assert.equal((await f.reply(id, '/ready')).status, 503);
  assert.equal((await f.reply(id, '/mcp', 'POST')).status, 503);
});

test('container service cannot clear the external maintenance override through its private socket', async t => {
  const f = await containerFixture(t);
  const id = await f.start({ AUTHZ_MAINTENANCE: 'true' });
  await f.healthy(id);
  assert.deepEqual(await f.maintenance(id, false), { ok: false, code: 'EXTERNAL_MAINTENANCE' });
  assert.equal((await f.reply(id, '/ready')).status, 503);
  assert.equal((await f.reply(id, '/health')).status, 200);
});

test('container service refuses overlap without disturbing grants and transfers ownership only after explicit stop', async t => {
  const f = await containerFixture(t);
  const incumbent = await f.start(); await f.healthy(incumbent); await f.maintenance(incumbent, false);
  const grant = await f.seedGrant();
  const overlap = await f.start(); assert.equal((await f.exited(overlap)).ExitCode, 1);
  assert.equal((await f.reply(incumbent, '/ready')).status, 200);
  assert.equal((await f.db.admin.query('SELECT boot_id FROM mpd_identity.service_state')).rows[0].boot_id, grant.bootId);
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.leases WHERE id=$1', [grant.leaseId])).rows[0].state, 'active');
  assert.equal(Number((await f.db.admin.query('SELECT connection_epoch FROM mpd_identity.devices WHERE id=$1', [grant.deviceId])).rows[0].connection_epoch), 7);
  await f.maintenance(incumbent, true); await f.stop(incumbent); await f.released();
  const replacement = await f.start(); await f.healthy(replacement);
  const replacementBoot = (await f.db.admin.query('SELECT boot_id FROM mpd_identity.service_state')).rows[0].boot_id;
  assert.notEqual(replacementBoot, grant.bootId);
  assert.equal((await f.reply(replacement, '/ready')).status, 503);
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.leases WHERE id=$1', [grant.leaseId])).rows[0].state, 'revoked');
  assert.equal((await f.db.admin.query('SELECT online FROM mpd_identity.devices WHERE id=$1', [grant.deviceId])).rows[0].online, false);
  await f.maintenance(replacement, false); assert.equal((await f.reply(replacement, '/ready')).status, 200);
  // A schema-compatible rollback uses the identical explicit stop/release/start procedure.
  await f.maintenance(replacement, true); await f.stop(replacement); await f.released();
  const rollback = await f.start(); await f.healthy(rollback);
  assert.notEqual((await f.db.admin.query('SELECT boot_id FROM mpd_identity.service_state')).rows[0].boot_id, replacementBoot);
  assert.equal((await f.reply(rollback, '/ready')).status, 503);
  await f.maintenance(rollback, false); assert.equal((await f.reply(rollback, '/ready')).status, 200);
});

test('container service exits on dedicated owner loss and a fresh boot keeps old grants invalid', async t => {
  const f = await containerFixture(t);
  const id = await f.start(); await f.healthy(id); await f.maintenance(id, false);
  const grant = await f.seedGrant();
  const terminated = await f.db.admin.query("SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE datname=current_database() AND application_name='mpd_identity_owner_connection'");
  assert.deepEqual(terminated.rows, [{ terminated: true }]);
  assert.equal((await f.exited(id)).ExitCode, 1); await f.released();
  const recovered = await f.start(); await f.healthy(recovered);
  assert.notEqual((await f.db.admin.query('SELECT boot_id FROM mpd_identity.service_state')).rows[0].boot_id, grant.bootId);
  assert.equal((await f.db.admin.query('SELECT state FROM mpd_identity.leases WHERE id=$1', [grant.leaseId])).rows[0].state, 'revoked');
  assert.equal((await f.reply(recovered, '/ready')).status, 200);
});

for (const failure of ['absent schema', 'old schema', 'wrong store', 'missing database', 'migration credentials'] as const) {
  test(`container startup refuses ${failure} before admission`, async t => {
    const f = await containerFixture(t, failure === 'absent schema' ? 'absent' : failure === 'old schema' ? 'old' : 'current');
    const overrides: Record<string, string> = {};
    if (failure === 'wrong store') overrides.AUTHZ_STORE_ID = randomUUID();
    if (failure === 'missing database') {
      const url = new URL(f.containerUrl(f.db.appUrl)); url.pathname = `/mpd_identity_missing_${randomUUID().replaceAll('-', '')}`; overrides.DATABASE_URL = url.href;
    }
    if (failure === 'migration credentials') overrides.DATABASE_URL = f.containerUrl(f.db.migrationUrl);
    const id = await f.start(overrides); assert.equal((await f.exited(id)).ExitCode, 1);
    const logs = await docker(['logs', id]);
    assert.match(logs.stderr, /IDENTITY_STARTUP_FAILED/);
    assert.equal((logs.stdout + logs.stderr).includes('disposable_identity_test_password'), false);
    await f.released();
  });
}
