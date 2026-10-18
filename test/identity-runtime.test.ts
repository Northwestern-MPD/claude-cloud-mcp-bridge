import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDispatchCoordinator } from '../packages/authorization/runtime.js';

// Break caught: admission and administrative revocation overlap or a rejected task poisons the shared fence.
test('dispatch coordinator holds one fence through awaited work and continues after rejection', async () => {
  const coordinator = createDispatchCoordinator();
  const events: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const first = coordinator.withFence(async () => { events.push('admit-start'); await blocked; events.push('admit-end'); throw new Error('denied'); });
  const failed = assert.rejects(first, /denied/);
  const revoke = coordinator.withFence(async () => { events.push('revoke'); return 'revoked'; });
  await Promise.resolve();
  assert.deepEqual(events, ['admit-start']);
  release();
  await failed;
  assert.equal(await revoke, 'revoked');
  assert.deepEqual(events, ['admit-start', 'admit-end', 'revoke']);
});
