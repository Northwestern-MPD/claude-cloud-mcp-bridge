import { createServer, connect, type Socket } from 'node:net';
import { lstat, mkdir, chmod, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { parseRecoveryManifest } from '../../packages/storage/recovery.js';
import { PolicyError } from '../../packages/authorization/errors.js';
import type { AdminCommand, AdminResult } from './types.js';

const MAX_FRAME=65_536;
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function text(value:unknown,max=256):value is string{return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);}
function resource(value:unknown):value is string{if(!text(value,2048))return false;try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash;}catch{return false;}}
function object(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function keys(value:Record<string,unknown>,allowed:readonly string[],required=allowed){return Object.keys(value).every(key=>allowed.includes(key))&&required.every(key=>Object.hasOwn(value,key));}
function secondsOrMillis(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;}
function reason(value:unknown):value is string{return typeof value==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(value);}
export function parseAdminCommand(input:unknown):AdminCommand{
  const invalid=()=>{throw new PolicyError('INVALID_ADMIN_COMMAND');};
  if(!object(input)||!text(input.kind,64))return invalid();
  if(Buffer.byteLength(JSON.stringify(input))>MAX_FRAME)return invalid();
  switch(input.kind){
    case 'reconcile-roster':if(!keys(input,['kind','manifest']))return invalid();return{kind:'reconcile-roster',manifest:parseRecoveryManifest(input.manifest)};
    case 'native-observations':if(!keys(input,['kind']))return invalid();break;
    case 'deny-observed-token':if(!keys(input,['kind','reference','reason'])||typeof input.reference!=='string'||!/^[a-f0-9]{32}$/.test(input.reference)||!reason(input.reason))return invalid();break;
    case 'retention':if(!keys(input,['kind']))return invalid();break;
    case 'close-course':if(!keys(input,['kind','courseId'])||!uuid(input.courseId))return invalid();break;
    case 'maintenance':if(!keys(input,['kind','enabled'])||typeof input.enabled!=='boolean')return invalid();break;
    case 'revoke-device':if(!keys(input,['kind','deviceId','reason'])||!uuid(input.deviceId)||!reason(input.reason))return invalid();break;
    case 'disable-user':if(!keys(input,['kind','userId','reason'])||!uuid(input.userId)||!reason(input.reason))return invalid();break;
    case 'remove-membership':if(!keys(input,['kind','userId','teamId','reason'])||!uuid(input.userId)||!uuid(input.teamId)||!reason(input.reason))return invalid();break;
    case 'block-resource':if(!keys(input,['kind','userId','resource','reason'])||!uuid(input.userId)||!resource(input.resource)||!reason(input.reason))return invalid();break;
    case 'deny-token':if(!keys(input,['kind','fingerprint','expiresAt','reason','userId','resource'],['kind','fingerprint','expiresAt','reason'])||typeof input.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(input.fingerprint)||!secondsOrMillis(input.expiresAt)||!reason(input.reason)||(input.userId!==undefined&&!uuid(input.userId))||(input.resource!==undefined&&!resource(input.resource)))return invalid();break;
    case 'import-invites':{
      if(!keys(input,['kind','invitations'])||!Array.isArray(input.invitations)||input.invitations.length<1||input.invitations.length>100)return invalid();
      for(const invite of input.invitations){
        if(!object(invite)||!keys(invite,['id','email','issuer','subject','courseId','teamId','role','expiresAt'])||!uuid(invite.id)||!uuid(invite.courseId)||!uuid(invite.teamId)||!text(invite.email,320)||!text(invite.subject)||!resource(invite.issuer)||!['student','instructor'].includes(String(invite.role))||!secondsOrMillis(invite.expiresAt))return invalid();
      }break;
    }
    default:return invalid();
  }
  if(Buffer.byteLength(JSON.stringify(input))>MAX_FRAME)return invalid();
  return structuredClone(input) as AdminCommand;
}
export async function startAdminSocket(path:string,execute:(command:AdminCommand)=>Promise<AdminResult>):Promise<{close():Promise<void>}>{
  if(!isAbsolute(path)||Buffer.byteLength(path)>100)throw new PolicyError('INVALID_ADMIN_SOCKET');
  const directory=dirname(path);await mkdir(directory,{recursive:true,mode:0o700});
  const parent=await lstat(directory);
  if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o777)!==0o700||(process.getuid&&parent.uid!==process.getuid()))throw new PolicyError('INSECURE_ADMIN_DIRECTORY');
  try{await lstat(path);throw new PolicyError('ADMIN_SOCKET_EXISTS');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const clients=new Set<Socket>();
  const server=createServer(socket=>{
    clients.add(socket);socket.on('error',()=>{});socket.on('close',()=>clients.delete(socket));
    let buffer=Buffer.alloc(0);let submitted=false;
    const reply=(value:unknown)=>{if(!socket.destroyed){const frame=JSON.stringify(value)+'\n';socket.end(Buffer.byteLength(frame)<=4096?frame:'{"ok":false,"code":"INVALID_ADMIN_RESPONSE"}\n');}};
    socket.setTimeout(5000,()=>{submitted=true;reply({ok:false,code:'ADMIN_REQUEST_TIMEOUT'});});
    socket.on('data',data=>{
      const chunk=Buffer.isBuffer(data)?data:Buffer.from(data);
      if(submitted)return;
      if(buffer.length+chunk.length>MAX_FRAME){submitted=true;reply({ok:false,code:'ADMIN_REQUEST_TOO_LARGE'});return;}
      buffer=Buffer.concat([buffer,chunk]);const newline=buffer.indexOf(10);if(newline<0)return;
      submitted=true;
      void(async()=>{
        let command:AdminCommand;
        try{
          if(newline!==buffer.length-1)throw new PolicyError('INVALID_ADMIN_COMMAND');
          command=parseAdminCommand(JSON.parse(buffer.subarray(0,newline).toString('utf8')));
        }catch{reply({ok:false,code:'INVALID_ADMIN_COMMAND'});return;}
        try{reply(await execute(command));}
        catch(error){reply({ok:false,code:error instanceof PolicyError?error.code:'STORE_UNAVAILABLE'});}
      })();
    });
  });
  server.maxConnections=16;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,()=>{server.off('error',reject);resolve();});});
  await chmod(path,0o600);
  return{async close(){for(const socket of clients)socket.destroy();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));try{await unlink(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}};
}
function observationResponse(value:unknown):boolean {
  if(!Array.isArray(value)||value.length>8)return false;
  return value.every(row=>object(row)&&keys(row,['reference','token','principal','context','outcome','ageMs','expiresInMs'])&&typeof row.reference==='string'&&/^[a-f0-9]{32}$/.test(row.reference)&&typeof row.token==='string'&&/^[a-f0-9]{16}$/.test(row.token)&&typeof row.principal==='string'&&/^[a-f0-9]{16}$/.test(row.principal)&&(row.context===null||(typeof row.context==='string'&&/^[a-f0-9]{16}$/.test(row.context)))&&(row.outcome==='allowed'||row.outcome==='denied')&&secondsOrMillis(row.ageMs)&&secondsOrMillis(row.expiresInMs)&&row.expiresInMs>0);
}
export function createSocketAdmin(path:string):{execute(command:AdminCommand):Promise<AdminResult>}{
  return{execute(command){
    const validated=parseAdminCommand(command);
    return new Promise((resolve,reject)=>{
      const socket=connect(path);let buffer='';socket.setTimeout(5000,()=>socket.destroy(new PolicyError('ADMIN_UNAVAILABLE')));
      socket.on('connect',()=>socket.write(JSON.stringify(validated)+'\n'));
      socket.on('data',chunk=>{buffer+=chunk.toString();if(Buffer.byteLength(buffer)>4096)socket.destroy(new PolicyError('INVALID_ADMIN_RESPONSE'));});
      socket.on('error',()=>reject(new PolicyError('ADMIN_UNAVAILABLE')));
      socket.on('end',()=>{try{const result=JSON.parse(buffer);if(result.ok!==true)throw new PolicyError(typeof result.code==='string'&&/^[A-Z_]+$/.test(result.code)?result.code:'ADMIN_UNAVAILABLE');if(!Number.isSafeInteger(result.affected)||result.affected<0)throw new PolicyError('INVALID_ADMIN_RESPONSE');if(validated.kind==='native-observations'){if(!keys(result,['ok','affected','observations'])||!observationResponse(result.observations)||result.affected!==result.observations.length)throw new PolicyError('INVALID_ADMIN_RESPONSE');resolve({ok:true,affected:result.affected,observations:result.observations});}else{if(!keys(result,['ok','affected']))throw new PolicyError('INVALID_ADMIN_RESPONSE');resolve({ok:true,affected:result.affected});}}catch(error){reject(error instanceof PolicyError?error:new PolicyError('INVALID_ADMIN_RESPONSE'));}});
    });
  }};
}
