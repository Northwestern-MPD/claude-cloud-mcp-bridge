# Milestone 2 Identity and Durable Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build reusable Auth0 authentication for class MCP servers and durable PostgreSQL authorization, with real-client verification before any desktop authority is enabled.

**Architecture:** A storage-independent authentication package verifies provider tokens and serves MCP discovery. A separate identity-only service uses Postgres enrollment and current revocation policy; local adapters exercise persistent device/lease behavior. Native OAuth is checked early; unresolved same-user cloud context isolation blocks full milestone acceptance and all public desktop capabilities.

**Tech Stack:** Node 22+, TypeScript/NodeNext, existing MCP SDK 1.32.1, jose, pg, Auth0 hosted email OTP, Railway Docker/private Postgres, Node test runner with tsx.

**Spec:** [Approved milestone 2 design](../specs/2026-10-17-milestone-2-identity-authorization-design.md).

**Status:** Execution began October 17 and continues October 18, 2026. Local implementation is being integrated and independently reviewed; hosted/native acceptance remains blocked. Auth0 built-in development mail reached both authorized inboxes. See [verification evidence](../../IDENTITY_VERIFICATION.md). Checkboxes describe recorded completion, not production readiness.

## Global Constraints

- Work from main, preserve local changes, and use direct commits/pushes; no PR requirement. Use a worktree only if isolation is needed at execution time.
- Auth0 plus Railway Postgres are approved. Invited, verified email is sufficient; Northwestern NetID SSO is not required.
- Keep the existing public ping probe separate and harmless. No public mock gateway, desktop tools, agent/WSS endpoint, shared roster API, Redis or cluster in this milestone.
- Shared identity is `(issuer, subject)`. Every MCP server has its own exact audience, allowed clients and scopes. The reusable package imports no Blender, connector or storage implementation.
- Require boolean true in the signed claim `https://github.com/Northwestern-MPD/claims/email_verified`, populated from trusted Auth0 verification state.
- RS256 only; exact issuer/audience; signed azp allowlist; client_id must agree when present; scopes come from signed scope. API access-token lifetime 600 seconds; clock tolerance 60 seconds.
- Cache trusted JWKS for at most one hour, refresh after ten minutes and rate-limit unknown-key refresh attempts. Never fetch token-provided issuer/jku/x5u URLs.
- Invitation lifetime seven days; pairing code randomness at least 128 bits; device credential randomness at least 256 bits.
- One private Postgres database/schema with pg (no pg-native/ORM). Separate owner, migration, limited application and read-only backup roles; only the app role reaches normal serving configuration. Parameterized SQL and versioned/checksummed migrations.
- One identity app replica with no data volume; one private Railway Postgres service owns its volume. Missing database/schema/store marker fails closed; initialization/migration is an explicit privileged operator job.
- Disable identity-service autodeploys/image updates; every deploy and rollback drains/stops the incumbent and verifies owner-lock release before replacement startup. Brief downtime is accepted.
- Recovery keeps AUTHZ_TOKEN_IAT_AFTER outside the restored DB, never decreases it, and requires iat strictly greater with no tolerance subtraction. Current revocations must be verified before roster reactivation; missing evidence stays denied.
- Restart invalidates contexts/pairings/leases, marks devices offline and advances epochs; enrollment/revocations survive. Never replay mutations.
- Check current local disable/revocation before dispatch. Auth0 logout/refresh revocation alone does not revoke an existing access JWT.
- Audit retention 30 days; roster PII removal course close plus 30 days. No bearer/refresh/device secret, OTP, raw claims, code, scene or image payload in logs/audit.
- Public JSON limit 64 KiB; retain 64 transports total, 8/user, 120 authenticated requests/minute/user and finite timeouts.
- No plaintext keychain fallback. Real macOS/Windows keychain, enrollment and production WSS evidence belong to milestone 3.
- Use meaningful red-green tests for feature work. Resolve current compatible stable dependency versions at execution, pin exact versions and commit the lockfile; no incidental SDK upgrade.
- Do not request pasted credentials or send student invitations without explicit recipient/send authorization. Account login, approved test users, SMTP sender and tenant/domain/client values are external inputs, not values to invent.

## Review Focus

1. JWKS rotation/outage and malicious key URLs: only a known cached key inside the one-hour bound may survive a fetch failure (Task 2).
2. Provider creation succeeds but local enrollment fails: retry reconciles the exact subject without duplicate membership or duplicate invitation mail (Tasks 4 and 6).
3. Chunked/oversized/ambiguous requests and copied MCP handles: continued sessions receive the same bounds and authentication as initialization (Task 5).
4. Restoring old authorization data while newer tokens/credentials exist: maintenance, epoch, issuance cutoff and current revocations prevent resurrection after reconciliation and reopened admission (Tasks 3–5 and 11).
5. Pool exhaustion, database restart, leaked clients and deployment overlap: close admission on store failure, reject an overlapping owner harmlessly, and require drain/stop/lock-release/start for every deploy and rollback (Tasks 3, 5, 7–8).

## Execution map

Tasks 1–8 deliver an identity-only release and its native OAuth check. Tasks 9–11 build durable desktop-policy foundations through local adapters. Task 12 establishes the actual same-user context outcome; Task 13 records acceptance or a precise blocked result. Execute in order. External access blockers need not stop independent local tests, but no local test substitutes for native evidence.

## File structure

| Files | Responsibility |
|---|---|
| `packages/auth/{types,errors,verifier,jwks,metadata,index}.ts` | Reusable token verification, trusted keys and OAuth discovery |
| `packages/storage/{types,database,migrations,enrollment,contexts,devices,grants,operations,revocations,recovery,retention}.ts` | Versioned Postgres schema, lifecycle, bounded pool and transactional repositories |
| `packages/authorization/{identity,policy,runtime,session-binding}.ts` | Enrollment decisions, local policy/dispatch, invalidation and rejecting default binding resolver |
| `packages/credentials/keychain.ts` | CredentialStore interface, test injection and fail-closed unavailable implementation |
| `apps/identity/{config,server,main}.ts` | New HTTP MCP identity-only application |
| `apps/operator/{types,socket,commands,main,provision,mail}.ts` | Private admin socket/CLI, provider reconciliation and invitation sender |
| `auth0/actions/verified-email.js` | Auth0 Action issuing the fixed verification claim |
| `test/support/{auth,storage,operator,postgres-tools}.ts` | Local signing keys/clocks, disposable Postgres databases, provider/mail fakes |
| `test/{auth-verifier,auth-discovery,session-binding}.test.ts and test/database/{storage,enrollment,identity-http,operator,durable-policy,durable-dispatch,recovery}.test.ts` | Unit suites under the existing root glob; database integration suites run explicitly |
| `scripts/{migrate-identity,validate-identity-store}.ts` | Explicit operator migration and restore-validation entrypoints |
| `test/container/identity.test.ts` | Explicit container-only suite, excluded from the default root test glob |
| `Dockerfile.identity`, `Dockerfile.identity.dockerignore`, `railway.identity.json`, `compose.identity-test.yml` | Non-root app image, private database test service and independent app deployment config |
| `examples/identity.env.example`, `examples/identity.mcp.json` | Nonsecret examples, clearly labeled as examples |
| `docs/{AUTH0_SETUP,IDENTITY_OPERATIONS,IDENTITY_VERIFICATION}.md` | Provider setup, operational procedures and evidence |
| Existing package/lock files, CI workflow, SessionStart hook, .gitignore and handoff | Dependency/build integration, private-artifact exclusions and continuation state |

