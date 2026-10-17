# Railway remote MCP probe

This deploys a public, read-only compatibility probe. It exposes only `ping` and a health check, with no desktop access, secrets, identity assertions, database, or laptop connection. Production desktop routing is still separate work.

Current deployment (October 17, 2026): `bridge-remote-probe` is live at `https://bridge-remote-probe-production.up.railway.app/mcp`, deployed from main. Direct HTTPS health/discovery/ping passed; the first native Claude Code cloud ping succeeded per the operator; post-service-restart and fresh-session native repeats remain pending. Reuse the existing service; see `HANDOFF.md` for IDs and evidence. Project `.mcp.json` now contains the real HTTP entry.

## Deploy from GitHub

1. In Railway, create a project using **Deploy from GitHub repo** and select `Northwestern-MPD/claude-cloud-mcp-bridge`. Authorize Railway's GitHub app for this repository if needed.
2. Set the service source branch to **`main`** and root directory to `/`. The bridge implementation and Railway configuration are now on `main`.
3. Railway reads `railway.json` and the root Dockerfile. Leave build/start command overrides empty. Use one service and one replica. No database or volume is needed for this probe.
4. No user-supplied environment variables or secrets are needed. Railway supplies `PORT`; the Docker image sets `PROBE_HOST=0.0.0.0` and `NODE_ENV=production`. Do not override the container command with `gateway:mock`.
5. Under service **Settings → Networking**, generate a public domain. Select the service's assigned listening port if prompted. Railway provides HTTPS; do not buy a domain for this test.
6. Open `https://YOUR-GENERATED-DOMAIN/health`. Expected HTTP 200:

   ```json
   {"status":"ok","mode":"compatibility-probe","desktop_access":false}
   ```

7. The MCP endpoint is `https://YOUR-GENERATED-DOMAIN/mcp`. Opening this URL in a browser returns HTTP 405 because the stateless MCP transport uses POST. That is expected; health is the browser check.

Set a low usage alert/budget in Railway's billing controls and review the effect of any hard limit before enabling it. Trial/Hobby pricing and usage limits depend on your account. This probe requires only one service; do not add Postgres, Redis, or another service yet.

## Configure Claude Cloud

Keep the existing working STDIO `bridge-probe` entry for comparison. Add a distinct HTTP server named `bridge-remote-probe` using the real Railway URL; `examples/remote-probe.mcp.json` shows the shape:

```json
{
  "mcpServers": {
    "bridge-remote-probe": {
      "type": "http",
      "url": "https://YOUR-GENERATED-DOMAIN/mcp"
    }
  }
}
```

For project `.mcp.json` direct egress, configure your Anthropic cloud environment as **Custom** network access, include the default package-manager allowlist, and add your exact generated Railway hostname. Start a new session from the branch containing the HTTP entry. As an alternative, add the URL as a custom connector in claude.ai and enable it in the session; that path is documented as using Anthropic connector infrastructure. No bearer token is needed for this fixed public ping probe.

Cloud test prompt:

```text
Discover bridge-remote-probe and call its ping tool through this session's
native MCP interface. Do not call the local bridge-probe instead and do
not substitute a shell or SDK call. Report the result and exact server name.
If it fails, report the connection error and server stderr if available.
```

Expected result: `pong: true`, `mode: compatibility-probe`, `desktop_access: false`. This proves remote HTTP tool discovery/execution, not OAuth or laptop connectivity. Record the Railway deployment commit and cloud MCP result. Share the public URL with the implementation agent to configure and verify it; never paste account tokens.

## Updates, rollback, and lifecycle

The HTTP and STDIO probe bundles are committed build artifacts. After changing their source, run `npm run build:probe` and commit the regenerated bundles and notices. CI checks that artifacts match source. The Docker image includes only the HTTP bundle and third-party notices, runs as the Node user, and uses Railway TLS termination. A deploy restart loses no application data because the ping service has no state.

For rollback select the previous successful deployment in Railway. Stop/delete the service after testing if you do not want ongoing resource usage. Future authentication, leases and WSS must use a separate reviewed deployment; do not publish the local mock gateway.

## Local container check

```sh
docker build -t bridge-probe .
docker run --rm -p 127.0.0.1:3334:3334 -e PORT=3334 bridge-probe
```

Check `http://127.0.0.1:3334/health` from your machine. The public bind is inside this ping-only container; the Docker host mapping above remains loopback-only. Blender and the local mock gateway remain loopback-bound.

Official references checked 2026-10-17:
- https://docs.railway.com/config-as-code/reference
- https://docs.railway.com/networking/public-networking
- https://docs.railway.com/deployments/healthchecks
