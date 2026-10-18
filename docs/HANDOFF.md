# Local development handoff — Claude Cloud ↔ Local Blender MCP Bridge

Updated: October 18, 2026 (America/Chicago). This file is the continuation brief; the prior chat transcript is not required.

## Resume here

Milestone 2 implementation is in progress: **Auth0 plus Railway Postgres**, invited verified email, and reusable per-resource MCP authentication. Read [the verification record](IDENTITY_VERIFICATION.md), [Auth0 setup](AUTH0_SETUP.md), the [approved design](superpowers/specs/2026-10-17-milestone-2-identity-authorization-design.md) and [execution plan](superpowers/plans/2026-10-17-milestone-2-identity-authorization.md). Local strict auth/JWKS/discovery, identity-only HTTP, durable enrollment/device/grant/revocation policy, private operator controls and isolated backup/restore are implemented. Final local verification passed: 138 root +232 real Postgres tests, 11 rebuilt identity container checks, typecheck/build, mock demo, no probe artifact drift and both image smoke paths. Coverage is95.42% line/statement,96.87% function,93.08% branch; all planned91% gates pass. Fresh Astra implementation review found two important bugs (pending-invitation removal and leaked-checkout shutdown); both were fixed with regressions and included in that complete run. Local implementation commits remain unpushed pending publication/deployment approval. The Auth0 tenant is authenticated; its fixed Action is deployed/bound, invited-only email connection configured, and both authorized test inboxes received development mail. No completed sign-in or native Claude OAuth result is claimed. Railway Postgres 17 and an empty identity service are staged, not deployed; public domain generation was rejected by automatic approval review pending explicit publication approval. Keep full milestone acceptance blocked and public desktop capabilities disabled (`SESSION_ISOLATION_UNPROVEN`). No external email service is available; built-in mail is development-only and automatic provider creation remains gated.

The existing remote HTTPS ping acceptance criterion remains satisfied by operator-reported native calls before and after a verified Railway restart. Its service and both working probe entries remain unchanged. Fresh-session provenance for the repeat and actual Railway budget/backup entitlement remain follow-ups.

Repository: https://github.com/Northwestern-MPD/claude-cloud-mcp-bridge

Work from **`main`**, which now contains the implementation. The implementation was merged directly, without a PR. At handoff preparation, the latest implementation/setup commit was `a05e80b`; this handoff is committed after it. The old `codex/bridge-mock-pilot` branch can remain, but new deployments and sessions should use main.

User preferences:
- Railway is the chosen host. Keep the pilot inexpensive: one replica per app and one private Postgres service for identity, no Redis or Kubernetes.
- User is a solo developer and explicitly prefers direct merges/pushes to main; do not introduce a PR requirement.
- User wants to continue locally with this file instead of copying the whole transcript.
- User requested browser assistance and reported signing into Railway in the desktop app's built-in browser. **No browser-control tool was exposed to the cloud agent.** Discover actual local browser capabilities before offering to control it. Do not repeat speculative instructions about unavailable Work/local switches. Ask the user to handle login in the browser if needed, never paste credentials.

## Product goal and scope

Students run independent Claude Code sessions on Anthropic-hosted cloud infrastructure. They share standardized environment configurations, but each student controls Blender on their own laptop through an explicitly activated, authenticated local connector.

A cloud environment is reusable configuration, not a shared VM or proof of student/team identity. No Claude Tags, shared channel identity, per-student SSH VMs, inbound laptop connections, public Blender sockets, remote desktop, arbitrary shell tools, or arbitrary TCP forwarding.

Intended production flow:

```text
Individual Claude Code cloud session
  → authenticated HTTPS MCP gateway on Railway
  → approved lease for a specific owned device
  → existing outbound WSS connection from that laptop
  → local STDIO Blender MCP adapter
  → Blender add-on on laptop loopback only
```

Decisive success: a student approves pairing locally, reads their real scene, approves a simple object change and sees it in Blender, then retrieves a real viewport screenshot. Another student or unrelated cloud session must not inherit that control.

## What actually works

