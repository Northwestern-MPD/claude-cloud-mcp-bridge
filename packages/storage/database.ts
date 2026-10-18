import pg from 'pg';
import type { ClientConfig } from 'pg';
import type { DatabaseConnectionOptions, OpenStoreOptions, Store, Transaction } from './types.js';
import { LOCK_NAMESPACE, OWNER_LOCK, validateSchema, validateStoreIdentity } from './migrations.js';
import { recoverStartup } from './recovery.js';

/** URL parameters are rejected so pg cannot override the validated host, database or TLS policy. */
export function databaseClientConfig(connectionString: string, options: DatabaseConnectionOptions): ClientConfig {
  let url: URL;
  try { url = new URL(connectionString); } catch { throw new Error('INVALID_DATABASE_URL'); }
  if (!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || url.pathname==='/' || !url.pathname || url.hash || !url.username) throw new Error('INVALID_DATABASE_URL');
  if (url.search) throw new Error('DATABASE_URL_PARAMETERS_FORBIDDEN');
  let ssl: ClientConfig['ssl'] = false;
  if (options.transportMode==='railway-private') {
    if (!url.hostname.endsWith('.railway.internal')) throw new Error('PRIVATE_DATABASE_HOST_REQUIRED');
  } else if (options.transportMode==='verify-full') {
    if (!options.ca?.trim()) throw new Error('DATABASE_CA_REQUIRED');
    ssl={ ca: options.ca, rejectUnauthorized:true, servername:url.hostname };
  } else if (options.transportMode==='local-test') {
    if (process.env.PG_TEST_DISPOSABLE!=='true' || !['127.0.0.1','localhost','::1','[::1]','postgres'].includes(url.hostname) || !url.pathname.startsWith('/mpd_identity_')) throw new Error('DISPOSABLE_LOCAL_DATABASE_REQUIRED');
  } else { throw new Error('INVALID_DATABASE_TRANSPORT'); }
  return { connectionString, ssl, connectionTimeoutMillis:5000, statement_timeout:5000,
    lock_timeout:2000, idle_in_transaction_session_timeout:10000, query_timeout:5500 };
}
function connectionFailure(error: unknown): boolean {
  const code = (error as {code?: string})?.code;
  return Boolean(code && (code.startsWith('08') || ['57P01','57P02','57P03','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE'].includes(code))) ||
    /connection (terminated|closed)|query read timeout|timeout exceeded when trying to connect/i.test(String((error as Error)?.message));
}
async function validateRuntimeRole(client: Transaction): Promise<void> {
  const result = await client.query(`SELECT current_user AS name,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
    has_schema_privilege(current_user,'mpd_identity','CREATE') AS schema_create,
    has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
    pg_has_role(current_user,'mpd_identity_owner','MEMBER') AS owner_member,
    pg_has_role(current_user,'mpd_identity_migrator','MEMBER') AS migrator_member,
    EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles member_role ON member_role.oid=m.member WHERE member_role.rolname=current_user) AS additional_memberships
    FROM pg_roles r WHERE rolname=current_user`);
  const row = result.rows[0];
  if (!row || row.name!=='mpd_identity_app' || row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.rolreplication || row.rolbypassrls || row.schema_create || row.database_create || row.owner_member || row.migrator_member || row.additional_memberships) throw new Error('UNSAFE_RUNTIME_DATABASE_ROLE');
}

