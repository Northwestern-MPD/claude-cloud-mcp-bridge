# Threat model and limits

The hosted milestone 2 MCP service provides identity only and returns `desktop_access:false`. The separate public probe exposes harmless ping. The local mock gateway/fake Blender adapter remain development fixtures. See [ARCHITECTURE.md](ARCHITECTURE.md) and [IDENTITY_VERIFICATION.md](IDENTITY_VERIFICATION.md).

## Identity and authority

Invited verified-email sign-in authenticates through Auth0; stable issuer/subject binds explicit course/team authorization. Names, model instructions, email similarity, shared cloud configuration and team membership alone never grant another owner's device control. Each resource validates signature, issuer, audience/resource, scope, client, expiry and issuance cutoff. Reusing authentication requires each server's own authorization policy. Unknown tool fields are rejected.

Private PostgreSQL stores durable identities, memberships, devices, fingerprints, contexts, pairings, leases, denials and metadata-only audit events. Limited serving privileges are separate from migration/backup authority. Schema/store/role validation and the dedicated owner lock fail closed; owner/database loss ends admission. Restart invalidates old runtime authority and makes interrupted writes uncertain. Deployment requires maintenance, drain, stop and confirmed lock release; one replica alone does not ensure safe handoff.

Two-account native identity, refresh, scoped refresh revocation after access-token expiry, reconnect and concurrent same-account identity usability passed on operator-reported evidence supported by provider events. Grant deletion can leave issued JWTs valid. Concurrent identity success does not establish separate chat bearers/transports/work-session authority. Copied-token/handle attacks and immediate identical-JWT denial remain unproven; `SESSION_ISOLATION_UNPROVEN` keeps desktop tools disabled.

## Private operator boundary

Administration uses a private `0600` Unix socket in a `0700` directory through approved authenticated operator access, with no public admin/diagnostic MCP endpoint. It trusts the operator/host account and does not isolate hostile processes with equivalent privileges. Temporary workspace SSH registrations and remote command files require cleanup.

The deployed observation update, verified locally and in Linux CI, records requests reaching the verified authentication boundary. Its process-local ring holds at most 64 records for at most five minutes, pruned at token expiry. Reports expose only the last eight records, random references, outcomes, relative age/expiry and opaque token/principal/context correlations keyed for that boot. No raw access/refresh token is retained. Restart clears records and changes correlations. This is bounded experiment evidence, not durable audit or proof of independent chats.

Live-reference denial privately resolves fingerprint/resource/original expiry and uses the existing revocation fence/durable denial path with its existing 60-second grace. It neither disables the account nor creates account-wide/resource blocks. Expired/evicted/previous-boot references are unavailable. Hosted/native experiments are still required after deployment; do not extract client-held credentials to fill the evidence gap.

## Desktop and mock execution risks

The mock independently verifies user/device credentials, binds each MCP transport to its principal and requires owner consent for pairing/capabilities. Fixture bearers are random 256-bit secrets stored as hashes, expire after an hour and are never printed by the demo. Device credentials/state last only for the in-memory run. Loopback and Host/Origin restrictions do not isolate malicious processes sharing the local account. Never expose the mock through a tunnel/reverse proxy.

Disconnect, expiry or admission closure may happen after execution starts. Cancellation cannot roll back Blender mutations. Interrupted/timed-out writes return `EXECUTION_UNCERTAIN`; no automatic mutation retry or queued replay occurs. Write ownership and connector busy guards reject overlap. A real adapter still needs supervision/cancellation where possible.

An eventual execute capability implies arbitrary laptop code execution, with no sandbox. It requires locally granted capability and separate approval displaying JSON-escaped exact code per invocation. The fake adapter executes no Python; structured scene output is untrusted model input. Production WSS, enrollment/keychain and real Blender integration remain unfinished.

Mock bounds: 64 MCP sessions total, eight per user, eight registered devices per user, 120 authenticated requests/minute per user, 64 KiB MCP bodies, 2 MiB WebSocket frames/results, 16,000-character code, 30-second RPC deadlines and ten-second heartbeats. These development bounds do not prove deployed laptop transport. The probe accepts 16 KiB bodies; public abuse controls remain an operational concern.

## Recovery and operations

A verified encrypted local export/catalogue does not establish hosted restore performance, scheduled/offsite protection or PITR. Railway DAILY backup configuration was rejected as Pro-only. Recovery requires a new external issuance cutoff, isolated target validation, suspension and reviewed roster/revocation reconciliation. Snapshots cannot prove current revocation completeness; missing evidence keeps admissions closed.

External production SMTP is unavailable; built-in mail remains development-only. CPU/memory limits are not a workspace spending cap. Cost review, production abuse controls, distribution and physical Mac/Windows Blender acceptance remain prerequisites. Identity/probe success grants no desktop authority.
