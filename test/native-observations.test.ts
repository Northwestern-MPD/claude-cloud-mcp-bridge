import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAdminCommand } from '../apps/operator/socket.js';
const modulePath='../packages/authorization/native-observations.js';
const implementation=await import(modulePath).catch(()=>({})) as any;
const auth={principal:{issuer:'https://issuer.example',subject:'private-subject',clientId:'private-client',scopes:['private-scope'],issuedAt:1000,expiresAt:900000,emailVerified:true},resource:'https://bridge.example/mcp',tokenFingerprint:'a'.repeat(64)};
function fixture(){assert.equal(typeof implementation.createNativeObservations,'function','bounded verified observation recorder exists');let now=10000;return{observations:implementation.createNativeObservations(()=>now),advance:(ms:number)=>{now+=ms;}};}
// Break caught: reports leak JWT facts/context handles or lose same-token/principal correlation.
test('private observation reports correlate verified requests without exposing trusted inputs',()=>{
 const {observations}=fixture();observations.record(auth,'allowed','secret-context');observations.record({...auth,principal:{...auth.principal,clientId:'another-client'},tokenFingerprint:'b'.repeat(64)},'denied','secret-context');observations.record(auth,'allowed','different-context');
 const rows=observations.report();assert.equal(rows.length,3);assert.equal(rows[0].token,rows[2].token);assert.notEqual(rows[0].token,rows[1].token);assert.equal(rows[0].principal,rows[1].principal);assert.equal(rows[0].context,rows[1].context);assert.notEqual(rows[0].context,rows[2].context);assert.equal(rows[1].outcome,'denied');
 const text=JSON.stringify(rows);for(const secret of ['private-subject','private-client','private-scope','secret-context','different-context',auth.tokenFingerprint,auth.resource,auth.principal.issuer])assert.equal(text.includes(secret),false);
 assert.deepEqual(observations.resolve(rows[0].reference),{fingerprint:auth.tokenFingerprint,resource:auth.resource,expiresAt:900000});
});
// Break caught: eviction/TTL/shutdown/another boot leaves a usable administrative token reference.
test('observation references are bounded, expire, and cannot survive another boot or shutdown',()=>{
 const f=fixture();f.observations.record(auth,'allowed');const first=f.observations.report()[0].reference;
 const other=fixture();other.observations.record(auth,'allowed');assert.notEqual(other.observations.report()[0].reference,first);assert.throws(()=>other.observations.resolve(first),/OBSERVATION_UNAVAILABLE/);
 for(let i=0;i<64;i++)f.observations.record(auth,'denied');assert.equal(f.observations.report().length,8);assert.throws(()=>f.observations.resolve(first),/OBSERVATION_UNAVAILABLE/);assert.ok(Buffer.byteLength(JSON.stringify(f.observations.report()))<4000);
 const last=f.observations.report()[0].reference;f.advance(300000);assert.deepEqual(f.observations.report(),[]);assert.throws(()=>f.observations.resolve(last),/OBSERVATION_UNAVAILABLE/);
 f.observations.record({...auth,principal:{...auth.principal,expiresAt:310001}},'allowed');const expiring=f.observations.report()[0].reference;f.advance(1);assert.throws(()=>f.observations.resolve(expiring),/OBSERVATION_UNAVAILABLE/);
 f.observations.close();f.observations.record(auth,'allowed');assert.deepEqual(f.observations.report(),[]);
});
test('private observation admin commands strictly reject raw tokens and caller authority',()=>{
 assert.deepEqual(parseAdminCommand({kind:'native-observations'}),{kind:'native-observations'});
 assert.deepEqual(parseAdminCommand({kind:'deny-observed-token',reference:'a'.repeat(32),reason:'operator'}),{kind:'deny-observed-token',reference:'a'.repeat(32),reason:'operator'});
 for(const input of [{kind:'native-observations',limit:100},{kind:'deny-observed-token',reference:'Bearer secret',reason:'operator'},{kind:'deny-observed-token',reference:'a'.repeat(32),reason:'operator',expiresAt:999999},{kind:'deny-observed-token',reference:'a'.repeat(32),reason:'raw reason'}])assert.throws(()=>parseAdminCommand(input),/INVALID_ADMIN_COMMAND/);
});

// Break caught: a compromised/malformed private response smuggles identity fields into operator output.
test('private socket client validates bounded observation response shape without accepting extra secret fields',async t=>{
 const {createServer}=await import('node:net');const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createSocketAdmin}=await import('../apps/operator/socket.js');
 const directory=await mkdtemp(join(tmpdir(),'mpd-observation-response-'));const path=join(directory,'admin.sock');
 let response:any={ok:true,affected:0,observations:[]};const server=createServer(socket=>socket.on('data',()=>socket.end(JSON.stringify(response)+'\n')));await new Promise<void>(resolve=>server.listen(path,resolve));t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});});
 const client=createSocketAdmin(path);assert.deepEqual(await client.execute({kind:'native-observations'} as any),response);
 const row={reference:'a'.repeat(32),token:'b'.repeat(16),principal:'c'.repeat(16),context:null,outcome:'allowed',ageMs:0,expiresInMs:1000};response={ok:true,affected:1,observations:[row]};assert.deepEqual(await client.execute({kind:'native-observations'} as any),response);
 for(const invalid of [{...row,subject:'secret'},{...row,reference:'raw bearer'},{...row,token:'raw-fingerprint'},{...row,context:'raw-context-handle'},{...row,outcome:'claims'},{...row,outcome:['allowed']},{...row,ageMs:-1},{...row,expiresInMs:0}]){response={ok:true,affected:1,observations:[invalid]};await assert.rejects(client.execute({kind:'native-observations'} as any),/INVALID_ADMIN_RESPONSE/);}
 response={ok:true,affected:9,observations:Array(9).fill(row)};await assert.rejects(client.execute({kind:'native-observations'} as any),/INVALID_ADMIN_RESPONSE/);
 response={ok:true,affected:1,observations:[row]};await assert.rejects(client.execute({kind:'retention'}),/INVALID_ADMIN_RESPONSE/);
 response={ok:true,affected:1};await assert.rejects(client.execute({kind:'native-observations'} as any),/INVALID_ADMIN_RESPONSE/);
});

// Break caught: inactive process retains expired private token evidence until another request or report arrives.
test('private observation cleanup runs while idle and stops after expiry or close',t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
 let reads=0;assert.equal(typeof implementation.createNativeObservations,'function');const observations=implementation.createNativeObservations(()=>{reads++;return Date.now();});t.after(()=>observations.close());
 observations.record(auth,'allowed');const afterRecord=reads;t.mock.timers.tick(300000);assert.ok(reads>afterRecord,'idle expiry invokes cleanup without report or resolution');
 const afterExpiry=reads;t.mock.timers.tick(300000);assert.equal(reads,afterExpiry,'empty ring has no pending cleanup');
 observations.record({...auth,principal:{...auth.principal,expiresAt:610005}},'allowed');const beforeJwtExpiry=reads;t.mock.timers.tick(5);assert.ok(reads>beforeJwtExpiry,'original JWT expiry also clears idle evidence');
 observations.record({...auth,principal:{...auth.principal,expiresAt:900000}},'allowed');observations.close();const afterClose=reads;t.mock.timers.tick(300000);assert.equal(reads,afterClose,'close cancels private evidence timers');
});
