# Milestone 2 Identity and Durable Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build reusable Auth0 authentication for class MCP servers and durable SQLite authorization, with real-client verification before any desktop authority is enabled.

**Architecture:** A storage-independent authentication package verifies provider tokens and serves MCP discovery. A separate identity-only service uses SQLite enrollment and current revocation policy; local adapters exercise persistent device/lease behavior. Native OAuth is checked early; unresolved same-user cloud context isolation blocks full milestone acceptance and all public desktop capabilities.

**Tech Stack:** Node 22+, TypeScript/NodeNext, existing MCP SDK 1.32.1, jose, better-sqlite3, Auth0 hosted email OTP, Railway Docker/volume, Node test runner with tsx.

**Spec:** [Approved milestone 2 design](../specs/2026-10-17-milestone-2-identity-authorization-design.md).

**Status:** Design approved October 17, 2026. This plan is for review; no implementation task or provider provisioning has been performed.

## Global Constraints

- Work from main, preserve local changes, and use direct commits/pushes; no PR requirement. Use a worktree only if isolation is needed at execution time.
- Auth0 plus SQLite are approved. Invited, verified email is sufficient; Northwestern NetID SSO is not required.
- Keep the existing public ping probe separate and harmless. No public mock gateway, desktop tools, agent/WSS endpoint, shared roster API, Redis or cluster in this milestone.
- Shared identity is `(issuer, subject)`. Every MCP server has its own exact audience, allowed clients and scopes. The reusable package imports no Blender, connector or storage implementation.
- Require boolean true in the signed claim `https://github.com/Northwestern-MPD/claims/email_verified`, populated from trusted Auth0 verification state.
- RS256 only; exact issuer/audience; signed azp allowlist; client_id must agree when present; scopes come from signed scope. API access-token lifetime 600 seconds; clock tolerance 60 seconds.
- Cache trusted JWKS for at most one hour, refresh after ten minutes and rate-limit unknown-key refresh attempts. Never fetch token-provided issuer/jku/x5u URLs.
- Invitation lifetime seven days; pairing code randomness at least 128 bits; device credential randomness at least 256 bits.
- Database path `/data/authorization.sqlite`; foreign keys on every connection, WAL, synchronous=FULL, bounded busy timeout and restrictive permissions.
- One authorization-service instance/replica and one volume. Missing production DB fails closed; initialization requires an explicit operator action.
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
4. Restoring old authorization data while newer tokens/credentials exist: maintenance, epoch change and roster reconciliation prevent authority resurrection (Tasks 3 and 11).
5. Fresh Node 22 installs, native-module architecture and empty/root-owned volumes: controlled build, non-root serving process and explicit initialization work together (Task 7).

## Execution map

Tasks 1–8 deliver an identity-only release and its native OAuth check. Tasks 9–11 build durable desktop-policy foundations through local adapters. Task 12 establishes the actual same-user context outcome; Task 13 records acceptance or a precise blocked result. Execute in order. External access blockers need not stop independent local tests, but no local test substitutes for native evidence.

## File structure

| Files | Responsibility |
|---|---|
| `packages/auth/{types,errors,verifier,jwks,metadata,index}.ts` | Reusable token verification, trusted keys and OAuth discovery |
| `packages/storage/{types,database,migrations,enrollment,contexts,devices,grants,operations,revocations,recovery,backup,retention}.ts` | Versioned SQL schema, lifecycle and transactional repositories |
| `packages/authorization/{identity,policy,runtime,session-binding}.ts` | Enrollment decisions, local policy/dispatch, invalidation and rejecting default binding resolver |
| `packages/credentials/keychain.ts` | CredentialStore interface, test injection and fail-closed unavailable implementation |
| `apps/identity/{config,server,main}.ts` | New HTTP MCP identity-only application |
| `apps/operator/{types,socket,commands,main,provision,mail}.ts` | Private admin socket/CLI, provider reconciliation and invitation sender |
| `auth0/actions/verified-email.js` | Auth0 Action issuing the fixed verification claim |
| `test/support/{auth,storage,operator}.ts` | Local signing keys/clocks, temporary databases, provider/mail fakes |
| `test/{auth-verifier,auth-discovery,storage,enrollment,identity-http,operator,durable-policy,durable-dispatch,recovery,session-binding}.test.ts` | Focused behavioral suites compatible with existing root test glob |
| `test/container/identity.test.ts` | Explicit container-only suite, excluded from the default root test glob |
| `Dockerfile.identity`, `scripts/identity-entrypoint.sh`, `railway.identity.json` | Separate deployment image, volume ownership/bootstrap and service config |
| `examples/identity.env.example`, `examples/identity.mcp.json` | Nonsecret examples, clearly labeled as examples |
| `docs/{AUTH0_SETUP,IDENTITY_OPERATIONS,IDENTITY_VERIFICATION}.md` | Provider setup, operational procedures and evidence |
| Existing package/lock files, CI workflow, SessionStart hook, .gitignore and handoff | Dependency/build integration, private-artifact exclusions and continuation state |

