import { createHash } from 'node:crypto';
import { PolicyError } from '../../packages/authorization/errors.js';
import { parseAdminCommand } from './socket.js';
import type { Auth0Provisioner,EnrollmentAdmin,InvitationSender,ProvisionRecord,ProvisionSummary,RosterRow,ProviderIdentity } from './types.js';

export function normalizeRosterEmail(email:string):string{
  if(typeof email!=='string')throw new PolicyError('INVALID_ROSTER');
  const trimmed=email.trim();const parts=trimmed.split('@');
  if(parts.length!==2||!parts[0]||!parts[1]||trimmed.length>320||/[\s\x00-\x1f\x7f]/.test(trimmed))throw new PolicyError('INVALID_ROSTER');
  return parts[0]+'@'+parts[1].toLowerCase();
}
export async function provisionRoster(rows:readonly RosterRow[],deps:{provider:Auth0Provisioner;local:EnrollmentAdmin;sender:InvitationSender;sendAuthorized:boolean}):Promise<ProvisionSummary>{
  const summary={persisted:0,sent:0,failed:0,uncertain:0,skipped:0};
  if(!Array.isArray(rows)||rows.length<1||rows.length>100)throw new PolicyError('INVALID_ROSTER');
  const validatedRows=rows.map(row=>{if(!row||typeof row!=='object'||Array.isArray(row))throw new PolicyError('INVALID_ROSTER');return{...row,email:normalizeRosterEmail(row.email)};});
  if(new Set(validatedRows.map(row=>row.id)).size!==validatedRows.length)throw new PolicyError('INVALID_ROSTER');
  parseAdminCommand({kind:'import-invites',invitations:validatedRows.map(row=>({...row,subject:row.subject??'unresolved-provider-subject'}))});
  for(const row of validatedRows){
    const email=normalizeRosterEmail(row.email);
    const rowHash=createHash('sha256').update(JSON.stringify({id:row.id,email,issuer:row.issuer,courseId:row.courseId,teamId:row.teamId,role:row.role,expiresAt:row.expiresAt})).digest('hex');
    let record=await deps.local.load(row.id);
    if(record&&(record.rowHash!==rowHash||(row.subject&&row.subject!==record.subject)))throw new PolicyError('PROVISIONING_CONFLICT');
    if(!record){
      const identity=await deps.provider.reconcile({email,...(row.subject?{subject:row.subject}:{})});
      if(identity.connection!=='email'||!identity.subject||identity.subject.length>256)throw new PolicyError('PROVIDER_IDENTITY_MISMATCH');
      const providerEmail=normalizeRosterEmail(identity.email);
      const confirmed=providerEmail===email||(row.subject===identity.subject&&providerEmail.toLowerCase()===email.toLowerCase());
      record={id:row.id,rowHash,subject:identity.subject,email,providerEmail,confirmed,phase:'subject-recorded'};
      await deps.local.save(record);
    }else{
      const identity=await deps.provider.reconcile({email,subject:record.subject});
      if(identity.subject!==record.subject||identity.connection!=='email')throw new PolicyError('PROVIDER_IDENTITY_MISMATCH');
      if(!record.confirmed&&row.subject===record.subject&&normalizeRosterEmail(identity.email).toLowerCase()===email.toLowerCase()){
        record={...record,confirmed:true};await deps.local.save(record);
      }
    }
    if(!record.confirmed)throw new PolicyError('PROVIDER_RECONCILIATION_REQUIRED');
    await deps.local.recordInvitation({...row,email,subject:record.subject});summary.persisted++;
    if(record.phase==='sent'){summary.skipped++;continue;}
    if(record.phase==='sending'||record.phase==='uncertain'){record={...record,phase:'uncertain'};await deps.local.save(record);summary.uncertain++;continue;}
    record={...record,phase:'persisted'};await deps.local.save(record);
    if(!deps.sendAuthorized){summary.skipped++;continue;}
    record={...record,phase:'sending'};await deps.local.save(record);
    let state:'sent'|'failed'|'uncertain';
    try{state=(await deps.sender.deliver({id:row.id,email})).state;}catch{state='uncertain';}
    if(!['sent','failed','uncertain'].includes(state))state='uncertain';
    await deps.local.save({...record,phase:state});summary[state]++;
  }
  return Object.freeze(summary);
}

type Auth0Options=Readonly<{
  origin:string;managementToken:string;
  /** Protected evidence reference from an authorized tenant test proving passwordless create sends no mail. */
  creationMailSuppressionEvidence?:string;
  fetch?:typeof globalThis.fetch;
}>;
export function createAuth0Provisioner(options:Auth0Options):Auth0Provisioner{
  const origin=new URL(options.origin);
  if(origin.protocol!=='https:'||origin.origin!==options.origin||origin.username||origin.password||!options.managementToken||/[\r\n]/.test(options.managementToken))throw new PolicyError('INVALID_PROVIDER_CONFIGURATION');
  const request=async(path:string,init:RequestInit={}):Promise<unknown>=>{
    try{
      const response=await(options.fetch??globalThis.fetch)(new URL(path,origin),{...init,headers:{Authorization:`Bearer ${options.managementToken}`,'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(5000)});
      if(!response.ok){await response.body?.cancel();throw new PolicyError(response.status===409?'PROVIDER_RECONCILIATION_REQUIRED':'PROVIDER_UNAVAILABLE');}
      const reader=response.body?.getReader();if(!reader)throw new PolicyError('PROVIDER_UNAVAILABLE');let length=0;const chunks:Uint8Array[]=[];
      while(true){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>65536){await reader.cancel();throw new PolicyError('PROVIDER_RESPONSE_TOO_LARGE');}chunks.push(next.value);}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch(error){throw error instanceof PolicyError?error:new PolicyError('PROVIDER_UNAVAILABLE');}
  };
  function identity(value:unknown):ProviderIdentity{
    const record=value as {user_id?:unknown;email?:unknown;identities?:{provider?:unknown;connection?:unknown}[]};
    if(!record||typeof record.user_id!=='string'||typeof record.email!=='string'||!Array.isArray(record.identities)||!record.identities.some(item=>item&&item.provider==='email'&&item.connection==='email'))throw new PolicyError('PROVIDER_IDENTITY_MISMATCH');
    return{subject:record.user_id,email:record.email,connection:'email'};
  }
  return{async reconcile(input){
    const email=normalizeRosterEmail(input.email);
    if(input.subject){const result=identity(await request('/api/v2/users/'+encodeURIComponent(input.subject)));if(result.subject!==input.subject)throw new PolicyError('PROVIDER_IDENTITY_MISMATCH');return result;}
    const result=await request('/api/v2/users-by-email?email='+encodeURIComponent(email));
    if(!Array.isArray(result))throw new PolicyError('PROVIDER_IDENTITY_MISMATCH');
    const candidates=result.filter(item=>Array.isArray(item?.identities)&&item.identities.some((entry:{provider?:unknown;connection?:unknown})=>entry&&entry.provider==='email'&&entry.connection==='email'));
    if(candidates.length>1)throw new PolicyError('PROVIDER_RECONCILIATION_REQUIRED');
    if(candidates.length===1)return identity(candidates[0]);
    if(!options.creationMailSuppressionEvidence?.trim())throw new PolicyError('PROVIDER_CREATE_NOT_VERIFIED');
    return identity(await request('/api/v2/users',{method:'POST',body:JSON.stringify({connection:'email',email,email_verified:false,verify_email:false})}));
  }};
}
