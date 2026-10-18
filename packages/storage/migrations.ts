import { createHash } from 'node:crypto';
import pg from 'pg';
import type { MigrationOptions, Transaction } from './types.js';

export const LOCK_NAMESPACE = 1297105993;
export const MIGRATION_LOCK = 1;
export const OWNER_LOCK = 2;
const nowDefault = "(extract(epoch FROM clock_timestamp()) * 1000)::bigint";
const initialSql = `
CREATE TABLE mpd_identity.schema_migrations (
  version integer PRIMARY KEY CHECK (version>0), checksum text NOT NULL,
  applied_at bigint NOT NULL DEFAULT (${nowDefault})
);
CREATE TABLE mpd_identity.service_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), store_id uuid NOT NULL,
  deployment_epoch text NOT NULL CHECK (length(deployment_epoch)>0),
  token_iat_after bigint NOT NULL DEFAULT 0 CHECK (token_iat_after BETWEEN 0 AND 9007199254740991),
  maintenance boolean NOT NULL DEFAULT true, boot_id uuid,
  updated_at bigint NOT NULL DEFAULT (${nowDefault})
);
CREATE TABLE mpd_identity.users (
  id uuid PRIMARY KEY, status text NOT NULL CHECK (status IN ('pending','active','suspended','disabled')),
  authorization_version bigint NOT NULL DEFAULT 1 CHECK (authorization_version>0),
  created_at bigint NOT NULL DEFAULT (${nowDefault}), updated_at bigint NOT NULL DEFAULT (${nowDefault})
);
CREATE TABLE mpd_identity.identities (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES mpd_identity.users(id), issuer text NOT NULL,
  subject text NOT NULL, connection text NOT NULL, provider text,
  created_at bigint NOT NULL DEFAULT (${nowDefault}), UNIQUE(issuer,subject)
);
CREATE TABLE mpd_identity.courses (
  id uuid PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at bigint NOT NULL DEFAULT (${nowDefault})
);
CREATE TABLE mpd_identity.teams (
  id uuid PRIMARY KEY, course_id uuid NOT NULL REFERENCES mpd_identity.courses(id), name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at bigint NOT NULL DEFAULT (${nowDefault}), UNIQUE(id,course_id)
);
CREATE TABLE mpd_identity.memberships (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES mpd_identity.users(id),
  team_id uuid NOT NULL REFERENCES mpd_identity.teams(id), status text NOT NULL CHECK (status IN ('pending','active','suspended','removed')),
  role text NOT NULL DEFAULT 'student', version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  created_at bigint NOT NULL DEFAULT (${nowDefault}), updated_at bigint NOT NULL DEFAULT (${nowDefault})
);
CREATE UNIQUE INDEX memberships_current ON mpd_identity.memberships(user_id,team_id) WHERE status<>'removed';
CREATE TABLE mpd_identity.invitations (
  id uuid PRIMARY KEY, email text NOT NULL, issuer text NOT NULL, subject text NOT NULL,
  course_id uuid NOT NULL REFERENCES mpd_identity.courses(id), team_id uuid NOT NULL,
  user_id uuid REFERENCES mpd_identity.users(id), role text NOT NULL DEFAULT 'student' CHECK(role IN ('student','instructor')), status text NOT NULL CHECK (status IN ('pending','accepted','revoked')),
  expires_at bigint NOT NULL, created_at bigint NOT NULL DEFAULT (${nowDefault}), accepted_at bigint,
  FOREIGN KEY(team_id,course_id) REFERENCES mpd_identity.teams(id,course_id)
);
CREATE TABLE mpd_identity.devices (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES mpd_identity.users(id), name text NOT NULL,
  disabled boolean NOT NULL DEFAULT false, online boolean NOT NULL DEFAULT false,
  connection_epoch bigint NOT NULL DEFAULT 0 CHECK(connection_epoch>=0),
  created_at bigint NOT NULL DEFAULT (${nowDefault}), updated_at bigint NOT NULL DEFAULT (${nowDefault})
);
CREATE TABLE mpd_identity.device_credentials (
  id uuid PRIMARY KEY, device_id uuid NOT NULL REFERENCES mpd_identity.devices(id), fingerprint text NOT NULL UNIQUE,
  generation bigint NOT NULL CHECK(generation>0), deployment_epoch text NOT NULL,
  expires_at bigint NOT NULL, revoked_at bigint, last_used_at bigint,
  created_at bigint NOT NULL DEFAULT (${nowDefault}), UNIQUE(device_id,generation)
);
CREATE TABLE mpd_identity.work_contexts (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES mpd_identity.users(id), resource text NOT NULL,
  client_id text NOT NULL, binding_provenance text, binding_id text, boot_id uuid NOT NULL,
  deployment_epoch text NOT NULL, state text NOT NULL CHECK(state IN ('active','revoked','expired')),
  expires_at bigint NOT NULL, created_at bigint NOT NULL DEFAULT (${nowDefault}), revoked_at bigint
);
CREATE TABLE mpd_identity.pairings (
  id uuid PRIMARY KEY, context_id uuid NOT NULL REFERENCES mpd_identity.work_contexts(id),
  owner_id uuid NOT NULL REFERENCES mpd_identity.users(id), team_id uuid NOT NULL REFERENCES mpd_identity.teams(id),
  fingerprint text NOT NULL UNIQUE, capabilities text[] NOT NULL CHECK(capabilities <@ ARRAY['read','execute']::text[]),
  expires_at bigint NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','consumed','revoked','expired')),
  created_at bigint NOT NULL DEFAULT (${nowDefault}), consumed_at bigint, revoked_at bigint
);
CREATE TABLE mpd_identity.leases (
  id uuid PRIMARY KEY, context_id uuid NOT NULL REFERENCES mpd_identity.work_contexts(id),
  user_id uuid NOT NULL REFERENCES mpd_identity.users(id), device_id uuid NOT NULL REFERENCES mpd_identity.devices(id),
  team_id uuid NOT NULL REFERENCES mpd_identity.teams(id), capabilities text[] NOT NULL CHECK(capabilities <@ ARRAY['read','execute']::text[]),
  epoch bigint NOT NULL CHECK(epoch>=0), expires_at bigint NOT NULL, idle_expires_at bigint NOT NULL,
  state text NOT NULL CHECK(state IN ('active','revoked','expired','released')), reason text,
  created_at bigint NOT NULL DEFAULT (${nowDefault}), terminated_at bigint
);
CREATE UNIQUE INDEX leases_active_user ON mpd_identity.leases(user_id) WHERE state='active';
CREATE UNIQUE INDEX leases_active_device ON mpd_identity.leases(device_id) WHERE state='active';
CREATE TABLE mpd_identity.operation_attempts (
  id uuid PRIMARY KEY, request_id text NOT NULL UNIQUE, correlation_id text,
  lease_id uuid NOT NULL REFERENCES mpd_identity.leases(id), device_id uuid NOT NULL REFERENCES mpd_identity.devices(id),
  epoch bigint NOT NULL CHECK(epoch>=0), classification text NOT NULL CHECK(classification IN ('read','write')),
  state text NOT NULL CHECK(state IN ('admitted','dispatched','completed','uncertain','denied')),
  created_at bigint NOT NULL DEFAULT (${nowDefault}), dispatched_at bigint, completed_at bigint, reason text
);
CREATE TABLE mpd_identity.token_denials (
  fingerprint text PRIMARY KEY, user_id uuid REFERENCES mpd_identity.users(id), resource text,
  expires_at bigint NOT NULL, reason text NOT NULL, created_at bigint NOT NULL DEFAULT (${nowDefault})
);
CREATE TABLE mpd_identity.user_resource_blocks (
  user_id uuid NOT NULL REFERENCES mpd_identity.users(id), resource text NOT NULL, reason text NOT NULL,
  created_at bigint NOT NULL DEFAULT (${nowDefault}), PRIMARY KEY(user_id,resource)
);
CREATE TABLE mpd_identity.audit_events (
  id uuid PRIMARY KEY, occurred_at bigint NOT NULL DEFAULT (${nowDefault}), actor_id uuid REFERENCES mpd_identity.users(id),
  resource text, device_id uuid REFERENCES mpd_identity.devices(id), grant_id uuid REFERENCES mpd_identity.leases(id),
  action text NOT NULL, outcome text NOT NULL, reason text, correlation_id text
);
REVOKE ALL ON ALL TABLES IN SCHEMA mpd_identity FROM PUBLIC;
GRANT USAGE ON SCHEMA mpd_identity TO mpd_identity_app,mpd_identity_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA mpd_identity TO mpd_identity_backup;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA mpd_identity TO mpd_identity_app;
REVOKE INSERT,UPDATE,DELETE ON mpd_identity.schema_migrations FROM mpd_identity_app;
REVOKE INSERT,UPDATE,DELETE ON mpd_identity.service_state FROM mpd_identity_app;
GRANT UPDATE(deployment_epoch,token_iat_after,maintenance,boot_id,updated_at) ON mpd_identity.service_state TO mpd_identity_app;
`;
const operationRecoverySql = `
ALTER TABLE mpd_identity.operation_attempts
  ADD COLUMN token_fingerprint text CHECK (token_fingerprint IS NULL OR token_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD COLUMN deadline_at bigint CHECK (deadline_at IS NULL OR deadline_at>0);
ALTER TABLE mpd_identity.courses ADD COLUMN closed_at bigint CHECK (closed_at IS NULL OR closed_at>=0);
`;
export const AUTHORIZATION_MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, sql: initialSql, checksum: createHash('sha256').update(initialSql).digest('hex') }),
  Object.freeze({ version: 2, sql: operationRecoverySql, checksum: createHash('sha256').update(operationRecoverySql).digest('hex') }),
]);

