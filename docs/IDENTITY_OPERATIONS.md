# Identity service operations and recovery

This runbook describes the milestone2 identity service and its private PostgreSQL authority store. It does not enable production desktop control. Example paths, service names, UUIDs and JSON below must be replaced with reviewed operator inputs. Keep raw roster records, exact subject mappings, recovery evidence and command files under a protected operator directory; `work/identity-operator/` is ignored by Git. Use directory mode0700 and file mode0600. Keep credentials in protected configuration, never command arguments, Git, logs, MCP arguments or the serving app's operator records.

## Observed and unverified evidence

Local acceptance uses PostgreSQL17 in the explicitly disposable `mpd-m2-tests` Compose project (`mpd-m2-tests-postgres-1`, loopback55432). The restore tests use that container's matching-major pg_dump/pg_restore, a read-only backup role, restricted migration/app roles, custom-format archives in private temporary directories, and separate newly created target databases. They exercise consistent export during committed writes, integrity/privilege validation, recovery suspension, cutoff enforcement and external roster reconciliation.

Hosted database version, daily Railway backup entitlement, enabled schedule, platform backup retention, measured cost, restore performance and PITR are **NOT VERIFIED by this runbook**. Record each actual hosted observation in the protected operator evidence and the deployment acceptance record before relying on it. Local tests and provider documentation do not establish those facts. Native Claude OAuth compatibility and independent same-user cloud context isolation require separate evidence; identity-only evaluation remains partial until the required gates pass.

## Authority configuration and startup

The serving process receives only the limited `mpd_identity_app` DATABASE_URL. Its database transport is explicit: railway-private permits plaintext only for `.railway.internal`; external operator/admin connections use verify-full with a trusted CA. Do not disable certificate verification. Local-test is limited to explicitly marked disposable databases and is not production configuration.

Provision a dedicated database/schema and four roles through the operator migration job: NOLOGIN `mpd_identity_owner`, migration login allowed to SET ROLE owner, limited app login, and SELECT-only backup login. The app has no superuser, role/database creation, schema creation or migration privileges. Migration and backup credentials remain outside its environment. Global roles/passwords are not included in a schema dump and must be provisioned and rotated separately on the target.

The operator migration CLI accepts `--bootstrap-roles` separately from migrations. Bootstrap uses the privileged operator connection, creates roles/database privileges only, and returns before creating schema. Reconnect as the migration role for schema migrations. Initial provisioning uses `--initialize` under explicit maintenance; ordinary startup and restore validation never initialize missing schema. Do not run `--initialize` before restoring an archive into an otherwise empty target schema.

Startup validates migration checksums, store UUID and app-role safety, then acquires a dedicated single-owner advisory lock. It generates a new boot ID, revokes old contexts/pairings/leases, marks devices offline with a newer connection epoch, and marks unfinished write intents uncertain. A replacement that cannot obtain ownership exits without invalidating the incumbent. A database/pool/owner loss closes admission and ends that serving lifetime; restart must complete recovery. No mutation is replayed.

Configure the exact HTTPS AUTH0_ISSUER including its slash, configured JWKS URI, MCP_RESOURCE_URI ending `/mcp`, matching MCP_EXTERNAL_ORIGIN, allowed clients, and browser MCP_ALLOWED_ORIGINS. Host/proxy headers never choose resource identity. Public /health contains liveness only; /ready is503 until stored and external maintenance permit admissions and the current store/owner checks pass. Request deadlines are35seconds and headers10seconds; per-operation local test RPC deadlines are30seconds.

## Private administrative path

Administrative commands go through the0600 Unix socket at AUTHZ_ADMIN_SOCKET (default `/tmp/mpd-identity/admin.sock`) in its0700 parent. Reach it through the authenticated Railway shell or approved equivalent. There is no public admin HTTP/MCP endpoint. Each command shares the serving runtime's admission coordinator through commit and invalidation; delegated reconciliation/revocation acquire that fence once.

Write a strictly bounded JSON command into a private0600 file and run the operator CLI with `admin --file /protected/command.json`. Supported commands include maintenance, exact-subject invitation import, disable-user, remove-membership, block-resource, deny-token, revoke-device, close-course, retention and reconcile-roster. Reports expose counts/status only. The deny-token convenience command reads the raw token from protected stdin and emits only its fingerprint into the admin command; never place a bearer on a command line or in a shell transcript.

