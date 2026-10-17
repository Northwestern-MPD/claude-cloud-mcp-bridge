# Anthropic cloud test configuration

Ready for an isolated **Phase 0 compatibility test**, not an end-to-end Blender pilot.

## Create the environment

| Field | Value |
|---|---|
| Name | `MPD Blender Bridge — Phase 0` |
| Repository | `Northwestern-MPD/claude-cloud-mcp-bridge` |
| Session branch | `main` |
| Session repositories | Only this repository |
| Network | `Trusted` for the first local/mock probe |
| Environment variables | Leave empty |
| Network secrets | Leave empty |
| Setup script | Leave empty; the repository SessionStart hook installs the locked dependencies |
| Identity | Your own Claude account, independent Claude Code cloud session |
| Other connectors | Disable unrelated connectors for this test |

Use a private test session initially. A shared environment is configuration, not desktop identity. There is no student token, team token, Anthropic API key, SSH key, VPN, or laptop address to add.

The ping probe is a checked-in SDK bundle (`node probe/stdio.cjs`) requiring no npm install. The project contains a synchronous SessionStart hook running `npm ci --ignore-scripts`. It requires Node 22+ (documented cloud default: 22). No gateway daemon is started from a cached setup script. If your organization blocks repository hooks, run the install command manually before reconnecting `bridge-probe`.

Initial test prompt:

```text
Run node --version and npm --version, then npm run typecheck, npm test,
and npm run dev:mock. Find the bridge-probe MCP server and call its ping
MCP tool (not a shell substitute). Report the exact tool result and whether
it was loaded from this repository's .mcp.json. If unavailable, report the
MCP error and inspect its stderr. Do not substitute a shell/SDK call for the native MCP call.
Do not add credentials, modify authorization, or publish any server.
```

Expected MCP result: `pong: true`, `mode: compatibility-probe`, `desktop_access: false`. This tests STDIO loading inside the cloud VM only. The mock demo tests HTTP/WS within the VM; neither reaches a laptop.

Record Claude Code version if exposed, selected branch/commit, MCP tool discovery/result, hook behavior and error text. Redact IDs and credentials before sharing output.

## Second test: remote HTTP compatibility

The **read-only probe** is deployed at `https://bridge-remote-probe-production.up.railway.app/mcp`; direct HTTPS checks passed. The project `.mcp.json` includes this endpoint as `bridge-remote-probe` alongside STDIO `bridge-probe`. Use a fresh session from the main commit containing the HTTP entry. The operator reported successful native remote cloud pings before and after a verified Railway service restart, satisfying the transport acceptance criterion. A separate fresh-session result was not identified; account usage-limit review remains outstanding. See `HANDOFF.md`. The following hosting instructions remain as a runbook for replacement hosts.

1. Operator runs `npm ci --ignore-scripts` and `npm run probe -- --http` on a host, then configures TLS reverse proxy to `127.0.0.1:3334`. Permit POST `/mcp`; bound request sizes/concurrency at the proxy. Disable payload logging. No WSS is needed for the ping probe.
2. Add the HTTPS `/mcp` URL as a custom connector in claude.ai and enable it for your cloud session. Team/Enterprise may require an administrator. This route is documented as going through Anthropic infrastructure.
3. Alternatively use `examples/remote-probe.mcp.json` as the session's project `.mcp.json` with the real hostname substituted. For direct egress, change network to Custom, include default package-manager domains, and add that exact hostname. **Do not enter localhost** as the public endpoint.
4. Call remote `ping`, restart the cloud session, call it again, and record behavior. Do not add a common bearer key to make it pass.

The probe has no authorization because its entire capability is a fixed public ping result. Successful ping does not validate OAuth. Before desktop tools can be exposed, implement and verify individual OAuth login, token issuer/audience/scope, team provisioning, protected-resource discovery and session/grant attachment. No production desktop endpoint exists yet.

References checked 2026-10-17:
- https://code.claude.com/docs/en/cloud-environments
- https://code.claude.com/docs/en/mcp
