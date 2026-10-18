import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { bootstrapAuthorizationRoles, migrateAuthorizationStore } from '../packages/storage/migrations.js';
import { databaseClientConfig } from '../packages/storage/database.js';
import type { TransportMode } from '../packages/storage/types.js';

export async function migrateIdentityCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const allowed = new Set(['--initialize','--bootstrap-roles']);
  if (args.some((arg)=>!allowed.has(arg))) throw new Error('INVALID_MIGRATION_ARGUMENT');
  const migrationUrl=process.env.MIGRATION_DATABASE_URL;
  const expectedStoreId=process.env.AUTHZ_STORE_ID;
  const deploymentEpoch=process.env.AUTHZ_DEPLOY_EPOCH;
  if (!migrationUrl || !expectedStoreId || !deploymentEpoch) throw new Error('MIGRATION_CONFIGURATION_REQUIRED');
  const options={ migrationUrl, expectedStoreId, deploymentEpoch,
    transportMode:process.env.DB_TRANSPORT_MODE as TransportMode, ca:process.env.DB_CA_CERT,
    maintenance:process.env.AUTHZ_MAINTENANCE==='true',initialize:args.includes('--initialize') };
  if (!options.maintenance) throw new Error('MAINTENANCE_REQUIRED');
  if (args.includes('--bootstrap-roles')) {
    const client=new pg.Client(databaseClientConfig(migrationUrl,options));
    client.on('error',()=>{});
    try { await client.connect(); await bootstrapAuthorizationRoles(client); }
    finally { await client.end(); }
    return; // Operator sets protected role passwords and reconnects as migrator for migrations.
  }
  await migrateAuthorizationStore(options);
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  migrateIdentityCli().catch(()=>{ console.error('Identity migration failed; inspect protected operator diagnostics.'); process.exitCode=1; });
}