| Component | Implementation / evidence |
|---|---|
| Mock bridge policy | In-memory users, provisioned teams, devices, pairings, leases, capability checks and revocation |
| Local mock transport | Real MCP Streamable HTTP and real outbound WebSocket connectors, both loopback-only |
| Consent controls | Pairing approval callbacks, narrowed grants, per-code approval, lease expiry, write exclusion, request/lease/epoch correlation |
| Fake Blender | Deterministic scene reads, `mock:add_cube` mutation, fixed 1×1 PNG screenshot fixture; no Python execution |
| Mock demo | Two fixture students in different teams; owner-only reads, cross-team denial, revocation; scripted fixture consent, no real sign-in |
| Native cloud HTTPS probe | Operator reported successful `mcp__bridge-remote-probe__ping` calls before and after the verified Railway service restart; fixed result only, no desktop access |
| Native cloud STDIO probe | User reported successful discovery and invocation of `mcp__bridge-probe__ping` through Claude's native MCP interface |
| HTTP probe | Ping-only server with `/health`, stateless POST `/mcp`, and configurable probe bind; locally tested with actual MCP clients |
| Railway deployment | Root Dockerfile deployed from main; one replica, no volume/database; direct HTTPS health, MCP initialization, ping-only discovery and ping verified at the recorded URL |
| GitHub CI | Workflow is present. Remote results were unavailable through the accessible APIs; do not claim remote CI passed |

Latest local verification before the main merge passed: **14 tests**, typecheck, bundle regeneration with no artifact drift, TypeScript build, mock demo and Docker build. Earlier container smoke testing verified `/health`, HTTP MCP initialization, a ping-only catalogue and ping on Node v22.23.3. These are local checks, not a live Railway test.

Successful native Claude Cloud result, as reported by user:

```json
{"pong":true,"mode":"compatibility-probe","desktop_access":false}
```

Native cloud discovery initially failed because the repo was not on the session's starting branch. It later failed with `CONNECTION_CLOSED`; a clean-checkout reproduction found a missing `tsx` dependency. The fix was a committed self-contained SDK bundle. **Do not revert `.mcp.json` to `node --import tsx apps/probe.ts`**: that depends on npm installation finishing before MCP discovery.

## Current code map

- `.mcp.json`: working local/cloud **STDIO** `bridge-probe`, `node probe/stdio.cjs`, plus **HTTP** `bridge-remote-probe` at `https://bridge-remote-probe-production.up.railway.app/mcp`. The operator reported native cloud HTTP success before and after the Railway service restart. A separate fresh-session result was not identified.
- `.claude/settings.json`: SessionStart hook runs `npm ci --ignore-scripts` for the full project. The bundled probe does not depend on that hook.
- `apps/probe-stdio.ts`: standalone STDIO probe source.
- `apps/probe.ts`: HTTP probe source (also supports STDIO); configurable `PROBE_HOST`, default `127.0.0.1`, public bind allowed only for this ping service.
- `scripts/build-probe.mjs`: bundles the SDK-based STDIO and HTTP probes and generates third-party license notices.
- `probe/stdio.cjs`, `probe/http.cjs`, license/notice files: committed runtime artifacts. Regenerate and commit these when their source changes. CI checks artifact drift.
- `Dockerfile`: Node 22, copies **HTTP probe only**, runs as Node user, sets `PROBE_HOST=0.0.0.0` and `NODE_ENV=production`. No dependency install or mock gateway startup.
- `railway.json`: Dockerfile build, `/health` readiness check, bounded failure restart policy.
- `packages/core.ts`: mock policy engine and transient identity/credential stores. This is not a production database/auth layer.
- `packages/protocol.ts`: fixed tool schemas, wire validation, bounds, result types and controlled errors.
- `apps/gateway/server.ts`: loopback mock MCP gateway/agent channel. Mock credentials verified every request; Host/Origin checks, caps and heartbeat.
- `apps/gateway/main.ts`: mock-only entrypoint; rejects production mode.
- `apps/connector/connector.ts`: WebSocket client, fake adapter, consent callbacks, lease/capability/deadline/epoch checks, deduplication and busy guard.
- `apps/connector/main.ts`: interactive mock CLI; requires a fixture identity/token from a local harness. It is not a working student OAuth enrollment flow.
- `apps/demo.ts`: supported self-contained mock demo; exits after its checks and prints no fixture tokens.
- `test/`: policy, transport, cold-start and Railway probe regression coverage.
- `examples/remote-probe.mcp.json`: HTTP config shape with a placeholder hostname; merge a real entry with the working STDIO entry later.

Fixed mock tools: `bridge_status`, `request_blender_pairing`, `blender_get_scene_info`, `blender_get_object_info`, `blender_get_viewport_screenshot`, `blender_execute_code`, `disconnect_blender`. The public probe exposes **only `ping`**.

## Get running locally

Node 22+ and npm required; Docker needed only for container checks.

New checkout:

```sh
git clone https://github.com/Northwestern-MPD/claude-cloud-mcp-bridge.git
cd claude-cloud-mcp-bridge
git switch main
npm ci --ignore-scripts
npm run typecheck
npm test
npm run dev:mock
npm run build
```

