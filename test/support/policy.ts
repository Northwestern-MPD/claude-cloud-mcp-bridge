import { createHash, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import pg from 'pg';
import { createTestDatabase } from './storage.js';
import { signingFixture } from './auth.js';
import { verifyAccessToken } from '../../packages/auth/verifier.js';
import { migrateAuthorizationStore } from '../../packages/storage/migrations.js';
import { openAuthorizationStore } from '../../packages/storage/database.js';
import { enrollInvitation } from '../../packages/storage/enrollment.js';
import { authorizeIdentity } from '../../packages/authorization/identity.js';
import type { Store, Transaction } from '../../packages/storage/types.js';
import type { ContextRef } from '../../packages/storage/contexts.js';

export const POLICY_NOW = 1_800_000_000_000;
export async function policyFixture(t: TestContext) {
  const db = await createTestDatabase();
  let store: Store | undefined;
  const extraClients: pg.Client[] = [];
  t.after(async () => { for (const client of extraClients) await client.end(); await store?.close(); await db.close(); });
  await db.provisionRoles();
  const storeId = randomUUID(), deploymentEpoch = 'durable-policy-test';
  await migrateAuthorizationStore({ migrationUrl: db.migrationUrl, transportMode: 'local-test', initialize: true, maintenance: true, expectedStoreId: storeId, deploymentEpoch });
  let nowMs = POLICY_NOW;
  const clock = () => nowMs;
  const options = { connectionString: db.appUrl, transportMode: 'local-test' as const, expectedStoreId: storeId,
    maintenance: false, deploymentEpoch, tokenIatAfter: 0, now: clock };
  store = await openAuthorizationStore(options);
  await store.setMaintenance(false);
  const courseId = randomUUID(), teamId = randomUUID();
  await db.admin.query("INSERT INTO mpd_identity.courses(id,name,status) VALUES ($1,'Policy test','active')", [courseId]);
  await db.admin.query("INSERT INTO mpd_identity.teams(id,course_id,name,status) VALUES ($1,$2,'Policy team','active')", [teamId, courseId]);
  const signing = await signingFixture(POLICY_NOW);
  async function owner(subject = 'auth0|policy-owner') {
    const token = await signing.mint({ sub: subject });
    const principal = await verifyAccessToken(token, signing.config, signing);
    const auth = { principal, resource: signing.config.resource, tokenFingerprint: createHash('sha256').update(token).digest('hex') };
    await enrollInvitation(store!, { id: randomUUID(), email: `${randomUUID()}@example.edu`, issuer: principal.issuer,
      subject, courseId, teamId, role: 'student', expiresAt: POLICY_NOW + 604_800_000 }, clock);
    const view = await authorizeIdentity(store!, auth, { clock });
    const context: ContextRef = { id: randomUUID(), userId: view.userId, resource: auth.resource,
      clientId: principal.clientId, bootId: store!.bootId, deploymentEpoch };
    // Explicit local harness provenance; never asserts a native/public work-context binding.
    await db.admin.query("INSERT INTO mpd_identity.work_contexts(id,user_id,resource,client_id,binding_provenance,binding_id,boot_id,deployment_epoch,state,expires_at) VALUES ($1,$2,$3,$4,'local-test-harness',$5,$6,$7,'active',$8)", [context.id, context.userId, context.resource, context.clientId, randomUUID(), context.bootId, deploymentEpoch, POLICY_NOW + 7_200_000]);
    return { userId: view.userId, context, auth, token };
  }
  const primary = await owner();
  return {
    db, get store() { return store!; }, clock, options, teamId, courseId, ...primary, owner,
    advance(ms: number) { nowMs += ms; },
    async online(deviceId: string) { await store!.transaction(tx => tx.query('UPDATE mpd_identity.devices SET online=true,connection_epoch=connection_epoch+1 WHERE id=$1', [deviceId]).then(() => {})); },
    async client() { const client = new pg.Client({ connectionString: db.appUrl }); await client.connect(); extraClients.push(client); return client; },
    async independentStore() {
      const client = new pg.Client({ connectionString: db.appUrl }); await client.connect(); extraClients.push(client);
      const wrapper: Store = { ...store!, async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
        await client.query('BEGIN');
        try { const result = await fn(client); await client.query('COMMIT'); return result; }
        catch (error) { await client.query('ROLLBACK'); throw error; }
      } };
      return { store: wrapper, client };
    },
    async reopen() { await store!.close(); store = await openAuthorizationStore(options); await store.setMaintenance(false); return store; },
  };
}