Keep `packages/core.ts`, the mock gateway and current probes as existing regression paths. Do not retrofit persistence into the fixture singleton or import its bearer parser into production. Keep new modules focused; publish no npm package yet. The planned private package identity is `@northwestern-mpd/mcp-auth`.

### Common contracts

Types live in the owning task's types.ts. Times are Unix milliseconds except raw JWT claims and tokenIatAfter/AUTHZ_TOKEN_IAT_AFTER, which use Unix seconds.

- `PrincipalKey = Readonly<{issuer: string; subject: string}>`.
- `VerifiedPrincipal = PrincipalKey & Readonly<{clientId: string; scopes: readonly string[]; issuedAt: number; expiresAt: number; emailVerified: true}>`; no raw token/claim bag.
- `AuthConfig = Readonly<{issuer: string; jwksUri: string; resource: string; allowedClientIds: readonly string[]; requiredScopes: readonly string[]}>`.
- `Store = {bootId: string; deploymentEpoch: string; transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>; close(): Promise<void>}`. Transaction wraps one checked-out pg.PoolClient with query methods; no raw pool is exposed to repositories. Every transaction releases its client in finally. Readiness/owner-client state is tracked privately.
- `IdentityView = Readonly<{userId: string; resource: string; courseIds: readonly string[]; teamIds: readonly string[]; desktop_access: false}>`.
- `VerifiedRequestAuth = Readonly<{principal: VerifiedPrincipal; resource: string; tokenFingerprint: string}>`; principal carries issuedAt/expiresAt in Unix milliseconds. Only the HTTP verification boundary constructs it from the verified bearer and configured resource; never from tools, stored contexts or supplied JSON. No raw token is retained.
- `DispatchCoordinator = {withFence<T>(action: () => Promise<T>): Promise<T>}`; one process-wide instance shared by runtime, private admin commands and dispatch.
- `IdentityRuntime = RuntimeInvalidator & {coordinator: DispatchCoordinator}`.
- `ContextRef = Readonly<{id: string; userId: string; resource: string; clientId: string; bootId: string; deploymentEpoch: string}>`.
- `RuntimeInvalidator = {invalidate(input: {userId?: string; deviceId?: string; contextId?: string; teamId?: string}): void}`; synchronously removes runtime authority and rejects/notifies matching local pending work.
- All repository I/O returns Promises. Deadline-sensitive methods receive a clock callback and read it after locks and immediately before dispatch; do not authorize from a stale pre-await timestamp.
- `PolicyError` exposes a stable string code. HTTP errors never include provider/SQL/stack/credential details.

---

### Task 1: Strict reusable Auth0 access-token verification

**Files:** Create auth/types.ts, errors.ts, verifier.ts, index.ts under packages; test/support/auth.ts; test/auth-verifier.test.ts. Modify package.json/lockfile.

**Interfaces:** Produce `verifyAccessToken(token: string, config: AuthConfig, deps: {resolveKey: JWTVerifyGetKey; now(): number}): Promise<VerifiedPrincipal>` and `requireScopes(principal: VerifiedPrincipal, scopes: readonly string[]): void`. JWTVerifyGetKey is imported from jose. Export VERIFIED_EMAIL_CLAIM with the exact spec literal. Test helper `signingFixture(nowMs: number)` exposes `mint(overrides?: Record<string, unknown>): Promise<string>`, resolveKey, now and valid config; defaults use RS256, azp, identity:read and the fixed verification claim.

- [x] Write tests for wrong key/algorithm/issuer/audience, ID-token audience, malformed/missing/false/string verification claim, malformed subject/azp, conflicting client_id, missing scopes and clock boundaries. The wrong-audience case must assert:
  ```ts
  const f = await signingFixture(1_800_000_000_000);
  const token = await f.mint({ aud: 'https://other.example/mcp' });
  await assert.rejects(verifyAccessToken(token, f.config, f), /INVALID_TOKEN/);
  ```
- [x] Check stable jose engines/release compatibility with Node 22 using `npm view jose version engines --json`, pin the selected exact version, install test prerequisites, then run `node --import tsx --test test/auth-verifier.test.ts`. Expected red: missing verifier behavior, not a broken fixture/dependency.
- [x] Implement with jose.jwtVerify, RS256 and 60-second tolerance. Require typed exp/iat, nonempty subject/azp and valid scope; require client_id agreement when present. Match exact audience/issuer, reject future issuance and normalize immutable output. Do not resolve trust from incoming data.
- [x] Run the focused suite and `npm run typecheck`; expect every positive/negative assertion passes.
- [x] Commit as `feat: add reusable strict Auth0 token verification`.

### Task 2: Trusted JWKS, MCP metadata and second-server reuse

**Files:** Create packages/auth/jwks.ts, metadata.ts and test/auth-discovery.test.ts; extend auth exports/fixtures.

**Interfaces:** Consume Task 1. Produce `createJwksResolver(config: AuthConfig, deps: {fetch: typeof fetch; now(): number}): JWTVerifyGetKey`, `protectedResourceMetadata(config: AuthConfig): object`, `metadataPath(resource: string): string`, and `authenticationChallenge(config: AuthConfig, error: 'invalid_token' | 'insufficient_scope', scopes?: readonly string[]): string`.

- [x] Write counting-fetch tests: trusted fetch only, refresh at 600_000 ms, known-key outage grace ending at 3_600_000 ms, unknown kid denial and at most one unknown-key refresh/minute. Ignore token jku/x5u; bound fetch to 5 seconds/64 KiB/32 keys and reject redirects to unconfigured origins. A second resource uses the same package/keyset but rejects the first resource's token:
  ```ts
  const other = { ...f.config, resource: 'https://assignments.example/mcp' };
  await assert.rejects(verifyAccessToken(await f.mint(), other, f), /INVALID_TOKEN/);
  ```
- [x] Run `node --import tsx --test test/auth-discovery.test.ts`; expect red for missing key-cache/metadata behavior.
- [x] Implement per-config trusted caches with explicit last-success age and failed-refresh handling. Generate RFC 9728 metadata/challenges; a resource ending /mcp uses `/.well-known/oauth-protected-resource/mcp`. Metadata and token verification use the identical canonical resource, without altering it from request headers.
- [x] Run auth-verifier/auth-discovery suites plus typecheck; expect audience/scope isolation and outage/rotation tests pass. Inspect imports to verify no storage/Blender dependencies.
- [x] Commit as `feat: add bounded JWKS and reusable MCP auth discovery`.

