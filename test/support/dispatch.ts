import { createHash, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { policyFixture, POLICY_NOW } from './policy.js';
import { signingFixture } from './auth.js';
import { verifyAccessToken } from '../../packages/auth/verifier.js';
import { enrollDevice } from '../../packages/storage/devices.js';
import { createPairing, approvePairing } from '../../packages/storage/grants.js';
import { createIdentityRuntime } from '../../packages/authorization/runtime.js';
import type { VerifiedRequestAuth } from '../../packages/auth/types.js';
import type { OperationInput, OperationRef } from '../../packages/storage/operations.js';

export async function dispatchFixture(t: TestContext, cutoff = 0) {
  const f = await policyFixture(t);
  let context = f.context;
  if (cutoff) {
    f.options.tokenIatAfter = cutoff;
    await f.reopen();
    context = { ...f.context, id: randomUUID(), bootId: f.store.bootId };
    await f.db.admin.query("INSERT INTO mpd_identity.work_contexts(id,user_id,resource,client_id,binding_provenance,binding_id,boot_id,deployment_epoch,state,expires_at) VALUES ($1,$2,$3,$4,'local-test-harness',$5,$6,$7,'active',$8)", [context.id, context.userId, context.resource, context.clientId, randomUUID(), context.bootId, context.deploymentEpoch, POLICY_NOW + 7_200_000]);
  }
  const device = await enrollDevice(f.store, { ownerId: f.userId, name: 'Dispatch test laptop' }, f.clock);
  await f.online(device.deviceId);
  const pair = await createPairing(f.store, { context, teamId: f.teamId, capabilities: ['read', 'execute'] }, f.clock);
  const lease = await approvePairing(f.store, { pairingId: pair.pairingId, deviceId: device.deviceId, capabilities: ['read', 'execute'] }, f.clock);
  const runtime = createIdentityRuntime(f.store);
  let closed = 0;
  runtime.registerContext(context, [f.teamId], () => { closed++; });
  t.after(() => runtime.close());
  const sent: OperationRef[] = [];
  const transport = { enqueue(operation: OperationRef) { sent.push(operation); } };
  const signing = await signingFixture(POLICY_NOW);
  async function request(overrides: Record<string, unknown> = {}): Promise<VerifiedRequestAuth> {
    const token = await signing.mint(overrides);
    return Object.freeze({ principal: await verifyAccessToken(token, signing.config, signing), resource: signing.config.resource, tokenFingerprint: createHash('sha256').update(token).digest('hex') });
  }
  const input: OperationInput = { auth: f.auth, context, leaseId: lease.id, tool: 'blender_execute_code', write: true, clock: f.clock };
  return { ...f, get store() { return f.store; }, context, device, lease, runtime, sent, transport, input, request,
    get closed() { return closed; }, deps: { store: f.store, coordinator: runtime.coordinator, transport } };
}

export function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