Examples of command bodies (illustrative values, not working resources):

```json
{"kind":"maintenance","enabled":true}
```

```json
{"kind":"close-course","courseId":"00000000-0000-4000-8000-000000000001"}
```

```json
{"kind":"retention"}
```

close-course records the first closure timestamp, disables the course/teams, removes current memberships, revokes pending invitations/pairings and active leases, and makes unfinished writes uncertain. Team transports are invalidated before acknowledgement. Repeating the command preserves the original closure date. Do not use direct serving SQL as a substitute for this command. SQL shown below is restricted to offline, isolated target provisioning/validation by a trusted operator.

## Every deployment and rollback

1. Disable GitHub autodeploys and automatic image updates for the identity service. Stage variables/build settings without starting a replacement. Preserve AUTHZ_STORE_ID, AUTHZ_DEPLOY_EPOCH and the external issuance cutoff on every release and rollback.
2. Enable stored maintenance through the private socket. Stop new admissions, invalidate/drain active work for at most the30-second RPC deadline, and mark unfinished mutation intents uncertain.
3. Stop the incumbent deployment and verify its dedicated owner connection/advisory lock is gone. Force-stop an unresponsive incumbent if required, then verify lock release. One configured replica is not a handoff mechanism.
4. Start the schema-compatible replacement. Check health200, readiness503 and denied student admission while maintenance remains active. Clear stored maintenance through the private socket only when AUTHZ_MAINTENANCE=false, then require ready200 plus an unauthorized-account denial.

The external AUTHZ_MAINTENANCE=true flag is a hard deny and cannot be cleared by the socket. Changes to that flag still follow stop/drain/lock-release/start; avoid automatic rolling deployment overlap.

### Current Railway service configuration

