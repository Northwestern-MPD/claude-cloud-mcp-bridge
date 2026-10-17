import { createServer } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpServer } from './gateway/server.js';
import { jsonResult, fail } from '../packages/protocol.js';
const create = () => mcpServer(async (name, args) => {
  if (name !== 'ping' || !args || typeof args !== 'object' || Object.keys(args).length) return fail('INVALID_INPUT');
  return jsonResult({ pong: true, mode: 'compatibility-probe', desktop_access: false });
}, true);
if (process.argv.includes('--http')) {
  // Separate read-only probe: never imports or instantiates desktop control state.
  // Bind on loopback. An operator-owned HTTPS reverse proxy may expose this probe ONLY.
  const port = Number(process.env.PORT ?? 3334);
  const server = createServer(async (req, res) => {
    if (req.url !== '/mcp' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    if (req.headers.origin) { res.writeHead(403).end(); return; }
    const mcp = create();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 16384 });
    res.on('close', () => { void transport.close(); void mcp.close(); });
    try { await mcp.connect(transport); await transport.handleRequest(req, res); }
    catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.listen(port, '127.0.0.1', () => { const address = server.address(); if (address && typeof address !== 'string') console.error(`Read-only ping probe: http://127.0.0.1:${address.port}/mcp`); });
} else { await create().connect(new StdioServerTransport()); }
