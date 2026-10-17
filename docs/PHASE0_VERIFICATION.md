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

## First Anthropic Cloud reports and cold-start fix

Operator-relayed results: code at `3fac770` passed typecheck, all 12 tests and the mock demo on Anthropic's Node 22.22.0. The first session started from empty main, so no native probe was registered; an SDK-driven ping succeeded from a temporary checkout. A later session with `.mcp.json` present reported native `bridge-probe (CONNECTION_CLOSED): Connection closed`. No native ping succeeded and no cloud stderr was supplied. These are user-provided reports, not direct observations by this workspace.

Local reproduction: launching the original `node --import tsx apps/probe.ts` from an isolated `/tmp` checkout without node_modules exits with `ERR_MODULE_NOT_FOUND` for tsx, observed by the SDK as `Connection closed`. The installed checkout works. This confirms a dependency-sensitive cold start; it does not prove Anthropic's hook/MCP ordering or rule out another cloud cause.

Fix: `.mcp.json` launches a checked-in SDK-based Node bundle, `probe/stdio.cjs`, with no npm runtime dependencies. The build includes third-party notices and CI regeneration checks. A regression test copies the checkout's probe/config/source into an isolated temporary directory without node_modules, then uses the exact configured command to initialize, list tools and call ping. It failed before the fix and passes afterward. Cloud native discovery must be tested again on the new commit; full startup stderr is needed if it still fails. Do not replace native discovery with a shell/SDK invocation in that cloud acceptance test.

Post-fix verification: typecheck, full 13-test suite, mock demo and TypeScript build pass locally. The isolated cold-checkout regression also passed using Node 22.22.0 (`npm exec --yes --package=node@22.22.0 -- node --import tsx --test test/cold-start.test.ts`), matching the reported cloud version. Native cloud startup remains unverified until the next operator test.

## Native cloud ping and Railway preparation

The operator subsequently reported native tool discovery and a successful `mcp__bridge-probe__ping` call after the cold-start fix, with the expected read-only result and no shell/SDK substitute. This establishes native STDIO loading for the reported cloud session. It does not establish remote HTTP or identity.

Railway was selected for remote hosting. `railway.json`, the root Dockerfile, a standalone HTTP bundle, configurable probe-only bind host, and `/health` support prepare the next test. No Railway account is connected in this workspace, and no public deployment or remote cloud HTTP success is claimed. See `RAILWAY_SETUP.md`.

Railway preparation validation: all 14 automated tests, typecheck, mock demo and TypeScript build passed. The Dockerfile built successfully; the resulting non-root, read-only-container smoke test passed `/health`, real HTTP MCP initialization, ping-only tool enumeration and ping on Node v22.23.3. The test container was stopped afterward. This is local container evidence, not a live Railway deployment.

## Live Railway HTTPS probe — local continuation

On October 17, 2026, the connected Railway account initially contained no projects. Created one project/service and deployed `main` commit `f21fa7c2ebe758a0103568e1baa7cc77ae3f32bc`. Deployment `9393c752-4d04-416b-9402-8565b1edbe35` reached `SUCCESS`. Build logs confirmed the root Dockerfile, `node:22-bookworm-slim` and committed HTTP bundle. Inventory confirmed one replica in `iad`, no volume/database and no user variables. The public endpoint is https://bridge-remote-probe-production.up.railway.app/mcp . IDs are recorded in `HANDOFF.md`.

Direct HTTPS requests from the local continuation session verified HTTP 200 `/health` with the expected JSON, MCP initialization (`2025-03-26`), `tools/list` containing only `ping`, and `tools/call` returning `{"pong":true,"mode":"compatibility-probe","desktop_access":false}`. GET `/mcp` returned 405 as designed. Equivalent loopback checks passed on Node v22.14.0. No source or bundle changed in this continuation; dependencies/full tests were not rerun.

The real HTTP URL was added to project `.mcp.json` as `bridge-remote-probe`, preserving the STDIO entry. **Native remote Claude Code cloud discovery/ping and the repeat after session/service restart are still unverified.** These direct HTTP checks do not satisfy that acceptance gate or establish identity, OAuth, desktop access or Blender control. Account usage limits have not been inspected or changed.

## First native remote cloud ping and service restart

The operator reported a successful invocation through an actual Claude Code cloud session's native MCP interface: server `bridge-remote-probe`, tool `mcp__bridge-remote-probe__ping`, description “Read-only bridge compatibility check. No desktop access.” Result: `{"pong":true,"mode":"compatibility-probe","desktop_access":false}`. They reported no connection error and explicitly excluded the local STDIO server and shell/SDK substitutes. This is operator-reported cloud evidence; the exact session commit/version was not provided.

After that report, restarted the existing Railway deployment `9393c752-4d04-416b-9402-8565b1edbe35` using the connected Railway tool. The API returned that deployment ID; a new runtime startup line was observed at `2026-10-17T20:46:25.054364503Z` (15:46 America/Chicago), listening on `0.0.0.0:8080`. Direct HTTPS `/health`, ping-only catalogue and ping passed after restart. The process writes its startup line to stderr, which Railway labels as error severity; the line itself reports startup, and health/ping passed.

Requested a repeat native ping after the service restart and another in a fresh cloud session. Those results remain pending. Budget/usage-limit review remains pending. No identity, OAuth or desktop capability has been established by these ping results.
