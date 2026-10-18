# Milestone 2 verification record

Status: **local implementation verified; full milestone acceptance blocked**. Native gate: `IDENTITY_NATIVE_BLOCKED` pending identity app deployment and actual cloud OAuth checks. Local evidence does not establish native Claude OAuth or separation between simultaneous cloud sessions. Public desktop tools remain disabled.

## Auth0 development evidence

- Canonical issuer: `https://dev-exz4k4zrf6whdd7s.us.auth0.com/`.
- Trusted JWKS: `https://dev-exz4k4zrf6whdd7s.us.auth0.com/.well-known/jwks.json`.
- Official Auth0 CLI v1.37.0 was downloaded through `gh`, checksum verified, and authorized by the operator. No credentials are recorded here.
- Fixed verified-email Action `2bad5810-7533-408e-8720-09b398979aeb` was deployed and bound to the previously empty post-login flow. Runtime: Node 22. Local tests require the strict provider boolean; no account was manually marked verified.
- Development-only native email client: `dhUClk2hXClRgneUJn3jnA25w9EdJrrS` (`MPD - Local email preflight`). This is **not a Claude client registration** and has no desktop authority or production resource audience.
- Passwordless connection `con_0NIEg0VbB8exZW1K` (`email`) has signups disabled and is enabled only for that development client. OTP length six; expiry 180 seconds.
- The operator explicitly authorized test accounts A and B. Exact addresses/subjects are protected operator records, not repository evidence. Deliberate profile creation left `email_verified:false`; no local membership was granted.
- Each `/passwordless/start` request returned HTTP 200; the tenant recorded two `cls` events. The operator confirmed delivery to **both** inboxes. No code or link was requested in chat.
- This establishes development delivery only. A completed hosted sign-in, issued access-token claim verification, refresh and native MCP invocation are pending.
- Auth0's built-in sender is for testing. No external SMTP provider is configured; production email readiness and automatic account creation remain blocked as documented in [AUTH0_SETUP.md](AUTH0_SETUP.md).

### Hosted OAuth configuration — October 18

Both official CLI sign-ins were renewed successfully. Auth0 API `6ad5153e0cbf88ba082913bd` now uses exact audience `https://class-identity-production.up.railway.app/mcp`, RS256, `access_token`, 600-second API/web token lifetime and `identity:read`. Offline access is enabled.

Static public Claude client `OUmVGrnlfsCIzS8JG55tBhZIgPKBTCeu` uses token endpoint authentication `none`, Authorization Code/refresh grants and callback `https://claude.ai/api/mcp/auth_callback`. Rotating refresh tokens have 7-day idle/30-day maximum expiration and zero overlap. The email connection now enables this client plus the development client; signups remain disabled and brute-force protection enabled. API/client/connection settings were re-fetched. The tenant already had resource compatibility and authorization-response issuer support enabled; CIMD stays disabled. See [Auth0 setup](AUTH0_SETUP.md) for the documented static public-client delivery path and observed API correction.

No hosted token exchange, signed claim result, refresh compatibility or native identity invocation is established by these configuration writes.

## Local implementation evidence

The reusable package has no storage/Blender/connector imports. Verification enforces RS256, configured issuer/resource, signed client/scopes, fixed verified-email claim and expiry. Tests cover a second independent MCP resource. PostgreSQL tests use a marked disposable PostgreSQL 17 cluster with real restricted roles and independent clients.

Recorded checks include strict JWT/JWKS/discovery, durable enrollment, real SDK HTTP requests, owner-lock refusal/loss, private socket administration, durable device/pairing/lease policy, dispatch/revocation races, and isolated custom-format dump/restore with an external monotonic issuance cutoff. The execution ledger retains RED/GREEN logs. Fresh dependency installation (zero audit vulnerabilities), typecheck and build passed on October 18. **138 root tests plus 232 database tests passed (370 total).** The mock demo, probe regeneration with no drift, both image builds and separate probe HTTP initialization/catalogue/ping smoke passed. The rebuilt identity image passed **11/11 container checks** on linux/arm64, Node22.23.3, running as the Node user. Coverage: **95.42% line/statement, 96.87% function, 93.08% branch**; all four planned 91% gates pass. Type-only files and baseline mock entrypoints remain included; no coverage exemption was added.

The default binding resolver always returns `SESSION_ISOLATION_UNPROVEN`. Subject, client, `sid`, random values and copied MCP handles do not establish a verified cloud work session.

### Independent implementation review

A fresh Astra subagent reviewed the implementation through `96d9a98` and the Railway liveness fix `2894a15`. It found no critical issues and two important issues. Both were reproduced before fixing and verified in the final complete run:

