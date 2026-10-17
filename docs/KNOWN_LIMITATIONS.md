# Remaining work

See [HANDOFF.md](HANDOFF.md) for the current continuation brief and ordered implementation milestones.

Implemented and locally tested: mock policy, seven stable tools, authenticated fixture HTTP MCP and outbound WebSocket device transport, local consent callbacks, per-code approval, lease revocation/expiry, fake scene mutation and image return. STDIO and HTTP ping probes are bundled for dependency-free startup. Railway Docker/configuration files are prepared and the container passed local checks; no Railway deployment URL is recorded.

User-reported cloud verification: native Claude Code cloud discovery and invocation of STDIO `mcp__bridge-probe__ping` succeeded. This does not establish remote HTTP access, production identity or laptop connectivity.

Not implemented: production OAuth/OIDC, persistent database, refresh tokens/OS keychain, production WSS, real Blender STDIO adapter, signed installers, native UI, complete audit/admin operations. This is an M1 development foundation, not the full product definition of done.

Not verified: live Railway deployment and remote connector HTTP path, individual user token claims, same-principal cloud connection reuse, actual Windows/macOS Blender, physical viewport changes/screenshots. Remote GitHub CI results were inaccessible; no successful remote CI run is claimed.

Operator prerequisites for later stages: Railway project/public HTTPS hostname; approved OIDC provider/app registrations; explicit user/team enrollment; pilot laptop with a reviewed pinned loopback Blender add-on; separate real student accounts. Do not work around an integration blocker with a team-wide desktop-control key.

The mock CLI is a development building block rather than a complete distributed sign-in product. Its fixture token must be supplied by a local harness; `npm run dev:mock` is the supported first-run path. The demo exits after its checks and deliberately prints no reusable credentials. Persistent state, supervised local processes and production error/recovery behavior remain work.
