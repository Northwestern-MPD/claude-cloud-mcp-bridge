import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { BridgeError, fail, toolInputs, jsonResult, type Result, type Capability, type Tool } from './protocol.js';
export type User = { id: string; teams: string[]; disabled?: boolean };
export type Context = { user: string; connection: string };
export type Device = { id: string; owner: string; name: string; epoch: number; send?: (message: unknown) => void };
export type Pairing = { id: string; code: string; context: Context; team: string; capabilities: Capability[]; expires: number; state: 'pending' | 'approved' | 'revoked' };
export type Lease = { id: string; context: Context; team: string; device: string; capabilities: Capability[]; expires: number; idle: number; epoch: number; active: boolean };
type Pending = { device: string; lease: string; epoch: number; write: boolean; timer: ReturnType<typeof setTimeout>; resolve: (r: Result) => void; reject: (e: Error) => void };
export const secret = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** In-memory mock policy engine. Restart discards credentials, connections and grants. */
export class Bridge {
  readonly users = new Map<string, User>();
  readonly devices = new Map<string, Device>();
  readonly pairings = new Map<string, Pairing>();
  readonly leases = new Map<string, Lease>();
  readonly audit: { time: number; action: string; outcome: string }[] = [];
  private tokens = new Map<string, { user: string; expires: number }>();
  private deviceTokens = new Map<string, string>();
  private connections = new Map<string, string>();
  private pending = new Map<string, Pending>();
  private writes = new Set<string>();
  constructor(readonly clock = Date.now, readonly pairingMs = 300_000, readonly leaseMs = 3_600_000, readonly idleMs = 600_000, readonly rpcMs = 30_000) {}
  provision(user: User) { this.users.set(user.id, user); }
  private user(id: string) { const u = this.users.get(id); if (!u || u.disabled) return fail('UNAUTHORIZED'); return u; }
  token(user: string) { this.user(user); const token = secret(); this.tokens.set(hash(token), { user, expires: this.clock() + 3_600_000 }); return token; }
  authenticate(token: string) { const t = this.tokens.get(hash(token)); if (!t || t.expires <= this.clock()) return fail('UNAUTHORIZED'); this.user(t.user); return t.user; }
  open(user: string): Context { this.user(user); const connection = randomUUID(); this.connections.set(connection, user); return { user, connection }; }
  close(c: Context) { this.connections.delete(c.connection); for (const p of this.pairings.values()) if (p.context.connection === c.connection) p.state = 'revoked'; for (const l of this.leases.values()) if (l.context.connection === c.connection) this.revoke(l); }
  private context(c: Context) { if (this.connections.get(c.connection) !== c.user) return fail('UNAUTHORIZED'); return this.user(c.user); }
  enroll(owner: string, name: string) { this.user(owner); if (!name || name.length > 80) return fail('INVALID_INPUT'); const id = randomUUID(), credential = secret(); this.devices.set(id, { id, owner, name, epoch: 0 }); this.deviceTokens.set(hash(credential), id); return { id, credential }; }
  authenticateDevice(token: string) { const d = this.devices.get(this.deviceTokens.get(hash(token)) ?? ''); if (!d) return fail('UNAUTHORIZED'); this.user(d.owner); return d; }
  connect(device: string, send: (message: unknown) => void) { const d = this.devices.get(device) ?? fail('UNAUTHORIZED'); this.user(d.owner); if (d.send) return fail('DEVICE_ALREADY_CONNECTED'); d.epoch++; d.send = send; }
  disconnect(device: string) { const d = this.devices.get(device); if (!d) return; d.send = undefined; d.epoch++; for (const l of this.leases.values()) if (l.device === device) this.revoke(l); }
  revokeDevice(device: string) { this.disconnect(device); for (const [k, v] of this.deviceTokens) if (v === device) this.deviceTokens.delete(k); }
  private event(action: string, outcome = 'ok') { this.audit.push({ time: this.clock(), action, outcome }); if (this.audit.length > 1000) this.audit.shift(); }
  private valid(l: Lease) { return l.active && l.expires > this.clock() && l.idle > this.clock(); }
  private revoke(l: Lease) {
    if (!l.active) return; l.active = false;
    this.devices.get(l.device)?.send?.({ type: 'revoked', lease_id: l.id });
    for (const [id, p] of this.pending) if (p.lease === l.id) { clearTimeout(p.timer); this.pending.delete(id); p.reject(new BridgeError(p.write ? 'EXECUTION_UNCERTAIN' : 'NOT_PAIRED')); }
    this.event('lease_revoked');
  }
  sweep() { for (const l of this.leases.values()) if (!this.valid(l)) this.revoke(l); }
  private lease(c: Context) {
    const l = [...this.leases.values()].find(l => l.active && l.context.user === c.user);
    if (!l) return fail('NOT_PAIRED');
    if (l.context.connection !== c.connection) return fail('SESSION_CONFLICT');
    if (!this.valid(l)) { this.revoke(l); return fail('LEASE_EXPIRED'); }
    const d = this.devices.get(l.device) ?? fail('DEVICE_OFFLINE');
    if (!d.send || d.epoch !== l.epoch) { this.revoke(l); return fail('DEVICE_OFFLINE'); }
    if (d.owner !== c.user || !this.user(d.owner).teams.includes(l.team) || !this.user(c.user).teams.includes(l.team)) { this.revoke(l); return fail('UNAUTHORIZED'); }
    return { l, d };
  }
  approve(device: string, pairing: string, capabilities: Capability[]) {
    this.sweep(); const d = this.devices.get(device) ?? fail('UNAUTHORIZED'); const p = this.pairings.get(pairing) ?? fail('UNAUTHORIZED');
    if (!d.send) return fail('DEVICE_OFFLINE');
    this.context(p.context);
    if (p.state !== 'pending') return fail('PAIRING_USED');
    if (p.expires <= this.clock()) return fail('PAIRING_EXPIRED');
    if (d.owner !== p.context.user || !this.user(d.owner).teams.includes(p.team)) return fail('UNAUTHORIZED');
    if (!capabilities.length || capabilities.some(c => !p.capabilities.includes(c))) return fail('CAPABILITY_DENIED');
    if ([...this.leases.values()].some(l => this.valid(l) && (l.device === d.id || l.context.user === p.context.user))) return fail('SESSION_CONFLICT');
    p.state = 'approved';
    const l: Lease = { id: randomUUID(), context: p.context, team: p.team, device: d.id, capabilities: [...new Set(capabilities)], expires: this.clock() + this.leaseMs, idle: this.clock() + this.idleMs, epoch: d.epoch, active: true };
    this.leases.set(l.id, l); d.send({ type: 'lease', pairing_id: p.id, lease: l }); this.event('lease_approved'); return l;
  }
  localRevoke(device: string) { for (const l of this.leases.values()) if (l.device === device) this.revoke(l); }
  async call(c: Context, name: Tool, input: unknown): Promise<Result> {
    const user = this.context(c); const args = toolInputs[name].safeParse(input); if (!args.success) return fail('INVALID_INPUT');
    this.event(name);
    if (name === 'bridge_status') {
      const active = [...this.leases.values()].find(l => this.valid(l) && l.context.user === c.user);
      if (active && active.context.connection !== c.connection) return fail('SESSION_CONFLICT');
      return jsonResult({ user_id: user.id, paired: !!active, capabilities: active?.capabilities ?? [], expires_at: active?.expires ?? null, idle_expires_at: active?.idle ?? null });
    }
    if (name === 'request_blender_pairing') {
      this.sweep(); const a = args.data as { team_id: string; capabilities: Capability[] };
      if (!user.teams.includes(a.team_id)) return fail('UNAUTHORIZED');
      if ([...this.leases.values()].some(l => this.valid(l) && l.context.user === c.user)) return fail('SESSION_CONFLICT');
      if ([...this.pairings.values()].some(p => p.state === 'pending' && p.expires > this.clock() && p.context.user === c.user)) return fail('PAIRING_PENDING');
      const p: Pairing = { id: randomUUID(), code: randomBytes(6).toString('hex').toUpperCase(), context: c, team: a.team_id, capabilities: [...new Set(a.capabilities)], expires: this.clock() + this.pairingMs, state: 'pending' };
      this.pairings.set(p.id, p);
      for (const d of this.devices.values()) if (d.owner === c.user) d.send?.({ type: 'pairing', pairing: p });
      return jsonResult({ pairing_id: p.id, code: p.code, expires_at: p.expires, status: 'LOCAL_APPROVAL_REQUIRED' });
    }
    const { l, d } = this.lease(c);
    if (name === 'disconnect_blender') { this.revoke(l); return jsonResult({ status: 'REVOKED' }); }
    const write = name === 'blender_execute_code';
    if (!l.capabilities.includes(write ? 'execute' : 'read')) return fail('CAPABILITY_DENIED');
    if (write && this.writes.has(d.id)) return fail('DEVICE_BUSY');
    if (write) this.writes.add(d.id);
    l.idle = this.clock() + this.idleMs;
    try {
      return await new Promise<Result>((resolve, reject) => {
        const id = randomUUID(); const timer = setTimeout(() => {
          this.pending.delete(id); this.revoke(l); reject(new BridgeError(write ? 'EXECUTION_UNCERTAIN' : 'REQUEST_TIMEOUT'));
        }, this.rpcMs);
        this.pending.set(id, { device: d.id, lease: l.id, epoch: l.epoch, write, timer, resolve, reject });
        try { d.send!({ type: 'request', request_id: id, device_id: d.id, lease_id: l.id, epoch: l.epoch, tool: name, args: args.data, deadline: this.clock() + this.rpcMs }); }
        catch { clearTimeout(timer); this.pending.delete(id); this.disconnect(d.id); reject(new BridgeError(write ? 'EXECUTION_UNCERTAIN' : 'DEVICE_OFFLINE')); }
      });
    } finally { if (write) this.writes.delete(d.id); }
  }
  respond(device: string, id: string, lease: string, epoch: number, result: Result) {
    const p = this.pending.get(id); if (!p || p.device !== device || p.lease !== lease || p.epoch !== epoch) return;
    const l = this.leases.get(lease); if (!l || !this.valid(l)) { if (l) this.revoke(l); return; }
    this.pending.delete(id); clearTimeout(p.timer); p.resolve(result);
  }
  shutdown() { for (const d of this.devices.values()) this.disconnect(d.id); }
}
