import { pathToFileURL } from 'node:url';
import { validateRestoredStore } from '../packages/storage/recovery.js';
import type { TransportMode } from '../packages/storage/types.js';

/** Operator-only migration credential. Nothing is accepted from the request-serving Store. */
export async function validateIdentityStore(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const connectionString = env.MIGRATION_DATABASE_URL;
  const expectedStoreId = env.AUTHZ_STORE_ID;
  const transportMode = env.DB_TRANSPORT_MODE as TransportMode;
  if (!connectionString || !expectedStoreId || !transportMode) throw new Error('RESTORE_VALIDATION_CONFIG_REQUIRED');
  const report = await validateRestoredStore({ connectionString, transportMode, ...(env.DB_CA_CERT ? { ca: env.DB_CA_CERT } : {}) }, expectedStoreId);
  console.log(JSON.stringify(report));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateIdentityStore().catch(() => { console.error('RESTORE_VALIDATION_FAILED'); process.exitCode = 1; });
}
