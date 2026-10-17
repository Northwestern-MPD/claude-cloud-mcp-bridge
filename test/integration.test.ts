import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Bridge } from '../packages/core.js';
import { startGateway } from '../apps/gateway/server.js';
import { connectDevice, FakeBlender } from '../apps/connector/connector.js';
async function waitFor(predicate: () => boolean | Promise<boolean>) { for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('Timed out'); }
test('real HTTP MCP + WebSocket, two owners, per-request auth, code approval and image preservation', async () => {
  const b = new Bridge(); b.provision({ id: 'a', teams: ['team'] }); b.provision({ id: 'b', teams: ['team'] });
  const gateway = await startGateway(b); const cleanup: (() => Promise<any> | void)[] = [];
  try {
    const clients: { client: Client; adapter: FakeBlender; transport: StreamableHTTPClientTransport; token: string }[] = [];
    for (const owner of ['a', 'b']) {
      const token = b.token(owner); const d = b.enroll(owner, 'identical display label'); const adapter = new FakeBlender(owner);
      const connector = await connectDevice({ url: gateway.url.replace('http:', 'ws:') + '/agent', credential: d.credential, deviceId: d.id, owner, adapter,
        approvePairing: async p => p.capabilities, approveCode: async code => code === 'mock:add_cube' });
      cleanup.push(() => connector.disconnect());
      const transport = new StreamableHTTPClientTransport(new URL(gateway.url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
      const client = new Client({ name: 'cloud-simulator', version: '1' }); await client.connect(transport); cleanup.push(() => client.close());
      clients.push({ client, adapter, transport, token });
      assert.equal((await client.listTools()).tools.length, 7);
      await client.callTool({ name: 'request_blender_pairing', arguments: { team_id: 'team', capabilities: ['read', 'execute'] } });
      await waitFor(async () => !!((await client.callTool({ name: 'bridge_status', arguments: {} })).structuredContent as any)?.paired);
      const r = await client.callTool({ name: 'blender_get_scene_info', arguments: {} }); assert.equal((r.structuredContent as any)?.scene, owner);
      const denied = await client.callTool({ name: 'blender_execute_code', arguments: { code: 'unapproved' } }); assert.equal(denied.isError, true);
      await client.callTool({ name: 'blender_execute_code', arguments: { code: 'mock:add_cube' } }); assert.equal(adapter.objects.length, 2);
      const image = await client.callTool({ name: 'blender_get_viewport_screenshot', arguments: {} }); assert.equal((image.content as any[])[0].type, 'image');
    }
    const [a, other] = clients;
    const noAuth = await fetch(gateway.url + '/mcp', { method: 'POST', headers: { 'mcp-session-id': a!.transport.sessionId! } }); assert.equal(noAuth.status, 401);
    const spoof = await fetch(gateway.url + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${other!.token}`, 'mcp-session-id': a!.transport.sessionId! } }); assert.equal(spoof.status, 403);
    const origin = await fetch(gateway.url + '/health', { headers: { Origin: 'https://evil.invalid' } }); assert.equal(origin.status, 403);
    assert.equal(clients[0]!.adapter.objects.length, 2); assert.equal(clients[1]!.adapter.objects.length, 2);
    await a!.client.callTool({ name: 'disconnect_blender', arguments: {} });
    assert.equal((await a!.client.callTool({ name: 'blender_get_scene_info', arguments: {} })).isError, true);
  } finally { for (const close of cleanup.reverse()) await close(); await gateway.close(); }
});
test('STDIO cloud compatibility probe only exposes ping and never desktop controls', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'apps/probe.ts'] });
  const c = new Client({ name: 'probe-test', version: '1' });
  try { await c.connect(transport); assert.deepEqual((await c.listTools()).tools.map(t => t.name), ['ping']); const r = await c.callTool({ name: 'ping', arguments: {} }); assert.equal((r.structuredContent as any)?.pong, true); assert.equal((r.structuredContent as any)?.desktop_access, false); }
  finally { await c.close(); }
});