Keep `packages/core.ts`, the mock gateway and current probes as existing regression paths. Do not retrofit persistence into the fixture singleton or import its bearer parser into production. Keep new modules focused; publish no npm package yet. The planned private package identity is `@northwestern-mpd/mcp-auth`.

### Common contracts

Types live in the owning task's types.ts. Times are Unix milliseconds except raw JWT claims, which use seconds.

- `PrincipalKey = Readonly<{issuer: string; subject: string}>`.
- `VerifiedPrincipal = PrincipalKey & Readonly<{clientId: string; scopes: readonly string[]; issuedAt: number; expiresAt: number; emailVerified: true}>`; no raw token/claim bag.
- `AuthConfig = Readonly<{issuer: string; jwksUri: string; resource: string; allowedClientIds: readonly string[]; requiredScopes: readonly string[]}>`.
- `Store = {db: BetterSqlite3.Database; bootId: string; deploymentEpoch: string; close(): void}`; raw handle is private to repositories/storage tests. Import the BetterSqlite3 type from better-sqlite3.
- `IdentityView = Readonly<{userId: string; resource: string; courseIds: readonly string[]; teamIds: readonly string[]; desktop_access: false}>`.
- `ContextRef = Readonly<{id: string; userId: string; resource: string; clientId: string; bootId: string; deploymentEpoch: string}>`.
- `RuntimeInvalidator = {invalidate(input: {userId?: string; deviceId?: string; contextId?: string; teamId?: string}): void}`; synchronously removes runtime authority and rejects/notifies matching local pending work.
- `PolicyError` exposes a stable string code. HTTP errors never include provider/SQL/stack/credential details.

---

### Task 1: Strict reusable Auth0 access-token verification

**Files:** Create auth/types.ts, errors.ts, verifier.ts, index.ts under packages; test/support/auth.ts; test/auth-verifier.test.ts. Modify package.json/lockfile.

**Interfaces:** Produce `verifyAccessToken(token: string, config: AuthConfig, deps: {resolveKey: JWTVerifyGetKey; now(): number}): Promise<VerifiedPrincipal>` and `requireScopes(principal: VerifiedPrincipal, scopes: readonly string[]): void`. JWTVerifyGetKey is imported from jose. Export VERIFIED_EMAIL_CLAIM with the exact spec literal. Test helper `signingFixture(nowMs: number)` exposes `mint(overrides?: Record<string, unknown>): Promise<string>`, resolveKey, now and valid config; defaults use RS256, azp, identity:read and the fixed verification claim.

- [ ] Write tests for wrong key/algorithm/issuer/audience, ID-token audience, malformed/missing/false/string verification claim, malformed subject/azp, conflicting client_id, missing scopes and clock boundaries. The wrong-audience case must assert:
  ```ts
  const f = await signingFixture(1_800_000_000_000);
  const token = await f.mint({ aud: 'https://other.example/mcp' });
  await assert.rejects(verifyAccessToken(token, f.config, f), /INVALID_TOKEN/);
  ```
- [ ] Check stable jose engines/release compatibility with Node 22 using `npm view jose version engines --json`, pin the selected exact version, install test prerequisites, then run `node --import tsx --test test/auth-verifier.test.ts`. Expected red: missing verifier behavior, not a broken fixture/dependency.
- [ ] Implement with jose.jwtVerify, RS256 and 60-second tolerance. Require typed exp/iat, nonempty subject/azp and valid scope; require client_id agreement when present. Match exact audience/issuer, reject future issuance and normalize immutable output. Do not resolve trust from incoming data.
- [ ] Run the focused suite and `npm run typecheck`; expect every positive/negative assertion passes.
- [ ] Commit as `feat: add reusable strict Auth0 token verification`.

### Task 2: Trusted JWKS, MCP metadata and second-server reuse

**Files:** Create packages/auth/jwks.ts, metadata.ts and test/auth-discovery.test.ts; extend auth exports/fixtures.