### Task 3: Postgres roles, migrations, pool and fail-closed startup

**Files:** Create packages/storage/{types,database,migrations,recovery}.ts, scripts/migrate-identity.ts, test/support/storage.ts, test/database/storage.test.ts, compose.identity-test.yml; update package/lock files. Include scripts/**/*.ts in TypeScript build when adding the migration CLI.

**Interfaces:** Produce `migrateAuthorizationStore(options: {migrationUrl: string; transportMode: 'railway-private'|'verify-full'|'local-test'; ca?: string; initialize: boolean; maintenance: boolean; expectedStoreId: string; deploymentEpoch: string}): Promise<void>` and `openAuthorizationStore(options: {connectionString: string; transportMode: 'railway-private'|'verify-full'|'local-test'; ca?: string; expectedStoreId: string; maintenance: boolean; deploymentEpoch: string; tokenIatAfter: number; now(): number}): Promise<Store>`. Transaction uses a single PoolClient for BEGIN/COMMIT/ROLLBACK. The test fixture creates/disposes isolated databases on an explicitly disposable Postgres instance, never the hosted store.

- [x] Write real Postgres tests for missing database/schema/marker refusal, explicit initialization, concurrent migration serialization/checksums/rollback, unsupported newer schema, store-ID mismatch, FK/partial-unique constraints and runtime-role DDL denial. Test two clients really contend on locks. A second runtime owner must refuse readiness without revoking the first owner's grants. Test nonnegative safe-integer seconds for the configured issuance cutoff, reject a decrease below the stored value, and persist it before readiness. Restart recovery preserves enrollment/revocation but kills live contexts/leases. Use async assertions:
  ```ts
  await assert.rejects(openAuthorizationStore(uninitializedOptions), /STORE_NOT_INITIALIZED/);
  await assert.rejects(runtimeRole.query('CREATE TABLE mpd_identity.forbidden(id int)'), /permission denied/);
  ```
- [x] Resolve/pin Node-22-compatible pg/@types/pg, with no pg-native or native rebuild. Start a disposable Postgres test service matching the selected Railway major; require explicit PG_TEST_DISPOSABLE=true and PG_TEST_ADMIN_URL/PG_TEST_DATABASE_URL. Fixtures validate the disposable marker and refuse production URLs. Run `node --import tsx --test test/database/storage.test.ts`; establish red after actual connectivity works.
- [x] Implement roles mpd_identity_owner (NOLOGIN), mpd_identity_migrator (owner-capable DDL), mpd_identity_app (DML only) and mpd_identity_backup (schema-scoped read only). Revoke unnecessary PUBLIC privileges. Initialize/migrate only via explicit operator CLI under maintenance and schema advisory lock; runtime never receives migration credentials or creates schemas. Implement pool max=5, connect=5s, idle=30s, statement=5s, lock=2s and idle-in-transaction=10s timeouts. A separate dedicated client holds the runtime-owner advisory lock; losing it ends the app lifetime and disables dispatch. Roll back/release clients on every error.
- [x] Before readiness, validate schema/store ID, acquire ownership and atomically create a boot ID, revoke old contexts/pairings/leases, advance device epochs/offline state and mark unfinished mutation intents uncertain. Epoch mismatch additionally suspends restored users/memberships, revokes pending invitations and invalidates device credentials under maintenance. Persist the configured tokenIatAfter cutoff (seconds) in service_state; never lower it on restart or ordinary rollback. The operator supplies an advanced external cutoff before restoring an older database. Verify per-transaction backend PID consistency, rollback/release, pool timeout and network/owner-client failure with no fallback. Run the storage suite and typecheck.
- [x] Commit as `feat: add private Postgres authority store and safe startup`.


### Task 4: Subject-bound invitations and current authorization

**Files:** Create packages/storage/enrollment.ts, packages/authorization/identity.ts, test/database/enrollment.test.ts; extend storage types/fixtures.

**Interfaces:** Define `InvitationInput = {id: string; email: string; issuer: string; subject: string; courseId: string; teamId: string; role: 'student' | 'instructor'; expiresAt: number}`. Produce `enrollInvitation(store: Store, input: InvitationInput, clock: () => number): Promise<void>`, `activateEnrollment(store: Store, principal: VerifiedPrincipal, clock: () => number): Promise<string>` (user ID) and `authorizeIdentity(store: Store, auth: VerifiedRequestAuth, input: {clock: () => number}): Promise<IdentityView>`.

- [x] Test seven-day invitation bounds, subject-only activation, unverified/uninvited/disabled/expired/revoked denial, plus-address/domain distinctions, membership rollback and token/resource blocks. Test recovery-cutoff equality/before/after boundaries with no tolerance subtraction, seconds-to-milliseconds conversion, expired request evidence and fresh tokens for a blocked resource. Distinguish normal repeat login from invitation replay: accepted enrollment is idempotent, but it cannot recreate a revoked membership. Seed subject A's invitation, construct authB from subject B's verified token, and assert subject B cannot inherit it despite identical email display information:
  ```ts
  await assert.rejects(authorizeIdentity(store, authB, request), /NOT_ENROLLED/);
  assert.equal(await activeMembershipCount(store, principalB), 0);
  ```
- [x] Run `node --import tsx --test test/database/enrollment.test.ts`; expect missing repository/authorization behavior.
- [x] Implement transactional invitation consumption/membership activation. Trim surrounding whitespace and lowercase only email domains; do not merge local parts/dots/plus tags. Bind issuer/subject explicitly, require verified-email evidence and current local permissions, never email claims/domain inference. Use auth.principal/resource/tokenFingerprint to check current local denials, cutoff and expiry on every request; require principal.issuedAt > store cutoff * 1000 without subtracting the 60-second tolerance. No positive authorization cache; return only IdentityView.
- [x] Run enrollment/storage/auth suites. Inject a failure between consumption and membership creation; assert rollback and no duplicate enrollment on retry.
- [x] Commit as `feat: enforce durable invited student enrollment`.

### Task 5: Identity-only MCP server and per-request checks

**Files:** Create apps/identity/config.ts, server.ts, main.ts; packages/storage/contexts.ts; packages/authorization/runtime.ts; test/database/identity-http.test.ts.

**Interfaces:** Produce `readIdentityConfig(env: NodeJS.ProcessEnv): IdentityConfig`, `createDispatchCoordinator(): DispatchCoordinator` and `createIdentityRuntime(store: Store): IdentityRuntime` (owns exactly one coordinator and implements RuntimeInvalidator), and `startIdentityServer(options: {config: IdentityConfig; store: Store; verify(token: string): Promise<VerifiedPrincipal>; runtime: IdentityRuntime}): Promise<{url: string; close(): Promise<void>}>`. IdentityConfig contains auth:AuthConfig, database:{connectionString, transportMode, ca?, expectedStoreId, maintenance, deploymentEpoch, tokenIatAfter}, explicit externalOrigin, host, port, maintenance and adminSocketPath. App config has no schema-initialization flag or migration/backup URL; reject credentials pointing at a different store or an unapproved public database endpoint. Persist `recordTransportContext(store: Store, principal: VerifiedPrincipal, resource: string, clock: () => number): Promise<ContextRef>`; principal/client/resource/boot ownership is immutable across continued requests.

