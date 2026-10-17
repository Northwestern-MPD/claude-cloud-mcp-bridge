import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Bridge } from '../packages/core.js';
import { startGateway } from './gateway/server.js';
import { connectDevice, FakeBlender } from './connector/connector.js';
const bridge = new Bridge();
const gateway = await startGateway(bridge);
const cleanup: (() => Promise<unknown> | void)[] = [];
try {
  for (const suffix of ['a', 'b']) {
    const owner = `student-${suffix}`, team = `team-${suffix}`;
    bridge.provision({ id: owner, teams: [team] });
    const token = bridge.token(owner), device = bridge.enroll(owner, `Mock ${suffix}`);
    const connector = await connectDevice({ url: gateway.url.replace('http:', 'ws:') + '/agent', credential: device.credential, deviceId: device.id, owner,
      adapter: new FakeBlender(`Scene ${suffix}`),
      // Simulator only: human approvals are scripted for the deterministic fixture demo.
      approvePairing: async p => p.capabilities.filter(c => c === 'read'), approveCode: async () => false });
    cleanup.push(() => connector.disconnect());
    const transport = new StreamableHTTPClientTransport(new URL(gateway.url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    const client = new Client({ name: 'mock-cloud-client', version: '0.1.0' });
    await client.connect(transport); cleanup.push(() => client.close());
    assert.equal((await client.listTools()).tools.length, 7);
    await client.callTool({ name: 'request_blender_pairing', arguments: { team_id: team } });
    let paired = false;
    for (let i = 0; i < 50; i++) {
      const r = await client.callTool({ name: 'bridge_status', arguments: {} });
      if ((r.structuredContent as any)?.paired) { paired = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(paired, 'Pairing must complete');
    const result = await client.callTool({ name: 'blender_get_scene_info', arguments: {} });
    assert.equal((result.structuredContent as any).scene, `Scene ${suffix}`);
    const denied = await client.callTool({ name: 'request_blender_pairing', arguments: { team_id: suffix === 'a' ? 'team-b' : 'team-a' } });
    assert.equal(denied.isError, true);
    console.log(`${owner}: approved own mock scene, read succeeded, cross-team request denied.`);
    await client.callTool({ name: 'disconnect_blender', arguments: {} });
    const after = await client.callTool({ name: 'blender_get_scene_info', arguments: {} });
    assert.equal(after.isError, true);
  }
  console.log('Mock demo passed. No Anthropic credentials, real Blender or public listener used.');
} finally { for (const close of cleanup.reverse()) await close(); await gateway.close(); }
