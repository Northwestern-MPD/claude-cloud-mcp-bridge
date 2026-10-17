import WebSocket from 'ws';
import { z } from 'zod';
import { MAX_FRAME, capability, id, toolName, toolInputs, jsonResult, type Result, type Capability } from '../../packages/protocol.js';
import type { Lease, Pairing } from '../../packages/core.js';
const leaseSchema = z.object({ id, device: id, epoch: z.number().int(), expires: z.number(), capabilities: z.array(capability) });
const requestSchema = z.object({ type: z.literal('request'), request_id: id, device_id: id, lease_id: id, epoch: z.number().int(), tool: toolName, args: z.unknown(), deadline: z.number() }).strict();
export interface Adapter { call(tool: string, args: Record<string, unknown>): Promise<Result>; }
/** Deterministic fake. Never interprets Python or invokes a shell. */
export class FakeBlender implements Adapter {
  objects = ['Cube'];
  constructor(readonly label = 'Mock Blender') {}
  async call(tool: string, args: Record<string, unknown>): Promise<Result> {
    if (tool === 'blender_get_scene_info') return jsonResult({ scene: this.label, objects: this.objects });
    if (tool === 'blender_get_object_info') return jsonResult({ name: args.name, exists: this.objects.includes(String(args.name)) });
    if (tool === 'blender_get_viewport_screenshot') return { content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8XkAAAAASUVORK5CYII=' }] };
    if (tool === 'blender_execute_code' && args.code === 'mock:add_cube') { this.objects.push(`Cube.${this.objects.length}`); return jsonResult({ objects: this.objects }); }
    return { ...jsonResult({ error: 'MOCK_UNSUPPORTED' }), isError: true };
  }
}
export async function connectDevice(options: {
  url: string; credential: string; deviceId: string; owner: string; adapter: Adapter;
  approvePairing: (p: Pairing) => Promise<Capability[] | false>;
  approveCode: (code: string) => Promise<boolean>;
}) {
  const url = new URL(options.url);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.pathname !== '/agent' || url.search) throw new Error('Mock connector requires loopback ws://127.0.0.1:<port>/agent');
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${options.credential}` }, maxPayload: MAX_FRAME });
  let enabled = true; let lease: z.infer<typeof leaseSchema> | undefined; let busy = false;
  const seen = new Set<string>();
  const approved = new Map<string, { capabilities: Capability[]; expires: number }>();
  const send = (msg: unknown) => { if (enabled && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
  ws.on('message', async data => {
    try {
      const msg = JSON.parse(data.toString());
      if (!enabled) return;
      if (msg.type === 'pairing') {
        const p = msg.pairing as Pairing;
        if (p.context.user !== options.owner || p.expires <= Date.now()) return;
        const caps = await options.approvePairing(p);
        if (!caps || !enabled || p.expires <= Date.now() || caps.some(c => !p.capabilities.includes(c))) return;
        approved.set(p.id, { capabilities: caps, expires: p.expires });
        send({ type: 'approve', pairing_id: p.id, capabilities: caps }); return;
      }
      if (msg.type === 'lease') {
        const l = leaseSchema.parse(msg.lease);
        // Lease must correspond to a pairing this connector approved, not just an unsolicited relay packet.
        const consent = approved.get(msg.pairing_id);
        if (!consent || consent.expires <= Date.now() || !l.capabilities.every(c => consent.capabilities.includes(c)) || l.device !== options.deviceId || l.expires <= Date.now()) return;
        lease = l; approved.clear(); return;
      }
      if (msg.type === 'revoked') { if (lease?.id === msg.lease_id) lease = undefined; return; }
      if (msg.type !== 'request') return;
      const r = requestSchema.parse(msg); const l = lease;
      const respond = (result: Result) => send({ type: 'result', request_id: r.request_id, lease_id: r.lease_id, epoch: r.epoch, result });
      const error = (error: string) => respond({ ...jsonResult({ error }), isError: true });
      const valid = () => enabled && lease === l && l && l.device === r.device_id && l.id === r.lease_id && l.epoch === r.epoch && l.expires > Date.now() && r.deadline > Date.now();
      if (!valid() || seen.has(r.request_id)) return error('NOT_PAIRED');
      seen.add(r.request_id); if (seen.size > 10000) { enabled = false; ws.close(); return; }
      const write = r.tool === 'blender_execute_code';
      if (!l!.capabilities.includes(write ? 'execute' : 'read')) return error('CAPABILITY_DENIED');
      const args = toolInputs[r.tool].parse(r.args) as Record<string, unknown>;
      if (busy) return error('DEVICE_BUSY'); busy = true;
      try {
        if (write && !await options.approveCode(String(args.code))) return error('LOCAL_APPROVAL_DENIED');
        if (!valid()) return error('NOT_PAIRED');
        const result = await options.adapter.call(r.tool, args);
        if (Buffer.byteLength(JSON.stringify(result)) > MAX_FRAME - 1024) return error('RESULT_TOO_LARGE');
        if (valid()) respond(result);
      } finally { busy = false; }
    } catch { /* Malformed relay packets never invoke the adapter. */ }
  });
  ws.on('close', () => { enabled = false; lease = undefined; approved.clear(); });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('error', () => { enabled = false; lease = undefined; });
  return { disconnect: () => { enabled = false; lease = undefined; ws.close(); }, ws };
}