export function validateStoreIdentity(storeId: string, epoch: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(storeId)) throw new Error('INVALID_STORE_ID');
  if (!epoch || epoch.length>256 || /[\x00-\x1f]/.test(epoch)) throw new Error('INVALID_DEPLOYMENT_EPOCH');
}

export async function validateSchema(client: Transaction, expectedStoreId: string, allowPending = false): Promise<void> {
  const tables = await client.query("SELECT to_regclass('mpd_identity.service_state') AS state, to_regclass('mpd_identity.schema_migrations') AS migrations");
  if (!tables.rows[0]?.state || !tables.rows[0]?.migrations) throw new Error('STORE_NOT_INITIALIZED');
  const state = await client.query('SELECT store_id FROM mpd_identity.service_state WHERE singleton=true');
  if (state.rowCount!==1) throw new Error('STORE_NOT_INITIALIZED');
  if (state.rows[0].store_id!==expectedStoreId) throw new Error('STORE_ID_MISMATCH');
  const applied = await client.query('SELECT version,checksum FROM mpd_identity.schema_migrations ORDER BY version');
  const latest = AUTHORIZATION_MIGRATIONS.at(-1)!.version;
  if (applied.rows.some((row) => row.version>latest)) throw new Error('UNSUPPORTED_SCHEMA');
  if (!applied.rowCount || (!allowPending && applied.rowCount!==AUTHORIZATION_MIGRATIONS.length)) throw new Error('INCOMPLETE_SCHEMA');
  for (const [index, row] of applied.rows.entries()) {
    const migration = AUTHORIZATION_MIGRATIONS[index];
    if (!migration || row.version!==migration.version) throw new Error('INCOMPLETE_SCHEMA');
    if (row.checksum!==migration.checksum) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
  }
}