**Interfaces:** Consume Task 1. Produce `createJwksResolver(config: AuthConfig, deps: {fetch: typeof fetch; now(): number}): JWTVerifyGetKey`, `protectedResourceMetadata(config: AuthConfig): object`, `metadataPath(resource: string): string`, and `authenticationChallenge(config: AuthConfig, error: 'invalid_token' | 'insufficient_scope', scopes?: readonly string[]): string`.

- [ ] Write counting-fetch tests: trusted fetch only, refresh at 600_000 ms, known-key outage grace ending at 3_600_000 ms, unknown kid denial and at most one unknown-key refresh/minute. Ignore token jku/x5u; bound fetch to 5 seconds/64 KiB/32 keys and reject redirects to unconfigured origins. A second resource uses the same package/keyset but rejects the first resource's token:
  ```ts
  const other = { ...f.config, resource: 'https://assignments.example/mcp' };
  await assert.rejects(verifyAccessToken(await f.mint(), other, f), /INVALID_TOKEN/);
  ```
- [ ] Run `node --import tsx --test test/auth-discovery.test.ts`; expect red for missing key-cache/metadata behavior.
- [ ] Implement per-config trusted caches with explicit last-success age and failed-refresh handling. Generate RFC 9728 metadata/challenges; a resource ending /mcp uses `/.well-known/oauth-protected-resource/mcp`. Metadata and token verification use the identical canonical resource, without altering it from request headers.
- [ ] Run auth-verifier/auth-discovery suites plus typecheck; expect audience/scope isolation and outage/rotation tests pass. Inspect imports to verify no storage/Blender dependencies.
- [ ] Commit as `feat: add bounded JWKS and reusable MCP auth discovery`.

### Task 3: SQLite schema and fail-closed startup

**Files:** Create packages/storage/types.ts, database.ts, migrations.ts, recovery.ts; test/support/storage.ts; test/storage.test.ts. Modify dependencies/lockfile and private artifact exclusions.

**Interfaces:** Produce `openAuthorizationStore(options: {path: string; initialize: boolean; maintenance: boolean; deploymentEpoch: string; now(): number}): Store`. Define all spec tables/columns/states, including operation_attempts, token denials and deployment epochs. Temporary DB fixtures use real files and close/remove them in finally blocks.

- [ ] Test missing DB refusal, explicit initialization, initialized-store refusal when initialize=true, migration rollback/failure, newer unsupported schema, FKs/unique indexes, reopen durability and permissions. Seed active contexts/leases/pairings/devices/unfinished operations and assert reopening invalidates authority but preserves enrollment/revocations:
  ```ts
  assert.throws(() => openAuthorizationStore({
    path: missingPath, initialize: false, maintenance: false,
    deploymentEpoch: 'epoch-1', now: () => 1_800_000_000_000,
  }), /STORE_NOT_INITIALIZED/);
  ```
- [ ] Check/pin stable Node-22-compatible better-sqlite3 and its type declarations. Retain `npm ci --ignore-scripts`, then explicitly `npm rebuild better-sqlite3`. Run `node --import tsx --test test/storage.test.ts`; establish red after confirming the native module loads.
- [ ] Implement parameterized migrations, foreign_keys=ON, WAL, synchronous=FULL and busy_timeout=5000 per connection. Initialization requires initialize=true AND maintenance=true; store an initialization/schema marker. Before returning, atomically create a new boot ID, invalidate contexts/pairings/leases, advance device epochs/offline state and mark unfinished mutation intents uncertain. On deployment-epoch mismatch additionally suspend users/memberships and invalidate credentials; maintenance is required.
- [ ] Run storage suite, reopen databases and check PRAGMA integrity_check/foreign_key_check. Expect enrollment preserved and old live authority invalid. Normal startup never initializes a missing DB or silently downgrades a schema.
- [ ] Commit as `feat: add durable SQLite authority store and safe startup`.

### Task 4: Subject-bound invitations and current authorization

**Files:** Create packages/storage/enrollment.ts, packages/authorization/identity.ts, test/enrollment.test.ts; extend storage types/fixtures.

**Interfaces:** Define `InvitationInput = {id: string; email: string; issuer: string; subject: string; courseId: string; teamId: string; role: 'student' | 'instructor'; expiresAt: number}`. Produce `enrollInvitation(store: Store, input: InvitationInput, now: number): void`, `activateEnrollment(store: Store, principal: VerifiedPrincipal, now: number): string` (user ID) and `authorizeIdentity(store: Store, principal: VerifiedPrincipal, input: {resource: string; tokenFingerprint: string; now: number}): IdentityView`.