- [x] Write real SDK HTTP tests using local signed tokens: public metadata/health, 401 challenge, insufficient scope, uninvited 403, maintenance/store 503 and readiness. Reject copied handles with wrong principal/client, missing bearer on continued/DELETE requests, JSON over 65_536 bytes including chunked bodies, duplicate bearer, malformed JSON, disallowed Origin and spoofed forwarded Host. Assert:
  ```ts
  assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['class_identity']);
  const result = await client.callTool({ name: 'class_identity', arguments: {} });
  assert.equal(result.structuredContent?.desktop_access, false);
  ```
- [x] Run `node --import tsx --test test/database/identity-http.test.ts`; expect missing server/runtime behavior. Request local-port sandbox access if needed.
- [x] Implement with current SDK primitives, without importing the mock gateway. Auth precedes protected parsing/routing; create fresh immutable VerifiedRequestAuth using the verified bearer's SHA-256 fingerprint and configured resource on every request, then recheck local authorization on every tool call. Never cache request auth on an MCP context or accept it from tool input. Implement exact session/rate/body bounds and headers=10 seconds/request=35 seconds. Origin/proxy trust comes from configuration. class_identity takes no arguments and returns only IdentityView; reject all desktop tool names. Maintenance never admits students; failed store/config startup opens no listener; a later DB/pool/owner-client loss closes admission and ends this serving lifetime. Test statement/connection timeouts and close transports without replay.
- [x] Run identity/auth/enrollment suites and typecheck. Capture a canary token/secret and assert no response/log leaks it. Verify no cookie grants authority and current probe catalogue remains ping-only.
- [x] Commit as `feat: expose authenticated class identity MCP service`.

### Task 6: Local admin, idempotent Auth0 provisioning and Action

**Files:** Create apps/operator/{types,socket,commands,main,provision,mail}.ts; auth0/actions/verified-email.js; test/support/operator.ts; test/database/operator.test.ts; docs/AUTH0_SETUP.md. Add only required provider/SMTP dependencies, pinned after compatibility checks.

**Interfaces:** Define AdminCommand with literal kinds import-invites, disable-user, remove-membership, block-resource, deny-token and maintenance; Task 10 adds revoke-device and Task 11 adds reconcile-roster and retention. Database export/restore remains an operator procedure outside the app admin socket. AdminResult is {ok:true, affected:number}; errors use stable PolicyError codes. Accept user/team/resource IDs and validated fingerprints, not arbitrary SQL or provider URLs. Produce `executeAdmin(command: AdminCommand, deps: {store: Store; runtime: IdentityRuntime; coordinator: DispatchCoordinator; now(): number}): Promise<AdminResult>`, `startAdminSocket(path: string, execute: (command: AdminCommand) => Promise<AdminResult>): Promise<{close(): Promise<void>}>`, `runOperator(args: readonly string[], deps: OperatorDependencies): Promise<number>`, and `provisionRoster(rows: readonly RosterRow[], deps: {provider: Auth0Provisioner; local: EnrollmentAdmin; sender: InvitationSender; sendAuthorized: boolean}): Promise<ProvisionSummary>`. Define dependency types in operator/types.ts; their operations are create/reconcile exact email-connection subject, record invitation, and deliver invitation.

- [x] Test socket mode 0600, strict/bounded commands, durable mutation before acknowledgement and runtime invalidation. Assert bootstrap passes runtime.coordinator to executeAdmin and all authorization mutations hold that same fence through commit and invalidation; reject mismatched coordinator injection. Test each delegated revoke/reconcile command completes without attempting to acquire the non-reentrant fence twice. Fake-provider/SMTP tests reproduce remote success/local failure; retry must reconcile the same subject, create one membership and send no mail before persistence. sendAuthorized=false sends zero mail. Already confirmed mail is not resent; uncertain delivery is surfaced for operator reconciliation. Test the Action issues only the fixed boolean claim from event.user.email_verified, ignoring request/user_metadata.
- [x] Run `node --import tsx --test test/database/operator.test.ts`; expect missing admin/provisioning behavior.
- [x] Implement private socket commands and file/stdin CLI inputs. Wire the serving runtime's coordinator into executeAdmin; no private admin handler may allocate a separate coordinator or bypass its fence for authorization mutations. Acquire the fence exactly once per command: Task 10 revokeAuthorization and Task 11 reconcileRoster acquire it themselves, so executeAdmin delegates those without an outer fence; earlier mutation handlers acquire it directly. Implement maintenance now for Task 7 deployments: persist its deny-admissions state, invalidate/drain runtime work when enabling it, and allow the private socket while admissions are closed. AUTHZ_MAINTENANCE=true remains an external hard-deny override; clearing the stored flag cannot override it. Keep roster, exact subject mapping and invitation delivery manifests under ignored work/identity-operator/ with restrictive permissions and no secrets. Use narrow Management API credentials only in the operator process, not the serving process. Use a maintained SMTP adapter; classify sent/failed/uncertain outcomes rather than promise exactly-once email. Hash a token from protected stdin before token-denial admin submission; never print it.
- [x] Document Auth0 setup: production SMTP/verified sender, disabled email signups, pre-provisioned identities, Action binding, RS256/default access-token profile, 600-second API lifetime, identity:read, resource compatibility, PKCE and approved native client registration. Include supported refresh rotation/reuse/expiry settings, narrow Management API scopes and local-first disable. Validate nonsecret examples with readIdentityConfig.
- [x] Run operator/enrollment/identity suites and typecheck; verify logs omit recipient lists/OTP/secrets. Commit as `feat: add operator enrollment and Auth0 setup contracts`.

### Task 7: Non-root Node image, real Postgres CI and service config

**Files:** Create Dockerfile.identity, Dockerfile.identity.dockerignore, railway.identity.json, examples/identity.env.example, examples/identity.mcp.json, test/container/identity.test.ts; extend compose.identity-test.yml. Modify npm scripts/lockfile, .github/workflows/check.yml and private-artifact exclusions/build instructions. SessionStart remains npm ci --ignore-scripts; it does not start a database or rebuild a native module.

**Interfaces:** Add start:identity (`node dist/apps/identity/main.js`), operator (`node dist/apps/operator/main.js`), migrate:identity (`node dist/scripts/migrate-identity.js`), test:db (`node --import tsx --test test/database/*.test.ts`), test:all (`npm test && npm run test:db`), test:identity-container (`node --import tsx --test test/container/identity.test.ts`) and test:coverage. Default root npm test/probe discovery must require neither Postgres nor Docker; DB/container suites are explicit and must fail with a clear prerequisite error rather than silently skip.