If the repository is already cloned, check `git status` first, preserve local changes, and use `git pull --ff-only origin main` on a clean main branch rather than cloning over existing work.

To rebuild probe artifacts: `npm run build:probe`, then inspect `git diff -- probe/` and commit expected generated changes alongside source changes. No npm install is needed to run `node probe/stdio.cjs` or `node probe/http.cjs --http` from a fresh checkout.

Local Docker smoke path:

```sh
docker build -t bridge-probe .
docker run --rm -p 127.0.0.1:3334:3334 -e PORT=3334 bridge-probe
```

Health URL: `http://127.0.0.1:3334/health`. Container public binding is only for the harmless probe; the host mapping above remains loopback-only.

## Local continuation — October 17, 2026

- Local checkout: `/Users/john_renaldi/claude-code-projects/mpd-claude-cloud-mcp-bridge`. Clean `main` at `f21fa7c` before these configuration/documentation changes; `git pull --ff-only origin main` reported already up to date.
- Rechecked the committed HTTP bundle directly on local Node v22.14.0 without installing dependencies. Loopback health, MCP initialization, ping-only catalogue, ping and GET `/mcp` → 405 passed; the temporary process was stopped.
- Browser control is exposed, but its runtime failed before reading browser state: `failed to start Node runtime: No such file or directory (os error 2)`. Railway's plugin subsequently became connected, so browser control was not needed for deployment. No Railway CLI was installed.
- Railway inventory initially returned zero projects. Created project `mpd-claude-cloud-mcp-bridge` (`e759a352-01af-4dd6-994d-662f809d7478`), production environment `bd25f4b4-0fa5-4eaf-9a1d-d3490edddebd`, service `bridge-remote-probe` (`e299c6b9-b030-4cfb-a724-17d5a702033d`). Verified one replica in `iad`, no volumes/buckets, no supplied variables or manual build/start overrides. Build logs show the root Dockerfile and Node 22 image.
- Deployment `9393c752-4d04-416b-9402-8565b1edbe35` reached `SUCCESS` for commit `f21fa7c2ebe758a0103568e1baa7cc77ae3f32bc` from `main`. Domain: `bridge-remote-probe-production.up.railway.app`; MCP endpoint: `https://bridge-remote-probe-production.up.railway.app/mcp`.
- Direct hosted HTTPS checks passed: `/health` returned `{"status":"ok","mode":"compatibility-probe","desktop_access":false}`; initialization negotiated `2025-03-26`; `tools/list` exposed only `ping`; `tools/call` returned `{"pong":true,"mode":"compatibility-probe","desktop_access":false}`; GET `/mcp` returned 405. These were direct HTTP requests from this local session, **not native Claude Code cloud calls**.
- Added the real URL as `bridge-remote-probe` in `.mcp.json`, preserving STDIO `bridge-probe`. Start the acceptance test from the main commit containing this HTTP entry.
- Railway billing/usage limits are not exposed by the connected tools. Account plan, current spend and configured limits remain unverified; operator review is still required. Official cost controls: https://docs.railway.com/pricing/cost-control . A hard limit can stop workspace workloads; select it deliberately.
- The operator subsequently reported successful native invocation of server `bridge-remote-probe`, tool `mcp__bridge-remote-probe__ping`, result `{"pong":true,"mode":"compatibility-probe","desktop_access":false}`, with no connection error. They explicitly confirmed no local probe, shell or SDK substitute. The exact cloud session commit/version was not supplied; this is operator-reported cloud evidence.
- Restarted Railway deployment `9393c752-4d04-416b-9402-8565b1edbe35` on October 17 at approximately 15:46 America/Chicago (20:46 UTC). The restart API succeeded and runtime logs contain a new startup line at `2026-10-17T20:46:25.054364503Z`, listening on `0.0.0.0:8080`. Direct HTTPS health, ping-only catalogue and ping passed after restart. No application source or configuration changed.
- In reply to the post-restart native-repeat request, the operator reported another successful call, no connection error, and the same `{"pong":true,"mode":"compatibility-probe","desktop_access":false}` result. This satisfies the native remote HTTPS acceptance criterion before and after a service restart. The reply did not identify a separate fresh-session run, so that additional coverage remains unverified. Usage-limit review remains an operational follow-up; it is not evidence about MCP transport.

## Remaining work, in execution order

### 1. Railway remote ping — transport acceptance passed