- [ ] Test seven-day invitation bounds, subject-only activation, unverified/uninvited/disabled/expired/revoked denial, plus-address/domain distinctions, membership rollback and token/resource blocks. Distinguish normal repeat login from invitation replay: accepted enrollment is idempotent, but it cannot recreate a revoked membership. Seed subject A's invitation and assert subject B cannot inherit it despite identical email display information:
  ```ts
  assert.throws(() => authorizeIdentity(store, principalB, request), /NOT_ENROLLED/);
  assert.equal(activeMembershipCount(store, principalB), 0);
  ```
- [ ] Run `node --import tsx --test test/enrollment.test.ts`; expect missing repository/authorization behavior.
- [ ] Implement transactional invitation consumption/membership activation. Trim surrounding whitespace and lowercase only email domains; do not merge local parts/dots/plus tags. Bind issuer/subject explicitly, require verified-email evidence and current local permissions, never email claims/domain inference. No positive authorization cache; return only IdentityView.
- [ ] Run enrollment/storage/auth suites. Inject a failure between consumption and membership creation; assert rollback and no duplicate enrollment on retry.
- [ ] Commit as `feat: enforce durable invited student enrollment`.

### Task 5: Identity-only MCP server and per-request checks

**Files:** Create apps/identity/config.ts, server.ts, main.ts; packages/storage/contexts.ts; packages/authorization/runtime.ts; test/identity-http.test.ts.

**Interfaces:** Produce `readIdentityConfig(env: NodeJS.ProcessEnv): IdentityConfig`, `createIdentityRuntime(store: Store): IdentityRuntime` (implements RuntimeInvalidator), and `startIdentityServer(options: {config: IdentityConfig; store: Store; verify(token: string): Promise<VerifiedPrincipal>; runtime: IdentityRuntime}): Promise<{url: string; close(): Promise<void>}>`. IdentityConfig contains auth:AuthConfig, database:{path, initialize, maintenance, deploymentEpoch}, explicit externalOrigin, host, port, maintenance and adminSocketPath; its startup validation rejects contradictory maintenance/bootstrap flags. Persist `recordTransportContext(store: Store, principal: VerifiedPrincipal, resource: string, now: number): ContextRef`; principal/client/resource/boot ownership is immutable across continued requests.

- [ ] Write real SDK HTTP tests using local signed tokens: public metadata/health, 401 challenge, insufficient scope, uninvited 403, maintenance/store 503 and readiness. Reject copied handles with wrong principal/client, missing bearer on continued/DELETE requests, JSON over 65_536 bytes including chunked bodies, duplicate bearer, malformed JSON, disallowed Origin and spoofed forwarded Host. Assert:
  ```ts
  assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['class_identity']);
  const result = await client.callTool({ name: 'class_identity', arguments: {} });
  assert.equal(result.structuredContent?.desktop_access, false);
  ```
- [ ] Run `node --import tsx --test test/identity-http.test.ts`; expect missing server/runtime behavior. Request local-port sandbox access if needed.
- [ ] Implement with current SDK primitives, without importing the mock gateway. Auth precedes protected parsing/routing; recheck local authorization on every tool call. Implement exact session/rate/body bounds and headers=10 seconds/request=35 seconds. Origin/proxy trust comes from configuration. class_identity takes no arguments and returns only IdentityView; reject all desktop tool names. Maintenance never admits students; failed store/config startup opens no listener.
- [ ] Run identity/auth/enrollment suites and typecheck. Capture a canary token/secret and assert no response/log leaks it. Verify no cookie grants authority and current probe catalogue remains ping-only.
- [ ] Commit as `feat: expose authenticated class identity MCP service`.

### Task 6: Local admin, idempotent Auth0 provisioning and Action

**Files:** Create apps/operator/{types,socket,commands,main,provision,mail}.ts; auth0/actions/verified-email.js; test/support/operator.ts; test/operator.test.ts; docs/AUTH0_SETUP.md. Add only required provider/SMTP dependencies, pinned after compatibility checks.

**Interfaces:** Define AdminCommand with literal kinds import-invites, disable-user, remove-membership, block-resource and deny-token; Task 10 adds revoke-device and Task 11 adds maintenance, reconcile-roster, backup and retention. AdminResult is {ok:true, affected:number}; errors use stable PolicyError codes. Accept user/team/resource IDs and validated fingerprints, not arbitrary SQL or provider URLs. Produce `executeAdmin(command: AdminCommand, deps: {store: Store; runtime: RuntimeInvalidator; now(): number}): AdminResult`, `startAdminSocket(path: string, execute: (command: AdminCommand) => Promise<AdminResult>): Promise<{close(): Promise<void>}>`, `runOperator(args: readonly string[], deps: OperatorDependencies): Promise<number>`, and `provisionRoster(rows: readonly RosterRow[], deps: {provider: Auth0Provisioner; local: EnrollmentAdmin; sender: InvitationSender; sendAuthorized: boolean}): Promise<ProvisionSummary>`. Define dependency types in operator/types.ts; their operations are create/reconcile exact email-connection subject, record invitation, and deliver invitation.

