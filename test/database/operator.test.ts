import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, stat, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { operatorFixture, socketRequest, OPERATOR_NOW } from '../support/operator.js';
import { createIdentityRuntime, createDispatchCoordinator } from '../../packages/authorization/runtime.js';
import type { AdminCommand, Auth0Provisioner, InvitationSender, ProvisionRecord } from '../../apps/operator/types.js';

import { provisionRoster } from '../../apps/operator/provision.js';
import { executeAdmin } from '../../apps/operator/commands.js';
import { startAdminSocket,parseAdminCommand } from '../../apps/operator/socket.js';
import * as main from '../../apps/operator/main.js';

async function deadline<T>(task:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([task,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('ADMIN_FENCE_TIMEOUT')),1500);})]);}finally{if(timer)clearTimeout(timer);}}

function fakeProvider() {
  let creates=0;const subjects=new Map<string,string>();const requests:{email:string;subject?:string}[]=[];
  const provider:Auth0Provisioner={async reconcile(input){requests.push(input);let subject=input.subject??subjects.get(input.email);if(!subject){creates++;subject=`email|student-${creates}`;subjects.set(input.email,subject);}return{subject,email:input.email,connection:'email'};}};
  return{provider,requests,get creates(){return creates;}};
}

test('provider success and local failure retry exact subject without premature mail or duplicate authority',async()=>{
  const f=await operatorFixture();const remote=fakeProvider();let mail=0;
  const sender:InvitationSender={async deliver(){mail++;return{state:'sent'};}};
  try{
    f.setFailLocal(true);
    await assert.rejects(provisionRoster([f.row],{provider:remote.provider,local:f.local,sender,sendAuthorized:true}),/STORE_UNAVAILABLE/);
    assert.equal(mail,0);assert.equal(remote.creates,1);assert.equal(f.records.get(f.row.id)?.subject,'email|student-1');
    f.setFailLocal(false);
    const result=await provisionRoster([f.row],{provider:remote.provider,local:f.local,sender,sendAuthorized:true});
    assert.equal(result.sent,1);assert.equal(mail,1);assert.equal(remote.creates,1);
    assert.equal(remote.requests[1]?.subject,'email|student-1');
    assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.invitations')).rows[0].count,'1');
    const {activateEnrollment}=await import('../../packages/storage/enrollment.js');
    const principal={issuer:f.row.issuer,subject:'email|student-1',clientId:'client',scopes:['identity:read'],issuedAt:OPERATOR_NOW-1000,expiresAt:OPERATOR_NOW+600000,emailVerified:true as const};
    await activateEnrollment(f.store,principal,()=>OPERATOR_NOW);
    await activateEnrollment(f.store,principal,()=>OPERATOR_NOW);
    assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.memberships')).rows[0].count,'1');
    await provisionRoster([f.row],{provider:remote.provider,local:f.local,sender,sendAuthorized:true});
    assert.equal(mail,1);
  }finally{await f.close();}
});

test('unauthorized send delivers zero mail; uncertain delivery never retries automatically',async()=>{
  const f=await operatorFixture();const remote=fakeProvider();let mail=0;
  const sender:InvitationSender={async deliver(){mail++;return{state:'uncertain'};}};
  try{
    await provisionRoster([f.row],{provider:remote.provider,local:f.local,sender,sendAuthorized:false});assert.equal(mail,0);
    const first=await provisionRoster([f.row],{provider:remote.provider,local:f.local,sender,sendAuthorized:true});assert.equal(first.uncertain,1);
    const second=await provisionRoster([f.row],{provider:remote.provider,local:f.local,sender,sendAuthorized:true});assert.equal(second.uncertain,1);assert.equal(mail,1);
  }finally{await f.close();}
});

test('sending manifest after interrupted delivery is uncertain and roster conflicts cannot remap identity',async()=>{
  const f=await operatorFixture();const remote=fakeProvider();let mail=0;
  const sender:InvitationSender={async deliver(){mail++;return{state:'sent'};}};
  try{
    await provisionRoster([f.row],{provider:remote.provider,local:f.local,sender,sendAuthorized:false});
    const record=f.records.get(f.row.id)!;f.records.set(f.row.id,{...record,phase:'sending'});
    assert.equal((await provisionRoster([f.row],{provider:remote.provider,local:f.local,sender,sendAuthorized:true})).uncertain,1);assert.equal(mail,0);
    await assert.rejects(provisionRoster([{...f.row,email:'Studentsection@example.edu'}],{provider:remote.provider,local:f.local,sender,sendAuthorized:true}),/PROVISIONING_CONFLICT/);
  }finally{await f.close();}
});

test('provider email normalization requires explicit same-subject operator reconciliation',async()=>{
  const f=await operatorFixture();
  const provider:Auth0Provisioner={async reconcile(){return{subject:'email|normalized',email:'student+section@example.edu',connection:'email'};}};
  const sender:InvitationSender={async deliver(){throw new Error('unexpected mail');}};
  try{
    await assert.rejects(provisionRoster([f.row],{provider,local:f.local,sender,sendAuthorized:false}),/PROVIDER_RECONCILIATION_REQUIRED/);
    await assert.rejects(provisionRoster([f.row],{provider,local:f.local,sender,sendAuthorized:false}),/PROVIDER_RECONCILIATION_REQUIRED/);
    await provisionRoster([{...f.row,subject:'email|normalized'}],{provider,local:f.local,sender,sendAuthorized:false});
    assert.equal((await f.db.admin.query('SELECT email,subject FROM mpd_identity.invitations')).rows[0].email,'Student+section@example.edu');
  }finally{await f.close();}
});

