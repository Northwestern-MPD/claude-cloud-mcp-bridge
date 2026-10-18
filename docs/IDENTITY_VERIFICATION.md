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

## Local implementation evidence

The reusable package has no storage/Blender/connector imports. Verification enforces RS256, configured issuer/resource, signed client/scopes, fixed verified-email claim and expiry. Tests cover a second independent MCP resource. PostgreSQL tests use a marked disposable PostgreSQL 17 cluster with real restricted roles and independent clients.

Recorded checks include strict JWT/JWKS/discovery, durable enrollment, real SDK HTTP requests, owner-lock refusal/loss, private socket administration, durable device/pairing/lease policy, dispatch/revocation races, and isolated custom-format dump/restore with an external monotonic issuance cutoff. The execution ledger retains RED/GREEN logs. Fresh dependency installation (zero audit vulnerabilities), typecheck and build passed on October 18. **138 root tests plus 232 database tests passed (370 total).** The mock demo, probe regeneration with no drift, both image builds and separate probe HTTP initialization/catalogue/ping smoke passed. The rebuilt identity image passed **11/11 container checks** on linux/arm64, Node22.23.3, running as the Node user. Coverage: **95.42% line/statement, 96.87% function, 93.08% branch**; all four planned 91% gates pass. Type-only files and baseline mock entrypoints remain included; no coverage exemption was added.

The default binding resolver always returns `SESSION_ISOLATION_UNPROVEN`. Subject, client, `sid`, random values and copied MCP handles do not establish a verified cloud work session.

### Independent implementation review

A fresh Astra subagent reviewed the implementation through `96d9a98` and the Railway liveness fix `2894a15`. It found no critical issues and two important issues. Both were reproduced before fixing and verified in the final complete run:

- Pending team invitations now become revoked in the same fenced transaction as membership removal, including before first verified login. A removed invitation cannot create membership later; another active team remains usable.
- Store shutdown retires outstanding request connections and confirms server-side backend/lock cleanup before releasing ownership. Transaction query wrappers are valid only during their checkout and reject late queries/COMMIT. Real PostgreSQL tests hold five callbacks without releasing them, force exhaustion or close, verify old backends/locks are gone, acquire a replacement owner, and then prove resumed callbacks cannot write.

The reviewer accepted the narrow Railway `GET /health` hostname exception. Its explicitly deferred native, production mail, hosted backup/cost and later desktop experiments remain outstanding below. No second review was requested; the fixes have focused RED/GREEN evidence, author inspection and the fresh whole-suite/container verification above.

## Railway rollout — October 18, 2026

The operator explicitly approved pushing main and deploying the public identity-only pilot. Main was pushed through `82b9cc7`, followed by the CI fixture correction `4d789b2`. The existing compatibility probe deployment remains unchanged.

Project `e759a352-01af-4dd6-994d-662f809d7478`, production environment `bd25f4b4-0fa5-4eaf-9a1d-d3490edddebd`:

- Approved patch `8409e706-8682-4f46-a5f9-fcef695ef3dc` was applied.
- `Postgres`: service `7dc54ec7-71c3-4f33-bf2d-7f5da9f49be5`, deployment `35f201bc-1e01-403f-adaa-4a1b0cddde03` reports `SUCCESS`. Image is pinned to `ghcr.io/railwayapp-templates/postgres-ssl:17`, database configuration is `identity`, and volume `4fad8e5d-ba96-4113-b622-475efd21c3c7` is mounted at `/var/lib/postgresql/data` (5000 MB). No public domain or TCP proxy exists. Actual SQL version, separate role provisioning and initial schema validation remain pending private operator access.
- `class-identity`: service `947ffd02-0ac5-42fb-9e95-179437cd12c9` exists with reserved public domain `class-identity-production.up.railway.app` targeting port 8080. Its exact resource will be `https://class-identity-production.up.railway.app/mcp`. It has **no app deployment, source, variables or volume** yet.
- Both services have one replica in `iad`, with configured limits of 1 vCPU and 500,000,000 bytes memory per container. These limits do not establish measured spend or a workspace spending cap.
- The identity service has explicit API/dashboard configuration for `Dockerfile.identity`, `node dist/apps/identity/main.js`, `/health`, 60-second health timeout, 30-second drain and zero overlap. Railway rejects `railwayConfigFile` for new services: legacy JSON/TOML Config as Code is deprecated. The checked-in identity JSON is not consumed by this new service. [Railway configuration transition](https://docs.railway.com/infrastructure-as-code).

Official Railway CLI 5.70.0 was downloaded through `gh` and its release SHA256 verified. Private database bootstrap requires authenticated CLI shell access; its browser login timed out before authorization. The previous Auth0 CLI session also expired, and renewed authorization is pending. No credential was requested in chat or added to Git.

Next: complete official CLI sign-ins; verify account budget/backup entitlement; initialize and validate separate database roles/schema through the protected operator path; register the exact Auth0 resource and observed native-client callbacks; attach a reviewed commit with autodeploy disabled; configure only app-role credentials in the serving process. Keep maintenance enabled until operator checks pass. All future releases and rollbacks require explicit drain/stop/owner-lock release/start.

### GitHub CI fixture correction

The identity job at `82b9cc7` hung after its first application lifecycle test and was automatically cancelled after six hours. On Linux Node22.23.3, recursive directory creation below `/proc/no-permission` never settled; the startup-failure fixture therefore never reached its intended rejection. The replacement uses an owned temporary directory with insecure permissions, asserts the exact startup refusal, preserves cleanup/retry checks and has a 10-second timeout. The original Linux regression timed out at 3 seconds; the corrected Linux lifecycle pair passed 2/2. A fresh local coverage run passed all 370 tests and the mock demo, with 95.42% lines/statements,96.87% functions and93.07% branches. Build, typecheck and diff checks passed. The test-only change does not alter the previously verified container runtime.

[GitHub run 39139754683](https://github.com/Northwestern-MPD/claude-cloud-mcp-bridge/actions/runs/39139754683) passed for `4d789b2`: both mock and identity jobs succeeded on Linux Node22.23.3, including138 root tests,232 PostgreSQL tests and11 rebuilt container tests. Remote coverage is95.42% lines/statements,96.87% functions and93.08% branches. The previously hanging lifecycle test passed. The older successful workflow contained only the mock job; the new run supplies the identity CI evidence.

## Outstanding acceptance gates

1. Complete the approved Railway identity release, actual private database role/readiness/backup verification and measured cost controls.
2. Exact native OAuth registration/resource behavior, two real verified accounts, signed token claims, refresh/reuse/logout/reconnect and immediate local revocation.
3. Simultaneous native cloud sessions for the same user, including copied-token/handle attacks. Until an integrity-protected work-session mechanism is established, full milestone acceptance and desktop authority stay blocked.
4. Production mail provider or a reviewed onboarding change before class rollout; built-in development delivery is not production readiness.
Local integration, coverage, rebuilt container verification and independent implementation review are complete. These results do not satisfy the outstanding hosted/native gates above.

No production laptop connector, OS keychain, outbound WSS or real Blender evidence is claimed; those remain later milestones.
