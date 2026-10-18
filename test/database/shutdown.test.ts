import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {createTestDatabase} from '../support/storage.js';
import {migrateAuthorizationStore} from '../../packages/storage/migrations.js';
import {openAuthorizationStore} from '../../packages/storage/database.js';
import type {Store,Transaction} from '../../packages/storage/types.js';

async function deadline<T>(work:Promise<T>,milliseconds=1500):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('STORE_SHUTDOWN_DID_NOT_RETIRE_CHECKOUTS')),milliseconds);})]);}
  finally{if(timer)clearTimeout(timer);}
}
for(const trigger of ['pool exhaustion','explicit close'] as const){
  test(`${trigger} retires held transactions before releasing ownership and denies resumed callbacks`,async()=>{
    const db=await createTestDatabase();let store:Store|undefined,replacement:Store|undefined;
    let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
    let allHeld!:()=>void;const acquired=new Promise<void>(resolve=>{allHeld=resolve;});
    const pids:number[]=[];let pending:Promise<PromiseSettledResult<void>[]>|undefined;
    try{
      await db.provisionRoles();const storeId=randomUUID();
      await migrateAuthorizationStore({migrationUrl:db.migrationUrl,transportMode:'local-test',initialize:true,maintenance:true,expectedStoreId:storeId,deploymentEpoch:'shutdown-test'});
      const options={connectionString:db.appUrl,transportMode:'local-test' as const,maintenance:false,expectedStoreId:storeId,deploymentEpoch:'shutdown-test',tokenIatAfter:0,now:Date.now};
      store=await openAuthorizationStore(options);await store.setMaintenance(false);const oldBoot=store.bootId;
      pending=Promise.allSettled(Array.from({length:5},(_,index)=>store!.transaction(async tx=>{
        await tx.query("INSERT INTO mpd_identity.users(id,status) VALUES($1,'pending')",[randomUUID()]);
        await tx.query('SELECT pg_advisory_xact_lock(1278104649,$1)',[index]);
        pids.push((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        if(pids.length===5)allHeld();await held;
        await assert.rejects(Promise.resolve().then(()=>tx.query("INSERT INTO mpd_identity.users(id,status) VALUES($1,'active')",[randomUUID()])),/STORE_UNAVAILABLE/);
        await assert.rejects(Promise.resolve().then(()=>tx.query('COMMIT')),/STORE_UNAVAILABLE/);
      })));
      await acquired;
      assert.equal((await db.admin.query('SELECT count(*) FROM pg_locks WHERE pid=ANY($1::integer[]) AND locktype=\'advisory\' AND granted',[pids])).rows[0].count,'5');
      if(trigger==='pool exhaustion'){
        await assert.rejects(store.transaction(tx=>tx.query('SELECT 1')),/STORE_UNAVAILABLE/);
        assert.equal(await store.ready(),false);
      }
      await deadline(store.close());
      assert.equal((await db.admin.query('SELECT count(*) FROM pg_stat_activity WHERE pid=ANY($1::integer[])',[pids])).rows[0].count,'0');
      assert.equal((await db.admin.query('SELECT count(*) FROM pg_locks WHERE pid=ANY($1::integer[]) AND locktype=\'advisory\'',[pids])).rows[0].count,'0');
      replacement=await deadline(openAuthorizationStore(options));assert.notEqual(replacement.bootId,oldBoot);assert.equal(await replacement.ready(),true);
      release();const outcomes=await deadline(pending);
      assert.ok(outcomes.every(result=>result.status==='rejected'&&/STORE_UNAVAILABLE/.test(String(result.reason))));
      assert.equal((await db.admin.query('SELECT count(*) FROM mpd_identity.users')).rows[0].count,'0');
    }finally{
      release();if(pending)await pending;await replacement?.close();await store?.close();await db.close();
    }
  });
}

test('a retained transaction query cannot escape its completed checkout',async()=>{
  const db=await createTestDatabase();let store:Store|undefined;let escaped:Transaction|undefined;
  try{
    await db.provisionRoles();const storeId=randomUUID();await migrateAuthorizationStore({migrationUrl:db.migrationUrl,transportMode:'local-test',initialize:true,maintenance:true,expectedStoreId:storeId,deploymentEpoch:'escape-test'});
    store=await openAuthorizationStore({connectionString:db.appUrl,transportMode:'local-test',maintenance:false,expectedStoreId:storeId,deploymentEpoch:'escape-test',tokenIatAfter:0,now:Date.now});
    await store.transaction(async tx=>{escaped=tx;await tx.query('SELECT 1');});
    await assert.rejects(Promise.resolve().then(()=>escaped!.query("INSERT INTO mpd_identity.users(id,status) VALUES($1,'active')",[randomUUID()])),/STORE_UNAVAILABLE/);
    assert.equal((await db.admin.query('SELECT count(*) FROM mpd_identity.users')).rows[0].count,'0');
  }finally{await store?.close();await db.close();}
});
