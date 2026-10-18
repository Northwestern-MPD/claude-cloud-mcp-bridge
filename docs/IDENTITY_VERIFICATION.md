# Milestone 2 verification record

Status: **local implementation verified; full milestone acceptance blocked**. Native gate: `IDENTITY_NATIVE_BLOCKED` pending approved publication and actual cloud OAuth checks. Local evidence does not establish native Claude OAuth or separation between simultaneous cloud sessions. Public desktop tools remain disabled.

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

## Railway preparation

Existing compatibility probe remains unchanged. The following changes are staged, **not deployed**, in project `e759a352-01af-4dd6-994d-662f809d7478`, environment `bd25f4b4-0fa5-4eaf-9a1d-d3490edddebd`:

- `Postgres`: service `7dc54ec7-71c3-4f33-bf2d-7f5da9f49be5`, private networking, one replica, image pinned to `ghcr.io/railwayapp-templates/postgres-ssl:17`, database `identity`, generated credentials and its own volume `4fad8e5d-ba96-4113-b622-475efd21c3c7`.
- `class-identity`: empty service `947ffd02-0ac5-42fb-9e95-179437cd12c9`; no source, domain, app credentials or volume attached yet.
- Staged patch: `8409e706-8682-4f46-a5f9-fcef695ef3dc`. No HA cluster or public database TCP proxy is configured. Template HA-conversion metadata merely offers a later dashboard option.

Railway configuration calls for these staged-only services return “service instance not found”; replica/resource/build settings must be applied after approved service creation and verified before app startup. Public domain creation was rejected by automatic approval review because publication had not been explicitly approved. No workaround was attempted.

Before deployment: obtain publication/deployment approval; verify account budget/backup entitlement; create private database; set up/verify separate roles and initial schema through a protected operator job; reserve the approved identity domain; register its exact Auth0 resource and actual native client callbacks; attach a reviewed commit with autodeploy disabled; configure only app-role credentials in the serving process. Keep maintenance enabled until operator checks pass. All future releases and rollbacks require explicit drain/stop/owner-lock release/start.

## Outstanding acceptance gates

1. Approved Railway identity release, actual private database role/readiness/backup verification and measured cost controls.
2. Exact native OAuth registration/resource behavior, two real verified accounts, signed token claims, refresh/reuse/logout/reconnect and immediate local revocation.
3. Simultaneous native cloud sessions for the same user, including copied-token/handle attacks. Until an integrity-protected work-session mechanism is established, full milestone acceptance and desktop authority stay blocked.
4. Production mail provider or a reviewed onboarding change before class rollout; built-in development delivery is not production readiness.
Local integration, coverage, rebuilt container verification and independent implementation review are complete. These results do not satisfy the outstanding hosted/native gates above.

No production laptop connector, OS keychain, outbound WSS or real Blender evidence is claimed; those remain later milestones.