/** Explicit privileged operator setup only. Does not set or emit passwords. */
export async function bootstrapAuthorizationRoles(client: Transaction): Promise<void> {
  await client.query('BEGIN');
  try {
    // Role names are global: serialize bootstrap independently of schema migrations.
    await client.query('SELECT pg_advisory_xact_lock($1,0)',[LOCK_NAMESPACE]);
    for (const role of ['mpd_identity_owner','mpd_identity_migrator','mpd_identity_app','mpd_identity_backup']) {
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role]);
      if (!exists.rowCount) await client.query(`CREATE ROLE ${role} ${role==='mpd_identity_owner'?'NOLOGIN':'LOGIN'} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
    }
    const roles = await client.query("SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=ANY($1)",[['mpd_identity_owner','mpd_identity_migrator','mpd_identity_app','mpd_identity_backup']]);
    if (roles.rows.some((role)=>role.rolsuper||role.rolcreatedb||role.rolcreaterole||role.rolreplication||role.rolbypassrls||(role.rolname==='mpd_identity_owner'?role.rolcanlogin:!role.rolcanlogin))) throw new Error('UNSAFE_DATABASE_ROLE');
    await client.query('GRANT mpd_identity_owner TO mpd_identity_migrator');
    const database = await client.query('SELECT current_database() AS name');
    const quoted = '"'+String(database.rows[0].name).replaceAll('"','""')+'"';
    await client.query(`ALTER DATABASE ${quoted} OWNER TO mpd_identity_owner`);
    await client.query(`REVOKE ALL ON DATABASE ${quoted} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${quoted} TO mpd_identity_migrator,mpd_identity_app,mpd_identity_backup`);
    await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; }
}

export async function migrateAuthorizationStore(options: MigrationOptions): Promise<void> {
  if (!options.maintenance) throw new Error('MAINTENANCE_REQUIRED');
  validateStoreIdentity(options.expectedStoreId,options.deploymentEpoch);
  const { databaseClientConfig } = await import('./database.js');
  const client = new pg.Client(databaseClientConfig(options.migrationUrl,options));
  client.on('error',()=>{});
  try {
    await client.connect();
    await client.query('SELECT pg_advisory_lock($1,$2)',[LOCK_NAMESPACE,MIGRATION_LOCK]);
    const lock = await client.query('SELECT pg_try_advisory_lock($1,$2) AS acquired',[LOCK_NAMESPACE,OWNER_LOCK]);
    if (!lock.rows[0].acquired) throw new Error('STORE_ALREADY_OWNED');
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE mpd_identity_owner');
      const existing = await client.query("SELECT to_regclass('mpd_identity.service_state') AS state");
      if (!existing.rows[0].state) {
        if (!options.initialize) throw new Error('STORE_NOT_INITIALIZED');
        await client.query('CREATE SCHEMA IF NOT EXISTS mpd_identity AUTHORIZATION mpd_identity_owner');
        await client.query('REVOKE ALL ON SCHEMA mpd_identity FROM PUBLIC');
        for (const migration of AUTHORIZATION_MIGRATIONS) {
          await client.query(migration.sql);
          await client.query('INSERT INTO mpd_identity.schema_migrations(version,checksum) VALUES($1,$2)',[migration.version,migration.checksum]);
        }
        await client.query('INSERT INTO mpd_identity.service_state(store_id,deployment_epoch,maintenance) VALUES($1,$2,true)',[options.expectedStoreId,options.deploymentEpoch]);
      } else {
        await validateSchema(client,options.expectedStoreId,true);
        const applied = await client.query('SELECT version FROM mpd_identity.schema_migrations ORDER BY version');
        for (const migration of AUTHORIZATION_MIGRATIONS.slice(applied.rows.length)) {
          await client.query(migration.sql);
          await client.query('INSERT INTO mpd_identity.schema_migrations(version,checksum) VALUES($1,$2)',[migration.version,migration.checksum]);
        }
        await validateSchema(client,options.expectedStoreId);
        await client.query('UPDATE mpd_identity.service_state SET maintenance=true');
      }
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; }
  } finally { await client.end(); }
}