export async function openAuthorizationStore(options: OpenStoreOptions): Promise<Store> {
  validateStoreIdentity(options.expectedStoreId,options.deploymentEpoch);
  if (!Number.isSafeInteger(options.tokenIatAfter) || options.tokenIatAfter<0) throw new Error('INVALID_TOKEN_IAT_AFTER');
  const config = databaseClientConfig(options.connectionString,options);
  const owner = new pg.Client({ ...config, application_name:'mpd_identity_owner_connection' });
  const pool = new pg.Pool({ ...config, application_name:'mpd_identity_request_connection', max:5,idleTimeoutMillis:30000 });
  let available = true;
  let closed = false;
  let shuttingDown: Promise<void> | undefined;
  const listeners = new Set<()=>void>();
  function shutdown(): Promise<void> {
    if (!shuttingDown) shuttingDown=pool.end().catch(()=>{}).then(()=>owner.end()).catch(()=>{});
    return shuttingDown;
  }
  function loseAuthority(): void {
    if (!available) return;
    available=false;
    for (const listener of listeners) { try { listener(); } catch { /* Subscribers cannot restore authority. */ } }
    void shutdown();
  }
  owner.on('error',loseAuthority);
  owner.on('end',()=>{ if (!closed) loseAuthority(); });
  pool.on('error',loseAuthority);
  // pg forwards idle failures to Pool; checked-out clients also need a listener.
  pool.on('connect',(client)=>{ client.on('error',loseAuthority); });
  function assertAvailable(): void { if (!available || closed) throw new Error('STORE_UNAVAILABLE'); }
  async function transaction<T>(action:(client:Transaction)=>Promise<T>): Promise<T> {
    assertAvailable();
    let client: pg.PoolClient | undefined;
    let began = false;
    let destroy = false;
    try {
      client=await pool.connect(); assertAvailable();
      await client.query('BEGIN'); began=true;
      const result=await action(client); assertAvailable();
      await client.query('COMMIT'); began=false; assertAvailable();
      return result;
    } catch(error) {
      if (connectionFailure(error)) { destroy=true; loseAuthority(); }
      if (client && began) { try { await client.query('ROLLBACK'); } catch { destroy=true; loseAuthority(); } }
      if (!available) throw new Error('STORE_UNAVAILABLE',{cause:error});
      throw error;
    } finally { client?.release(destroy); }
  }
  try {
    await owner.connect();
    await validateSchema(owner,options.expectedStoreId);
    await validateRuntimeRole(owner);
    const ownership=await owner.query('SELECT pg_try_advisory_lock($1,$2) AS acquired',[LOCK_NAMESPACE,OWNER_LOCK]);
    if (!ownership.rows[0].acquired) throw new Error('STORE_ALREADY_OWNED');
    const bootId = await transaction(async(client)=>{
      await validateSchema(client,options.expectedStoreId);
      return recoverStartup(client,options);
    });
    const store: Store = {
      bootId, expectedStoreId:options.expectedStoreId, deploymentEpoch:options.deploymentEpoch, tokenIatAfter:options.tokenIatAfter,
      transaction,
      async ready() {
        if (!available || closed || options.maintenance) return false;
        try {
          await owner.query('SELECT 1');
          return await transaction(async(client)=>{
            const state=await client.query('SELECT maintenance,boot_id,store_id,deployment_epoch,token_iat_after FROM mpd_identity.service_state WHERE singleton=true');
            const row=state.rows[0];
            if (!row || row.boot_id!==bootId || row.store_id!==options.expectedStoreId || row.deployment_epoch!==options.deploymentEpoch || BigInt(row.token_iat_after)!==BigInt(options.tokenIatAfter)) { loseAuthority(); return false; }
            return !row.maintenance;
          });
        } catch { loseAuthority(); return false; }
      },
      async setMaintenance(enabled) {
        if (!enabled && options.maintenance) throw new Error('EXTERNAL_MAINTENANCE');
        await transaction(async(client)=>{ await client.query('UPDATE mpd_identity.service_state SET maintenance=$1,updated_at=$2 WHERE singleton=true',[enabled,options.now()]); });
      },
      onUnavailable(listener) { listeners.add(listener); if (!available) listener(); return ()=>{ listeners.delete(listener); }; },
      async close() { closed=true; available=false; await shutdown(); },
    };
    return Object.freeze(store);
  } catch(error) {
    closed=true; available=false; await shutdown();
    throw error;
  }
}
