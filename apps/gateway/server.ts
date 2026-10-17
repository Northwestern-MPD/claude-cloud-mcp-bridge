import { createServer, type IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Bridge, type Context } from '../../packages/core.js';
import { BridgeError, MAX_FRAME, clientMessage, toolInputs, toolName, jsonResult } from '../../packages/protocol.js';
export function mcpServer(call: (name: string, args: unknown) => Promise<any>, probe = false) {
  const server = new Server({ name: probe ? 'bridge-compatibility-probe' : 'course-blender-bridge-mock', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: probe
    ? [{ name: 'ping', description: 'Read-only bridge compatibility check. No desktop access.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } }]
    : Object.entries(toolInputs).map(([name, schema]) => ({ name, description: name === 'blender_execute_code' ? 'High risk: requires local capability grant and approval of each code request. Mock mode only.' : `${name} (mock bridge)`, inputSchema: z.toJSONSchema(schema) as any, annotations: { readOnlyHint: name.startsWith('blender_get') || name === 'bridge_status', openWorldHint: false } })) }));
  server.setRequestHandler(CallToolRequestSchema, async req => {
    try { return await call(req.params.name, req.params.arguments ?? {}); }
    catch (e) { return { ...jsonResult({ error: e instanceof BridgeError ? e.code : 'INVALID_INPUT' }), isError: true }; }
  });
  return server;
}
export async function startGateway(bridge: Bridge, port = 0) {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; context: Context; server: Server }>();
  const limits = new Map<string, { reset: number; count: number }>();
  const bearer = (req: IncomingMessage) => req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1] ?? '';
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const http = createServer(async (req, res) => {
    const send = (status: number, data: unknown) => { if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      const host = req.headers.host ?? '';
      // This entire gateway uses mock identities. It cannot listen publicly.
      if (!/^127\.0\.0\.1:\d+$/.test(host) || req.headers.origin) return send(403, { error: 'ORIGIN_REJECTED' });
      if (req.url === '/health' && req.method === 'GET') return send(200, { status: 'ok', mode: 'localhost-mock' });
      const user = bridge.authenticate(bearer(req));
      const limit = limits.get(user); const now = Date.now();
      if (!limit || limit.reset < now) limits.set(user, { reset: now + 60_000, count: 1 });
      else if (++limit.count > 120) return send(429, { error: 'RATE_LIMITED' });
      if (req.url === '/devices' && req.method === 'POST') {
        let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 512) return send(413, { error: 'TOO_LARGE' }); }
        const input = z.object({ name: z.string().min(1).max(80) }).strict().parse(JSON.parse(data));
        if ([...bridge.devices.values()].filter(d => d.owner === user).length >= 8) return send(429, { error: 'DEVICE_LIMIT' });
        return send(201, bridge.enroll(user, input.name));
      }
      if (req.url !== '/mcp') return send(404, { error: 'NOT_FOUND' });
      const sessionId = req.headers['mcp-session-id'];
      if (typeof sessionId === 'string') {
        const s = sessions.get(sessionId);
        if (!s || s.context.user !== user) return send(403, { error: 'UNAUTHORIZED' });
        await s.transport.handleRequest(req, res);
        if (req.method === 'DELETE') { bridge.close(s.context); sessions.delete(sessionId); }
        return;
      }
      if (req.method !== 'POST') return send(400, { error: 'SESSION_REQUIRED' });
      if (sessions.size >= 64 || [...sessions.values()].filter(s => s.context.user === user).length >= 8) return send(429, { error: 'SESSION_LIMIT' });
      let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 65536) return send(413, { error: 'TOO_LARGE' }); }
      const body: unknown = JSON.parse(data);
      if (!isInitializeRequest(body)) return send(400, { error: 'INITIALIZE_REQUIRED' });
      const context = bridge.open(user);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => context.connection, enableJsonResponse: true, maxRequestBodySize: 65536 });
      const server = mcpServer(async (name, args) => bridge.call(context, toolName.parse(name), args));
      await server.connect(transport);
      sessions.set(context.connection, { context, server, transport });
      transport.onclose = () => { bridge.close(context); sessions.delete(context.connection); };
      await transport.handleRequest(req, res, body);
    } catch (e) { send(e instanceof BridgeError ? 401 : 400, { error: e instanceof BridgeError ? e.code : 'INVALID_REQUEST' }); }
  });
  http.requestTimeout = 35_000; http.headersTimeout = 10_000;
  http.on('upgrade', (req, socket, head) => {
    try {
      if (req.url !== '/agent' || req.headers.origin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '')) throw new Error();
      const d = bridge.authenticateDevice(bearer(req)); if (d.send) throw new Error();
      wss.handleUpgrade(req, socket, head, ws => {
        let alive = true;
        bridge.connect(d.id, msg => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); else throw new Error('offline'); });
        ws.on('pong', () => { alive = true; });
        const heartbeat = setInterval(() => { if (!alive) { bridge.disconnect(d.id); ws.terminate(); } else { alive = false; ws.ping(); } }, 10_000);
        heartbeat.unref();
        ws.on('message', data => {
          try {
            // Revalidate device enrollment and owner on every agent packet.
            bridge.authenticateDevice(bearer(req));
            const msg = clientMessage.parse(JSON.parse(data.toString()));
            if (msg.type === 'approve') bridge.approve(d.id, msg.pairing_id, msg.capabilities);
            if (msg.type === 'revoke') bridge.localRevoke(d.id);
            if (msg.type === 'result') bridge.respond(d.id, msg.request_id, msg.lease_id, msg.epoch, msg.result);
          } catch (e) { ws.send(JSON.stringify({ type: 'error', error: e instanceof BridgeError ? e.code : 'INVALID_MESSAGE' })); }
        });
        ws.on('close', () => { clearInterval(heartbeat); bridge.disconnect(d.id); });
        ws.on('error', () => { bridge.disconnect(d.id); ws.terminate(); });
      });
    } catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); }
  });
  const sweep = setInterval(() => bridge.sweep(), 1000); sweep.unref();
  await new Promise<void>(resolve => http.listen(port, '127.0.0.1', resolve));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No address');
  return { url: `http://127.0.0.1:${address.port}`, close: async () => {
    clearInterval(sweep); bridge.shutdown(); for (const ws of wss.clients) ws.terminate();
    for (const s of sessions.values()) await s.server.close();
    wss.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
  } };
}