The Railway service now exists and passed direct HTTPS checks; see the local continuation above for IDs and deployed commit. **Reuse this service; do not create a duplicate.** The Railway plugin is connected in the local continuation session. Deployment steps below are retained as the runbook. Native cloud ping succeeded both before and after the verified service restart, per the operator. The transport acceptance criterion below is satisfied. Remaining operational follow-up: review account usage limits; separate fresh-session coverage is not established by the supplied report.

Follow [RAILWAY_SETUP.md](RAILWAY_SETUP.md):

- Deploy `Northwestern-MPD/claude-cloud-mcp-bridge` from **main**, root `/`.
- Use the repository's Dockerfile/railway.json. No manual build/start override, secrets, database or volume needed for this probe. One service and replica.
- Railway supplies `PORT`; Docker supplies the probe bind and production environment setting.
- Generate a Railway public domain; use managed HTTPS without buying a custom domain.
- Confirm HTTPS `/health` returns `status: ok`, `mode: compatibility-probe`, `desktop_access: false`.
- `/mcp` is the MCP endpoint; browser GET returning 405 is expected, not a failed deployment.
- Review usage/budget controls with the user; do not add paid database services yet.
- Record the domain and deployed commit in this handoff/verification notes. Never record tokens.

The real HTTPS `/mcp` URL is now configured as **`bridge-remote-probe`** in project `.mcp.json`, alongside STDIO `bridge-probe` for comparison. A claude.ai custom connector is an alternative. For direct project-config egress, add the exact Railway hostname to the Anthropic environment's Custom allowlist with package-manager defaults included. Connector delivery is a different path; verify it rather than conflating the two.

Start a fresh cloud session from the config-containing branch and request:

```text
Discover bridge-remote-probe and call its ping tool through this session's
native MCP interface. Do not call the local bridge-probe instead and do
not substitute a shell or SDK invocation. Report the exact server name,
result, and connection errors if any.
```

Acceptance: **native remote HTTPS** ping succeeds and succeeds again after a session/service restart. **Passed on October 17, 2026**, using operator-reported native cloud results before and after the directly verified Railway service restart. This evidence is separate from the earlier STDIO ping inside the VM. A separate fresh-session repeat was requested as additional coverage but was not specifically identified in the reply.

### 2. Implement and verify individual identity and durable authorization

The current credentials are mock fixture bearers, not OIDC. Before any public desktop tool:

- Provider/storage selected: **Auth0 + Railway Postgres**. Invited, verified email is sufficient; NetID SSO is not required. The [design spec](superpowers/specs/2026-10-17-milestone-2-identity-authorization-design.md) is approved; continue the [implementation plan](superpowers/plans/2026-10-17-milestone-2-identity-authorization.md) using its recorded evidence and pending gates. Auth0 development setup and local implementation have progressed as recorded above; the identity service is staged only and production SMTP remains unavailable.
- Implement the MCP OAuth-facing flow/protected resource metadata and external OIDC login as appropriate. Validate issuer, stable subject, audience, scope, expiration, refresh and revocation.
- Establish exactly what individual principal a real Anthropic connector presents. Do not assume an immutable Claude session ID is forwarded.
- Verify two simultaneous cloud sessions of the same user. The mock binds a lease to a gateway-generated MCP connection plus principal and conflicts on a separately initialized second connection. **It does not prove separation when two cloud sessions reuse the same token/transport.** Resolve this with a tested authenticated session/grant mechanism before shipping.
- Persist users, explicitly provisioned team memberships, enrolled devices, credential fingerprints, pairing requests, leases/epochs and metadata-only audit events. Use one private Railway Postgres service with a limited application role, separate migration/backup roles and bounded pg connections. The identity app has no data volume; no durable store is implemented yet.
- Design credential storage/rotation/revocation and Mac/Windows OS keychain support. Do not persist raw credentials in logs or commit them.
- Add actual production endpoints/transport separately; keep fixture authentication local-only.

Done when separate real accounts, invalid audience/issuer/scope, expired/revoked credentials, disabled users and same-user concurrent sessions have verified outcomes, including safe restart behavior.

### 3. Implement the production laptop connector and WSS relay

- Add browser-based individual sign-in, device enrollment, explicit per-work-session activation and outbound authenticated WSS.
- Local pairing UI/CLI must show verified requester/team, requested capabilities, expiry and exact high-risk code for approval.
- Maintain single-use pairing, owner consent, expiration, immediate revocation, lease epoch/correlation/deadline checks, exclusive writes and no mutation replay after reconnect.
- Use one Railway instance for the pilot. No silent failover to another device. No arbitrary destination host, executable or MCP URL from tool arguments.
- Exercise local mock adapters through the real hosted, authenticated path before involving Blender.