test('admin mutations use the runtime coordinator and acknowledge only durable invalidation',async()=>{
  const f=await operatorFixture();const runtime=createIdentityRuntime(f.store);
  try{
    const user=randomUUID();await f.db.admin.query("INSERT INTO mpd_identity.users(id,status) VALUES($1,'active')",[user]);
    await assert.rejects(executeAdmin({kind:'disable-user',userId:user,reason:'operator'}, {store:f.store,runtime,coordinator:createDispatchCoordinator(),now:()=>OPERATOR_NOW}),/COORDINATOR_MISMATCH/);
    let release!:()=>void;let entered!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});const active=new Promise<void>(resolve=>{entered=resolve;});
    const fence=runtime.coordinator.withFence(async()=>{entered();await gate;});await active;
    let done=false;const mutation=executeAdmin({kind:'disable-user',userId:user,reason:'operator'},{store:f.store,runtime,coordinator:runtime.coordinator,now:()=>OPERATOR_NOW}).then(result=>{done=true;return result;});
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal(done,false);release();await fence;
    assert.deepEqual(await deadline(mutation),{ok:true,affected:1});
    assert.equal((await f.db.admin.query('SELECT status FROM mpd_identity.users WHERE id=$1',[user])).rows[0].status,'disabled');
    assert.equal((await f.db.admin.query("SELECT count(*) FROM mpd_identity.audit_events WHERE actor_id IS NOT NULL")).rows[0].count,'1');
  }finally{runtime.close();await f.close();}
});

test('maintenance persists deny admission and external override cannot be cleared',async()=>{
  const f=await operatorFixture();const runtime=createIdentityRuntime(f.store);
  try{
    const deps={store:f.store,runtime,coordinator:runtime.coordinator,now:()=>OPERATOR_NOW};
    assert.deepEqual(await executeAdmin({kind:'maintenance',enabled:true},deps),{ok:true,affected:1});assert.equal(await f.store.ready(),false);
    assert.deepEqual(await executeAdmin({kind:'maintenance',enabled:false},deps),{ok:true,affected:1});assert.equal(await f.store.ready(),true);
  }finally{runtime.close();await f.close();}
});

test('strict admin commands reject unknown fields, unsafe IDs, SQL and raw bearer tokens',()=>{
  for(const invalid of [{kind:'sql',query:'DROP DATABASE authority'},{kind:'maintenance',enabled:false,extra:true},{kind:'disable-user',userId:'not-an-id',reason:'operator'},
    {kind:'deny-token',fingerprint:'Bearer secret',expiresAt:OPERATOR_NOW+10000,reason:'operator'}, {kind:'maintenance',enabled:'false'}]){
    assert.throws(()=>parseAdminCommand(invalid),/INVALID_ADMIN_COMMAND/);
  }
  assert.deepEqual(parseAdminCommand({kind:'maintenance',enabled:true}),{kind:'maintenance',enabled:true});
});

test('private socket is 0600 in a 0700 directory and bounds frames without leaking input',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mpd-admin-'));const path=join(directory,'admin.sock');let calls=0;
  const socket=await startAdminSocket(path,async()=>{calls++;return{ok:true,affected:1};});
  try{
    assert.equal((await stat(path)).mode&0o777,0o600);assert.equal((await stat(directory)).mode&0o777,0o700);
    assert.deepEqual(await socketRequest(path,'{"kind":"maintenance","enabled":true}\n'),{ok:true,affected:1});
    const invalid=await socketRequest(path,'{"kind":"maintenance","enabled":true,"token":"canary-secret"}\n');
    assert.deepEqual(invalid,{ok:false,code:'INVALID_ADMIN_COMMAND'});assert.equal(JSON.stringify(invalid).includes('canary-secret'),false);
    assert.deepEqual(await socketRequest(path,'x'.repeat(65537)),{ok:false,code:'ADMIN_REQUEST_TOO_LARGE'});assert.equal(calls,1);
    await assert.rejects(startAdminSocket(path,async()=>({ok:true,affected:0})),/ADMIN_SOCKET_EXISTS/);
  }finally{await socket.close();await rm(directory,{recursive:true,force:true});}
});