- [x] Write container/DB tests: image starts as Node UID without source/tsx/dev dependencies or a data volume; refuses absent/old schema/wrong marker/runtime DDL credentials; readiness/admission close on database restart, exhausted pool or owner connection loss. Recover via a new boot with old grants invalid and no frame replay. Verify migration role is not present in app environment and other service DB credentials are not shared. Test an overlapping replacement while the incumbent holds the lock: it fails without invalidating incumbent grants; drain/stop incumbent, confirm lock release, then start replacement and perform the same procedure for rollback. Add a sentinel secret under work/ and a nested .env under an allowed source directory; assert neither enters the build context or final image. Run tests against the absent image to establish packaging failure.
- [x] Build from the repository root with `docker build -f Dockerfile.identity .`. Add Dockerfile.identity.dockerignore because root .dockerignore currently permits only probe artifacts: allow package.json/package-lock.json/tsconfig.json, Dockerfile.identity and required apps/packages/scripts TypeScript inputs with traversable parent directories; explicitly exclude nested .env/secret files, .git, node_modules, work/ and dumps. Keep the root probe allowlist unchanged. Build multi-stage Node-22 Debian image using npm ci --ignore-scripts, tsc, production pruning and pg pure JavaScript runtime. USER node directly; remove all root chown/gosu/bootstrap concepts. Copy compiled migration/operator entrypoints for explicitly invoked jobs, but do not give app startup privileged database credentials. Keep existing probe Dockerfile/railway.json unchanged.
- [x] Configure identity Dockerfile, ON_FAILURE/three retries, 60-second health timeout and /health liveness. /ready validates DB/schema/store/ownership/maintenance; no app volume or initialization flag. Document explicit privileged initialization/migration followed by deploy. Every deployment/rollback disables autodeploys/image updates, stages configuration without launching a replacement, sets incumbent maintenance through the socket, drains at most 30 seconds, marks unfinished mutations uncertain, closes transports and stops the deployment. Confirm owner connection/lock release before manually starting the next schema-compatible release; force-stop a stuck incumbent and verify release. Retain epoch/cutoff settings on rollback. Verify /health=200, /ready=503 and denial while maintenance is active; with the external hard-deny flag false, clear stored maintenance through the socket and then require /ready=200 plus a denial check for an unauthorized account. An overlapping replacement must fail closed; changing the health endpoint does not transfer ownership. Record DB_TRANSPORT_MODE and CA/private-network policy without exposing URLs/passwords.
- [x] Add a matching-major Postgres CI service and disposable roles/databases, preserve npm ci --ignore-scripts, then run root unit/probe tests and explicit database tests. Pin c8 and run test:all with 91% checks for lines/functions/branches/statements, apps/packages includes and text/lcov reporters; exclude only generated/test artifacts and report baseline gaps honestly. DB suites must use actual pg and independent clients, never an in-memory substitute.
- [x] Run typecheck, unit+DB suites, coverage, mock demo, build, probe regeneration/drift, both image builds and explicit identity container smoke. Record observed architectures. Ignore private dumps/operator files and commit as `build: package identity service for private Postgres`.


### Task 8: Hosted native identity compatibility gate

**Files:** Create docs/IDENTITY_VERIFICATION.md; update AUTH0_SETUP, HANDOFF and .mcp.json only with a real URL.

**Interfaces:** Consume Tasks 1–7; produce IDENTITY_NATIVE_PASS or a concrete IDENTITY_NATIVE_BLOCKED evidence record. Neither status enables desktop tools.

- [ ] Verify local/container gates, authenticated Auth0 access, SMTP sender, explicitly authorized test recipients/roster and Railway service inventory/spend controls. Reuse any identity service already created. Never invent provider/domain/client values or send real invitations without authorization; no artificial unit test for a dashboard action is needed.
- [ ] Create/reuse one private Railway Postgres service (database volume only) and a separate identity service with no data volume in the existing project/environment. Disable public TCP exposure; record the selected Postgres major and align CI/test tooling before migrations. Generate the identity HTTPS domain, then configure its exact /mcp resource/API and actual native client in Auth0. Prefer operator-approved CIMD/static registration; verify any alternate client-required registration instead of assuming DCR. Provision database roles and explicitly initialize/migrate under maintenance through a privileged operator job. Give the app only its limited private DATABASE_URL, expected AUTHZ_STORE_ID and epoch/transport configuration; keep migration/backup secrets in their operator jobs. Disable identity GitHub autodeploys/image auto-updates before connecting its source; confirm configuration changes can be staged without starting replacements. Follow Task 7's explicit stop/drain/lock-release/start for every deployment and rollback and record observed hosted evidence. Set initial AUTHZ_TOKEN_IAT_AFTER=0; preserve/advance its external value on recovery. Apply issuer/resource/client settings, enroll test subjects, verify maintenance denial, then clear stored maintenance and require readiness before student use. Verify roles, bounded connection counts, private-only access and backup settings in the real account.
- [ ] Check hosted health/metadata/401 challenge, direct authenticated MCP identity and wrong-audience/uninvited denial without logging tokens. Add real class-identity MCP config alongside both probes and configure exact network allowlists for the selected delivery path.
- [ ] Ask the operator to run actual native cloud OAuth/discovery/class_identity for two accounts. Record branch/commit, delivery path, exposed client/version and sanitized result. Exercise expired access, supported refresh, revoked refresh, local block with a valid JWT and provider-only logout/block. Shell/SDK checks are separate evidence. Fix incompatibility with regression tests; never weaken audience/verification to pass.
- [ ] Commit nonsecret configuration/runbook/evidence changes. A native blocker leaves the service identity-only and milestone partial; independent local policy tasks can continue.

### Task 9: Durable device credentials, pairings and leases

**Files:** Create packages/storage/devices.ts, grants.ts; packages/authorization/policy.ts; packages/credentials/keychain.ts; test/database/durable-policy.test.ts. Extend storage types/fixtures.

**Interfaces:** Produce `enrollDevice(store: Store, input: {ownerId: string; name: string}, clock: () => number): Promise<{deviceId: string; secret: string}>`, `rotateDeviceCredential(store: Store, deviceId: string, clock: () => number): Promise<{secret: string}>`, `authenticateDevice(store: Store, secret: string, clock: () => number): Promise<DeviceRef>`, `createPairing(store: Store, input: PairingInput, clock: () => number): Promise<{pairingId: string; code: string}>`, `approvePairing(store: Store, input: {pairingId: string; deviceId: string; capabilities: readonly Capability[]}, clock: () => number): Promise<LeaseRef>`. DeviceRef has id/owner/epoch/deploymentEpoch/online state. PairingInput has ContextRef, teamId and capabilities. LeaseRef has id/context/device/team/capabilities/epoch/expiresAt/idleExpiresAt/state. Capability remains read|execute from protocol. CredentialStore exposes save/load/remove returning Promises; load returns string|null; unavailable production storage throws KEYCHAIN_UNAVAILABLE.

