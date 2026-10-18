import { randomUUID } from 'node:crypto';
import type { OpenStoreOptions, Transaction } from './types.js';

/** Invoked only after the dedicated connection has acquired exclusive runtime ownership. */
export async function recoverStartup(transaction: Transaction, options: OpenStoreOptions): Promise<string> {
  const state = await transaction.query('SELECT deployment_epoch,token_iat_after FROM mpd_identity.service_state WHERE singleton=true FOR UPDATE');
  const stored = state.rows[0];
  if (!stored) throw new Error('STORE_NOT_INITIALIZED');
  if (BigInt(options.tokenIatAfter)<BigInt(stored.token_iat_after)) throw new Error('TOKEN_IAT_AFTER_DECREASE');
  const changed = stored.deployment_epoch!==options.deploymentEpoch;
  if (changed && !options.maintenance) throw new Error('RECOVERY_MAINTENANCE_REQUIRED');
  if (changed && BigInt(options.tokenIatAfter)<=BigInt(stored.token_iat_after)) throw new Error('RECOVERY_TOKEN_IAT_AFTER_REQUIRED');
  const bootId = randomUUID();
  const now = options.now();
  if (!Number.isSafeInteger(now) || now<0) throw new Error('INVALID_CLOCK');
  await transaction.query("UPDATE mpd_identity.work_contexts SET state='revoked',revoked_at=$1 WHERE state='active'",[now]);
  await transaction.query("UPDATE mpd_identity.pairings SET state='revoked',revoked_at=$1 WHERE state='pending'",[now]);
  await transaction.query("UPDATE mpd_identity.leases SET state='revoked',reason='startup',terminated_at=$1 WHERE state='active'",[now]);
  await transaction.query('UPDATE mpd_identity.devices SET online=false,connection_epoch=connection_epoch+1,updated_at=$1',[now]);
  await transaction.query("UPDATE mpd_identity.operation_attempts SET state='uncertain',reason='startup',completed_at=$1 WHERE state IN ('admitted','dispatched') AND classification='write'",[now]);
  await transaction.query("UPDATE mpd_identity.operation_attempts SET state='denied',reason='startup',completed_at=$1 WHERE state IN ('admitted','dispatched') AND classification='read'",[now]);
  if (changed) {
    await transaction.query("UPDATE mpd_identity.users SET status='suspended',authorization_version=authorization_version+1,updated_at=$1 WHERE status IN ('pending','active')",[now]);
    await transaction.query("UPDATE mpd_identity.memberships SET status='suspended',version=version+1,updated_at=$1 WHERE status IN ('pending','active')",[now]);
    await transaction.query("UPDATE mpd_identity.invitations SET status='revoked' WHERE status='pending'");
    await transaction.query('UPDATE mpd_identity.device_credentials SET revoked_at=$1 WHERE revoked_at IS NULL',[now]);
  }
  await transaction.query('UPDATE mpd_identity.service_state SET boot_id=$1,deployment_epoch=$2,token_iat_after=$3,maintenance=maintenance OR $4,updated_at=$5 WHERE singleton=true',[bootId,options.deploymentEpoch,options.tokenIatAfter,options.maintenance,now]);
  return bootId;
}