- Pending team invitations now become revoked in the same fenced transaction as membership removal, including before first verified login. A removed invitation cannot create membership later; another active team remains usable.
- Store shutdown retires outstanding request connections and confirms server-side backend/lock cleanup before releasing ownership. Transaction query wrappers are valid only during their checkout and reject late queries/COMMIT. Real PostgreSQL tests hold five callbacks without releasing them, force exhaustion or close, verify old backends/locks are gone, acquire a replacement owner, and then prove resumed callbacks cannot write.

The reviewer accepted the narrow Railway `GET /health` hostname exception. Its explicitly deferred native, production mail, hosted backup/cost and later desktop experiments remain outstanding below. No second review was requested; the fixes have focused RED/GREEN evidence, author inspection and the fresh whole-suite/container verification above.

## Railway identity deployment — October 18, 2026

The approved identity-only pilot is **deployed and ready** at `https://class-identity-production.up.railway.app/mcp`. Public desktop capabilities remain disabled. Native Claude OAuth/token results and full milestone acceptance are still pending.

Project `e759a352-01af-4dd6-994d-662f809d7478`, production environment `bd25f4b4-0fa5-4eaf-9a1d-d3490edddebd`:

- Private `Postgres` service `7dc54ec7-71c3-4f33-bf2d-7f5da9f49be5`, deployment `35f201bc-1e01-403f-adaa-4a1b0cddde03`, reports SUCCESS. Actual SQL version is **17.11** (`170011`), database `identity`; image remains `ghcr.io/railwayapp-templates/postgres-ssl:17`. Volume `4fad8e5d-ba96-4113-b622-475efd21c3c7` mounts at `/var/lib/postgresql/data`. No public database domain or TCP proxy exists.
- `class-identity` service `947ffd02-0ac5-42fb-9e95-179437cd12c9`, successful deployment `f7c87ab7-57ad-40bf-b1fb-737b93be8e9a`, is pinned to reviewed commit `355ba952341ad1fa374028ed12476420e32624cc`; later pushes do not auto-deploy. [Release CI 39156401352 passed](https://github.com/Northwestern-MPD/claude-cloud-mcp-bridge/actions/runs/39156401352). There is no app volume. Domain `class-identity-production.up.railway.app` targets 8080.
- Both services retain one replica in `iad`, with configured 1 vCPU/500,000,000-byte container limits. The serving identity process is PID 1, UID 1000, Node 22.23.3. Authenticated SSH shells use root; that is separate from the serving process.
- The first identity attempt `65acc3ee-7e7d-4639-b38c-a83a80b4c9bd` failed because Railway built the root probe Dockerfile despite `Dockerfile.identity` being present in its service manifest. Its missing-entrypoint failure acquired no database owner/request connection. The documented `RAILWAY_DOCKERFILE_PATH=Dockerfile.identity` variable corrected the build; an explicit source rebuild produced the successful deployment above. Preserve that variable. No application authentication rule was weakened. [Railway Dockerfile override](https://docs.railway.com/builds/dockerfiles#custom-dockerfile-path).
- New services reject legacy `railwayConfigFile`; this service uses API/dashboard settings plus the Dockerfile override. Its explicit start command is `node dist/apps/identity/main.js`, health path `/health`, 60-second health timeout, 30-second drain and zero overlap. The existing probe's legacy configuration and deployment remain unchanged. [Railway configuration transition](https://docs.railway.com/infrastructure-as-code).

### Private initialization and enrollment

Through the approved temporary workspace SSH key, a checksum-verified Node 22.23.3 operator runtime ran the reviewed role/bootstrap, migration and integrity code inside the authenticated private database shell. Production dependencies were lockfile-pinned with zero audit findings. Roles have independent random passwords; the owner is NOLOGIN, the migrator alone can SET ROLE owner, the app has limited DML/selected state-column updates, and backup is SELECT-only.

Actual integrity validation passed: schema 2, 17 tables, 73 constraints, eight invariants and four roles. The app role opened the store and correctly reported unready under maintenance. Store UUID is `f9ec2176-3bd8-41b4-971b-ed46efec6a93`; epoch is `pilot-20261018-770e9a393d30`; initial external token cutoff is 0. These external values remain in protected operator configuration and Railway settings across releases/rollback.

The serving environment was separately inspected: DATABASE_URL uses only `mpd_identity_app` on `postgres.railway.internal`; no migration, backup, SMTP or Auth0 management variables are present. The private admin directory/socket are owned by node with 0700/0600 modes. The operator imported two explicitly authorized exact-subject invitations into separate pilot teams using the live socket. No additional invitation email was sent. Invitations expire six days after import; at the enrollment check both were pending and no active membership existed. Real verified login must activate membership.

Stored maintenance was cleared through that same socket only after schema, role, metadata and denial checks. The external maintenance setting is false; the stored setting initially provided the admission block. Observed connection counts were one dedicated owner and one pooled request connection; the configured pool maximum remains five.

### Hosted HTTPS checks

- `/health`: 200 throughout maintenance and after release.
- `/ready`: 503 under maintenance, 200 after the private release command.
- `/.well-known/oauth-protected-resource/mcp`: 200, exact resource URI, canonical Auth0 issuer, `identity:read`, bearer header method. The resource-specific `/mcp` suffix is required.
- POST `/mcp`: 503 while maintenance was active; after release, missing and deliberately invalid bearers both returned 401 with the exact `resource_metadata` challenge URL.
- Unapproved Origin returned 403. The existing compatibility probe still returned 200 and its fixed no-desktop result.

These are direct HTTPS/operator checks, **not authenticated/native MCP evidence**. No minted JWT, native `class_identity`, refresh or same-user session result has been observed yet.

### Temporary access cleanup

The user explicitly approved temporary **workspace-wide** SSH access after automatic review rejected the earlier personal-key registration. The CLI only searches its agent/`~/.ssh` inventory, so its key-path flag could not find the protected project-local key. Registration through the inspected official API succeeded with the approved workspace scope. The temporary registration ID was `5420c217-3f79-499f-97eb-2471b9fd953b`; its public fingerprint was `SHA256:3z/bboC50hanGTxBlLw7PNgpSATJSew3bIQZnMCJTV8`.

Remote operator runtimes and temporary roster/command files were removed. The key registration was **deleted**, and the workspace key list confirmed none remain. Health/readiness stayed 200 after cleanup. Local private key/role credentials and exact recipient evidence remain 0700/0600 under ignored operator storage; no secret entered Git or a tool argument. Further maintenance access requires an authorized temporary registration, not an assumed persistent key.

### Hosted backup entitlement and usage

The actual volume instance is `7a116fb2-7202-4404-bf3d-d0528a033f04`, with observed usage 133.824512 MB on its 5000 MB volume. Its backup schedule list is empty. The approved attempt to enable DAILY backups was rejected by Railway: **"Manual backups and backup schedules are only available for Pro workspaces"**. Re-fetch confirmed no schedule was created. No subscription upgrade, PITR or alternate paid storage was enabled. Hosted backup acceptance remains blocked pending an operator-selected plan or reviewed backup approach. A one-time local age-encrypted export was prepared as a possible pilot alternative, but automatic approval review rejected exporting private database contents without specific payload/destination authorization. **No export or archive was created.** A checksum-verified temporary age 1.3.2 tool and protected local encryption identity are prepared; do not claim a local, offsite, scheduled or tested restore backup exists.

Railway's usage API reported current-period resource usage `$0.007874182515617285` at the October 18 check and no workspace usage limit. The billing period is October 17–November 17. This is an early usage snapshot taken before the identity app started, not a monthly operating-cost estimate. A separate `$5` agent-tooling limit exists and is not a workload spending cap. No spending cap was changed. [Railway backup schedules and incremental volume pricing](https://docs.railway.com/volumes/backups).

### GitHub CI fixture correction

The identity job at `82b9cc7` hung after its first application lifecycle test and was automatically cancelled after six hours. On Linux Node22.23.3, recursive directory creation below `/proc/no-permission` never settled; the startup-failure fixture therefore never reached its intended rejection. The replacement uses an owned temporary directory with insecure permissions, asserts the exact startup refusal, preserves cleanup/retry checks and has a 10-second timeout. The original Linux regression timed out at 3 seconds; the corrected Linux lifecycle pair passed 2/2. A fresh local coverage run passed all 370 tests and the mock demo, with 95.42% lines/statements,96.87% functions and93.07% branches. Build, typecheck and diff checks passed. The test-only change does not alter the previously verified container runtime.

[GitHub run 39139754683](https://github.com/Northwestern-MPD/claude-cloud-mcp-bridge/actions/runs/39139754683) passed for `4d789b2`: both mock and identity jobs succeeded on Linux Node22.23.3, including138 root tests,232 PostgreSQL tests and11 rebuilt container tests. Remote coverage is95.42% lines/statements,96.87% functions and93.08% branches. The previously hanging lifecycle test passed. The older successful workflow contained only the mock job; the new run supplies the identity CI evidence.

## Outstanding acceptance gates

1. Select/authorize a functioning backup approach and complete hosted export/restore verification and workload cost controls. The identity release, roles/schema and readiness checks above passed.
2. Verify the configured native OAuth registration/resource behavior with two real verified accounts, signed token claims, refresh/reuse/logout/reconnect and immediate local revocation.
3. Simultaneous native cloud sessions for the same user, including copied-token/handle attacks. Until an integrity-protected work-session mechanism is established, full milestone acceptance and desktop authority stay blocked.
4. Production mail provider or a reviewed onboarding change before class rollout; built-in development delivery is not production readiness.
Local integration, coverage, rebuilt container verification and independent implementation review are complete. These results do not satisfy the outstanding hosted/native gates above.

No production laptop connector, OS keychain, outbound WSS or real Blender evidence is claimed; those remain later milestones.
