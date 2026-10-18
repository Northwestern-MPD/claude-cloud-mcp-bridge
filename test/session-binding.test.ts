import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VerifiedPrincipal } from '../packages/auth/types.js';
import type { ContextRef } from '../packages/storage/contexts.js';
import { resolveWorkBinding } from '../packages/authorization/session-binding.js';

const principal: VerifiedPrincipal = Object.freeze({ issuer: 'https://class.example.auth0.com/', subject: 'auth0|student',
  clientId: 'claude-client', scopes: Object.freeze(['identity:read']), issuedAt: 1_800_000_000_000,
  expiresAt: 1_800_000_600_000, emailVerified: true });
const context: ContextRef = Object.freeze({ id: 'context-a', userId: 'student', resource: 'https://identity.example/mcp',
  clientId: 'claude-client', bootId: 'boot', deploymentEpoch: 'epoch' });

test('verified individual identity does not establish independent cloud work authority', () => {
  assert.deepEqual(resolveWorkBinding({ principal, context }), { status: 'SESSION_ISOLATION_UNPROVEN' });
});

test('provider session claims and caller-asserted bindings cannot establish independent work authority', () => {
  const request = { principal: { ...principal, sid: 'provider-session', azp: 'claude-client' }, context,
    binding: { verified: true, chatId: 'claimed-chat', grant: 'claimed-grant' } };
  assert.deepEqual(resolveWorkBinding(request), { status: 'SESSION_ISOLATION_UNPROVEN' });
});

test('copied or newly generated MCP handles do not manufacture independent approved work', () => {
  for (const id of ['copied-context', 'new-random-context']) {
    assert.deepEqual(resolveWorkBinding({ principal, context: { ...context, id } }), { status: 'SESSION_ISOLATION_UNPROVEN' });
  }
});
