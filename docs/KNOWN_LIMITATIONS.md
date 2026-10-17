# Remaining work

Implemented and locally tested: mock policy, seven stable tools, authenticated HTTP MCP and outbound WebSocket device transport, local consent callbacks, per-code approval, lease revocation/expiry, fake scene mutation and image return; STDIO compatibility ping.

Not implemented: production OAuth/OIDC, persistent database, refresh tokens/OS keychain, production WSS, public hosting/deployment, real Blender STDIO adapter, signed installers, native UI, complete audit/admin operations. This is an M1 development foundation, not the handoff definition of done.

Not tested: Anthropic Cloud tool loading, remote connector HTTP path, individual user token claims, same-principal cloud connection reuse, actual Windows/macOS Blender, physical viewport changes/screenshots. These require operator/account/laptop resources. The repository's automated CI workflow has not run remotely yet.

Operator prerequisites for later stages: a course-owned HTTPS/WSS hostname and single-instance host; approved OIDC provider/app registrations; explicit user/team enrollment; pilot laptop with a reviewed pinned loopback Blender add-on; separate real student accounts. Do not work around an integration blocker by installing a team-wide desktop-control key.

The mock CLI is a development building block rather than a complete distributed sign-in product. Its fixture token must be supplied by a local harness; the self-contained `npm run dev:mock` is the supported first-run path. The demo exits after its checks and deliberately prints no reusable credentials.
