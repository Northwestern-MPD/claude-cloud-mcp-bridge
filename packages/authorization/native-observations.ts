import { createHmac, randomBytes } from 'node:crypto';
import type { VerifiedRequestAuth } from '../auth/types.js';
import { PolicyError } from './errors.js';

export type NativeObservation = Readonly<{
  reference: string; token: string; principal: string; context: string | null;
  outcome: 'allowed' | 'denied'; ageMs: number; expiresInMs: number;
}>;
type RecordEntry = { reference: string; token: string; principal: string; context: string | null; outcome: 'allowed' | 'denied'; observedAt: number; fingerprint: string; resource: string; expiresAt: number };
export type NativeObservations = ReturnType<typeof createNativeObservations>;

/** Private, process-local evidence from the verified HTTP boundary. Never stores a bearer. */
export function createNativeObservations(clock: () => number) {
  const secret = randomBytes(32);
  let records: RecordEntry[] = [];
  let closed = false;
  let cleanup: ReturnType<typeof setTimeout> | undefined;
  const correlate = (kind: string, value: string) => createHmac('sha256', secret).update(JSON.stringify([kind, value])).digest('hex').slice(0, 16);
  function scheduleCleanup(now: number): void {
    clearTimeout(cleanup); cleanup = undefined;
    if (closed || records.length === 0) return;
    const deadline = Math.min(...records.map(row => Math.min(row.observedAt + 300_000, row.expiresAt)));
    cleanup = setTimeout(() => prune(clock()), Math.max(1, deadline - now));
    cleanup.unref();
  }
  function prune(now: number) {
    records = records.filter(row => row.observedAt + 300_000 > now && row.expiresAt > now);
    scheduleCleanup(now);
  }
  return {
    record(auth: VerifiedRequestAuth, outcome: 'allowed' | 'denied', context?: string): void {
      if (closed) return;
      const now = clock(); prune(now);
      if (auth.principal.expiresAt <= now) return;
      records.push({ reference: randomBytes(16).toString('hex'), token: correlate('token', auth.tokenFingerprint), principal: correlate('principal', JSON.stringify([auth.principal.issuer, auth.principal.subject])), context: context ? correlate('context', context) : null, outcome, observedAt: now, fingerprint: auth.tokenFingerprint, resource: auth.resource, expiresAt: auth.principal.expiresAt });
      if (records.length > 64) records.shift();
      scheduleCleanup(now);
    },
    report(): readonly NativeObservation[] {
      const now = clock(); prune(now);
      return records.slice(-8).map(row => ({ reference: row.reference, token: row.token, principal: row.principal, context: row.context, outcome: row.outcome, ageMs: Math.max(0, now - row.observedAt), expiresInMs: row.expiresAt - now }));
    },
    resolve(reference: string): Readonly<{ fingerprint: string; resource: string; expiresAt: number }> {
      prune(clock());
      const row = records.find(entry => entry.reference === reference);
      if (!row) throw new PolicyError('OBSERVATION_UNAVAILABLE');
      return { fingerprint: row.fingerprint, resource: row.resource, expiresAt: row.expiresAt };
    },
    close(): void { closed = true; clearTimeout(cleanup); cleanup = undefined; records = []; secret.fill(0); },
  };
}
