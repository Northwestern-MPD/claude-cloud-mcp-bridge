# Architecture

Implemented local flow:

```text
MCP SDK client -- authenticated HTTP --> mock gateway policy core
                                             |
                                   device-authenticated WebSocket
                                             |
                                  consent-driven local connector
                                             |
                                       fake Blender adapter
```

Both HTTP services bind only to `127.0.0.1`. Mock WebSocket URLs require loopback; production WSS/TLS is deliberately not enabled. The separately invocable read-only HTTP probe can be placed behind operator-managed HTTPS.

Policy represents user, provisioned team, random enrolled device, gateway-created MCP connection, single-use pairing request and expiring lease independently. Display names never route requests. MCP arguments select an authorized team for a pairing request; they cannot select a host, device, server or executable. Only the owner can approve. All device capabilities remain fixed and listed even offline.

One active lease per user and device. A second independently initialized MCP transport conflicts rather than inheriting control. This relies on a gateway-generated random connection handle plus authenticated principal, not an Anthropic-provided session claim. Sharing the same authenticated MCP connection across two Claude sessions remains unverified and blocks production. A session handle alone grants no authority.

Pairing defaults to five minutes, lease one hour and idle expiry ten minutes. Each forwarded request has random correlation ID, device ID, lease ID, connection epoch and deadline. The connector only accepts a lease corresponding to its own local consent; checks capabilities/deadlines; deduplicates request IDs; requires approval of every code execution. No automatic reconnect, retry or queued replay exists.

State and hashed credentials are in memory only. Restart invalidates everything. Expiration cleanup revokes active leases; bounded mock audit metadata contains action/outcome/time, never payloads. Mock object metadata and images are returned only in MCP replies. SQLite/Postgres, keychain, external OIDC and production retention/audit are follow-up work.

Single process only. Horizontal scaling would require shared identity/lease storage, atomic lease/write ownership, sticky MCP sessions and authenticated pub/sub for the instance owning each WSS connection. No cluster is prebuilt.
