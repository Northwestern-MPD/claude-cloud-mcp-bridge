import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { PolicyError, policyError } from '../authorization/errors.js';
import type { IdentityRuntime } from '../authorization/runtime.js';
import type { Store } from './types.js';
import { AUTHORIZATION_MIGRATIONS, LOCK_NAMESPACE, MIGRATION_LOCK, OWNER_LOCK, validateSchema } from './migrations.js';
import type { OpenStoreOptions, Transaction } from './types.js';

/** Invoked only after the dedicated connection has acquired exclusive runtime ownership. */
export async function recoverStartup(transaction: Transaction, options: OpenStoreOptions): Promise<string> {
  const state = await transaction.query('SELECT deployment_epoch,token_iat_after FROM mpd_identity.service_state WHERE singleton=true FOR UPDATE');
  const stored = state.rows[0];
  if (!stored) throw new Error('STORE_NOT_INITIALIZED');
  if (BigInt(options.tokenIatAfter)<BigInt(stored.token_iat_after)) throw new Error('TOKEN_IAT_AFTER_DECREASE');
  const changed = stored.deployment_epoch!==options.deploymentEpoch;
  if (changed && !options.maintenance) throw new Error('RECOVERY_MAINTENANCE_REQUIRED');
  if (changed && BigInt(options.tokenIatAfter)<=BigInt(stored.token_iat_after)) throw new Error('RECOVERY_TOKEN_IAT_AFTER_REQUIRED');
  const bootId = randomUUID();
  const now = options.now();
  if (!Number.isSafeInteger(now) || now<0) throw new Error('INVALID_CLOCK');
  await transaction.query("UPDATE mpd_identity.work_contexts SET state='revoked',revoked_at=$1 WHERE state='active'",[now]);
  await transaction.query("UPDATE mpd_identity.pairings SET state='revoked',revoked_at=$1 WHERE state='pending'",[now]);
  await transaction.query("UPDATE mpd_identity.leases SET state='revoked',reason='startup',terminated_at=$1 WHERE state='active'",[now]);
  await transaction.query('UPDATE mpd_identity.devices SET online=false,connection_epoch=connection_epoch+1,updated_at=$1',[now]);
  await transaction.query("UPDATE mpd_identity.operation_attempts SET state='uncertain',reason='startup',completed_at=$1 WHERE state IN ('admitted','dispatched') AND classification='write'",[now]);
  await transaction.query("UPDATE mpd_identity.operation_attempts SET state='denied',reason='startup',completed_at=$1 WHERE state IN ('admitted','dispatched') AND classification='read'",[now]);
  if (changed) {
    await transaction.query("UPDATE mpd_identity.users SET status='suspended',authorization_version=authorization_version+1,updated_at=$1 WHERE status IN ('pending','active')",[now]);
    await transaction.query("UPDATE mpd_identity.memberships SET status='suspended',version=version+1,updated_at=$1 WHERE status IN ('pending','active')",[now]);
    await transaction.query("UPDATE mpd_identity.invitations SET status='revoked' WHERE status='pending'");
    await transaction.query('UPDATE mpd_identity.device_credentials SET revoked_at=$1 WHERE revoked_at IS NULL',[now]);
  }
  await transaction.query('UPDATE mpd_identity.service_state SET boot_id=$1,deployment_epoch=$2,token_iat_after=$3,maintenance=maintenance OR $4,updated_at=$5 WHERE singleton=true',[bootId,options.deploymentEpoch,options.tokenIatAfter,options.maintenance,now]);
  return bootId;
}

export type RecoveryManifest = Readonly<{
  storeId: string; deploymentEpoch: string; tokenIatAfter: number; reviewedAt: number; sourceRefs: readonly string[];
  revocationsVerified: true; approvedMemberships: readonly { userId: string; teamId: string }[];
  disabledUserIds: readonly string[]; removedMemberships: readonly { userId: string; teamId: string }[];
  resourceBlocks: readonly { userId: string; resource: string }[];
}>;
export type MigrationConnection = Readonly<{connectionString:string;transportMode:import('./types.js').TransportMode;ca?:string}>;
export type IntegrityReport = Readonly<{ok:boolean;schemaVersion:number;constraints:number;tables:number;invariants:number;roles:number}>;