- [ ] Test socket mode 0600, strict/bounded commands, durable mutation before acknowledgement and runtime invalidation. Fake-provider/SMTP tests reproduce remote success/local failure; retry must reconcile the same subject, create one membership and send no mail before persistence. sendAuthorized=false sends zero mail. Already confirmed mail is not resent; uncertain delivery is surfaced for operator reconciliation. Test the Action issues only the fixed boolean claim from event.user.email_verified, ignoring request/user_metadata.
- [ ] Run `node --import tsx --test test/operator.test.ts`; expect missing admin/provisioning behavior.
- [ ] Implement private socket commands and file/stdin CLI inputs. Keep roster, exact subject mapping and invitation delivery manifests under ignored work/identity-operator/ with restrictive permissions and no secrets. Use narrow Management API credentials only in the operator process, not the serving process. Use a maintained SMTP adapter; classify sent/failed/uncertain outcomes rather than promise exactly-once email. Hash a token from protected stdin before token-denial admin submission; never print it.
- [ ] Document Auth0 setup: production SMTP/verified sender, disabled email signups, pre-provisioned identities, Action binding, RS256/default access-token profile, 600-second API lifetime, identity:read, resource compatibility, PKCE and approved native client registration. Include supported refresh rotation/reuse/expiry settings, narrow Management API scopes and local-first disable. Validate nonsecret examples with readIdentityConfig.
- [ ] Run operator/enrollment/identity suites and typecheck; verify logs omit recipient lists/OTP/secrets. Commit as `feat: add operator enrollment and Auth0 setup contracts`.

### Task 7: Node 22 image, volume bootstrap and CI

**Files:** Create Dockerfile.identity, scripts/identity-entrypoint.sh, railway.identity.json, examples/identity.env.example, examples/identity.mcp.json, test/container/identity.test.ts. Modify npm scripts/lockfile, .github/workflows/check.yml, .claude/settings.json, .gitignore and applicable agent build instructions.

**Interfaces:** Add scripts start:identity (`node dist/apps/identity/main.js`), operator (`node dist/apps/operator/main.js`), test:identity-container (`node --import tsx --test test/container/identity.test.ts`) and test:coverage. Container tests must not run under the default `test/*.test.ts` glob. AUTHZ_INITIALIZE_DATABASE=true is an explicit initialization input permitted only with AUTHZ_MAINTENANCE=true; remove it before normal admission. Default initialization is false.

- [ ] Write smoke tests against a new temporary mounted volume: normal startup refuses missing DB; explicit maintenance initialization succeeds; student admission remains denied; restart with initialization disabled preserves enrollment. Test root-owned data directory, permission failure, native module load, runtime without source/tsx/dev dependencies and listening process UID !=0. Initially run `npm run test:identity-container` and establish failure against the absent image/entrypoint.
- [ ] Build separate multi-stage Node-22 Debian image: npm ci --ignore-scripts, controlled better-sqlite3 rebuild with build tools in builder, tsc build, dev pruning, runtime outputs/dependencies only. Install gosu in the runtime image; scope root entrypoint work to fixed /data ownership, reject symlink/unexpected paths and exec gosu node before opening listeners. No RAILWAY_RUN_UID=0 application workaround. Do not change current probe Dockerfile/railway.json.
- [ ] Configure identity service's Dockerfile, ON_FAILURE restart policy with three retries, 60-second healthcheck timeout and /health Railway liveness. /ready and protected requests remain closed during maintenance. Document an executable bootstrap: initialize in maintenance, remove initialize flag, reconcile/provision, then leave maintenance. It must not require SSH into a crashing uninitialized process. Do not use pre-deploy hooks to write the service volume.
- [ ] Retain npm ci --ignore-scripts in CI/SessionStart and add only the controlled native rebuild. Pin c8 and add test:coverage to run the existing npm test suite with c8 checks at 91% for lines/functions/branches/statements, include apps/**/*.ts and packages/**/*.ts, and text/lcov reporters. Exclude only generated artifacts/test fixtures; report legacy gaps rather than excluding security code. Run typecheck, tests, coverage, mock demo, build, probe regeneration/drift and both images. Record local architecture and CI linux/amd64; check arm64 where available without claiming unobserved coverage.
- [ ] Add private SQLite/WAL/SHM/operator artifacts to .gitignore and document dependency/build changes. Commit as `build: package identity service with controlled SQLite initialization`.

