import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Bridge } from '../packages/core.js';
import { jsonResult } from '../packages/protocol.js';
import { startGateway } from '../apps/gateway/server.js';
import { FakeBlender, connectDevice } from '../apps/connector/connector.js';

function fixture(rpcMs = 20) {
  let now = 1000; const bridge = new Bridge(() => now, 100, 1000, 500, rpcMs);
  bridge.provision({ id: 'owner', teams: ['team'] }); const context = bridge.open('owner');
  const device = bridge.enroll('owner', 'Local fixture'); const frames: any[] = [];
  bridge.connect(device.id, frame => frames.push(frame));
  const pairing = async () => (await bridge.call(context, 'request_blender_pairing', { team_id: 'team' })).structuredContent!.pairing_id as string;
  const pair = async () => bridge.approve(device.id, await pairing(), ['read']);
  return { bridge, context, device, frames, pair, pairing, advance(ms: number) { now += ms; } };
}

test('mock authority refuses invalid enrollment, duplicate devices, pending pairings and escalated approvals', async t => {
  const f = fixture(); t.after(() => f.bridge.shutdown());
  assert.throws(() => f.bridge.enroll('owner', ''), /INVALID_INPUT/);
  assert.throws(() => f.bridge.enroll('owner', 'x'.repeat(81)), /INVALID_INPUT/);
  assert.throws(() => f.bridge.connect(randomUUID(), () => {}), /UNAUTHORIZED/);
  assert.throws(() => f.bridge.connect(f.device.id, () => {}), /DEVICE_ALREADY_CONNECTED/);
  f.bridge.disconnect(randomUUID());
  const id = await f.pairing();
  await assert.rejects(f.pairing(), /PAIRING_PENDING/);
  assert.throws(() => f.bridge.approve(randomUUID(), id, ['read']), /UNAUTHORIZED/);
  assert.throws(() => f.bridge.approve(f.device.id, id, []), /CAPABILITY_DENIED/);
  assert.throws(() => f.bridge.approve(f.device.id, id, ['execute']), /CAPABILITY_DENIED/);
  f.bridge.disconnect(f.device.id);
  assert.throws(() => f.bridge.approve(f.device.id, id, ['read']), /DEVICE_OFFLINE/);
});

test('mock read revocation rejects pending work and stale late replies cannot complete it', async t => {
  const f = fixture(); t.after(() => f.bridge.shutdown()); const lease = await f.pair();
  const pending = f.bridge.call(f.context, 'blender_get_scene_info', {}); const rejection = assert.rejects(pending, /NOT_PAIRED/);
  const frame = f.frames.at(-1); f.bridge.localRevoke(f.device.id); f.bridge.localRevoke(f.device.id);
  await rejection;
  f.bridge.respond(f.device.id, frame.request_id, lease.id, lease.epoch, jsonResult({ scene: 'late' }));
  await assert.rejects(f.bridge.call(f.context, 'blender_get_scene_info', {}), /NOT_PAIRED/);
});

test('mock lease checks missing devices, changed epochs and changed owners before sending', async () => {
  for (const cause of ['missing', 'epoch', 'owner']) {
    const f = fixture(); await f.pair(); const before = f.frames.filter(frame => frame.type === 'request').length;
    if (cause === 'missing') f.bridge.devices.delete(f.device.id);
    if (cause === 'epoch') f.bridge.devices.get(f.device.id)!.epoch++;
    if (cause === 'owner') f.bridge.devices.get(f.device.id)!.owner = 'different';
    await assert.rejects(f.bridge.call(f.context, 'blender_get_scene_info', {}), /DEVICE_OFFLINE|UNAUTHORIZED/);
    assert.equal(f.frames.filter(frame => frame.type === 'request').length, before); f.bridge.shutdown();
  }
});

test('mock transport send failure and unacknowledged writes fail closed without replay', async () => {
  for (const write of [false, true]) {
    const f = fixture(); const request = await f.bridge.call(f.context, 'request_blender_pairing', { team_id: 'team', capabilities: ['read', 'execute'] });
    f.bridge.approve(f.device.id, String(request.structuredContent!.pairing_id), ['read', 'execute']);
    f.bridge.devices.get(f.device.id)!.send = () => { throw new Error('fixture transport disconnected'); };
    // A relay may throw while notifying revocation too; it must never enqueue another request.
    await assert.rejects(f.bridge.call(f.context, write ? 'blender_execute_code' : 'blender_get_scene_info', write ? { code: 'mock:add_cube' } : {}));
    f.bridge.devices.get(f.device.id)!.send = undefined; f.bridge.shutdown();
  }
  const f = fixture(5); const request = await f.bridge.call(f.context, 'request_blender_pairing', { team_id: 'team', capabilities: ['execute'] });
  f.bridge.approve(f.device.id, String(request.structuredContent!.pairing_id), ['execute']);
  await assert.rejects(f.bridge.call(f.context, 'blender_get_scene_info', {}), /CAPABILITY_DENIED/);
  await assert.rejects(f.bridge.call(f.context, 'blender_execute_code', { code: 'mock:add_cube' }), /EXECUTION_UNCERTAIN/); f.bridge.shutdown();
});

