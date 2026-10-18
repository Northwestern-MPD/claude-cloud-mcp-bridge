# Remaining work and evidence limits

Milestone 2 has a deployed identity-only service backed by Auth0 and private Railway PostgreSQL 17. Production desktop authority remains disabled; full milestone acceptance is incomplete. See [HANDOFF.md](HANDOFF.md) for continuation order and [IDENTITY_VERIFICATION.md](IDENTITY_VERIFICATION.md) for release-specific evidence.

## Established evidence

The identity service validates individual OAuth identities and uses durable subject-bound enrollment, explicit memberships and restricted database roles. Direct hosted health/readiness, metadata, maintenance denial and missing/invalid bearer checks passed. Local automated verification covers durable devices/pairings/leases, owner-lock safety, dispatch/revocation races, private administration and isolated recovery. It does not establish a deployed laptop relay.

Operator-reported native identity passed for two accounts with distinct users/teams in one course. Account A refresh, scoped refresh-grant revocation after issued access tokens expired, reconnect to the original identity and concurrent identity calls from two chats also passed with supporting provider events. The revocation failure event omitted its subject, so correlation uses client/timing and the operator report. Exact native client/session provenance is incomplete. Grant deletion does not immediately invalidate issued JWTs.

The separate public HTTPS probe passed direct health/discovery/ping and operator-reported native calls before and after a verified Railway restart. STDIO and HTTP bundles support dependency-free startup. Probe success establishes neither identity nor laptop connectivity.

The restart recovery bug exposed by native errors has a tested/deployed server fix at af6d8f8: authenticated/enrolled stale transport handles return404 for fresh initialization. Native client recovery is still pending; see the verification record. The platform’s first source build can still select the wrong Dockerfile despite the saved override; explicit source rebuild is the tested recovery.

## Open gates

- **Session isolation:** Concurrent same-account identity usability does not prove separate authenticated work sessions, token/transport equality or copied-token/handle resistance. No account B control/copy attack was performed in the account A concurrency checks. `SESSION_ISOLATION_UNPROVEN` blocks desktop tools.
- **Private observations:** The deployed update has a maximum 64-record ring, five-minute TTL, token-expiry cleanup and last-eight private report, with boot-specific opaque correlations and no raw tokens. Live-reference denial uses observed fingerprint/resource/original expiry plus existing 60-second grace, without account-wide blocks. Final local/CI verification and deployment passed; identical still-valid JWT denial and native cross-chat equality remain unproven.
- **Laptop path:** Production sign-in/device enrollment, OS keychain, authenticated WSS, supervised processes, real Blender STDIO integration, packaged Mac/Windows connectors and physical scene/screenshot acceptance remain work. The adapter is fake and executes no Python.
- **Recovery:** One approved local age-encrypted schema export passed a matching PostgreSQL catalogue check. No hosted restore drill, scheduled/offsite protection or PITR is established. Railway DAILY backup configuration was rejected as Pro-only; no upgrade occurred. Follow the external monotonic cutoff, isolated validation and reconciliation runbook before relying on recovery.
- **Mail/cost:** External SMTP is unavailable; Auth0 built-in mail remains development-only and automatic provider creation gated. Configured resource limits are neither a workspace spending cap nor measured ongoing cost. Usage/budget review remains open.
- **Provider behavior:** Refresh-token reuse detection and provider-only logout semantics remain unverified. Authentication reuse across class services requires separate resource/audience checks and server authorization policies.

## Mock scope

The local mock implements seven stable desktop tools, fixture-authenticated HTTP MCP, outbound loopback WebSocket transport, owner consent, per-code approval, expiry/revocation and bounded fake scene/image results. Credentials/state are in memory. Do not expose it through a tunnel/reverse proxy.

`npm run dev:mock` is the supported first-run demo and prints no reusable credentials. The standalone mock CLI requires fixture credentials from a local harness. Neither provides production enrollment or real Blender evidence. Never bypass a gate with a shared team desktop-control key.