The new `class-identity` service uses API/dashboard configuration. Railway deprecated legacy `railway.json`/`railway.toml` configuration for new services and rejects opting in with `railwayConfigFile`; the existing probe still uses its legacy configuration. The identity service explicitly selects `Dockerfile.identity`, `node dist/apps/identity/main.js`, `/health`, a 60-second health timeout, 30-second drain, zero overlap, and one replica in `iad`. Its per-container limit is 1 vCPU/500,000,000 bytes memory, also applied to private Postgres. These are configured limits, not measured cost or a spending cap. Verify the live settings before connecting a pinned source commit; avoid enabling autodeploy. [Railway configuration transition](https://docs.railway.com/infrastructure-as-code).

## Daily database backups and portable export

Enable daily backups on the **database service**, then record the actual Railway schedule, plan entitlement, retention, encryption/access policy and measured cost. Keep platform backup retention distinct from application row retention. PITR is optional after its availability, cost and restore drill are observed. Retain the original database for rollback; backup/restore authorization does not authorize deleting it.

Use PostgreSQL17 tools for the local selected major; confirm the hosted major and match its tools before a hosted operation. A developer's older psql/pg_dump installation is not an acceptable substitute. Production tools run in an approved operator environment or authenticated database shell, not the identity request-serving image.

Store connection details in a protected libpq service file and password file (0600); choose a read-only backup service and a separate target migration service. The following commands use operator-defined paths and public encryption recipient metadata. They contain no credential URL or password:

```bash
umask 077
export PGSERVICEFILE=/protected/pg_service.conf
export PGPASSFILE=/protected/identity.pgpass
export PGSERVICE=identity_backup
pg_dump --format=custom --schema=mpd_identity --no-owner --no-privileges --file=/protected/authority.dump
age --recipient "$MPD_BACKUP_RECIPIENT" --output /protected/authority.dump.age /protected/authority.dump
```

Record command exit status, tool/server versions, protected archive digest, snapshot time and source store/deployment epoch without dumping rows or credentials. Verify encrypted artifact access/recoverability, then remove plaintext staging through the approved operator cleanup process. Store encrypted copies in protected backup storage; do not copy them into Git, an app image, routine logs or model context. Keep decryption identities separately protected.

Schema selection includes both data and definitions; `--schema-only` would omit enrollment/denial data. pg_dump supplies a consistent snapshot while normal transactions commit. Custom archives can retain owner labels; `--no-owner` is enforced again at restore so labels never assign target ownership, and ACLs are not replayed. See [PostgreSQL17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html) and [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html).

## Isolated restore procedure

1. Enable external maintenance, enable stored maintenance on the incumbent, drain, stop it and verify owner-lock release. Record trusted current UTC **after** stop/drain. Set a new external AUTHZ_TOKEN_IAT_AFTER to at least that Unix-seconds time plus60seconds, strictly above the existing maximum. Record it outside PostgreSQL before restoring. A copied snapshot cannot recover a denial that happened after that snapshot; the cutoff permanently rejects all those old tokens.
2. Create a separate empty target database. Confirm its identity twice from protected operator records. Keep the original isolated for rollback. Provision/validate target roles and explicit database privileges with the privileged bootstrap job; assign protected rotated passwords. Do not initialize the schema or use `--clean`/`--create` against the incumbent.
3. Decrypt the reviewed trusted archive into a private staging directory. Under the target migration login, restore as the NOLOGIN schema owner:

```bash
export PGSERVICE=identity_restore_target
pg_restore --exit-on-error --no-owner --no-privileges --role=mpd_identity_owner --dbname=identity_restore_target /protected/authority.dump
```

The database argument above is an illustrative database name, not a credential string; its configured host/user/password/TLS still come from protected libpq configuration. Restore errors stop the procedure. An incomplete target never receives serving credentials/admission.

4. Explicitly regrant the reviewed target privileges under the migration/owner role. Do not restore broad historical ACLs:

```sql
SET ROLE mpd_identity_owner;
GRANT USAGE ON SCHEMA mpd_identity TO mpd_identity_app, mpd_identity_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA mpd_identity TO mpd_identity_backup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mpd_identity TO mpd_identity_app;
REVOKE INSERT, UPDATE, DELETE ON mpd_identity.schema_migrations FROM mpd_identity_app;
REVOKE INSERT, UPDATE, DELETE ON mpd_identity.service_state FROM mpd_identity_app;
GRANT UPDATE(deployment_epoch, token_iat_after, maintenance, boot_id, updated_at)
  ON mpd_identity.service_state TO mpd_identity_app;
```

5. While no runtime owns the target, run `node dist/scripts/validate-identity-store.js` from the approved operator build with MIGRATION_DATABASE_URL, DB_TRANSPORT_MODE, trusted DB_CA_CERT where applicable, and AUTHZ_STORE_ID in protected configuration. No URL is accepted as a CLI argument. Validation acquires the migration and owner locks and uses a read-only transaction. It verifies the exact approved PostgreSQL17 schema shape (all columns/defaults/nullability,73 constraints,26 indexes and owners for migrations1..2), checksums/store marker, required limited role privileges, absence of unapproved functions/triggers, and cross-table identity/owner/context/credential/grant invariants. The report contains counts/status; success is not an approval to resume. A schema change requires review of both migrations and the validator's explicit catalog fingerprint.
6. Advance AUTHZ_DEPLOY_EPOCH and the external issuance cutoff, rotate the app database credential, and switch the private DATABASE_URL to the target. Start a recovery instance with AUTHZ_MAINTENANCE=true. A changed epoch additionally requires a strictly increased cutoff and external maintenance. Startup persists the monotonic cutoff, suspends restored active/pending users and memberships, revokes restored pending invitations, revokes old credentials/contexts/pairings/leases, and marks devices offline. Confirm health200/ready503 and denied admission. Do not replay tools to validate the restore.
7. Reconcile current roster/denial evidence as described below. Deliberately issue new device credentials only through the approved later enrollment procedure; reconciliation never activates devices or leases. Public desktop tools remain unavailable.
8. Use stop/drain/lock-release/start again to remove the external maintenance flag while preserving the same epoch/cutoff. Stored maintenance remains closed until the operator deliberately clears it. Check old unexpired token denial, fresh-token denial for current disabled/removed/resource-blocked subjects, and a newly issued unblocked account after the cutoff. Then clear stored maintenance and verify readiness and authorization again. Keep the source isolated; do not delete or silently fall back to it.

Ordinary configuration decreases below the stored cutoff fail startup. An epoch change without a strictly higher cutoff also fails. Tokens with iat **equal** to the cutoff are denied; there is no60-second tolerance subtraction for this comparison. A future cutoff may temporarily deny newly minted tokens; wait until after it and obtain a fresh token. Preserve the maximum through restart, release, rollback and subsequent restore.

## RecoveryManifest and reconciliation

The manifest is a trusted operator assertion based on current external records, not something the restored database can prove. Review authoritative current roster, disabled accounts, removed memberships and subject/resource denials kept outside that snapshot. If revocation completeness is unknown, leave the affected users suspended and admissions closed. Do not set revocationsVerified:true merely to satisfy parsing.

Create/review the manifest after the recovery instance has completed startup. reviewedAt is Unix **milliseconds**, must be no earlier than the current authority-state update, no later than trusted current time, and at most15minutes old. Regenerate stale evidence after a lock wait or prolonged procedure. tokenIatAfter remains Unix **seconds**. References are protected record identifiers (for example `operator-record:current-roster`); they must contain neither credentials nor full roster rows. No external record is automatically fetched or trusted by the app.

```json
{
  "kind": "reconcile-roster",
  "manifest": {
    "storeId": "00000000-0000-4000-8000-000000000001",
    "deploymentEpoch": "example-restored-epoch",
    "tokenIatAfter": 1800000060,
    "reviewedAt": 1800000062000,
    "sourceRefs": ["operator-record:current-roster", "operator-record:current-revocations"],
    "revocationsVerified": true,
    "approvedMemberships": [],
    "disabledUserIds": [],
    "removedMemberships": [],
    "resourceBlocks": []
  }
}
```

The example intentionally approves no membership. Approved entries are `{userId,teamId}`; removals use the same pair; resource blocks are `{userId,resource}`. Include only explicitly approved **existing** subject-bound, previously accepted memberships. No membership is created by recovery. Unknown approvals, missing source references, unverified/stale evidence and store/epoch/cutoff mismatch deny reconciliation. Command arrays are bounded, JSON is bounded below the admin frame limit, and unknown fields are rejected.

Reconciliation requires maintenance, the restricted app role and the runtime's identical coordinator. It applies disabled users, removals and resource blocks before approvals in one transaction, rechecks freshness after locks, and invalidates runtime authority after commit. Current disabled/removed states and resource blocks are retained; an approval never clears them. A late error rolls back the entire reconciliation. Only explicitly approved eligible memberships become active, and users not approved stay suspended. Restored pending invitations remain revoked.

## Retention

Run `{kind:"retention"}` through the private admin path. Each transaction handles at most500 audit rows,500 token denials and500 roster-email records; repeat bounded runs until returned counts show no eligible work. Retention never deletes users, stable issuer/subject identity mappings, memberships, grant/device foreign-key records or current subject/resource blocks.

- Audit events older than30days are deleted. Exactly30days are still retained until the next later run.
- Token denials are retained through expiry plus60seconds and are deleted only after that boundary. Their IDs do not authorize a token whose separate expiry/cutoff checks fail.
- Invitation email is redacted to an empty value only after the course's explicit closed_at timestamp plus30days. A disabled course without an approved close timestamp and an open course do not qualify. Repeating close-course preserves its first timestamp. Stable subject/provenance IDs required for enforcement and foreign keys remain.

Application retention does not erase historical copies in encrypted dumps, platform snapshots or protected operator evidence. Apply their separate approved retention/access policy and record actual platform retention. Retention reports contain counts only, not emails, tokens or deleted row payloads.

### Railway deployment prober

Railway sends deployment health checks with `Host: healthcheck.railway.app`. The identity server accepts that exact host only for a plain `GET /health` without Origin or forwarded-host/protocol headers. It does not admit that host for `/ready`, discovery, MCP, or any other method. The configured public resource host and normal origin/proxy checks remain required for protected traffic. The local HTTP regression exercises this exact prober request under maintenance and verifies that all other routes remain denied. See [Railway health-check hostname](https://docs.railway.com/deployments/healthchecks#healthcheck-hostname).