### Task 8: Hosted native identity compatibility gate

**Files:** Create docs/IDENTITY_VERIFICATION.md; update AUTH0_SETUP, HANDOFF and .mcp.json only with a real URL.

**Interfaces:** Consume Tasks 1–7; produce IDENTITY_NATIVE_PASS or a concrete IDENTITY_NATIVE_BLOCKED evidence record. Neither status enables desktop tools.

- [ ] Verify local/container gates, authenticated Auth0 access, SMTP sender, explicitly authorized test recipients/roster and Railway service inventory/spend controls. Reuse any identity service already created. Never invent provider/domain/client values or send real invitations without authorization; no artificial unit test for a dashboard action is needed.
- [ ] Create/reuse a separate identity service plus one volume in the existing project, generate HTTPS domain, then configure its exact /mcp resource/API and the actual native client in Auth0. Prefer operator-approved CIMD/static registration; verify any alternate client-required registration instead of assuming DCR. Apply issuer/resource/client/epoch/database config, secrets only in supported stores. Bootstrap in maintenance, enroll test subjects, remove bootstrap flag and require readiness before admission.
- [ ] Check hosted health/metadata/401 challenge, direct authenticated MCP identity and wrong-audience/uninvited denial without logging tokens. Add real class-identity MCP config alongside both probes and configure exact network allowlists for the selected delivery path.
- [ ] Ask the operator to run actual native cloud OAuth/discovery/class_identity for two accounts. Record branch/commit, delivery path, exposed client/version and sanitized result. Exercise expired access, supported refresh, revoked refresh, local block with a valid JWT and provider-only logout/block. Shell/SDK checks are separate evidence. Fix incompatibility with regression tests; never weaken audience/verification to pass.
- [ ] Commit nonsecret configuration/runbook/evidence changes. A native blocker leaves the service identity-only and milestone partial; independent local policy tasks can continue.

### Task 9: Durable device credentials, pairings and leases

**Files:** Create packages/storage/devices.ts, grants.ts; packages/authorization/policy.ts; packages/credentials/keychain.ts; test/durable-policy.test.ts. Extend storage types/fixtures.

**Interfaces:** Produce `enrollDevice(store: Store, input: {ownerId: string; name: string}, now: number): {deviceId: string; secret: string}`, `rotateDeviceCredential(store: Store, deviceId: string, now: number): {secret: string}`, `authenticateDevice(store: Store, secret: string, now: number): DeviceRef`, `createPairing(store: Store, input: PairingInput, now: number): {pairingId: string; code: string}`, `approvePairing(store: Store, input: {pairingId: string; deviceId: string; capabilities: readonly Capability[]}, now: number): LeaseRef`. DeviceRef has id/owner/epoch/deploymentEpoch/online state. PairingInput has ContextRef, teamId and capabilities. LeaseRef has id/context/device/team/capabilities/epoch/expiresAt/idleExpiresAt/state. Capability remains read|execute from protocol. CredentialStore exposes save/load/remove returning Promises; load returns string|null; unavailable production storage throws KEYCHAIN_UNAVAILABLE.

- [ ] Write real-file SQL tests for credential purpose separation, rotation/revoke/expiry/epoch, same-team wrong-owner denial, hashed pairing codes, expiry/replay/narrowing and concurrent approvals from two DB connections. Exactly one approval succeeds and one active lease exists. Test injected CredentialStore and unavailable adapter; no filesystem fallback/test-adapter selection in production.
- [ ] Run `node --import tsx --test test/durable-policy.test.ts`; establish red for missing durable behavior.
- [ ] Implement transactions, 256-bit device secrets, 128-bit pair codes, fingerprints only, partial unique active-lease indexes by user/device and current owner/membership/epoch checks. Retain five-minute pairing, one-hour lease and ten-minute idle defaults. Secrets are returned only on issuance. No public enrollment/WSS is added; test harness supplies devices/contexts.
- [ ] Run policy/enrollment/storage suites and reopen DB; device enrollment/revocation persists while live leases are invalid. Confirm no raw secret/code is stored/logged. Document real OS adapters as milestone 3 evidence.
- [ ] Commit as `feat: persist device ownership and single-use lease policy`.