- [x] Write real Postgres integration tests for credential purpose separation, rotation/revoke/expiry/epoch, same-team wrong-owner denial, hashed pairing codes, expiry/replay/narrowing and concurrent approvals from two DB connections. Exactly one approval succeeds and one active lease exists. Test injected CredentialStore and unavailable adapter; no filesystem fallback/test-adapter selection in production.
- [x] Run `node --import tsx --test test/database/durable-policy.test.ts`; establish red for missing durable behavior.
- [x] Implement single-client pg transactions, SELECT FOR UPDATE in a stable user/device/context/grant lock order, 256-bit device secrets, 128-bit pair codes, fingerprints only, partial unique active-lease indexes by user/device and current owner/membership/epoch checks using a fresh clock after lock waits. Partial unique indexes backstop races; timeouts/deadlocks return controlled conflicts without automatic mutation retry. Retain five-minute pairing, one-hour lease and ten-minute idle defaults. Secrets are returned only on issuance. No public enrollment/WSS is added; test harness supplies devices/contexts.
- [x] Run policy/enrollment/storage suites and reopen DB; device enrollment/revocation persists while live leases are invalid. Confirm no raw secret/code is stored/logged. Document real OS adapters as milestone 3 evidence.
- [x] Commit as `feat: persist device ownership and single-use lease policy`.

### Task 10: Atomic admission, execution uncertainty and revocation

**Files:** Create packages/storage/operations.ts, revocations.ts; test/database/durable-dispatch.test.ts. Extend authorization policy/runtime and operator commands.

**Interfaces:** Produce `admitOperation(store: Store, input: {auth: VerifiedRequestAuth; context: ContextRef; leaseId: string; tool: Tool; write: boolean; clock: () => number}): Promise<OperationRef>`, `completeOperation(store: Store, input: {requestId: string; deviceId: string; leaseId: string; epoch: number; outcome: 'completed' | 'uncertain'; clock: () => number}): Promise<void>`, and `revokeAuthorization(store: Store, command: RevocationCommand, runtime: RuntimeInvalidator, coordinator: DispatchCoordinator, clock: () => number): Promise<void>`. OperationRef holds only request/device/lease/context/epoch/deadline/write metadata; Tool comes from current protocol. RevocationCommand covers disable, membership removal, resource block, token fingerprint and device revoke. Dispatch is an injected local test transport. Consume the single DispatchCoordinator created by Task 5, and produce `dispatchAuthorized(deps: {store: Store; coordinator: DispatchCoordinator; transport: LocalTestTransport}, input: OperationInput): Promise<OperationRef>`, where OperationInput is admitOperation's input type. Both dispatchAuthorized and revokeAuthorization use runtime.coordinator, also supplied to Task 6 executeAdmin; its handler routes revocation commands here. Admission checks auth.principal against the context's owner/client/resource and uses auth.tokenFingerprint plus principal issuedAt/expiresAt, never token evidence remembered from initialization.

- [x] Force an interleaving where HTTP verification succeeds, token denial commits and acknowledges through the private admin handler, then dispatch acquires the fence: zero frames must be sent. Also test token expiry while waiting for the fence/SQL lock, cutoff enforcement and token B for the same principal/context remaining distinguishable from denied token A. Test concurrent writers/revoke, next-dispatch denial after disable/removal, token-only versus resource-wide blocks, mismatched/late response, interrupted send and crash after durable intent. Assert no resend after reopening:
  ```ts
  assert.equal(recoveredOperation.state, 'uncertain');
  assert.equal(testTransport.sent.length, 0);
  await assert.rejects(admitOperation(reopened, staleRequest), /NOT_PAIRED|STALE_CONTEXT/);
  ```
- [x] Run `node --import tsx --test test/database/durable-dispatch.test.ts`; establish red for missing admission/revocation semantics.
- [x] Implement metadata intent-before-send, exclusive write ownership, exact correlation and 30-second RPC deadline. Hold the coordinator fence across awaited current-state row locks and checks of the request's token fingerprint/expiry/cutoff, exact principal/client/resource binding, current enrollment and grant policy, intent transaction COMMIT, fresh token-expiry/deadline/readiness check and synchronous transport enqueue; revoke uses that same fence through durable denial and runtime invalidation before acknowledgement. Release SQL transactions/fence before awaiting RPC results. A lost COMMIT acknowledgement is uncertain and must never enqueue/retry. Test forced interleavings, rollback/client release and SQL deadlock/lock-timeout denial. No routine can bypass the fence just because a pg query awaits. Revoke/notify/reject pending operations after durable revocation; writes with uncertain outcome return EXECUTION_UNCERTAIN, never replay or rollback claims. No payload queue or production transport.
- [x] Run policy/dispatch/operator/identity suites; still-valid JWTs must fail after local block and after restart. Assert no Management API call occurs in request authorization.
- [x] Commit as `feat: enforce atomic durable dispatch and local revocation`.

### Task 11: Postgres backup, isolated restore and retention

**Files:** Create packages/storage/retention.ts, scripts/validate-identity-store.ts, test/support/postgres-tools.ts, test/database/recovery.test.ts, docs/IDENTITY_OPERATIONS.md. Extend storage types, recovery/admin commands and private dump exclusions.

**Interfaces:** Produce `validateRestoredStore(connection: MigrationConnection, expectedStoreId: string): Promise<IntegrityReport>`, `runRetention(store: Store, clock: () => number): Promise<RetentionReport>` and `reconcileRoster(store: Store, manifest: RecoveryManifest, runtime: IdentityRuntime, clock: () => number): Promise<{activated:number}>`. Define `RecoveryManifest = Readonly<{storeId: string; deploymentEpoch: string; tokenIatAfter: number; reviewedAt: number; sourceRefs: readonly string[]; revocationsVerified: true; approvedMemberships: readonly {userId: string; teamId: string}[]; disabledUserIds: readonly string[]; removedMemberships: readonly {userId: string; teamId: string}[]; resourceBlocks: readonly {userId: string; resource: string}[]}>`. The manifest is an explicit trusted operator input from current evidence outside the restored DB; references identify protected roster/revocation records, never credentials. Reject missing/unverified evidence or store/epoch/cutoff mismatch. MigrationConnection is an operator-only validated credential, never part of Store. The test-only helper `runPostgresTool(tool: 'pg_dump'|'pg_restore', args: readonly string[], connection: TestConnection): Promise<void>` runs matching-major tools locally or in the explicit disposable test container. Production export/restore uses the same documented flags from the authenticated Railway database shell; no Node installation or backup login is required in the identity app. Reports contain counts/status only; reconciliation requires maintenance and runtime.coordinator, applies disabled users/removals/resource blocks first and then reactivates only explicitly approved existing subject-bound memberships; denial wins over approval. It never clears a block or activates devices/leases. Users without verified current revocation evidence stay suspended; restored pending invitations remain revoked.

