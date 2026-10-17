# Phase 0 verification — 2026-10-17

## Evidence and confidence

| Question | Evidence | Status |
|---|---|---|
| Cloud project MCP configuration | Official cloud environment documentation lists `.mcp.json` for single-repository sessions; MCP documentation explains project loading in cloud sessions | Documented, not tested in Anthropic Cloud |
| Connector delivery/auth | Official MCP documentation says cloud hosts deliver claude.ai connectors; connector authorization is completed in claude.ai | Documented, per-user identity and exact claims unverified |
| Network path | Official environment documentation distinguishes connector traffic from direct VM allowlists | Documented, external HTTP ping untested |
| Trusted immutable Claude session claim | No tested claim available | Unsupported assumption; do not use asserted IDs |
| MCP SDK transport compatibility | Local SDK clients exercised real HTTP, WebSocket connectors and STDIO ping | Tested locally, not Anthropic infrastructure |
| Real Blender on Windows/macOS | No laptop or Blender available in this workspace | Blocked/manual |
| Public TLS gateway | No domain/hosting configured | Blocked/operator prerequisite |

Official references:
- https://code.claude.com/docs/en/cloud-environments
- https://code.claude.com/docs/en/claude-code-on-the-web
- https://code.claude.com/docs/en/mcp
- https://modelcontextprotocol.io/specification/

The docs alone do not establish account entitlement, OAuth issuer/subject forwarding, independent session context, SSE behavior, or timeouts through Anthropic. The unauthenticated probe has no desktop capabilities. Production integration remains stopped until actual identity and transport evidence is recorded.

## Local results

Commands: `npm run typecheck`, `npm test`, `npm run dev:mock`. All passed on Linux with Node v24.19.0, npm 11.9.0. Exact dependencies are in `package-lock.json`: MCP SDK 1.32.1, ws 8.22.0, Zod 4.6.7. Production dependency audit (`npm audit --omit=dev --audit-level=high`) reported zero vulnerabilities. No Anthropic credential used. Tests include cloud client simulations, not a real Claude session. CI also targets Node 22; a passing CI run is not claimed here.

Twelve automated tests cover owner/team isolation (including same-team owners), spoofed tool fields, no unapproved execution, consent replay/expiry, session conflict, request/lease/epoch correlation, exclusive writes, uncertain execution on disconnect, no reconnect replay, lease/idle expiry, membership removal, credential expiry/revocation, HTTP auth/session binding, origin rejection, image preservation and STDIO/HTTP ping.

## Upstream source review

Cloned into ignored `work/`; no upstream code is incorporated.

- `domdomegg/mcp-local-tunnel` commit `ae8cab457fdd2834552cdba2a0d3dc237da743a9` (package 1.2.0, MIT). Inspected relay server, agent auth, connection manager, relay MCP server, package manifest and license. Tools aggregate per user and acquire device prefixes with multiple devices; devices are selected by display name. The reviewed response correlation tracks request ID without checking originating device. OAuth routes disable rate limits and allow broad client registration/redirect behavior. Agent tokens cache in a permission-limited file rather than OS keychain. These findings are observations of this snapshot, not a comprehensive vulnerability audit. Existing tests were located but not run. Decision: original small policy core using the MCP SDK and ws; do not fork broad arbitrary-tool routing for this MVP.
- `ahujasid/blender-mcp` commit `7a0373ec9199183cb460068c4f96aed9c579fb4f` (MIT). The handoff's `ahujasid/mcp-for-blender` name is not the repository inspected. Inspected addon listener, scene/code/screenshot entry points and telemetry hints. The listener defaults to `localhost:9876`; this is not proof of runtime loopback-only binding. Current scene/screenshot wrappers can themselves execute Blender Python; strict read-vs-write classification needs adapter-specific review. Tool names evolved, so forwarding legacy names blindly would fail. Telemetry defaults and dependencies must be reviewed for a pinned pilot release. No physical Blender invocation, package audit, or adapter compatibility is claimed.

## Next evidence required

Follow `CLOUD_TEST.md` to record the first real cloud ping. Then obtain public probe hosting, validate remote ping, implement gateway OAuth/OIDC and verify per-user tokens and independent-session behavior. Only then integrate a pinned local Blender STDIO adapter and physical two-student tests. Tests of the mock are not a substitute for these gates.