### Task 10: Atomic admission, execution uncertainty and revocation

**Files:** Create packages/storage/operations.ts, revocations.ts; test/durable-dispatch.test.ts. Extend authorization policy/runtime and operator commands.

**Interfaces:** Produce `admitOperation(store: Store, input: {context: ContextRef; leaseId: string; tool: Tool; write: boolean; now: number}): OperationRef`, `completeOperation(store: Store, input: {requestId: string; deviceId: string; leaseId: string; epoch: number; outcome: 'completed' | 'uncertain'; now: number}): void`, and `revokeAuthorization(store: Store, command: RevocationCommand, runtime: RuntimeInvalidator, now: number): void`. OperationRef holds only request/device/lease/context/epoch/deadline/write metadata; Tool comes from current protocol. RevocationCommand covers disable, membership removal, resource block, token fingerprint and device revoke. Dispatch is an injected local test transport.

- [ ] Test concurrent writers/revoke, next-dispatch denial after disable/removal, token-only versus resource-wide blocks, mismatched/late response, interrupted send and crash after durable intent. Assert no resend after reopening:
  ```ts
  assert.equal(recoveredOperation.state, 'uncertain');
  assert.equal(testTransport.sent.length, 0);
  assert.throws(() => admitOperation(reopened, staleRequest), /NOT_PAIRED|STALE_CONTEXT/);
  ```
- [ ] Run `node --import tsx --test test/durable-dispatch.test.ts`; establish red for missing admission/revocation semantics.
- [ ] Implement metadata intent-before-send, exclusive write ownership, exact correlation and 30-second RPC deadline. Coordinate current policy/commit/synchronous send in the owning process without an await gap that permits revoked dispatch. Revoke/notify/reject pending operations after durable revocation; writes with uncertain outcome return EXECUTION_UNCERTAIN, never replay or rollback claims. No payload queue or production transport.
- [ ] Run policy/dispatch/operator/identity suites; still-valid JWTs must fail after local block and after restart. Assert no Management API call occurs in request authorization.
- [ ] Commit as `feat: enforce atomic durable dispatch and local revocation`.

### Task 11: Backups, safe restore and retention

**Files:** Create packages/storage/backup.ts, retention.ts; test/recovery.test.ts; docs/IDENTITY_OPERATIONS.md. Extend recovery/admin commands and artifact exclusions.

**Interfaces:** Produce `backupStore(store: Store, destination: string): Promise<void>`, `checkStoreIntegrity(path: string): IntegrityReport`, `runRetention(store: Store, now: number): RetentionReport`. Reports contain counts/status codes only. Maintenance/reconcile commands reuse Task 3 startup/epoch behavior, not another recovery implementation. Add `reconcileRoster(store: Store, approved: readonly {userId:string; teamId:string}[], runtime: RuntimeInvalidator, now:number): {activated:number}`; it requires maintenance, activates only explicitly approved extant subject-bound records and never reactivates device credentials or leases. Unlisted restored users/memberships remain suspended.

- [ ] Test online backup during WAL writes, restore of old permissions/credentials/leases, corrupt DB/FK violations, unchanged versus advanced epoch and missing volume. New epoch plus maintenance must suspend restored users/memberships and reject every old credential/context. Test 30-day audit/course-close-plus-30-day PII boundaries without deleting active enforcement/FKs.
- [ ] Run `node --import tsx --test test/recovery.test.ts`; establish red for backup/retention behavior while existing recovery tests remain intact.
- [ ] Implement SQLite online backup/integrity APIs, never copying only a live main DB. Expire token denials only after expiry+60 seconds. Remove expired pairing secrets/eligible PII without destroying retained enforcement/audit records; run bounded cleanup within the service, not a new worker.
- [ ] Write/exercise restore sequence: external maintenance, stop admissions, restore, integrity check, advance AUTHZ_DEPLOY_EPOCH, reconcile suspended roster and reissue device credentials, verify denial before resume. Configure daily Railway backups where available and perform an isolated hosted restore; record observed versus pending account steps and platform backup retention. Protect backup access.
- [ ] Run recovery/storage/durable suites, verify no restored authority becomes active and commit as `feat: add safe authority backups restore and retention`.

### Task 12: Native same-user context evidence gate

**Files:** Create packages/authorization/session-binding.ts, test/session-binding.test.ts; extend private observation/runtime hooks and IDENTITY_VERIFICATION. Do not add public diagnostics/desktop tools.