export function parseRecoveryManifest(input: unknown): RecoveryManifest {
  const invalid = (): never => { throw new PolicyError('INVALID_RECOVERY_MANIFEST'); };
  const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  const keys = (value: Record<string, unknown>, fields: readonly string[]) => Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
  const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const array = (value: unknown): value is unknown[] => Array.isArray(value) && value.length <= 500;
  const pair = (value: unknown) => record(value) && keys(value, ['userId', 'teamId']) && uuid(value.userId) && uuid(value.teamId);
  const resource = (value: unknown) => {
    if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) return false;
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search && url.href === value; } catch { return false; }
  };
  if (!record(input) || !keys(input, ['storeId', 'deploymentEpoch', 'tokenIatAfter', 'reviewedAt', 'sourceRefs', 'revocationsVerified', 'approvedMemberships', 'disabledUserIds', 'removedMemberships', 'resourceBlocks']) || !uuid(input.storeId) || typeof input.deploymentEpoch !== 'string' || !/^[A-Za-z0-9._-]{1,256}$/.test(input.deploymentEpoch) || !integer(input.tokenIatAfter) || !integer(input.reviewedAt) || input.revocationsVerified !== true) return invalid();
  if (!array(input.sourceRefs) || input.sourceRefs.length === 0 || input.sourceRefs.length > 20 || input.sourceRefs.some(ref => typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/.test(ref))) return invalid();
  if (!array(input.approvedMemberships) || input.approvedMemberships.some(value => !pair(value)) || !array(input.removedMemberships) || input.removedMemberships.some(value => !pair(value)) || !array(input.disabledUserIds) || input.disabledUserIds.some(value => !uuid(value)) || !array(input.resourceBlocks) || input.resourceBlocks.some(value => !record(value) || !keys(value, ['userId', 'resource']) || !uuid(value.userId) || !resource(value.resource))) return invalid();
  if (Buffer.byteLength(JSON.stringify(input)) > 65_000) return invalid();
  return Object.freeze(structuredClone(input)) as RecoveryManifest;
}