- [x] Test pg_dump custom-format export during concurrent committed writes, pg_restore into a separate empty disposable target, wrong schema/store marker, missing/invalid constraints and app-role DDL denial. Restore old enrollment/credentials while newer tokens exist; new deployment epoch plus maintenance must suspend old permissions and reject every old context/credential. Test the full recovery sequence: mint token A, snapshot, deny A after the snapshot, restore, advance the external cutoff/epoch, reconcile a verified manifest, reopen admission while A is still unexpired and assert A remains denied while a new unblocked token B issued after the cutoff can succeed. A fresh token for a currently disabled/removed/resource-blocked principal must fail. Missing/stale/unverified manifest evidence stays suspended, and a conflicting approval never overrides a denial. Test cutoff equality without clock leeway, cutoff persistence across restart/rollback and old pending invitation refusal. Test 30-day audit/course-close-plus-30-day PII boundaries without breaking FKs/enforcement.
- [x] Run `node --import tsx --test test/database/recovery.test.ts`; establish red for backup/validation/retention behavior using real Postgres and matching-major pg_dump/pg_restore tools. Tests never restore into the active hosted database.
- [x] Implement/test the operator procedure and disposable-tool harness for pg_dump with schema=mpd_identity, custom format, no-owner/no-privileges; protect/encrypt output and use protected credentials, not command-line URLs. Restore with exit-on-error, no-owner and no-privileges into an isolated target under the migration/owner role; validate migration checksums, tables/constraints and authorization invariants, then explicitly regrant target roles. Do not install backup credentials/tools into the app request path. Before restore, set AUTHZ_TOKEN_IAT_AFTER outside Postgres to at least trusted current Unix seconds +60 after draining; admission requires a strictly later iat and may require a fresh token after that future time. Preserve the cutoff on future releases/rollbacks and advance it on every restore. Validate the RecoveryManifest against current external roster/revocation evidence; if completeness cannot be verified, do not reactivate affected identities. Apply manifest denials before approvals atomically under the runtime fence. Apply bounded transactional retention with denial expiry+60 seconds and preserved enforcement metadata.
- [ ] Exercise runbook: external maintenance, stop/drain identity app, restore isolated target, validate, provision/rotate target database roles/credentials, advance AUTHZ_DEPLOY_EPOCH and the external issuance cutoff, switch private DATABASE_URL, reconcile suspended roster using the verified RecoveryManifest and reissue device credentials, prove denial after reconciliation and reopening admission, including a previously denied pre-restore JWT and a fresh JWT for a still-blocked subject/resource. Keep original DB isolated for rollback; do not delete it without explicit authorization. Enable daily Railway DB-service backups and record actual retention/cost; PITR is optional only after explicit account/cost review. Record observed hosted restore versus pending prerequisites.
- [x] Run recovery/storage/durable suites, verify no restored authority becomes active and commit as `feat: add Postgres authority backup restore and retention`.

### Task 12: Native same-user context evidence gate

**Files:** Create packages/authorization/session-binding.ts, test/session-binding.test.ts; extend private observation/runtime hooks and IDENTITY_VERIFICATION. Do not add public diagnostics/desktop tools.

**Interfaces:** Produce `resolveWorkBinding(input: {principal: VerifiedPrincipal; context: ContextRef}): {status: 'SESSION_ISOLATION_UNPROVEN'}` as the production default. A verified resolver requires a later evidence-backed design; no provider/browser/session claim is presumed sufficient. Test-only trusted bindings may be injected locally but never selected by environment/tool input in production.

- [x] Write tests that subject, azp, sid, random context IDs and copied MCP handles cannot manufacture verified work identity. Default always returns SESSION_ISOLATION_UNPROVEN; production bootstrap cannot load test bindings and no public desktop grant can activate.
- [x] Run `node --import tsx --test test/session-binding.test.ts`; establish red, then implement the rejecting default and sanitized private observations. Record equality flags/correlation facts, never raw tokens/claims.
- [ ] Use two simultaneous native cloud sessions for one approved student and a second student's session. Record exact path and transport/token/grant equality facts; test initialization, controlled copied-token/handle attacks, refresh, reconnect and logout. Correlate private operator observations to actual native identity calls, with no diagnostic MCP endpoint or desktop relay.
- [ ] If a documented integrity-protected per-work-session credential exists, write/review its binding design before implementation. Otherwise record SESSION_ISOLATION_UNPROVEN and keep full milestone acceptance blocked. Different token strings or transport handles alone are not proof that future chats cannot inherit authority.
- [ ] Commit default/tests/evidence as `test: establish native session isolation gate`. A documented blocked outcome completes the experiment, not the full milestone.
### Task 13: Integration checks and honest acceptance handoff

**Files:** Update HANDOFF, ARCHITECTURE, THREAT_MODEL, KNOWN_LIMITATIONS, IDENTITY_VERIFICATION, IDENTITY_OPERATIONS, examples and applicable dependency/build instructions. No new feature in this task.

**Interfaces:** Consume prior task outputs; keep automated/local, direct hosted and operator-reported native evidence separate.

- [x] In a clean execution checkout run npm ci --ignore-scripts, start the explicit disposable Postgres service, then typecheck, root unit/probe tests, database integration tests, test:coverage (>90% per repo instructions), mock demo, build, probe regeneration/drift and both image smoke checks. Repair actual failures with meaningful regression tests; do not reuse old results as fresh verification or hide baseline coverage gaps.
- [x] Fill the spec acceptance matrix with native account/refresh evidence, isolated restore evidence and Task 12 outcome. Full milestone acceptance requires all gates; otherwise label identity delivery partial and name the exact missing integration mechanism/input. Do not claim real keychain/WSS/Blender success.
- [x] Perform the execution method's independent review of shared package isolation, claims/audiences, SQL/races, current revocation, logging, database roles/pool/owner lock/restore and production entrypoints. Check that test bindings/fixture auth cannot enter production and second-server tests pass.
- [x] Update handoff with actual nonsecret issuer/resource/client facts, service/deployment IDs, commits/domains, native path/results, operator recovery instructions and usage review. Retain only intentionally needed services; do not delete services without explicit authorization.
- [ ] Commit verified fixes/docs and push main after inspecting the diff. Report completed checks and honest acceptance status; move to milestone 3 only when its prerequisites are satisfied and the operator asks to continue.

## Spec coverage and self-review

