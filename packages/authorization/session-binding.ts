import type { VerifiedPrincipal } from '../auth/types.js';
import type { ContextRef } from '../storage/contexts.js';

/** Native per-work credentials need observed, integrity-protected client support before this can change. */
export function resolveWorkBinding(_input: { principal: VerifiedPrincipal; context: ContextRef }): { status: 'SESSION_ISOLATION_UNPROVEN' } {
  return { status: 'SESSION_ISOLATION_UNPROVEN' };
}
