import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { createTestDatabase } from './storage.js';
import { migrateAuthorizationStore } from '../../packages/storage/migrations.js';
import { openAuthorizationStore } from '../../packages/storage/database.js';
import { enrollInvitation } from '../../packages/storage/enrollment.js';
import type { EnrollmentAdmin, ProvisionRecord, RosterRow } from '../../apps/operator/types.js';

export const OPERATOR_NOW = 1_800_000_000_000;
export async function operatorFixture() {
  const db=await createTestDatabase(); await db.provisionRoles();
  const storeId=randomUUID();
  await migrateAuthorizationStore({migrationUrl:db.migrationUrl,transportMode:'local-test',initialize:true,maintenance:true,expectedStoreId:storeId,deploymentEpoch:'operator-test'});
  const store=await openAuthorizationStore({connectionString:db.appUrl,transportMode:'local-test',maintenance:false,expectedStoreId:storeId,deploymentEpoch:'operator-test',tokenIatAfter:0,now:()=>OPERATOR_NOW});
  await store.setMaintenance(false);
  const courseId=randomUUID(),teamId=randomUUID();
  await db.admin.query("INSERT INTO mpd_identity.courses(id,name) VALUES($1,'class')",[courseId]);
  await db.admin.query("INSERT INTO mpd_identity.teams(id,course_id,name) VALUES($1,$2,'team')",[teamId,courseId]);
  const records=new Map<string,ProvisionRecord>();
  let failLocal=false;
  const local:EnrollmentAdmin={
    async load(id){return records.get(id)??null;},
    async save(record){records.set(record.id,structuredClone(record));},
    async recordInvitation(input){if(failLocal)throw new Error('STORE_UNAVAILABLE');await enrollInvitation(store,input,()=>OPERATOR_NOW);},
  };
  const row:RosterRow={id:randomUUID(),email:'Student+section@example.edu',issuer:'https://tenant.example/',courseId,teamId,role:'student',expiresAt:OPERATOR_NOW+604800000};
  return {db,store,row,local,records,setFailLocal(value:boolean){failLocal=value;},async close(){await store.close();await db.close();}};
}
export function socketRequest(path:string,input:string,timeout=5000):Promise<unknown> {
  return new Promise((resolve,reject)=>{
    const socket=connect(path);let data='';
    socket.setTimeout(timeout,()=>socket.destroy(new Error('TEST_SOCKET_TIMEOUT')));
    socket.on('connect',()=>socket.write(input));socket.on('data',chunk=>{data+=chunk.toString();});
    socket.on('error',reject);socket.on('end',()=>{try{resolve(JSON.parse(data));}catch(error){reject(error);}});
  });
}

/** A loopback-only SMTP peer. It accepts no outbound delivery and stores messages in this test process. */
export async function localSmtpServer(outcome:'sent'|'rejected'|'uncertain'|'no-tls'='sent') {
  const {createServer:tcpServer}=await import('node:net');
  const {createServer:tlsServer}=await import('node:tls');
  const {mkdtemp,readFile,rm,chmod}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {execFile}=await import('node:child_process');
  const {promisify}=await import('node:util');
  const directory=await mkdtemp(join(tmpdir(),'mpd-smtp-'));
  const keyPath=join(directory,'key.pem'),certPath=join(directory,'cert.pem');
  await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost']);
  await chmod(keyPath,0o600);
  const cert=await readFile(certPath,'utf8');const key=await readFile(keyPath,'utf8');
  const sockets=new Set<import('node:net').Socket>();const messages:string[]=[];const commands:string[]=[];
  const handle=(socket:import('node:net').Socket)=>{
    sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
    socket.setEncoding('utf8');let buffer='',message='';let data=false;
    socket.write('220 localhost test SMTP\r\n');
    socket.on('data',chunk=>{
      buffer+=chunk.toString();let newline:number;
      while((newline=buffer.indexOf('\r\n'))>=0){
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+2);
        if(data){if(line!=='.'){message+=line+'\r\n';continue;}messages.push(message);data=false;
          if(outcome==='uncertain'){socket.destroy();return;}socket.write('250 2.0.0 queued in test memory\r\n');continue;}
        const command=line.split(' ')[0]!.toUpperCase();commands.push(command);
        if(command==='EHLO'||command==='HELO')socket.write(outcome==='no-tls'?'250 localhost\r\n':'250-localhost\r\n250-AUTH PLAIN\r\n250 SIZE 65536\r\n');
        else if(command==='STARTTLS')socket.write('502 5.5.1 TLS unavailable\r\n');
        else if(command==='AUTH')socket.write('235 2.7.0 authentication accepted\r\n');
        else if(command==='MAIL')socket.write('250 2.1.0 sender accepted\r\n');
        else if(command==='RCPT')socket.write(outcome==='rejected'?'550 5.1.1 recipient rejected\r\n':'250 2.1.5 recipient accepted\r\n');
        else if(command==='DATA'){data=true;message='';socket.write('354 send test message\r\n');}
        else if(command==='QUIT')socket.end('221 2.0.0 goodbye\r\n');
        else socket.write('250 2.0.0 ok\r\n');
      }
    });
  };
  const server=outcome==='no-tls'?tcpServer(handle):tlsServer({key,cert},handle);
  server.on('tlsClientError',()=>{});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
  const address=server.address();if(!address||typeof address==='string')throw new Error('TEST_SMTP_ADDRESS');
  return{port:address.port,cert,key,certPath,messages,commands,async close(){for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}};
}

export async function operatorCli(args:readonly string[],options:{cwd:string;env?:NodeJS.ProcessEnv;stdin?:string}) {
  const {spawn}=await import('node:child_process');
  return await new Promise<{code:number;stdout:string;stderr:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,['--import',new URL('../../node_modules/tsx/dist/loader.mjs',import.meta.url).href,new URL('../../apps/operator/main.ts',import.meta.url).pathname,...args],{
      cwd:options.cwd,env:{...process.env,...options.env},stdio:['pipe','pipe','pipe'],
    });
    let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error('TEST_OPERATOR_CLI_TIMEOUT'));},8000);
    child.stdout.on('data',chunk=>{stdout+=chunk.toString();});child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
    child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);resolve({code:code??1,stdout,stderr});});child.stdin.end(options.stdin??'');
  });
}
