import { randomUUID } from 'node:crypto';
import { enrollInvitation } from '../../packages/storage/enrollment.js';
import { reconcileRoster } from '../../packages/storage/recovery.js';
import { closeCourse,runRetention } from '../../packages/storage/retention.js';
import { revokeAuthorization } from '../../packages/storage/revocations.js';
import type { Store } from '../../packages/storage/types.js';
import type { DispatchCoordinator,IdentityRuntime } from '../../packages/authorization/runtime.js';
import { PolicyError,policyError } from '../../packages/authorization/errors.js';
import { parseAdminCommand } from './socket.js';
import type { AdminCommand,AdminResult } from './types.js';

export async function executeAdmin(command:AdminCommand,deps:{store:Store;runtime:IdentityRuntime;coordinator:DispatchCoordinator;now():number}):Promise<AdminResult>{
  const input=parseAdminCommand(command);
  if(deps.coordinator!==deps.runtime.coordinator)throw new PolicyError('COORDINATOR_MISMATCH');
  if(input.kind==='reconcile-roster'){
    const result=await reconcileRoster(deps.store,input.manifest,deps.runtime,deps.now);
    return{ok:true,affected:result.activated};
  }
  // Delegated revocation owns the same non-reentrant fence. Never wrap it again.
  if(input.kind!=='import-invites'&&input.kind!=='maintenance'&&input.kind!=='retention'&&input.kind!=='close-course'){
    await revokeAuthorization(deps.store,input,deps.runtime,deps.coordinator,deps.now);
    return{ok:true,affected:1};
  }
  return deps.coordinator.withFence(async()=>{
    try{
      const now=deps.now();if(!Number.isSafeInteger(now)||now<0)throw new PolicyError('INVALID_CLOCK');
      if(input.kind==='retention'){
        const result=await runRetention(deps.store,deps.now);
        return{ok:true,affected:result.auditEvents+result.tokenDenials+result.rosterEmails};
      }
      if(input.kind==='close-course'){
        const result=await closeCourse(deps.store,input.courseId,deps.now);
        for(const teamId of result.teamIds)deps.runtime.invalidate({teamId});
        return{ok:true,affected:result.affected};
      }
      if(input.kind==='import-invites'){
        for(const invitation of input.invitations)await enrollInvitation(deps.store,invitation,deps.now);
        return{ok:true,affected:input.invitations.length};
      }
      try{await deps.store.setMaintenance(input.enabled);}catch(error){if((error as Error).message==='EXTERNAL_MAINTENANCE')throw new PolicyError('EXTERNAL_MAINTENANCE');throw error;}
      await deps.store.transaction(async tx=>{
        if(input.enabled){
          await tx.query("UPDATE mpd_identity.work_contexts SET state='revoked',revoked_at=$1 WHERE state='active'",[now]);
          await tx.query("UPDATE mpd_identity.pairings SET state='revoked',revoked_at=$1 WHERE state='pending'",[now]);
          await tx.query("UPDATE mpd_identity.leases SET state='revoked',reason='maintenance',terminated_at=$1 WHERE state='active'",[now]);
          await tx.query("UPDATE mpd_identity.operation_attempts SET state='uncertain',reason='maintenance',completed_at=$1 WHERE classification='write' AND state IN ('admitted','dispatched')",[now]);
        }
        await tx.query("INSERT INTO mpd_identity.audit_events(id,occurred_at,action,outcome,reason) VALUES($1,$2,'maintenance','allowed',$3)",[randomUUID(),now,input.enabled?'enabled':'disabled']);
      });
      if(input.enabled)deps.runtime.invalidate({});
      return{ok:true,affected:1};
    }catch(error){throw policyError(error);}
  });
}
