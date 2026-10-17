# Threat model and limits

Automated coverage checks authorization independently of model text: user and device credentials differ, team membership is provisioned, device ownership must match local approval, and every MCP request verifies auth and binds the SDK session to its principal. Same-team access is not sufficient to approve another owner's device. Unknown tool fields are rejected.

Mock bearers are random 256-bit secrets, hashed in the gateway and never printed by the demo. They expire after an hour. Device credentials last only for the in-memory run and can be revoked. This is a development fixture, not OAuth/OIDC. Local-only transport and origin/Host checks keep fixture auth out of public deployment. They do not protect against another malicious process with the same local account; OS process isolation remains necessary.

A request may already be executing when a device disconnects or a lease expires. Cancellation cannot roll back a Blender operation. Mutations interrupted or timed out return `EXECUTION_UNCERTAIN`; no retry occurs. A per-device gateway write lock and connector busy guard reject overlapping work. A real adapter must add process supervision and cancellation where possible.

The execute capability implies arbitrary local code execution in a future real Blender adapter, not a sandbox. It is denied unless locally granted; the connector requires a separate approval displaying JSON-escaped exact code for every invocation. The fake adapter never executes Python. Structured scene output remains untrusted data to the model.

Transport bounds: 64 MCP sessions total, 8 per user, 8 registered mock devices per user, 120 authenticated HTTP requests/minute per user, 64 KiB MCP bodies, 2 MiB WSS frames/results, 16,000-character code inputs, 30-second RPC deadline, heartbeat every ten seconds, fixed seven-tool catalogue. The unauthenticated ping probe accepts 16 KiB bodies; apply public rate/concurrency limits at a reverse proxy if exposed.

Do not expose the mock gateway through a tunnel or reverse proxy. Public deployment requires OIDC issuer/audience/scope validation, TLS/WSS, OAuth metadata/PKCE flow, persistent memberships/devices, credential rotation, OS keychain and stronger abuse controls. The production entrypoint fails closed rather than accepting fixture identity. There is no claim that a cryptographically distinguishable Claude session is available.
