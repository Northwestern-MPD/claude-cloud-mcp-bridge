import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Client } = pg;
export const DISPOSABLE_MARKER = 'mpd_identity_disposable_test_only';
const TEST_PASSWORD = 'disposable_identity_test_password';

export async function disposableCluster(): Promise<pg.Client> {
  if (process.env.PG_TEST_DISPOSABLE !== 'true') throw new Error('PG_TEST_DISPOSABLE_REQUIRED');
  const adminUrl = new URL(process.env.PG_TEST_ADMIN_URL ?? '');
  const databaseUrl = new URL(process.env.PG_TEST_DATABASE_URL ?? '');
  for (const url of [adminUrl, databaseUrl]) {
    if (!['127.0.0.1', 'localhost', '::1', '[::1]', 'postgres'].includes(url.hostname) ||
        url.pathname !== '/mpd_identity_disposable' || url.search) throw new Error('UNSAFE_TEST_DATABASE');
  }
  if (adminUrl.host !== databaseUrl.host) throw new Error('TEST_CLUSTER_MISMATCH');
  const admin = new Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 5000 });
  await admin.connect();
  try {
    const marker = await admin.query("SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname=current_database()");
    if (marker.rows[0]?.marker !== DISPOSABLE_MARKER) throw new Error('DISPOSABLE_MARKER_REQUIRED');
    return admin;
  } catch (error) { await admin.end(); throw error; }
}

export async function createTestDatabase() {
  const admin = await disposableCluster();
  const name = `mpd_identity_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  await admin.query(`COMMENT ON DATABASE "${name}" IS '${DISPOSABLE_MARKER}'`);
  const url = new URL(process.env.PG_TEST_ADMIN_URL!);
  url.pathname = `/${name}`;
  const privileged = new Client({ connectionString: url.href });
  await privileged.connect();
  const roleUrl = (role: string) => {
    const result = new URL(url);
    result.username = role;
    result.password = TEST_PASSWORD;
    return result.href;
  };
  return {
    name, admin: privileged, migrationUrl: roleUrl('mpd_identity_migrator'),
    appUrl: roleUrl('mpd_identity_app'), backupUrl: roleUrl('mpd_identity_backup'),
    adminUrl: url.href,
    async provisionRoles() {
      // PostgreSQL advisory locks are database-scoped. Every fixture uses this
      // same marked administrative database while mutating cluster-wide roles.
      await admin.query('SELECT pg_advisory_lock(1297105993,3)');
      try {
        const { bootstrapAuthorizationRoles } = await import('../../packages/storage/migrations.js');
        await bootstrapAuthorizationRoles(privileged);
        for (const role of ['mpd_identity_migrator', 'mpd_identity_app', 'mpd_identity_backup']) {
          await privileged.query(`ALTER ROLE ${role} PASSWORD '${TEST_PASSWORD}'`);
        }
      } finally {
        await admin.query('SELECT pg_advisory_unlock(1297105993,3)');
      }
    },
    async close() {
      await privileged.end();
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]);
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    },
  };
}
export type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;
