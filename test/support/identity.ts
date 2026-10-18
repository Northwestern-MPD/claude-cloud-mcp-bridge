import { randomUUID } from 'node:crypto';
import { request as nodeRequest } from 'node:http';
import { Readable } from 'node:stream';
import type { TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestDatabase } from './storage.js';
import { signingFixture } from './auth.js';
import { verifyAccessToken } from '../../packages/auth/index.js';
import { migrateAuthorizationStore } from '../../packages/storage/migrations.js';
import { openAuthorizationStore } from '../../packages/storage/database.js';
import { enrollInvitation } from '../../packages/storage/enrollment.js';
import { createIdentityRuntime } from '../../packages/authorization/runtime.js';
import { startIdentityServer } from '../../apps/identity/server.js';
import type { IdentityConfig } from '../../apps/identity/config.js';

export async function identityFixture(t: TestContext, options: { enrolled?: boolean; maintenance?: boolean; cutoff?: number } = {}) {
  const db = await createTestDatabase();
  const closes: (() => Promise<unknown>)[] = [];
  t.after(async () => { for (const close of closes.reverse()) await close().catch(() => undefined); await db.close(); });
  await db.provisionRoles();
  const storeId = randomUUID();
  await migrateAuthorizationStore({ migrationUrl: db.migrationUrl, transportMode: 'local-test', initialize: true, maintenance: true, expectedStoreId: storeId, deploymentEpoch: 'http-test' });
  let nowMs = Date.now();
  const clock = () => nowMs;
  const store = await openAuthorizationStore({ connectionString: db.appUrl, transportMode: 'local-test', expectedStoreId: storeId, maintenance: false, deploymentEpoch: 'http-test', tokenIatAfter: options.cutoff ?? 0, now: clock });
  closes.push(() => store.close());
  if (!options.maintenance) await store.setMaintenance(false);
  const courseId = randomUUID(), teamId = randomUUID();
  await db.admin.query("INSERT INTO mpd_identity.courses(id,name,status) VALUES($1,'HTTP course','active')", [courseId]);
  await db.admin.query("INSERT INTO mpd_identity.teams(id,course_id,name,status) VALUES($1,$2,'HTTP team','active')", [teamId, courseId]);
  const signing = await signingFixture(nowMs);
  if (options.enrolled !== false) await enrollInvitation(store, { id: randomUUID(), email: 'http-student@example.edu', issuer: signing.config.issuer, subject: 'auth0|student-1', courseId, teamId, role: 'student', expiresAt: nowMs + 86_400_000 }, clock);
  const runtime = createIdentityRuntime(store);
  const config: IdentityConfig = {
    auth: { ...signing.config, allowedClientIds: ['claude-client', 'other-client'] },
    database: { connectionString: db.appUrl, transportMode: 'local-test', expectedStoreId: storeId, maintenance: false, deploymentEpoch: 'http-test', tokenIatAfter: options.cutoff ?? 0 },
    externalOrigin: 'https://bridge.example', allowedOrigins: ['https://bridge.example'], host: '127.0.0.1', port: 0, maintenance: false, adminSocketPath: '/tmp/mpd-identity-test/admin.sock',
  };
  let server = await startIdentityServer({ config, store, runtime, verify: token => verifyAccessToken(token, config.auth, signing), clock });
  const initialServer = server;
  closes.push(() => initialServer.close());
  const bearer = await signing.mint();
  const headers = { Host: 'bridge.example', Authorization: `Bearer ${bearer}` };
  async function request(path: string, init: RequestInit = {}) {
    return hostPreservingFetch(`${server.url}${path}`, { ...init, headers: { ...headers, ...init.headers } });
  }
  async function sdk(token = bearer) {
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { fetch: hostPreservingFetch, requestInit: { headers: { Host: 'bridge.example', Authorization: `Bearer ${token}` } } });
    const client = new Client({ name: 'identity-http-test', version: '1.0.0' });
    await client.connect(transport);
    closes.push(() => client.close());
    return { client, transport };
  }
  async function restart() {
    await server.close();
    await store.close();
    const restartedStore = await openAuthorizationStore({ ...config.database, now: clock });
    closes.push(() => restartedStore.close());
    const restartedRuntime = createIdentityRuntime(restartedStore);
    server = await startIdentityServer({ config, store: restartedStore, runtime: restartedRuntime, verify: token => verifyAccessToken(token, config.auth, signing), clock });
    const restartedServer = server;
    closes.push(() => restartedServer.close());
    return { store: restartedStore, runtime: restartedRuntime, server: restartedServer };
  }
  return { db, store, runtime, config, server, signing, headers, bearer, courseId, teamId, clock, advance(ms: number) { nowMs += ms; }, request, sdk, restart };
}

// Node22 fetch replaces caller Host with the connection host. This real HTTP adapter
// models a trusted front proxy's unchanged public Host while connecting to loopback.
const hostPreservingFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.from(await request.arrayBuffer());
  return await new Promise<Response>((resolve, reject) => {
    const outgoing = nodeRequest(request.url, { method: request.method, headers: Object.fromEntries(request.headers), signal: request.signal }, response => {
      const headers = new Headers();
      for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
      resolve(new Response([204, 205, 304].includes(response.statusCode!) ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status: response.statusCode!, headers }));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
};
