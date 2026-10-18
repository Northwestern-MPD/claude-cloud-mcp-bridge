import type { Store } from '../storage/types.js';
import type { ContextRef } from '../storage/contexts.js';

export type DispatchCoordinator = { withFence<T>(action: () => Promise<T>): Promise<T> };
export type Invalidation = { userId?: string; deviceId?: string; contextId?: string; teamId?: string };
export type RuntimeInvalidator = { invalidate(input: Invalidation): void };
export type IdentityRuntime = RuntimeInvalidator & {
  coordinator: DispatchCoordinator;
  registerContext(context: ContextRef, teamIds: readonly string[], close: () => void): () => void;
  isActive(contextId: string): boolean;
  close(): void;
};

/** One instance serializes admission and admin revocation; callers acquire it exactly once. */
export function createDispatchCoordinator(): DispatchCoordinator {
  let tail: Promise<unknown> = Promise.resolve();
  return Object.freeze({
    withFence<T>(action: () => Promise<T>): Promise<T> {
      const result = tail.then(action);
      tail = result.catch(() => undefined);
      return result;
    },
  });
}

export function createIdentityRuntime(store: Store): IdentityRuntime {
  const contexts = new Map<string, { context: ContextRef; teams: readonly string[]; close: () => void }>();
  let active = true;
  const coordinator = createDispatchCoordinator();
  function invalidate(input: Invalidation): void {
    for (const [id, registration] of contexts) {
      if (input.contextId && id !== input.contextId) continue;
      if (input.userId && registration.context.userId !== input.userId) continue;
      if (input.teamId && !registration.teams.includes(input.teamId)) continue;
      contexts.delete(id);
      try { registration.close(); } catch { /* Invalidated authority stays removed if a transport fails to close. */ }
    }
  }
  const unsubscribe = store.onUnavailable(() => { active = false; invalidate({}); });
  return Object.freeze({
    coordinator, invalidate,
    registerContext(context: ContextRef, teamIds: readonly string[], close: () => void) {
      if (!active) throw new Error('STORE_UNAVAILABLE');
      contexts.set(context.id, { context, teams: Object.freeze([...teamIds]), close });
      return () => { contexts.delete(context.id); };
    },
    isActive(contextId: string) { return active && contexts.has(contextId); },
    close() { active = false; unsubscribe(); invalidate({}); },
  });
}