- Sections 1–3: Tasks 1–2, 5 and second-server fixture establish reusable auth with separate authorization.
- Section 4: Tasks 4, 6, 8 cover explicit invitations, provider retries, email delivery and actual login.
- Section 5: Tasks 1–2, 5, 7–8 cover strict OAuth resource-server behavior and native compatibility.
- Sections 6–7: Tasks 3–4, 6, 9–10 cover durable schema/policy, credentials, refresh limits and immediate local denial.
- Section 8: Task 12 is a real-client gate with explicit blocked outcome, not a mock substitute.
- Sections 9–10: Tasks 3, 7–8, 11 cover restart, non-root app deployment, private database migrations/roles, restore, retention and budget review.
- Sections 11–12: Tasks 8, 12–13 obtain external inputs and record the full acceptance matrix.

Review the exact function/type references across tasks, all five Review Focus cases, link/section structure, no placeholder decisions and no accidental desktop implementation. Concrete tenant/resource/client/sender values belong to authenticated Task 8 setup because they do not exist yet; do not invent them.

## Execution handoff

No execution method has been selected. Review the plan before implementation. Recommend native execution for this solo pilot: auth/store/runtime interfaces are tightly dependent and one implementer can maintain consistency, followed by the fresh independent final review required by the execution skill. Subagent-driven execution adds separate implementer/reviewer gates per task at greater context cost. Use the selected skill after plan review; writing this plan does not begin implementation.

## Independent review corrections

The Astra document review identified four changes, incorporated into both artifacts: explicit stop/drain/lock-release/start for every deploy and rollback (Tasks 3, 7–8); external monotonic recovery cutoff plus verified current-revocation manifest and reopened-admission tests (Tasks 3–5, 11); fresh per-request authentication evidence checked under the shared admin/dispatch fence (Tasks 4–6, 10); and Dockerfile.identity.dockerignore with input/exclusion tests (Task 7). The operator requested no second Astra review; author consistency review is the revision check. These are planned changes, not implemented or hosted-test results.

## PostgreSQL revision review

Storage selection supersedes the previous local-file design. All repository signatures now return Promises; transaction tests use a real matching-major database, migrations use a separate role/job, app startup validates rather than creates schema, and dispatch/revocation coordinate awaited DB work. The app stays single-owner despite Postgres supporting multiple connections. Native OAuth/session gates remain required. No database, dependency, service or product code was changed while revising this document.

## Final local verification — October 18, 2026

138 root +232 real PostgreSQL tests passed; rebuilt identity container11/11; mock demo, typecheck/build, probe artifact drift and both image smoke paths passed. Whole-project coverage:95.42% lines/statements,96.87% functions,93.08% branches; planned 91% gates pass without exclusions. Fresh Astra implementation review identified two important bugs (pending invitation removal and leaked-checkout shutdown), both fixed with RED/GREEN tests and verified in this complete run. Hosted/native tasks and production mail/backup/cost prerequisites remain open; see the verification record. The operator approved remote push and the public identity-only Railway pilot. Main is pushed through `4d789b2`; private Postgres 17 is running and the identity hostname is reserved. Both CLI sign-ins succeeded and the exact Auth0 API/static public Claude client are configured. Temporary workspace SSH access was explicitly approved and used for actual PostgreSQL 17.11 role/schema 2 initialization and integrity checks. Identity deployment f7c87ab7-57ad-40bf-b1fb-737b93be8e9a at 355ba95 is ready; maintenance/private admin/enrollment/metadata/401/origin checks passed. Preserve RAILWAY_DOCKERFILE_PATH=Dockerfile.identity after the first manifest-path-only build failed. The temporary SSH registration and remote operator files were removed. DAILY backups were rejected as Pro-only; no upgrade occurred. The Linux CI fixture correction passed 370 local tests; replacement GitHub CI39139754683 passed both jobs,370 tests and11 container checks. See the verification record for exact rollout state.

Hosted gates remain unchecked until real native accounts/tokens/refresh/session results and a working backup/restore approach exist. The user later explicitly approved the local identity-schema export: one backup-role-only age-encrypted archive now exists, with matching PG17.11 catalogue/readability and private-mode checks. Temporary SSH access was revoked. A full hosted restore and ongoing backup approach remain pending. The successful two-account operator native tests use the inherited claude.ai connector with the documented static public-client option, preserving both existing probe entries.

First hosted email-code login and operator-reported native class_identity for account A passed after enabling prompts.identifier_first. Exact resource/course/team matched, desktop_access:false. Account B subsequently passed its operator-reported native call: distinct user/team, same course, desktop_access:false, matched against protected deployment state. Both native account checks passed; refresh/revocation and concurrent-session acceptance remain pending. Exact client version/server identifier/cloud-session commits were not supplied. Reported ~20-second submit wait and repeated-click behavior are recorded as an unresolved hosted-UI finding; no UI redesign was implemented.

October 18 refresh follow-up: account A operator-reported native repeat matched its original identity, and Auth0 sertft at 20:15:14.981 UTC followed its 20:02:53 code exchange by more than 12 minutes. Provider refresh passed; user logged out of B and chose A for further checks. Scoped grant revocation preflight lacks read:grants; official CLI reauthorization is pending, with no revocation yet. Read-only implementation inspection found native fingerprint/expiry observations are not persisted/exposed privately; same-token local-revocation and cross-chat equality evidence remain blocked without a reviewed private observation addition. No public diagnostic endpoint or desktop authority added.

October 18 scoped revocation: official CLI scope renewal completed. Exactly one account A/client/resource grant was identified, deleted by ID at 20:22:16 UTC and confirmed absent by filtered GET. No broad deletion. Native post-expiry failure/reconnect test requested at/after 3:34 PM Chicago remains pending.

October 18 revocation follow-up: the native connection redirected the operator to sign in. Auth0 fertft at 20:35:41.340 UTC for the configured client reported the token missing/undecodable. This supports the scoped post-expiry refresh-revocation check; the event lacked a mapped subject, so account correlation uses client/timing plus operator report. Fresh A login/native restoration is requested and pending. No immediate-JWT or token-reuse claim.

October 18 reconnect restoration passed: provider login/code exchange at 20:37:51 UTC matched account A, one exact client/resource grant is restored, and the operator’s native result matched A’s original user/course/team with desktop_access:false. Two concurrently open A cloud sessions without reconnecting are requested next; equality/isolation, reuse/logout, local JWT denial and recovery gates remain open.

October 18 concurrent native follow-up: operator supplied matching account A results from a new cloud session and then the still-open original session without reconnecting the connector. Concurrent identity usability passed; same-token/transport/grant equality, copied-handle attacks and a simultaneous B control were not observed. Keep Task12 stronger experiment unchecked and SESSION_ISOLATION_UNPROVEN; the plan’s private observation hooks are the next implementation gap.

October 18 approved private observation extension implemented: ring64,TTL5min/original-expiry with active idle cleanup,report8/private4KiBframe,per-boot opaque correlations,deny by trusted reference with original token expiry. Review reporting-race and parser-coercion findings reproduced/fixed; idle cleanup regression added. Final local143+234 tests,95.51% lines/statements,97.01% functions,93.32% branches, new module100%,build/typecheck/demo/probe drift passed. Container/remoteCI/deployment follow; native reference denial pending.
