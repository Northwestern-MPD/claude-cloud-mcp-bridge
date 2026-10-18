# Architecture

The project contains a hosted milestone 2 identity service, a separate public compatibility probe, and a local mock desktop bridge. See [HANDOFF.md](HANDOFF.md) and [IDENTITY_VERIFICATION.md](IDENTITY_VERIFICATION.md) for release and acceptance evidence.

## Hosted identity and durable authorization

Native Claude connector requests authenticate through Auth0 email sign-in and reach the Railway identity service over HTTPS MCP. The service uses private PostgreSQL 17 and exposes only `class_identity`, returning `desktop_access:false`. The independent public probe exposes only ping. Production laptop routing and desktop tools remain disabled.

The verifier checks JWT signature, exact issuer, audience/resource, scope, client, expiry and issuance cutoff. Stable issuer/subject identifies the user; accepted invitations and explicit course/team memberships determine authorization. Authentication is reusable across class MCP services, with separate resource/audience validation and server authorization policies. Display names, model text and shared cloud configuration confer no authority.

PostgreSQL stores identities, invitations, memberships, devices and credential fingerprints, contexts, pairings, leases, operation intents, denials and metadata-only audit events. Durable policy code covers ownership, capabilities, expiry, dispatch fencing and revocation. Four roles separate schema ownership, migration, limited application access and read-only backup. Only the limited app credential reaches the serving environment. Locally verified desktop policy does not establish a deployed production desktop path.

A dedicated advisory lock grants one runtime ownership. Startup validates schema/store/role, creates a new boot identity, invalidates old contexts/pairings/leases, marks devices offline and unfinished writes uncertain. Owner/database loss closes admission. Stored and external maintenance gate readiness. Deployment requires maintenance, bounded drain, incumbent stop and confirmed lock release before replacement; horizontal scaling and automatic overlapping handoff are unsupported. See [IDENTITY_OPERATIONS.md](IDENTITY_OPERATIONS.md).

Transport handles remain boot-local. After authentication/enrollment, an unknown terminated handle returns404 so the client can initialize anew; an expired mapped handle is retired only after owner validation. Wrong-owner/client/resource denial remains403 and invalid/revoked bearer denial401. No stale handle is revived or tool request replayed. Native automatic recovery still requires actual evidence.

Administration uses a private `0600` Unix socket inside a `0700` directory through approved authenticated operator access. Commands share the serving runtime's authorization fence for commit and invalidation. There is no public admin HTTP/MCP endpoint.

### Private observations — deployed identity-only release

The deployed update adds a process-local ring of at most 64 verified request observations, retained for at most five minutes and removed at token expiry. Reports return only the last eight records: outcome, relative age/expiry, random reference and boot-specific opaque token/principal/context correlations. No raw bearer or refresh token is retained. Restart clears records and changes correlations.

An operator can resolve a live reference privately to deny the observed token fingerprint/resource using its original expiry plus the existing 60-second denial grace. This does not disable the account or create account-wide/resource blocks. Final local/CI verification and deployment passed; native reference-based denial remains pending. Future observations can support equality and immediate-denial experiments; they do not themselves prove independent chats or desktop isolation.

## Local mock desktop bridge

```text
MCP SDK client -- fixture-authenticated HTTP --> mock gateway policy core
                                                       |
                                             device-authenticated WebSocket
                                                       |
                                            consent-driven local connector
                                                       |
                                                 fake Blender adapter
```

Mock HTTP binds to `127.0.0.1`; mock WebSocket destinations require loopback. Fixture credentials and state are in memory and invalidated at restart. The mock must not be publicly exposed.

User, provisioned team, enrolled device, gateway-created MCP connection, pairing request and lease are separate. Only the owner approves; sharing a team grants no desktop control. Arguments cannot choose a host, device, server or executable. One active lease per user/device is enforced; independently initialized transports conflict rather than inheriting control. Reuse of one authenticated connection across chats remains unproven.

Pairing defaults to five minutes, lease one hour and idle expiry ten minutes. Requests carry random correlation ID, device/lease IDs, connection epoch and deadline. The connector checks local consent, capabilities/deadlines, deduplicates requests and requires approval of every code execution. The fake adapter never executes Python. No automatic reconnect, mutation retry or queued replay exists. Mock audit metadata omits payloads; object metadata/images return only in MCP replies.

## Evidence and remaining components

Operator-reported native checks passed for two accounts with distinct teams, refresh, scoped refresh revocation after access-token expiry, reconnect and concurrent same-account identity calls. These do not prove bearer/transport equality or desktop work-session isolation: `SESSION_ISOLATION_UNPROVEN` remains the production gate.

Production laptop enrollment/sign-in, OS keychain, authenticated WSS, real pinned Blender adapter, supervision and distribution remain work. External SMTP, hosted recovery/scheduled/offsite backup and cost controls have open prerequisites. See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).