test('operator file manifests remain private and reject broad-readable input',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mpd-operator-'));const file=join(directory,'input.json');
  try{
    await writeFile(file,'{"kind":"maintenance","enabled":true}',{mode:0o600});
    let submitted:AdminCommand|undefined;
    const result=await main!.runOperator(['admin','--file',file],{admin:{async execute(command){submitted=command;return{ok:true,affected:1};}},output:()=>{},readStdin:async()=>''});
    assert.equal(result,0);assert.deepEqual(submitted,{kind:'maintenance',enabled:true});
    await chmod(file,0o644);await assert.rejects(main!.runOperator(['admin','--file',file],{admin:{async execute(){throw new Error('must not execute');}},output:()=>{},readStdin:async()=>''}),/PRIVATE_FILE_REQUIRED/);
    const token='eyJ.operator-canary.signature';let denial:AdminCommand|undefined;
    await main!.runOperator(['deny-token','--expires-at',String(OPERATOR_NOW+600000),'--reason','operator'],{admin:{async execute(command){denial=command;return{ok:true,affected:1};}},output:text=>assert.equal(text.includes(token),false),readStdin:async()=>token});
    assert.equal(denial?.kind,'deny-token');if(denial?.kind==='deny-token')assert.equal(denial.fingerprint,createHash('sha256').update(token).digest('hex'));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('all roster rows are validated before any provider write',async()=>{
  const f=await operatorFixture();const remote=fakeProvider();
  try{
    await assert.rejects(provisionRoster([f.row,{...f.row,id:randomUUID(),teamId:'unsafe'}],{provider:remote.provider,local:f.local,sender:{async deliver(){return{state:'sent'};}},sendAuthorized:false}),/INVALID_ADMIN_COMMAND|INVALID_ROSTER/);
    assert.equal(remote.requests.length,0);
  }finally{await f.close();}
});

test('Auth0 adapter keeps create blocked without suppression evidence and never marks email verified',async()=>{
  const {createAuth0Provisioner}=await import('../../apps/operator/provision.js');
  const calls:{url:string;init:RequestInit}[]=[];
  const fakeFetch:typeof fetch=async(input,init)=>{calls.push({url:String(input),init:init??{}});return new Response('[]',{status:200});};
  const provider=createAuth0Provisioner({origin:'https://tenant.example',managementToken:'management-canary',fetch:fakeFetch});
  await assert.rejects(provider.reconcile({email:'Student+section@example.edu'}),/PROVIDER_CREATE_NOT_VERIFIED/);
  assert.equal(calls.length,1);assert.equal(calls[0]?.init.method,undefined);
  let createdBody:Record<string,unknown>|undefined;
  const authorized=createAuth0Provisioner({origin:'https://tenant.example',managementToken:'management-canary',creationMailSuppressionEvidence:'protected/operator-evidence-1',fetch:async(input,init)=>{
    if(String(input).includes('users-by-email'))return new Response('[]');
    createdBody=JSON.parse(String(init?.body));
    return new Response(JSON.stringify({user_id:'email|exact',email:'Student+section@example.edu',identities:[{provider:'email',connection:'email'}]}));
  }});
  assert.equal((await authorized.reconcile({email:'Student+section@example.edu'})).subject,'email|exact');
  assert.deepEqual(createdBody,{connection:'email',email:'Student+section@example.edu',email_verified:false,verify_email:false});
});

test('provider failures and unexpected bodies never expose credentials or remote diagnostics',async()=>{
  const {createAuth0Provisioner}=await import('../../apps/operator/provision.js');
  const provider=createAuth0Provisioner({origin:'https://tenant.example',managementToken:'management-canary',fetch:async()=>new Response('remote canary token recipient@example.edu',{status:500})});
  await assert.rejects(provider.reconcile({email:'private@example.edu'}),error=>error instanceof Error&&error.message==='PROVIDER_UNAVAILABLE');
});

for(const kind of ['remove-membership','block-resource','deny-token','revoke-device'] as const){
  test(`${kind} commits the intended denial and runtime effects before acknowledgement`,async()=>{
    const f=await operatorFixture();const runtime=createIdentityRuntime(f.store);const user=randomUUID(),context=randomUUID(),device=randomUUID();
    try{
      await f.db.admin.query("INSERT INTO mpd_identity.users(id,status) VALUES($1,'active')",[user]);
      await f.db.admin.query("INSERT INTO mpd_identity.devices(id,owner_id,name) VALUES($1,$2,'laptop')",[device,user]);
      await f.db.admin.query("INSERT INTO mpd_identity.memberships(id,user_id,team_id,status) VALUES($1,$2,$3,'active')",[randomUUID(),user,f.row.teamId]);
      await f.db.admin.query("INSERT INTO mpd_identity.work_contexts(id,user_id,resource,client_id,boot_id,deployment_epoch,state,expires_at) VALUES($1,$2,'https://bridge.example/mcp','client',$3,'operator-test','active',$4)",[context,user,f.store.bootId,OPERATOR_NOW+600000]);
      if(kind==='revoke-device'||kind==='remove-membership')await f.db.admin.query("INSERT INTO mpd_identity.leases(id,context_id,user_id,device_id,team_id,capabilities,epoch,expires_at,idle_expires_at,state) VALUES($1,$2,$3,$4,$5,ARRAY['read'],0,$6,$6,'active')",[randomUUID(),context,user,device,f.row.teamId,OPERATOR_NOW+600000]);
      let closed=false;let observed:Promise<unknown>|undefined;
      runtime.registerContext({id:context,userId:user,resource:'https://bridge.example/mcp',clientId:'client',bootId:f.store.bootId,deploymentEpoch:f.store.deploymentEpoch},[f.row.teamId],()=>{closed=true;if(kind==='deny-token')return;observed=f.db.admin.query("SELECT state FROM mpd_identity.work_contexts WHERE id=$1",[context]).then(result=>assert.equal(result.rows[0].state,'revoked'));});
      const command:AdminCommand=kind==='revoke-device'?{kind,deviceId:device,reason:'operator'}:kind==='remove-membership'?{kind,userId:user,teamId:f.row.teamId,reason:'operator'}:kind==='block-resource'?{kind,userId:user,resource:'https://bridge.example/mcp',reason:'operator'}:{kind,userId:user,fingerprint:'a'.repeat(64),expiresAt:OPERATOR_NOW+600000,reason:'operator'};
      assert.deepEqual(await deadline(executeAdmin(command,{store:f.store,runtime,coordinator:runtime.coordinator,now:()=>OPERATOR_NOW})),{ok:true,affected:1});
      if(kind==='deny-token'){assert.equal(closed,false);assert.equal(runtime.isActive(context),true);}else{assert.equal(closed,true);assert.equal(runtime.isActive(context),false);await observed;}
      if(kind==='revoke-device')assert.equal((await f.db.admin.query('SELECT disabled FROM mpd_identity.devices WHERE id=$1',[device])).rows[0].disabled,true);
      if(kind==='remove-membership')assert.equal((await f.db.admin.query('SELECT status FROM mpd_identity.memberships')).rows[0].status,'removed');
      if(kind==='block-resource')assert.equal((await f.db.admin.query('SELECT count(*) FROM mpd_identity.user_resource_blocks')).rows[0].count,'1');
      if(kind==='deny-token')assert.equal((await f.db.admin.query('SELECT expires_at FROM mpd_identity.token_denials')).rows[0].expires_at,String(OPERATOR_NOW+660000));
    }finally{runtime.close();await f.close();}
  });
}

test('external maintenance flag refuses socket clearing even while the socket remains usable',async()=>{
  const f=await operatorFixture();await f.store.close();
  const {openAuthorizationStore}=await import('../../packages/storage/database.js');
  const external=await openAuthorizationStore({connectionString:f.db.appUrl,transportMode:'local-test',expectedStoreId:f.store.expectedStoreId,maintenance:true,deploymentEpoch:f.store.deploymentEpoch,tokenIatAfter:0,now:()=>OPERATOR_NOW});
  const runtime=createIdentityRuntime(external);
  try{await assert.rejects(executeAdmin({kind:'maintenance',enabled:false},{store:external,runtime,coordinator:runtime.coordinator,now:()=>OPERATOR_NOW}),/EXTERNAL_MAINTENANCE/);assert.equal(await external.ready(),false);assert.equal((await f.db.admin.query('SELECT maintenance FROM mpd_identity.service_state')).rows[0].maintenance,true);}
  finally{runtime.close();await external.close();await f.close();}
});

test('file enrollment adapter persists exact subject and delivery phase under private modes',async()=>{
  const {createFileEnrollmentAdmin}=await import('../../apps/operator/main.js');
  const directory=await mkdtemp(join(tmpdir(),'mpd-manifest-'));let submitted:AdminCommand|undefined;
  try{
    const adapter=await createFileEnrollmentAdmin(directory,{async execute(command){submitted=command;return{ok:true,affected:1};}});
    const id=randomUUID();const record:ProvisionRecord={id,rowHash:'a'.repeat(64),email:'Student+section@example.edu',subject:'email|exact',providerEmail:'Student+section@example.edu',confirmed:true,phase:'sending'};
    await adapter.save(record);assert.deepEqual(await adapter.load(id),record);assert.equal((await stat(join(directory,id+'.json'))).mode&0o777,0o600);
    assert.equal((await stat(directory)).mode&0o777,0o700);
    await adapter.recordInvitation({id,email:record.email,subject:record.subject,issuer:'https://tenant.example/',courseId:randomUUID(),teamId:randomUUID(),role:'student',expiresAt:OPERATOR_NOW+60000});assert.equal(submitted?.kind,'import-invites');
  }finally{await rm(directory,{recursive:true,force:true});}
});


test('documented nonsecret configuration is accepted by the serving config contract',async()=>{
  const {readIdentityConfig}=await import('../../apps/identity/config.js');
  const documentation=await readFile(new URL('../../docs/AUTH0_SETUP.md',import.meta.url),'utf8');
  const example=documentation.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(example?.[1]);const config=readIdentityConfig(JSON.parse(example[1]));
  assert.equal(config.auth.resource,'https://class-identity.example/mcp');assert.equal(config.maintenance,true);assert.equal(config.database.transportMode,'railway-private');
});

test('socket converts unexpected executor failures to a store error without reflecting diagnostics',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mpd-admin-error-'));const path=join(directory,'admin.sock');
  const socket=await startAdminSocket(path,async()=>{throw new Error('database canary secret');});
  try{assert.deepEqual(await socketRequest(path,'{"kind":"maintenance","enabled":true}\n'),{ok:false,code:'STORE_UNAVAILABLE'});}
  finally{await socket.close();await rm(directory,{recursive:true,force:true});}
});

test('confirmed SMTP failure can retry while persistence loss after acceptance remains uncertain',async()=>{
  const f=await operatorFixture();const remote=fakeProvider();let attempts=0;
  const sender:InvitationSender={async deliver(){attempts++;return{state:attempts===1?'failed':'sent'};}};
  try{
    assert.equal((await provisionRoster([f.row],{provider:remote.provider,local:f.local,sender,sendAuthorized:true})).failed,1);
    assert.equal((await provisionRoster([f.row],{provider:remote.provider,local:f.local,sender,sendAuthorized:true})).sent,1);assert.equal(attempts,2);
    const second={...f.row,id:randomUUID(),subject:'email|another'};
    const failingLocal={...f.local,async save(record:ProvisionRecord){if(record.phase==='sent')throw new Error('DISK_WRITE_FAILED');await f.local.save(record);}};
    await assert.rejects(provisionRoster([second],{provider:remote.provider,local:failingLocal,sender,sendAuthorized:true}),/DISK_WRITE_FAILED/);
    assert.equal(attempts,3);assert.equal(f.records.get(second.id)?.phase,'sending');
    assert.equal((await provisionRoster([second],{provider:remote.provider,local:f.local,sender,sendAuthorized:true})).uncertain,1);assert.equal(attempts,3);
  }finally{await f.close();}
});

test('operator provisioning output contains counts without recipient lists or subject/provider details',async()=>{
  const f=await operatorFixture();const directory=await mkdtemp(join(tmpdir(),'mpd-roster-'));const file=join(directory,'roster.json');const output:string[]=[];
  try{
    await writeFile(file,JSON.stringify([f.row]),{mode:0o600});
    const result=await main!.runOperator(['provision','--file',file],{admin:{async execute(){throw new Error('not used');}},output:value=>output.push(value),readStdin:async()=>'',provisioning:{provider:fakeProvider().provider,local:f.local,sender:{async deliver(){return{state:'sent'};}},sendAuthorized:false}});
    assert.equal(result,0);assert.deepEqual(output.map(value=>JSON.parse(value)),[{persisted:1,sent:0,failed:0,uncertain:0,skipped:1}]);assert.equal(output.join('').includes(f.row.email),false);assert.equal(output.join('').includes('email|student'),false);
  }finally{await rm(directory,{recursive:true,force:true});await f.close();}
});

test('close-course command commits closure and invalidates affected team under exactly one fence',async()=>{
  const f=await operatorFixture();const runtime=createIdentityRuntime(f.store);const user=randomUUID(),context=randomUUID();
  try{
    await f.db.admin.query("INSERT INTO mpd_identity.users(id,status) VALUES($1,'active')",[user]);
    await f.db.admin.query("INSERT INTO mpd_identity.work_contexts(id,user_id,resource,client_id,boot_id,deployment_epoch,state,expires_at) VALUES($1,$2,'https://bridge.example/mcp','client',$3,'operator-test','active',$4)",[context,user,f.store.bootId,OPERATOR_NOW+600000]);
    let closed=false;runtime.registerContext({id:context,userId:user,resource:'https://bridge.example/mcp',clientId:'client',bootId:f.store.bootId,deploymentEpoch:f.store.deploymentEpoch},[f.row.teamId],()=>{closed=true;});
    const command=parseAdminCommand({kind:'close-course',courseId:f.row.courseId});
    assert.deepEqual(await deadline(executeAdmin(command,{store:f.store,runtime,coordinator:runtime.coordinator,now:()=>OPERATOR_NOW})),{ok:true,affected:1});
    assert.equal((await f.db.admin.query('SELECT status FROM mpd_identity.courses WHERE id=$1',[f.row.courseId])).rows[0].status,'disabled');assert.equal(closed,true);
  }finally{runtime.close();await f.close();}
});

test('retention command uses the shared fence and returns only affected counts',async()=>{
  const f=await operatorFixture();const runtime=createIdentityRuntime(f.store);
  try{
    const result=await deadline(executeAdmin(parseAdminCommand({kind:'retention'}),{store:f.store,runtime,coordinator:runtime.coordinator,now:()=>OPERATOR_NOW}));
    assert.deepEqual(result,{ok:true,affected:0});
  }finally{runtime.close();await f.close();}
});

test('reconcile-roster delegates its own runtime fence once and leaves admissions closed',async()=>{
  const f=await operatorFixture();const runtime=createIdentityRuntime(f.store);
  try{
    await f.store.setMaintenance(true);
    const manifest={storeId:f.store.expectedStoreId,deploymentEpoch:f.store.deploymentEpoch,tokenIatAfter:f.store.tokenIatAfter,reviewedAt:OPERATOR_NOW,sourceRefs:['protected/current-roster-and-revocations'],revocationsVerified:true,approvedMemberships:[],disabledUserIds:[],removedMemberships:[],resourceBlocks:[]};
    const command=parseAdminCommand({kind:'reconcile-roster',manifest});
    assert.deepEqual(await deadline(executeAdmin(command,{store:f.store,runtime,coordinator:runtime.coordinator,now:()=>OPERATOR_NOW})),{ok:true,affected:0});assert.equal(await f.store.ready(),false);
  }finally{runtime.close();await f.close();}
});

test('real verified TLS SMTP accepts an invitation without exposing SMTP credentials in its body',async()=>{
  const {localSmtpServer}=await import('../support/operator.js');const nodemailer=(await import('nodemailer')).default;
  const {createSmtpInvitationSender}=await import('../../apps/operator/mail.js');
  const server=await localSmtpServer();
  try{
    const sender=createSmtpInvitationSender({host:'localhost',port:465,user:'smtp-user',password:'smtp-password-canary',from:'sender@example.invalid',signInUrl:'https://bridge.example/mcp'},config=>nodemailer.createTransport({...config,port:server.port,tls:{...config.tls,ca:server.cert}}));
    assert.deepEqual(await sender.deliver({id:randomUUID(),email:'student@example.invalid'}),{state:'sent'});
    assert.equal(server.messages.length,1);assert.ok(server.messages[0]?.includes('https://bridge.example/mcp'));assert.equal(server.messages[0]?.includes('smtp-password-canary'),false);
  }finally{await server.close();}
});

for(const outcome of ['rejected','uncertain','no-tls','untrusted-cert'] as const){
  test(`real local SMTP ${outcome} has a bounded, conservative delivery outcome`,async()=>{
    const {localSmtpServer}=await import('../support/operator.js');const nodemailer=(await import('nodemailer')).default;
    const {createSmtpInvitationSender}=await import('../../apps/operator/mail.js');
    const server=await localSmtpServer(outcome==='untrusted-cert'?'sent':outcome);
    try{
      const sender=createSmtpInvitationSender({host:'localhost',port:outcome==='no-tls'?587:465,user:'smtp-user',password:'smtp-password-canary',from:'sender@example.invalid',signInUrl:'https://bridge.example/mcp'},config=>nodemailer.createTransport({...config,port:server.port,tls:{...config.tls,...(outcome==='untrusted-cert'?{}:{ca:server.cert})}}));
      assert.deepEqual(await sender.deliver({id:randomUUID(),email:'student@example.invalid'}),{state:outcome==='uncertain'?'uncertain':'failed'});
      if(outcome==='no-tls'){assert.ok(server.commands.includes('STARTTLS'));assert.equal(server.commands.includes('AUTH'),false);assert.equal(server.messages.length,0);}
      if(outcome==='rejected'||outcome==='untrusted-cert')assert.equal(server.messages.length,0);
      if(outcome==='uncertain')assert.equal(server.messages.length,1);
    }finally{await server.close();}
  });
}

test('SMTP configuration denies unsafe destinations and missing sender credentials before any delivery',async()=>{
  const {createSmtpInvitationSender}=await import('../../apps/operator/mail.js');
  const valid={host:'localhost',port:465 as const,user:'test-user',password:'test-password',from:'sender@example.invalid',signInUrl:'https://bridge.example/mcp'};
  for(const overrides of [{port:25},{host:''},{host:'localhost\r\nX-Header:bad'},{from:'bad-address'},{from:'sender@example.invalid\nBcc:someone'},{user:''},{password:''},
    {signInUrl:'http://bridge.example/mcp'},{signInUrl:'https://secret@bridge.example/mcp'},{signInUrl:'https://bridge.example/mcp?token=bad'},{signInUrl:'https://bridge.example/mcp#bad'}]){
    assert.throws(()=>createSmtpInvitationSender({...valid,...overrides} as typeof valid),/INVALID_MAIL_CONFIGURATION/);
  }
});

test('SMTP adapter conservatively handles empty acceptance and explicit transport failure metadata',async()=>{
  const {createSmtpInvitationSender}=await import('../../apps/operator/mail.js');
  const options={host:'localhost',port:465 as const,user:'test-user',password:'test-password',from:'sender@example.invalid',signInUrl:'https://bridge.example/mcp'};
  const invitation={id:randomUUID(),email:'student@example.invalid'};
  const noAccepted=createSmtpInvitationSender(options,()=>({async sendMail(){return{accepted:[]};}}));assert.deepEqual(await noAccepted.deliver(invitation),{state:'failed'});
  for(const [failure,state] of [[{},'uncertain'],[{code:'EAUTH'},'failed'],[{command:'RCPT TO'},'failed'],[{responseCode:550},'failed'],[{originalCode:'ECONNREFUSED'},'failed']] as const){
    const sender=createSmtpInvitationSender(options,()=>({async sendMail(){throw failure;}}));assert.deepEqual(await sender.deliver(invitation),{state});
  }
});

test('actual operator CLI imports a roster over its private socket without SMTP settings or provider mail',async()=>{
  const {localSmtpServer,operatorCli}=await import('../support/operator.js');const {createServer}=await import('node:https');
  const f=await operatorFixture();const runtime=createIdentityRuntime(f.store);const directory=await mkdtemp(join(tmpdir(),'mpd-cli-'));const socketPath=join(directory,'admin.sock');
  const admin=await startAdminSocket(socketPath,command=>executeAdmin(command,{store:f.store,runtime,coordinator:runtime.coordinator,now:()=>OPERATOR_NOW}));
  const certificate=await localSmtpServer();const observed:string[]=[];
  const provider=createServer({key:certificate.key,cert:certificate.cert},(request,response)=>{
    observed.push(request.method??'');response.setHeader('Content-Type','application/json');
    const profile={user_id:'email|cli-student',email:f.row.email,identities:[{provider:'email',connection:'email'}]};response.end(JSON.stringify(request.url?.includes('users-by-email')?[profile]:profile));
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const address=provider.address();assert.ok(address&&typeof address!=='string');
  try{
    const file=join(directory,'roster.json');await writeFile(file,JSON.stringify([f.row]),{mode:0o600});
    const result=await operatorCli(['provision','--file',file],{cwd:directory,env:{AUTHZ_ADMIN_SOCKET:socketPath,AUTH0_MANAGEMENT_ORIGIN:`https://localhost:${address.port}`,AUTH0_MANAGEMENT_TOKEN:'test-management-token',NODE_EXTRA_CA_CERTS:certificate.certPath,IDENTITY_SEND_AUTHORIZED:'false',SMTP_HOST:'',SMTP_PORT:'',SMTP_USER:'',SMTP_PASSWORD:'',SMTP_FROM:''}});
    assert.deepEqual(result,{code:0,stdout:'{"persisted":1,"sent":0,"failed":0,"uncertain":0,"skipped":1}\n',stderr:''});assert.deepEqual(observed,['GET']);assert.equal(certificate.messages.length,0);
    assert.equal((await f.db.admin.query('SELECT subject FROM mpd_identity.invitations')).rows[0].subject,'email|cli-student');
    const files=await import('node:fs/promises');await assert.rejects(files.stat(join(directory,'work/identity-operator/.lock')),/ENOENT/);
  }finally{provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));await certificate.close();await admin.close();runtime.close();await f.close();await rm(directory,{recursive:true,force:true});}
});

test('actual operator CLI submits admin JSON and hashes protected token stdin while exposing only counts',async()=>{
  const {operatorCli}=await import('../support/operator.js');const f=await operatorFixture();const runtime=createIdentityRuntime(f.store);
  const directory=await mkdtemp(join(tmpdir(),'mpd-cli-admin-'));const path=join(directory,'admin.sock');
  const admin=await startAdminSocket(path,command=>executeAdmin(command,{store:f.store,runtime,coordinator:runtime.coordinator,now:()=>OPERATOR_NOW}));
  try{
    const file=join(directory,'command.json');await writeFile(file,'{"kind":"maintenance","enabled":true}',{mode:0o600});
    assert.deepEqual(await operatorCli(['admin','--file',file],{cwd:directory,env:{AUTHZ_ADMIN_SOCKET:path}}),{code:0,stdout:'{"ok":true,"affected":1}\n',stderr:''});assert.equal(await f.store.ready(),false);
    const raw='operator-cli-token-canary';const result=await operatorCli(['deny-token','--expires-at',String(OPERATOR_NOW+600000),'--reason','operator'],{cwd:directory,env:{AUTHZ_ADMIN_SOCKET:path},stdin:raw});
    assert.deepEqual(result,{code:0,stdout:'{"ok":true,"affected":1}\n',stderr:''});assert.equal((await f.db.admin.query('SELECT fingerprint FROM mpd_identity.token_denials')).rows[0].fingerprint,createHash('sha256').update(raw).digest('hex'));
  }finally{await admin.close();runtime.close();await f.close();await rm(directory,{recursive:true,force:true});}
});

test('actual operator CLI errors redact private input and do not require SMTP for non-sending validation',async()=>{
  const {operatorCli}=await import('../support/operator.js');const {mkdir,symlink}=await import('node:fs/promises');const directory=await mkdtemp(join(tmpdir(),'mpd-cli-errors-'));const file=join(directory,'input.json');
  const env={AUTHZ_ADMIN_SOCKET:join(directory,'missing.sock'),AUTH0_MANAGEMENT_ORIGIN:'https://tenant.example',AUTH0_MANAGEMENT_TOKEN:'test-token',IDENTITY_SEND_AUTHORIZED:'false',SMTP_HOST:'',SMTP_PORT:'',SMTP_USER:'',SMTP_PASSWORD:'',SMTP_FROM:''};
  const check=async(args:readonly string[],code:string,stdin?:string)=>{const result=await operatorCli(args,{cwd:directory,env,stdin});assert.deepEqual(result,{code:1,stdout:'',stderr:code+'\n'});};
  try{
    await check(['unknown'],'INVALID_OPERATOR_ARGUMENT');await check(['admin'],'INVALID_OPERATOR_ARGUMENT');await check(['deny-token'],'INVALID_OPERATOR_ARGUMENT');
    await writeFile(file,'{"kind":"maintenance","enabled":true}',{mode:0o600});await check(['admin','--file',file],'ADMIN_UNAVAILABLE');
    await chmod(file,0o644);await check(['admin','--file',file],'PRIVATE_FILE_REQUIRED');await chmod(file,0o600);
    const link=join(directory,'symlink.json');await symlink(file,link);await check(['admin','--file',link],'PRIVATE_FILE_REQUIRED');
    await writeFile(file,'{"secret":"canary-private-input"}');await check(['admin','--file',file],'INVALID_ADMIN_COMMAND');
    await writeFile(file,'not-json-canary-private-input');await check(['admin','--file',file],'OPERATOR_FAILED');
    await check(['deny-token','--expires-at','1800000600000','--reason','operator'],'INVALID_TOKEN_INPUT','');
    await check(['deny-token','--expires-at','1800000600000','--reason','operator'],'INVALID_TOKEN_INPUT','raw token with spaces');
    await check(['deny-token','--expires-at','1800000600000','--reason','operator'],'INPUT_TOO_LARGE','x'.repeat(65537));
    await writeFile(file,'[]');await check(['provision','--file',file],'INVALID_ROSTER');
    await mkdir(join(directory,'work/identity-operator/.lock'),{mode:0o700});await check(['provision','--file',file],'OPERATOR_ALREADY_RUNNING');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('Auth0 lookup handles exact subjects, ambiguous accounts and bounded malformed provider responses',async()=>{
  const {createAuth0Provisioner}=await import('../../apps/operator/provision.js');
  const profile={user_id:'email|known',email:'Student+section@example.edu',identities:[{provider:'email',connection:'email'}]};
  const options={origin:'https://tenant.example',managementToken:'management-canary'};
  const existing=createAuth0Provisioner({...options,fetch:async()=>new Response(JSON.stringify([profile]))});assert.deepEqual(await existing.reconcile({email:profile.email}),{subject:profile.user_id,email:profile.email,connection:'email'});
  const exact=createAuth0Provisioner({...options,fetch:async()=>new Response(JSON.stringify(profile))});assert.equal((await exact.reconcile({email:profile.email,subject:profile.user_id})).subject,profile.user_id);
  for(const [body,subject,code] of [
    ['{}',undefined,'PROVIDER_IDENTITY_MISMATCH'],[JSON.stringify([profile,profile]),undefined,'PROVIDER_RECONCILIATION_REQUIRED'],
    [JSON.stringify({...profile,user_id:'email|different'}),profile.user_id,'PROVIDER_IDENTITY_MISMATCH'],
    [JSON.stringify({...profile,identities:[{provider:'google-oauth2',connection:'google'}]}),profile.user_id,'PROVIDER_IDENTITY_MISMATCH'],
    [JSON.stringify({email:profile.email}),profile.user_id,'PROVIDER_IDENTITY_MISMATCH'],['not-json',undefined,'PROVIDER_UNAVAILABLE'],
    ['x'.repeat(65537),undefined,'PROVIDER_RESPONSE_TOO_LARGE'],
  ] as const){const provider=createAuth0Provisioner({...options,fetch:async()=>new Response(body)});await assert.rejects(provider.reconcile({email:profile.email,...(subject?{subject}:{})}),new RegExp(code));}
  const unavailable=createAuth0Provisioner({...options,fetch:async()=>new Response(null)});await assert.rejects(unavailable.reconcile({email:profile.email}),/PROVIDER_UNAVAILABLE/);
  const conflict=createAuth0Provisioner({...options,fetch:async()=>new Response('private remote diagnostic',{status:409})});await assert.rejects(conflict.reconcile({email:profile.email}),error=>error instanceof Error&&error.message==='PROVIDER_RECONCILIATION_REQUIRED');
  const network=createAuth0Provisioner({...options,fetch:async()=>{throw new Error('private-network-canary');}});await assert.rejects(network.reconcile({email:profile.email}),error=>error instanceof Error&&error.message==='PROVIDER_UNAVAILABLE');
  for(const change of [{origin:'http://tenant.example'},{origin:'https://tenant.example/path'},{origin:'https://secret@tenant.example'},{managementToken:''},{managementToken:'token\r\ncanary'}])assert.throws(()=>createAuth0Provisioner({...options,...change}),/INVALID_PROVIDER_CONFIGURATION/);
});

test('provisioning rejects invalid rosters and immutable subject conflicts without delivery',async()=>{
  const f=await operatorFixture();const remote=fakeProvider();let delivered=0;
  const sender:InvitationSender={async deliver(){delivered++;return{state:'sent'};}};
  const deps={provider:remote.provider,local:f.local,sender,sendAuthorized:true};
  try{
    for(const rows of [[],null,[null],[{...f.row,email:42}],[{...f.row,email:'not-an-email'}],[{...f.row,email:'mail @example.edu'}],[f.row,f.row]])await assert.rejects(provisionRoster(rows as unknown as Parameters<typeof provisionRoster>[0],deps),/INVALID_ROSTER/);
    assert.equal(remote.requests.length,0);assert.equal(delivered,0);
    await provisionRoster([f.row],{...deps,sendAuthorized:false});
    await assert.rejects(provisionRoster([{...f.row,subject:'email|different'}],deps),/PROVISIONING_CONFLICT/);
    await assert.rejects(provisionRoster([f.row],{...deps,provider:{async reconcile(){return{subject:'email|changed',email:f.row.email,connection:'email'};}}}),/PROVIDER_IDENTITY_MISMATCH/);
    const fresh={...f.row,id:randomUUID()};
    await assert.rejects(provisionRoster([fresh],{...deps,provider:{async reconcile(){return{subject:'',email:f.row.email,connection:'email'};}}}),/PROVIDER_IDENTITY_MISMATCH/);
    const failingSender:InvitationSender={async deliver(){throw new Error('smtp-secret-canary');}};
    assert.equal((await provisionRoster([fresh],{...deps,sender:failingSender})).uncertain,1);assert.equal(delivered,0);
    const another={...f.row,id:randomUUID()};
    const invalidSender={async deliver(){return{state:'unexpected'};}} as unknown as InvitationSender;
    assert.equal((await provisionRoster([another],{...deps,sender:invalidSender})).uncertain,1);
  }finally{await f.close();}
});

test('private manifest adapter refuses unsafe paths and cleans up a failed atomic replacement',async()=>{
  const {mkdir,readdir,symlink}=await import('node:fs/promises');const directory=await mkdtemp(join(tmpdir(),'mpd-manifest-failure-'));
  const adapter=await main.createFileEnrollmentAdmin(directory,{async execute(){return{ok:true,affected:0};}});
  try{
    assert.equal(await adapter.load(randomUUID()),null);await assert.rejects(adapter.load('../private'),/INVALID_ROSTER/);
    const id=randomUUID();await mkdir(join(directory,id+'.json'),{mode:0o700});
    const record:ProvisionRecord={id,rowHash:'b'.repeat(64),email:'student@example.invalid',subject:'email|exact',providerEmail:'student@example.invalid',confirmed:true,phase:'persisted'};
    await assert.rejects(adapter.save(record));assert.deepEqual((await readdir(directory)).sort(),[id+'.json']);
    const file=join(directory,'oversized.json');await writeFile(file,'x'.repeat(65537),{mode:0o600});await assert.rejects(main.readPrivateFile(file),/PRIVATE_FILE_REQUIRED/);
    const symbolic=join(directory,'symbolic.json');await symlink(file,symbolic);await assert.rejects(main.readPrivateFile(symbolic),/PRIVATE_FILE_REQUIRED/);
    await chmod(directory,0o755);await assert.rejects(main.createFileEnrollmentAdmin(directory,{async execute(){return{ok:true,affected:0};}}),/PRIVATE_DIRECTORY_REQUIRED/);await chmod(directory,0o700);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('socket client rejects invalid replies and private server refuses unsafe framing and paths',async()=>{
  const {createSocketAdmin}=await import('../../apps/operator/socket.js');const {createServer}=await import('node:net');
  const directory=await mkdtemp(join(tmpdir(),'mpd-socket-boundary-'));
  try{
    await assert.rejects(startAdminSocket('relative.sock',async()=>({ok:true,affected:0})),/INVALID_ADMIN_SOCKET/);
    await assert.rejects(startAdminSocket('/tmp/'+'x'.repeat(101),async()=>({ok:true,affected:0})),/INVALID_ADMIN_SOCKET/);
    await chmod(directory,0o755);await assert.rejects(startAdminSocket(join(directory,'bad.sock'),async()=>({ok:true,affected:0})),/INSECURE_ADMIN_DIRECTORY/);await chmod(directory,0o700);
    for(const [reply,code] of [['not-json','INVALID_ADMIN_RESPONSE'],['{"ok":true,"affected":-1}','INVALID_ADMIN_RESPONSE'],['{"ok":false,"code":"RESOURCE_BLOCKED"}','RESOURCE_BLOCKED'],['{"ok":false,"code":"private secret"}','ADMIN_UNAVAILABLE'],['x'.repeat(4097),'ADMIN_UNAVAILABLE']] as const){
      const path=join(directory,randomUUID()+'.sock');const peer=createServer(socket=>{socket.on('error',()=>{});socket.on('data',()=>socket.end(reply));});await new Promise<void>(resolve=>peer.listen(path,resolve));
      try{await assert.rejects(createSocketAdmin(path).execute({kind:'maintenance',enabled:true}),new RegExp(code));}finally{await new Promise<void>(resolve=>peer.close(()=>resolve()));}
    }
    const path=join(directory,'strict.sock');let calls=0;const server=await startAdminSocket(path,async()=>{calls++;return{ok:true,affected:0};});
    try{assert.deepEqual(await socketRequest(path,'{"kind":"maintenance","enabled":true}\n{}\n'),{ok:false,code:'INVALID_ADMIN_COMMAND'});assert.deepEqual(await socketRequest(path,'not-json\n'),{ok:false,code:'INVALID_ADMIN_COMMAND'});assert.equal(calls,0);}finally{await server.close();}
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('private admin server and client bound stalled frames and peers without admitting work',async()=>{
  const {createSocketAdmin}=await import('../../apps/operator/socket.js');const {createServer}=await import('node:net');
  const directory=await mkdtemp(join(tmpdir(),'mpd-socket-timeout-'));const serverPath=join(directory,'server.sock'),clientPath=join(directory,'client.sock');let calls=0;
  const sockets=new Set<import('node:net').Socket>();const stalled=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});await new Promise<void>(resolve=>stalled.listen(clientPath,resolve));
  const server=await startAdminSocket(serverPath,async()=>{calls++;return{ok:true,affected:0};});
  try{
    const start=Date.now();
    const results=await Promise.all([socketRequest(serverPath,'{"kind":',7000),createSocketAdmin(clientPath).execute({kind:'maintenance',enabled:true}).then(()=>assert.fail('stalled peer admitted'),error=>{assert.match(String(error),/ADMIN_UNAVAILABLE/);return null;})]);
    assert.deepEqual(results,[{ok:false,code:'ADMIN_REQUEST_TIMEOUT'},null]);assert.ok(Date.now()-start>=4500&&Date.now()-start<7000);assert.equal(calls,0);
  }finally{await server.close();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>stalled.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});
