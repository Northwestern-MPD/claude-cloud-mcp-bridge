import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer, request } from 'node:http';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { startIdentityApplication } from '../../apps/identity/main.js';
import { createSocketAdmin } from '../../apps/operator/socket.js';
import { migrateAuthorizationStore } from '../../packages/storage/migrations.js';
import { createTestDatabase } from '../support/storage.js';

async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return port;
}
function health(port: number, path = '/ready'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers: { Host: 'bridge.example' } }, response => { response.resume(); resolve(response.statusCode!); });
    req.on('error', reject); req.end();
  });
}

test('actual identity application opens its private admin socket and honors maintenance before health readiness', async t => {
  const db = await createTestDatabase(); const dir = await mkdtemp(join(tmpdir(), 'identity-main-'));
  let app: Awaited<ReturnType<typeof startIdentityApplication>> | undefined;
  t.after(async () => { await app?.close(); await db.close(); await rm(dir, { recursive: true, force: true }); });
  await db.provisionRoles(); const storeId = randomUUID(), epoch = 'application-test', port = await freePort();
  await migrateAuthorizationStore({ migrationUrl: db.migrationUrl, transportMode: 'local-test', initialize: true, maintenance: true, expectedStoreId: storeId, deploymentEpoch: epoch });
  const env = { AUTH0_ISSUER: 'https://issuer.example/', AUTH0_JWKS_URI: 'https://issuer.example/jwks', AUTH0_ALLOWED_CLIENT_IDS: 'native-test', MCP_RESOURCE_URI: 'https://bridge.example/mcp', MCP_EXTERNAL_ORIGIN: 'https://bridge.example', DATABASE_URL: db.appUrl, DB_TRANSPORT_MODE: 'local-test', AUTHZ_STORE_ID: storeId, AUTHZ_DEPLOY_EPOCH: epoch, AUTHZ_TOKEN_IAT_AFTER: '0', AUTHZ_MAINTENANCE: 'false', AUTHZ_ADMIN_SOCKET: join(dir, 'private/admin.sock'), HOST: '127.0.0.1', PORT: String(port) };
  app = await startIdentityApplication(env);
  assert.equal(await health(port), 503);
  assert.equal(await health(port, '/health'), 200, 'liveness stays available during maintenance');
  const admin = createSocketAdmin(env.AUTHZ_ADMIN_SOCKET);
  assert.deepEqual(await admin.execute({ kind: 'maintenance', enabled: false }), { ok: true, affected: 1 });
  assert.equal(await health(port), 200);
  await assert.rejects(startIdentityApplication({ ...env, PORT: String(await freePort()) }), /STORE_ALREADY_OWNED/);
  assert.equal(await health(port), 200, 'a refused second owner must not stop the incumbent');
  await app.close(); await app.close();
  await assert.rejects(health(port));
  // Explicit close releases ownership so a replacement can start.
  app = await startIdentityApplication(env);
  assert.equal(await health(port), 200);
});

test('application startup failure after store acquisition releases ownership and the HTTP listener', { timeout: 10_000 }, async t => {
  const db = await createTestDatabase(); const dir = await mkdtemp(join(tmpdir(), 'identity-main-refusal-'));
  let app: Awaited<ReturnType<typeof startIdentityApplication>> | undefined;
  t.after(async () => { await app?.close(); await db.close(); await rm(dir, { recursive: true, force: true }); });
  await db.provisionRoles(); const storeId = randomUUID(), epoch = 'application-test', port = await freePort();
  await migrateAuthorizationStore({ migrationUrl: db.migrationUrl, transportMode: 'local-test', initialize: true, maintenance: true, expectedStoreId: storeId, deploymentEpoch: epoch });
  // An owned insecure directory fails consistently on Linux and macOS. Recursive
  // mkdir below /proc can remain pending on Linux before startup can reject.
  await chmod(dir, 0o755);
  const env = { AUTH0_ISSUER: 'https://issuer.example/', AUTH0_JWKS_URI: 'https://issuer.example/jwks', AUTH0_ALLOWED_CLIENT_IDS: 'native-test', MCP_RESOURCE_URI: 'https://bridge.example/mcp', MCP_EXTERNAL_ORIGIN: 'https://bridge.example', DATABASE_URL: db.appUrl, DB_TRANSPORT_MODE: 'local-test', AUTHZ_STORE_ID: storeId, AUTHZ_DEPLOY_EPOCH: epoch, AUTHZ_TOKEN_IAT_AFTER: '0', AUTHZ_MAINTENANCE: 'false', AUTHZ_ADMIN_SOCKET: join(dir, 'refused.sock'), HOST: '127.0.0.1', PORT: String(port) };
  await assert.rejects(startIdentityApplication(env), /INSECURE_ADMIN_DIRECTORY/);
  await assert.rejects(health(port));
  app = await startIdentityApplication({ ...env, AUTHZ_ADMIN_SOCKET: join(dir, 'private/admin.sock') });
  assert.equal(await health(port), 503);
});

test('identity CLI reports only a controlled startup error for missing protected configuration', async () => {
  const execute = promisify(execFile);
  await assert.rejects(execute(process.execPath, ['--import', 'tsx', 'apps/identity/main.ts'], { env: { ...process.env, AUTH0_ISSUER: '' } }), (error: unknown) => {
    const failure = error as { code: number; stdout: string; stderr: string };
    assert.equal(failure.code, 1); assert.equal(failure.stdout, ''); assert.equal(failure.stderr.trim(), 'IDENTITY_STARTUP_FAILED'); return true;
  });
});
