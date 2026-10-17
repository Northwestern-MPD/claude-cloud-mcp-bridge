import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, type Context } from '../packages/core.js';
import { jsonResult } from '../packages/protocol.js';
function fixture(options: { pairing?: number; lease?: number; idle?: number; rpc?: number } = {}) {
  let now = 100000; const b = new Bridge(() => now, options.pairing ?? 100, options.lease ?? 1000, options.idle ?? 500, options.rpc ?? 1000);
  b.provision({ id: 'alice', teams: ['red'] }); b.provision({ id: 'bob', teams: ['blue'] }); b.provision({ id: 'carol', teams: ['red'] });
  const a = b.open('alice'), bob = b.open('bob'), carol = b.open('carol');
  const d = b.enroll('alice', 'same display name'), d2 = b.enroll('bob', 'same display name'), d3 = b.enroll('carol', 'same display name');
  const messages: any[] = [], other: any[] = [];
  b.connect(d.id, m => messages.push(m)); b.connect(d2.id, m => other.push(m)); b.connect(d3.id, m => other.push(m));
  const pair = async (c: Context = a, team = 'red', device = d.id, capabilities: ('read' | 'execute')[] = ['read']) => {
    const r = await b.call(c, 'request_blender_pairing', { team_id: team, capabilities });
    return b.approve(device, String(r.structuredContent!.pairing_id), capabilities);
  };
  return { b, a, bob, carol, d, d2, d3, messages, other, pair, advance: (ms: number) => { now += ms; } };
}
test('unpaired device receives no commands; spoofed fields and cross-team requests denied', async () => {
  const { b, a, messages, pair, bob, other } = fixture();
  await assert.rejects(b.call(a, 'blender_get_scene_info', {}), /NOT_PAIRED/);
  await assert.rejects(b.call(a, 'request_blender_pairing', { team_id: 'blue' }), /UNAUTHORIZED/);
  assert.equal(messages.length, 0);
  await pair();
  await assert.rejects(b.call(a, 'blender_get_scene_info', { device_id: 'bob', user_id: 'bob' }), /INVALID_INPUT/);
  await assert.rejects(b.call(bob, 'blender_get_scene_info', {}), /NOT_PAIRED/);
  assert.equal(other.length, 0);
  b.shutdown();
});
test('same-team device cannot approve another owner request; code alone grants no control', async () => {
  const { b, a, d3 } = fixture();
  const r = await b.call(a, 'request_blender_pairing', { team_id: 'red' });
  assert.throws(() => b.approve(d3.id, String(r.structuredContent!.pairing_id), ['read']), /UNAUTHORIZED/);
  assert.throws(() => b.approve(d3.id, String(r.structuredContent!.code), ['read']), /UNAUTHORIZED/);
  await assert.rejects(b.call(a, 'blender_get_scene_info', {}), /NOT_PAIRED/); b.shutdown();
});
test('pairing single-use, expiry, capability narrowing', async () => {
  const f = fixture(); const l = await f.pair();
  const id = [...f.b.pairings.keys()][0]!;
  assert.throws(() => f.b.approve(f.d.id, id, ['read']), /PAIRING_USED/);
  await assert.rejects(f.b.call(f.a, 'blender_execute_code', { code: 'mock:add_cube' }), /CAPABILITY_DENIED/);
  await f.b.call(f.a, 'disconnect_blender', {});
  const r = await f.b.call(f.a, 'request_blender_pairing', { team_id: 'red' }); f.advance(101);
  assert.throws(() => f.b.approve(f.d.id, String(r.structuredContent!.pairing_id), ['read']), /PAIRING_EXPIRED/);
  assert.equal(l.active, false); f.b.shutdown();
});
test('second connection of same user conflicts and cannot inherit lease', async () => {
  const f = fixture(); await f.pair(); const second = f.b.open('alice');
  for (const tool of ['bridge_status', 'blender_get_scene_info', 'disconnect_blender'] as const) await assert.rejects(f.b.call(second, tool, {}), /SESSION_CONFLICT/);
  await assert.rejects(f.b.call(second, 'request_blender_pairing', { team_id: 'red' }), /SESSION_CONFLICT/);
  f.b.close(f.a); await assert.rejects(f.b.call(f.a, 'bridge_status', {}), /UNAUTHORIZED/); f.b.shutdown();
});
test('responses correlated to device, lease, epoch; spoofed responses ignored', async () => {
  const f = fixture(); const l = await f.pair();
  const call = f.b.call(f.a, 'blender_get_scene_info', {}); const r = f.messages.at(-1);
  f.b.respond(f.d2.id, r.request_id, l.id, l.epoch, jsonResult({ scene: 'wrong' }));
  f.b.respond(f.d.id, r.request_id, l.id, l.epoch + 1, jsonResult({ scene: 'wrong' }));
  f.b.respond(f.d.id, r.request_id, l.id, l.epoch, jsonResult({ scene: 'correct' }));
  assert.equal((await call).structuredContent!.scene, 'correct'); f.b.shutdown();
});
test('writes exclusive; disconnect marks execution uncertain; reconnect never replays', async () => {
  const f = fixture(); await f.pair(f.a, 'red', f.d.id, ['read', 'execute']);
  const first = f.b.call(f.a, 'blender_execute_code', { code: 'mock:add_cube' });
  await assert.rejects(f.b.call(f.a, 'blender_execute_code', { code: 'mock:add_cube' }), /DEVICE_BUSY/);
  const rejected = assert.rejects(first, /EXECUTION_UNCERTAIN/); f.b.disconnect(f.d.id); await rejected;
  const sent: unknown[] = []; f.b.connect(f.d.id, m => sent.push(m));
  await assert.rejects(f.b.call(f.a, 'blender_get_scene_info', {}), /NOT_PAIRED/);
  assert.equal(sent.length, 0); f.b.shutdown();
});
test('lease expiry, idle expiry and revoked memberships are checked each call', async () => {
  for (const reason of ['expiry', 'idle', 'membership', 'disabled']) {
    const f = fixture(); await f.pair();
    if (reason === 'expiry') f.advance(1001);
    if (reason === 'idle') f.advance(501);
    if (reason === 'membership') f.b.users.get('alice')!.teams = [];
    if (reason === 'disabled') f.b.users.get('alice')!.disabled = true;
    await assert.rejects(f.b.call(f.a, 'blender_get_scene_info', {}), /LEASE_EXPIRED|UNAUTHORIZED/); f.b.shutdown();
  }
});
test('read deadline revokes lease and late result is ignored', async () => {
  const f = fixture({ rpc: 10 }); await f.pair();
  await assert.rejects(f.b.call(f.a, 'blender_get_scene_info', {}), /REQUEST_TIMEOUT/);
  await assert.rejects(f.b.call(f.a, 'blender_get_scene_info', {}), /NOT_PAIRED/); f.b.shutdown();
});
test('tokens are hashed, expire, disabled users rejected, device credentials distinct', () => {
  const f = fixture(); const token = f.b.token('alice');
  assert.equal(f.b.authenticate(token), 'alice'); assert.throws(() => f.b.authenticate(f.d.credential), /UNAUTHORIZED/);
  assert.equal(f.b.authenticateDevice(f.d.credential).owner, 'alice');
  f.advance(3_600_001); assert.throws(() => f.b.authenticate(token), /UNAUTHORIZED/);
  f.b.revokeDevice(f.d.id); assert.throws(() => f.b.authenticateDevice(f.d.credential), /UNAUTHORIZED/); f.b.shutdown();
});