export async function reconcileRoster(store: Store, input: RecoveryManifest, runtime: IdentityRuntime, clock: () => number): Promise<{ activated: number }> {
  const manifest = parseRecoveryManifest(input);
  return runtime.coordinator.withFence(async () => {
    try {
      const result = await store.transaction(async tx => {
        const currentRole = (await tx.query('SELECT current_user AS name')).rows[0]?.name;
        if (currentRole !== 'mpd_identity_app') throw new PolicyError('RECOVERY_ROLE_REQUIRED');
        const authority = (await tx.query('SELECT * FROM mpd_identity.service_state WHERE singleton=true FOR UPDATE')).rows[0];
        if (!authority?.maintenance) throw new PolicyError('RECOVERY_MAINTENANCE_REQUIRED');
        if (manifest.storeId !== store.expectedStoreId || authority.store_id !== manifest.storeId || authority.boot_id !== store.bootId || manifest.deploymentEpoch !== store.deploymentEpoch || authority.deployment_epoch !== manifest.deploymentEpoch || manifest.tokenIatAfter !== store.tokenIatAfter || Number(authority.token_iat_after) !== manifest.tokenIatAfter) throw new PolicyError('RECOVERY_AUTHORITY_MISMATCH');
        const requestedUsers = [...new Set([...manifest.disabledUserIds, ...manifest.approvedMemberships.map(value => value.userId), ...manifest.removedMemberships.map(value => value.userId), ...manifest.resourceBlocks.map(value => value.userId)])].sort();
        const users = await tx.query('SELECT id,status FROM mpd_identity.users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [requestedUsers]);
        const existingUsers = new Set<string>(users.rows.map(row => row.id));
        await tx.query('SELECT id FROM mpd_identity.memberships WHERE user_id=ANY($1::uuid[]) ORDER BY user_id,id FOR UPDATE', [requestedUsers]);
        const now = clock();
        if (!Number.isSafeInteger(now) || now < 0 || manifest.reviewedAt > now || now - manifest.reviewedAt > 900_000 || manifest.reviewedAt < Number(authority.updated_at)) throw new PolicyError('RECOVERY_EVIDENCE_STALE');
        // External current denials apply first and cannot be undone by an approval below.
        await tx.query("UPDATE mpd_identity.users SET status='disabled',authorization_version=authorization_version+1,updated_at=$2 WHERE id=ANY($1::uuid[]) AND status<>'disabled'", [manifest.disabledUserIds, now]);
        for (const removal of manifest.removedMemberships) await tx.query("UPDATE mpd_identity.memberships SET status='removed',version=version+1,updated_at=$3 WHERE user_id=$1 AND team_id=$2 AND status<>'removed'", [removal.userId, removal.teamId, now]);
        for (const block of manifest.resourceBlocks) if (existingUsers.has(block.userId)) await tx.query("INSERT INTO mpd_identity.user_resource_blocks(user_id,resource,reason,created_at) VALUES($1,$2,'recovery_manifest',$3) ON CONFLICT(user_id,resource) DO NOTHING", [block.userId, block.resource, now]);
        const disabled = new Set(manifest.disabledUserIds);
        const removed = new Set(manifest.removedMemberships.map(value => `${value.userId}/${value.teamId}`));
        let activated = 0;
        const seen = new Set<string>();
        for (const approval of manifest.approvedMemberships) {
          const key = `${approval.userId}/${approval.teamId}`;
          if (seen.has(key) || disabled.has(approval.userId) || removed.has(key)) continue;
          seen.add(key);
          const membership = (await tx.query(`SELECT m.id,m.status,u.status AS user_status FROM mpd_identity.memberships m JOIN mpd_identity.users u ON u.id=m.user_id JOIN mpd_identity.teams t ON t.id=m.team_id JOIN mpd_identity.courses c ON c.id=t.course_id WHERE m.user_id=$1 AND m.team_id=$2 AND t.status='active' AND c.status='active' AND c.closed_at IS NULL AND EXISTS(SELECT 1 FROM mpd_identity.identities i JOIN mpd_identity.invitations v ON v.issuer=i.issuer AND v.subject=i.subject AND v.user_id=i.user_id WHERE i.user_id=u.id AND i.subject<>'' AND v.team_id=m.team_id AND v.status='accepted') ORDER BY m.created_at DESC LIMIT 1`, [approval.userId, approval.teamId])).rows[0];
          if (!membership) throw new PolicyError('RECOVERY_MEMBERSHIP_NOT_FOUND');
          if (!['active', 'suspended'].includes(membership.user_status) || !['active', 'suspended'].includes(membership.status)) continue;
          if (membership.status !== 'active') {
            await tx.query("UPDATE mpd_identity.memberships SET status='active',version=version+1,updated_at=$2 WHERE id=$1", [membership.id, now]);
            activated++;
          }
          await tx.query("UPDATE mpd_identity.users SET status='active',authorization_version=authorization_version+1,updated_at=$2 WHERE id=$1 AND status='suspended'", [approval.userId, now]);
        }
        const completedAt = clock();
        if (!Number.isSafeInteger(completedAt) || completedAt < manifest.reviewedAt || completedAt - manifest.reviewedAt > 900_000) throw new PolicyError('RECOVERY_EVIDENCE_STALE');
        await tx.query("INSERT INTO mpd_identity.audit_events(id,occurred_at,action,outcome,reason) VALUES($1,$2,'roster_reconciled','allowed','external_evidence_verified')", [randomUUID(), now]);
        return { activated };
      });
      runtime.invalidate({});
      return result;
    } catch (error) { throw policyError(error); }
  });
}

// PostgreSQL17 catalog shape of approved migrations1..2. Includes every column,
// nullability/default, constraint definition/validation, index and table owner.
// Recompute/review deliberately when a schema migration changes; checksums alone
// cannot detect a constraint dropped after migration.
const APPROVED_SCHEMA_V2_SHA256 = '3e0e061e15258c0b1452a0296116635d797dafa6d0d1b9e1da6d99b558d9a081';
const CATALOG_QUERIES = [
  `SELECT c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,r.rolname AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='mpd_identity' AND c.relkind NOT IN('i','S') ORDER BY c.relname`,
  `SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) AS expression FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='mpd_identity' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`,
  `SELECT c.relname,k.conname,k.contype,k.convalidated,k.condeferrable,k.condeferred,pg_get_constraintdef(k.oid,false) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='mpd_identity' ORDER BY c.relname,k.conname`,
  `SELECT c.relname,i.relname AS index_name,x.indisvalid,x.indisready,x.indisunique,pg_get_indexdef(i.oid) AS definition FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='mpd_identity' ORDER BY c.relname,i.relname`,
];

export async function validateRestoredStore(connection: MigrationConnection, expectedStoreId: string): Promise<IntegrityReport> {
  let client: pg.Client | undefined;
  let began = false;
  try {
    if (decodeURIComponent(new URL(connection.connectionString).username) !== 'mpd_identity_migrator') throw new PolicyError('RESTORE_MIGRATION_ROLE_REQUIRED');
    const { databaseClientConfig } = await import('./database.js');
    client = new pg.Client(databaseClientConfig(connection.connectionString, connection));
    client.on('error', () => undefined);
    await client.connect();
    const identity = (await client.query("SELECT current_user AS role,current_setting('server_version_num')::int AS version")).rows[0];
    if (identity.role !== 'mpd_identity_migrator' || Math.floor(identity.version / 10000) !== 17) throw new PolicyError('RESTORE_MIGRATION_ROLE_REQUIRED');
    await client.query('SELECT pg_advisory_lock($1,$2)', [LOCK_NAMESPACE, MIGRATION_LOCK]);
    if (!(await client.query('SELECT pg_try_advisory_lock($1,$2) AS acquired', [LOCK_NAMESPACE, OWNER_LOCK])).rows[0].acquired) throw new PolicyError('STORE_ALREADY_OWNED');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); began = true;
    await client.query('SET LOCAL ROLE mpd_identity_owner');
    await client.query('SET LOCAL search_path=pg_catalog');
    await validateSchema(client, expectedStoreId);
    const shape = [];
    for (const sql of CATALOG_QUERIES) shape.push((await client.query(sql)).rows);
    if (createHash('sha256').update(JSON.stringify(shape)).digest('hex') !== APPROVED_SCHEMA_V2_SHA256) throw new PolicyError('RESTORED_SCHEMA_MISMATCH');
    const unsafeObjects = await client.query("SELECT (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='mpd_identity' AND NOT t.tgisinternal)+(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='mpd_identity') AS count");
    if (Number(unsafeObjects.rows[0].count)) throw new PolicyError('RESTORED_SCHEMA_MISMATCH');
    await validateRestoredPrivileges(client);
    const invariants = [
      "SELECT count(*) AS count FROM mpd_identity.identities WHERE subject !~ '[^[:space:]]' OR issuer !~ '^https://[^/[:space:]]+/' OR connection=''",
      "SELECT count(*) AS count FROM mpd_identity.invitations v WHERE v.status='accepted' AND NOT EXISTS(SELECT 1 FROM mpd_identity.identities i WHERE i.user_id=v.user_id AND i.issuer=v.issuer AND i.subject=v.subject)",
      'SELECT count(*) AS count FROM mpd_identity.leases l JOIN mpd_identity.work_contexts c ON c.id=l.context_id JOIN mpd_identity.devices d ON d.id=l.device_id WHERE l.user_id<>c.user_id OR l.user_id<>d.owner_id',
      'SELECT count(*) AS count FROM mpd_identity.pairings p JOIN mpd_identity.work_contexts c ON c.id=p.context_id WHERE p.owner_id<>c.user_id',
      "SELECT count(*) AS count FROM mpd_identity.work_contexts c CROSS JOIN mpd_identity.service_state s WHERE c.expires_at<=c.created_at OR (c.state='active' AND(c.boot_id IS DISTINCT FROM s.boot_id OR c.deployment_epoch<>s.deployment_epoch))",
      "SELECT count(*) AS count FROM mpd_identity.device_credentials k JOIN mpd_identity.devices d ON d.id=k.device_id CROSS JOIN mpd_identity.service_state s WHERE k.revoked_at IS NULL AND(k.deployment_epoch<>s.deployment_epoch OR d.disabled)",
      "SELECT count(*) AS count FROM mpd_identity.leases l JOIN mpd_identity.work_contexts c ON c.id=l.context_id JOIN mpd_identity.devices d ON d.id=l.device_id WHERE l.state='active' AND(c.state<>'active' OR d.disabled OR l.epoch<>d.connection_epoch OR NOT EXISTS(SELECT 1 FROM mpd_identity.memberships m JOIN mpd_identity.teams t ON t.id=m.team_id JOIN mpd_identity.courses course ON course.id=t.course_id JOIN mpd_identity.users u ON u.id=m.user_id WHERE m.user_id=l.user_id AND m.team_id=l.team_id AND m.status='active' AND u.status='active' AND t.status='active' AND course.status='active'))",
      "SELECT count(*) AS count FROM mpd_identity.operation_attempts o JOIN mpd_identity.leases l ON l.id=o.lease_id WHERE o.device_id<>l.device_id OR o.epoch<>l.epoch OR(o.state IN('admitted','dispatched') AND(o.token_fingerprint IS NULL OR o.deadline_at IS NULL))",
    ];
    for (const sql of invariants) if (Number((await client.query(sql)).rows[0].count) !== 0) throw new PolicyError('RESTORED_AUTHORIZATION_INVARIANT');
    await client.query('COMMIT'); began = false;
    return Object.freeze({ ok: true, schemaVersion: AUTHORIZATION_MIGRATIONS.at(-1)!.version, constraints: shape[2]!.length, tables: shape[0]!.length, invariants: invariants.length, roles: 4 });
  } catch (error) {
    if (client && began) await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof PolicyError) throw error;
    const code = (error as Error)?.message;
    if (['STORE_ID_MISMATCH', 'STORE_NOT_INITIALIZED', 'MIGRATION_CHECKSUM_MISMATCH', 'INCOMPLETE_SCHEMA', 'UNSUPPORTED_SCHEMA'].includes(code)) throw new PolicyError(code);
    throw new PolicyError('RESTORE_VALIDATION_FAILED');
  } finally { await client?.end().catch(() => undefined); }
}

