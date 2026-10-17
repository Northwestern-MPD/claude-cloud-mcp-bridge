# Claude Cloud ↔ Local Blender MCP Bridge

A working **local mock vertical slice**, plus a harmless MCP compatibility probe for Claude Code cloud. No SSH, Claude Tags, student inbound ports, real Blender, or Anthropic credentials are needed for the demo.

**Status:** mock routing is implemented and tested. Production OAuth/OIDC, persistence, public TLS hosting, a real Blender adapter, and Anthropic-hosted integration are not implemented/verified. Do not deploy the mock gateway publicly.

## Run

Node 22+ and npm:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run dev:mock
npm run build
```

The demo starts an HTTP MCP gateway and outbound WebSocket connectors on `127.0.0.1` in one process, provisions two mock students in different teams, simulates local consent, reads each student's own scene, rejects cross-team pairing, verifies revocation, then shuts down. Fixture tokens are generated in memory and never printed. It uses the real MCP SDK and WebSocket transport, with deterministic fake Blender adapters.

```text
student-a: approved own mock scene, read succeeded, cross-team request denied.
student-b: approved own mock scene, read succeeded, cross-team request denied.
Mock demo passed. No Anthropic credentials, real Blender or public listener used.
```

## First Claude cloud test

See [cloud test settings](docs/CLOUD_TEST.md). The committed `.mcp.json` exposes only `ping` over STDIO. The committed SDK-based `probe/stdio.cjs` bundle starts with Node alone, before dependencies or the SessionStart hook are ready. The hook installs dependencies for the full mock demo. Rebuild the bundle and included third-party notices with `npm run build:probe` after changing `apps/probe-stdio.ts`. This is a cloud loading probe, **not proof of cloud-to-laptop connectivity or authentication**.

For an operator-hosted HTTP probe:

```sh
npm run probe -- --http
```

This separate server exposes only `ping` at `http://127.0.0.1:3334/mcp`. A course-owned TLS reverse proxy can forward a public HTTPS hostname to that **probe only**. It does not expose the mock bridge. No public hostname is provisioned by this repository.

## Implementation

- `packages/core.ts`: mock identity fixtures, hashed credentials, device enrollment, pairing, leases, policy and request correlation.
- `apps/gateway/server.ts`: authenticated mock Streamable HTTP MCP, outbound agent WebSocket channel, strict tool catalogue, size/rate/session limits and heartbeat.
- `apps/connector/connector.ts`: explicit consent callbacks, per-code approval, lease/epoch/deadline checks, bounded responses, fake adapter.
- `apps/connector/main.ts`: interactive **mock-only** connector with no auto-approval; requires a local development harness to supply an ephemeral fixture token.
- `apps/demo.ts`: self-contained scripted fixture demonstration; auto-consent is limited to the test/demo harness.
- `test/`: policy tests and real HTTP/WS/STDIO integration checks.

The mock gateway exposes seven stable tools: `bridge_status`, `request_blender_pairing`, `blender_get_scene_info`, `blender_get_object_info`, `blender_get_viewport_screenshot`, `blender_execute_code`, `disconnect_blender`. Every remote call rechecks credentials. The execute tool remains listed but is denied unless separately granted and locally approved. The fake adapter recognizes only `mock:add_cube`; it never runs Python. The screenshot is a 1×1 fixture PNG, not a real viewport.

See [Phase 0 findings](docs/PHASE0_VERIFICATION.md), [architecture](docs/ARCHITECTURE.md), [threat model](docs/THREAT_MODEL.md), and [remaining work](docs/KNOWN_LIMITATIONS.md).