**Interfaces:** Produce `resolveWorkBinding(input: {principal: VerifiedPrincipal; context: ContextRef}): {status: 'SESSION_ISOLATION_UNPROVEN'}` as the production default. A verified resolver requires a later evidence-backed design; no provider/browser/session claim is presumed sufficient. Test-only trusted bindings may be injected locally but never selected by environment/tool input in production.

- [ ] Write tests that subject, azp, sid, random context IDs and copied MCP handles cannot manufacture verified work identity. Default always returns SESSION_ISOLATION_UNPROVEN; production bootstrap cannot load test bindings and no public desktop grant can activate.
- [ ] Run `node --import tsx --test test/session-binding.test.ts`; establish red, then implement the rejecting default and sanitized private observations. Record equality flags/correlation facts, never raw tokens/claims.
- [ ] Use two simultaneous native cloud sessions for one approved student and a second student's session. Record exact path and transport/token/grant equality facts; test initialization, controlled copied-token/handle attacks, refresh, reconnect and logout. Correlate private operator observations to actual native identity calls, with no diagnostic MCP endpoint or desktop relay.
- [ ] If a documented integrity-protected per-work-session credential exists, write/review its binding design before implementation. Otherwise record SESSION_ISOLATION_UNPROVEN and keep full milestone acceptance blocked. Different token strings or transport handles alone are not proof that future chats cannot inherit authority.
- [ ] Commit default/tests/evidence as `test: establish native session isolation gate`. A documented blocked outcome completes the experiment, not the full milestone.

### Task 13: Integration checks and honest acceptance handoff

**Files:** Update HANDOFF, ARCHITECTURE, THREAT_MODEL, KNOWN_LIMITATIONS, IDENTITY_VERIFICATION, IDENTITY_OPERATIONS, examples and applicable dependency/build instructions. No new feature in this task.

**Interfaces:** Consume prior task outputs; keep automated/local, direct hosted and operator-reported native evidence separate.

- [ ] In a clean execution checkout run npm ci --ignore-scripts, controlled SQLite rebuild, typecheck, full tests, test:coverage (>90% per repo instructions), mock demo, build, probe regeneration/drift and both image smoke checks. Repair actual failures with meaningful regression tests; do not reuse old results as fresh verification or hide baseline coverage gaps.
- [ ] Fill the spec acceptance matrix with native account/refresh evidence, isolated restore evidence and Task 12 outcome. Full milestone acceptance requires all gates; otherwise label identity delivery partial and name the exact missing integration mechanism/input. Do not claim real keychain/WSS/Blender success.
- [ ] Perform the execution method's independent review of shared package isolation, claims/audiences, SQL/races, current revocation, logging, bootstrap/UID/restore and production entrypoints. Check that test bindings/fixture auth cannot enter production and second-server tests pass.
- [ ] Update handoff with actual nonsecret issuer/resource/client facts, service/deployment IDs, commits/domains, native path/results, operator recovery instructions and usage review. Retain only intentionally needed services; do not delete services without explicit authorization.
- [ ] Commit verified fixes/docs and push main after inspecting the diff. Report completed checks and honest acceptance status; move to milestone 3 only when its prerequisites are satisfied and the operator asks to continue.

## Spec coverage and self-review

- Sections 1–3: Tasks 1–2, 5 and second-server fixture establish reusable auth with separate authorization.
- Section 4: Tasks 4, 6, 8 cover explicit invitations, provider retries, email delivery and actual login.
- Section 5: Tasks 1–2, 5, 7–8 cover strict OAuth resource-server behavior and native compatibility.
- Sections 6–7: Tasks 3–4, 6, 9–10 cover durable schema/policy, credentials, refresh limits and immediate local denial.
- Section 8: Task 12 is a real-client gate with explicit blocked outcome, not a mock substitute.
- Sections 9–10: Tasks 3, 7–8, 11 cover restart, non-root bootstrap, volume/restore, retention and budget review.
- Sections 11–12: Tasks 8, 12–13 obtain external inputs and record the full acceptance matrix.

Review the exact function/type references across tasks, all five Review Focus cases, link/section structure, no placeholder decisions and no accidental desktop implementation. Concrete tenant/resource/client/sender values belong to authenticated Task 8 setup because they do not exist yet; do not invent them.

## Execution handoff

No execution method has been selected. Review the plan before implementation. Recommend native execution for this solo pilot: auth/store/runtime interfaces are tightly dependent and one implementer can maintain consistency, followed by the fresh independent final review required by the execution skill. Subagent-driven execution adds separate implementer/reviewer gates per task at greater context cost. Use the selected skill after plan review; writing this plan does not begin implementation.