async function validateRestoredPrivileges(client: Transaction): Promise<void> {
  const invalid = () => { throw new PolicyError('RESTORED_ROLE_PRIVILEGES'); };
  const roles = (await client.query("SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=ANY($1)", [['mpd_identity_owner', 'mpd_identity_migrator', 'mpd_identity_app', 'mpd_identity_backup']])).rows;
  if (roles.length !== 4 || roles.some(role => role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls || role.rolcanlogin === (role.rolname === 'mpd_identity_owner'))) invalid();
  const memberships = (await client.query("SELECT member_role.rolname AS member,parent_role.rolname AS parent FROM pg_auth_members m JOIN pg_roles member_role ON member_role.oid=m.member JOIN pg_roles parent_role ON parent_role.oid=m.roleid WHERE member_role.rolname=ANY($1)", [['mpd_identity_owner', 'mpd_identity_migrator', 'mpd_identity_app', 'mpd_identity_backup']])).rows;
  if (memberships.length !== 1 || memberships[0]?.member !== 'mpd_identity_migrator' || memberships[0]?.parent !== 'mpd_identity_owner') invalid();
  const schemas = (await client.query("SELECT n.nspname,r.rolname AS owner,has_schema_privilege('mpd_identity_app',n.oid,'CREATE') AS app_create,has_schema_privilege('mpd_identity_backup',n.oid,'CREATE') AS backup_create,EXISTS(SELECT 1 FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) WHERE grantee=0) AS public FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname='mpd_identity'")).rows;
  if (schemas.length !== 1 || schemas[0]?.owner !== 'mpd_identity_owner' || schemas[0]?.app_create || schemas[0]?.backup_create || schemas[0]?.public) invalid();
  const database = (await client.query("SELECT has_database_privilege('mpd_identity_app',current_database(),'CREATE') AS app_create,has_database_privilege('mpd_identity_backup',current_database(),'CREATE') AS backup_create,EXISTS(SELECT 1 FROM aclexplode(COALESCE(datacl,acldefault('d',datdba))) WHERE grantee=0) AS public FROM pg_database WHERE datname=current_database()")).rows[0];
  if (database.app_create || database.backup_create || database.public) invalid();
  const tables = (await client.query("SELECT c.relname,has_table_privilege('mpd_identity_app',c.oid,'SELECT') AS app_select,has_table_privilege('mpd_identity_app',c.oid,'INSERT') AS app_insert,has_table_privilege('mpd_identity_app',c.oid,'UPDATE') AS app_update,has_table_privilege('mpd_identity_app',c.oid,'DELETE') AS app_delete,has_table_privilege('mpd_identity_backup',c.oid,'SELECT') AS backup_select,has_table_privilege('mpd_identity_backup',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS backup_mutate,has_table_privilege('mpd_identity_app',c.oid,'TRUNCATE,REFERENCES,TRIGGER') AS app_ddl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='mpd_identity' AND c.relkind='r' ORDER BY c.relname")).rows;
  for (const table of tables) {
    const ordinary = !['service_state', 'schema_migrations'].includes(table.relname);
    if (!table.app_select || !table.backup_select || table.backup_mutate || table.app_ddl || table.app_insert !== ordinary || table.app_update !== ordinary || table.app_delete !== ordinary) invalid();
  }
  const columns = (await client.query("SELECT a.attname,has_column_privilege('mpd_identity_app','mpd_identity.service_state',a.attname,'UPDATE') AS writable FROM pg_attribute a WHERE a.attrelid='mpd_identity.service_state'::regclass AND a.attnum>0 AND NOT a.attisdropped")).rows;
  const allowed = ['deployment_epoch', 'token_iat_after', 'maintenance', 'boot_id', 'updated_at'];
  if (columns.some(column => column.writable !== allowed.includes(column.attname))) invalid();
}