Done when two real users/devices cannot cross-route, revoke takes effect immediately, and reconnect requires a valid newly approved grant as policy dictates.

### 4. Integrate real Blender on the user's Mac, then Windows

- Pin and review a maintained local Blender MCP implementation. Prior source review used `ahujasid/blender-mcp`, commit `7a0373ec9199183cb460068c4f96aed9c579fb4f`; it is a reference snapshot, not an installed or validated adapter.
- Recheck current tool names, supported Blender versions, protocol/framing, screenshot return format, telemetry and license/dependency status before selecting a release.
- Launch the reviewed local MCP adapter over STDIO from trusted local configuration. Keep the add-on listener loopback-only (commonly port 9876); prove actual binding rather than trusting the default hostname.
- Map the fixed public `blender_*` tools to the chosen upstream tool names. Some upstream observation wrappers internally execute Python; review read/write classification per adapter.
- Demonstrate real scene/object reads, a bounded real viewport image, then a simple object modification after local consent. The current screenshot is a fixture and mock mutation is not Python.
- Arbitrary Blender Python implies laptop code execution. It must remain OFF by default, separately granted and approved for each execution; static filtering is not a sandbox.

Done when a real Anthropic cloud tool call visibly changes the approved student's local Blender scene and returns a real screenshot, with another student/session denied.

### 5. Pilot hardening and distribution

- Cross-team and same-team/different-owner end-to-end tests with two real student accounts/laptops; forged tool fields, stale codes/leases, wrong response/device, disconnects, deadlines and overlapping writes.
- Token rotation, lost-device revocation, membership/user disable, process restarts, uncertain mutation outcomes and no queued replay.
- Bounded payload/image transfer, controlled errors, production rate limits/Origin checks, metadata-only logging, retention and basic metrics.
- Student/instructor setup, backups/restore/rollback/shutdown runbook, provisioning tools, dependency/license audit, packaged Mac/Windows connector. Native UI/signed installers can follow CLI pilot usability.

Done when the pilot can be installed, operated, revoked and recovered by someone other than the implementer, with honest test evidence and documented residual risks.

## Authorization rules to preserve

Keep five concepts separate: verified user, explicitly provisioned team, enrolled device, cloud principal, approved pairing/lease. Names, environment labels, model assertions and tool arguments are not authentication.

A team-wide bearer key must never authorize desktop access. A pairing code is only a request identifier, not authority to execute. Sharing a team does not grant control of someone else's laptop; the MVP is owner-only. Device selection happens through local approval, not a model-provided device ID.

Every tool invocation must enforce valid principal, current membership/owner, matching active lease/context, capability, expiration, device liveness and write policy. Connector must independently enforce consent/enabled state and request envelope. No automatic mutating retry; disconnect may mean `EXECUTION_UNCERTAIN`, not a guarantee of cancellation or rollback.

The working mock is development evidence, not production authentication. **Do not expose `gateway:mock` on Railway to advance the demo.** The deployed probe may be public and unauthenticated solely because its fixed ping result has zero desktop authority.

## Supporting references and maintenance

Read this file first, then:
- [RAILWAY_SETUP.md](RAILWAY_SETUP.md): exact current deployment procedure.
- [PHASE0_VERIFICATION.md](PHASE0_VERIFICATION.md): chronological evidence and upstream review notes. Early entries describe earlier states; later evidence supersedes them.
- [ARCHITECTURE.md](ARCHITECTURE.md), [THREAT_MODEL.md](THREAT_MODEL.md), [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md): current scope and limitations.
- [CLOUD_TEST.md](CLOUD_TEST.md): environment settings and probe distinction.

The original 27 KB technical PRD was supplied as `claude_cloud_local_mcp_bridge_handoff.md` in the old conversation. Its critical product/security requirements and unfinished milestones are captured here; the original attachment is not required to resume immediate work.

Update this handoff as milestones are actually verified. Distinguish implementation, automated/mock evidence, user-reported cloud results, and direct physical-cloud/Blender evidence. Do not claim an unobserved deployment, auth property or test succeeded.

## Suggested first message in the local session

> Read docs/HANDOFF.md and the milestone 2 design spec linked above. Remote ping acceptance passed. Auth0 + Railway Postgres and invited verified email are approved choices; the written design is approved and the linked implementation plan awaits review/execution-method selection. Reuse authentication across class MCP servers with separate audiences and server authorization policies. Preserve the native same-user session-isolation evidence gate. Work from main; direct pushes are preferred. Keep production desktop tools disabled until their gates pass, and distinguish proposed design from implemented or verified behavior.
