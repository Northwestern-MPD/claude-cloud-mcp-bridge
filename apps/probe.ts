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
  // Only this ping probe permits a public bind; the mock desktop gateway stays loopback-only.
  const port = Number(process.env.PORT ?? 3334);
  const host = process.env.PROBE_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(host) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid probe bind configuration');
  const server = createServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ status: 'ok', mode: 'compatibility-probe', desktop_access: false })); return;
    }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    if (req.headers.origin) { res.writeHead(403).end(); return; }
    const mcp = create();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 16384 });
    res.on('close', () => { void transport.close(); void mcp.close(); });
    try { await mcp.connect(transport); await transport.handleRequest(req, res); }
    catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.listen(port, host, () => { const address = server.address(); if (address && typeof address !== 'string') console.error(`Read-only ping probe: http://${host}:${address.port}/mcp`); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.close(() => { process.exitCode = 0; });
    setTimeout(() => server.closeAllConnections(), 5000).unref();
  });
} else { void create().connect(new StdioServerTransport()).catch(() => { console.error('bridge-probe: stdio startup failed'); process.exitCode = 1; }); }
