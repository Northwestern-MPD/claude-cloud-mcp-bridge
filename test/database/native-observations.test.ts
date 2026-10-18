import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityFixture } from '../support/identity.js';
import { createSocketAdmin,startAdminSocket } from '../../apps/operator/socket.js';
import { executeAdmin } from '../../apps/operator/commands.js';
import { runOperator } from '../../apps/operator/main.js';
// Break caught: a private reference denial misses the serving process or revokes all tokens for a principal.
test('private socket observes verified HTTP only and denies the observed JWT while another same-user JWT works',async t=>{
 const f=await identityFixture(t);const observations=f.server.observations;assert.ok(observations,'serving process exposes private observation handle');
 const directory=await mkdtemp(join(tmpdir(),'mpd-observation-'));const path=join(directory,'admin.sock');
 const admin=await startAdminSocket(path,command=>executeAdmin(command,{store:f.store,runtime:f.runtime,coordinator:f.runtime.coordinator,now:f.clock,observations}));
 t.after(async()=>{await admin.close();await rm(directory,{recursive:true,force:true});});const socket=createSocketAdmin(path);const output:string[]=[];
 const deps={admin:socket,output:(value:string)=>output.push(value),readStdin:async()=>{throw new Error('must not read raw tokens');}};
 await f.request('/mcp',{headers:{Authorization:'Bearer invalid-canary'}});await runOperator(['native-observations'],deps);assert.deepEqual(JSON.parse(output.pop()!).observations,[]);
 const {client,transport}=await f.sdk();await client.listTools();
 await runOperator(['native-observations'],deps);const report=JSON.parse(output.pop()!);assert.ok(report.observations.length>=2);const ref=report.observations[0].reference;
 const serialized=JSON.stringify(report);for(const secret of [f.bearer,'auth0|student-1','http-student@example.edu',transport.sessionId!])assert.equal(serialized.includes(secret),false);
 await runOperator(['deny-observed-token','--reference',ref,'--reason','operator'],deps);assert.deepEqual(JSON.parse(output.pop()!),{ok:true,affected:1});
 const denial=(await f.db.admin.query('SELECT expires_at,resource FROM mpd_identity.token_denials')).rows[0];assert.equal(Number(denial.expires_at),(Math.floor(f.clock()/1000)+600)*1000+60000);assert.equal(denial.resource,f.config.auth.resource);
 const denied=await f.request('/mcp');assert.equal(denied.status,401);assert.deepEqual(await denied.json(),{error:'INVALID_TOKEN'});
 const alternate=await f.signing.mint({jti:'different-token'});const other=await f.sdk(alternate);assert.equal((await other.client.listTools()).tools.length,1);
 await runOperator(['native-observations'],deps);assert.ok(JSON.parse(output.pop()!).observations.some((row:any)=>row.outcome==='denied'));
 await assert.rejects(socket.execute({kind:'deny-observed-token',reference:'0'.repeat(32),reason:'operator'} as any),/OBSERVATION_UNAVAILABLE/);
 f.advance(300000);await assert.rejects(socket.execute({kind:'deny-observed-token',reference:ref,reason:'operator'} as any),/OBSERVATION_UNAVAILABLE/);
 for(const args of [['native-observations','extra'],['deny-observed-token'],['deny-observed-token','--reference',ref,'--reason','bad reason']])await assert.rejects(runOperator(args,deps));
});

// Break caught: token denial between outer admission and the MCP handler is reported as allowed because HTTP status stays 200.
test('observations retain request-local authorization denial inside HTTP 200 MCP tool errors',async t=>{
 const f=await identityFixture(t);
 const {startIdentityServer}=await import('../../apps/identity/server.js');const {verifyAccessToken}=await import('../../packages/auth/index.js');const {request}=await import('node:http');const {createHash}=await import('node:crypto');
 let armed=false;let fences=0;
 const runtime={...f.runtime,coordinator:{async withFence<T>(action:()=>Promise<T>):Promise<T>{
   if(armed&&++fences===3){armed=false;await executeAdmin({kind:'deny-token',fingerprint:createHash('sha256').update(f.bearer).digest('hex'),expiresAt:(Math.floor(f.clock()/1000)+600)*1000,resource:f.config.auth.resource,reason:'operator'},{store:f.store,runtime:f.runtime,coordinator:f.runtime.coordinator,now:f.clock});}
   return f.runtime.coordinator.withFence(action);
 }}};
 const server=await startIdentityServer({config:f.config,store:f.store,runtime,clock:f.clock,verify:token=>verifyAccessToken(token,f.config.auth,f.signing)});t.after(()=>server.close());
 async function rpc(body:unknown,token=f.bearer,session?:string){return new Promise<{status:number;session:string|undefined;body:any}>((resolve,reject)=>{
   const req=request(server.url+'/mcp',{method:'POST',headers:{Host:'bridge.example',Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(session?{'mcp-session-id':session}:{})}},res=>{let text='';res.on('data',chunk=>{text+=chunk;});res.on('end',()=>resolve({status:res.statusCode!,session:res.headers['mcp-session-id'] as string|undefined,body:JSON.parse(text)}));});req.on('error',reject);req.end(JSON.stringify(body));
 });}
 const initialized=await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'observation-race',version:'1'}}});assert.equal(initialized.status,200);assert.ok(initialized.session);
 armed=true;const denied=await rpc({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'class_identity',arguments:{}}},f.bearer,initialized.session);assert.equal(fences,3);assert.equal(denied.status,200);assert.equal(denied.body.result.isError,true);assert.equal(server.observations.report().at(-1)!.outcome,'denied');
 const alternate=await f.signing.mint({jti:'alternate-race-token'});const allowed=await rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'class_identity',arguments:{}}},alternate,initialized.session);assert.equal(allowed.status,200);assert.equal(allowed.body.result.isError,undefined);assert.equal(server.observations.report().at(-1)!.outcome,'allowed');
 const invalid=await rpc({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'unknown_tool',arguments:{}}},alternate,initialized.session);assert.equal(invalid.status,200);assert.equal(invalid.body.result.isError,true);assert.equal(server.observations.report().at(-1)!.outcome,'denied');
});