test('mock audit stays bounded and expired replies revoke rather than complete a read', async t => {
  const f = fixture(); t.after(() => f.bridge.shutdown());
  for (let i = 0; i < 1005; i++) await f.bridge.call(f.context, 'bridge_status', {});
  assert.equal(f.bridge.audit.length, 1000);
  f.bridge.enroll('owner', 'Offline device'); // Unconnected owned devices receive no pairing frame.
  const lease = await f.pair(); const pending = f.bridge.call(f.context, 'blender_get_scene_info', {});
  const rejected = assert.rejects(pending, /NOT_PAIRED/); const frame = f.frames.at(-1); f.advance(1001);
  f.bridge.respond(f.device.id, frame.request_id, lease.id, lease.epoch, jsonResult({ scene: 'expired' })); await rejected;
  f.bridge.sweep();
});

test('mock HTTP boundary enforces device/body/session bounds and authenticated rate limits', async t => {
  const bridge = new Bridge(); bridge.provision({ id: 'owner', teams: ['team'] });
  const gateway = await startGateway(bridge); t.after(() => gateway.close()); const token = bridge.token('owner');
  const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(gateway.url + '/missing', { headers })).status, 404);
  assert.equal((await fetch(gateway.url + '/mcp', { headers })).status, 400);
  assert.equal((await fetch(gateway.url + '/mcp', { method: 'POST', headers, body: '{}' })).status, 400);
  assert.equal((await fetch(gateway.url + '/mcp', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(gateway.url + '/mcp', { method: 'POST', headers, body: ' '.repeat(65537) })).status, 413);
  assert.equal((await fetch(gateway.url + '/devices', { method: 'POST', headers, body: '{}'})).status, 400);
  assert.equal((await fetch(gateway.url + '/devices', { method: 'POST', headers, body: 'x'.repeat(513) })).status, 413);
  for (let i = 0; i < 8; i++) assert.equal((await fetch(gateway.url + '/devices', { method: 'POST', headers, body: JSON.stringify({ name: 'Local test' }) })).status, 201);
  assert.equal((await fetch(gateway.url + '/devices', { method: 'POST', headers, body: JSON.stringify({ name: 'Ninth' }) })).status, 429);
  let limited = false;
  for (let i = 0; i < 125; i++) { if ((await fetch(gateway.url + '/missing', { headers })).status === 429) { limited = true; break; } }
  assert.equal(limited, true);
});

test('mock MCP session deletion closes authority and ninth concurrent session is refused', async t => {
  const bridge = new Bridge(); bridge.provision({ id: 'owner', teams: ['team'] }); const token = bridge.token('owner');
  const gateway = await startGateway(bridge); const clients: Client[] = []; t.after(async () => { for (const client of clients) await client.close(); await gateway.close(); });
  const transports: StreamableHTTPClientTransport[] = [];
  for (let i = 0; i < 8; i++) {
    const transport = new StreamableHTTPClientTransport(new URL(gateway.url + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    const client = new Client({ name: 'mock-session-limit', version: '1' }); await client.connect(transport); clients.push(client); transports.push(transport);
  }
  assert.equal((await fetch(gateway.url + '/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })).status, 429);
  const first = transports[0]!; const old = first.sessionId!; await first.terminateSession();
  assert.equal((await fetch(gateway.url + '/mcp', { headers: { Authorization: `Bearer ${token}`, 'mcp-session-id': old } })).status, 403);
});

test('mock agent rejects bad handshakes, malformed packets and revoked owners', async t => {
  const bridge = new Bridge(); bridge.provision({ id: 'owner', teams: ['team'] }); const gateway = await startGateway(bridge); t.after(() => gateway.close());
  const device = bridge.enroll('owner', 'Local test'); const url = gateway.url.replace('http:', 'ws:');
  for (const [path, credential] of [['/bad', device.credential], ['/agent', 'invalid']]) {
    const ws = new WebSocket(url + path, { headers: { Authorization: `Bearer ${credential}` } });
    await new Promise<void>(resolve => { ws.once('error', () => resolve()); });
  }
  const ws = new WebSocket(url + '/agent', { headers: { Authorization: `Bearer ${device.credential}` } }); await once(ws, 'open'); t.after(() => ws.terminate());
  const packet = async (data: string) => { const received = once(ws, 'message'); ws.send(data); return JSON.parse(String((await received)[0])); };
  assert.equal((await packet('{')).error, 'INVALID_MESSAGE');
  assert.equal((await packet(JSON.stringify({ type: 'approve', pairing_id: randomUUID(), capabilities: ['read'] }))).error, 'UNAUTHORIZED');
  bridge.users.get('owner')!.disabled = true;
  assert.equal((await packet(JSON.stringify({ type: 'revoke' }))).error, 'UNAUTHORIZED');
});

test('fake adapter never interprets arbitrary code and connector rejects nonloopback URLs', async () => {
  const adapter = new FakeBlender();
  assert.equal((await adapter.call('blender_get_object_info', { name: 'Cube' })).structuredContent!.exists, true);
  assert.equal((await adapter.call('blender_execute_code', { code: 'arbitrary Python' })).isError, true);
  for (const url of ['wss://127.0.0.1/agent', 'ws://example.com/agent', 'ws://127.0.0.1/wrong', 'ws://127.0.0.1/agent?token=x']) {
    await assert.rejects(connectDevice({ url, credential: 'fixture', deviceId: randomUUID(), owner: 'owner', adapter, approvePairing: async () => false, approveCode: async () => false }), /loopback/);
  }
});
