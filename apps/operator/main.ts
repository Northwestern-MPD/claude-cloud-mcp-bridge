import { createHash,randomUUID } from 'node:crypto';
import { open,lstat,mkdir,rename,unlink,rmdir } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PolicyError } from '../../packages/authorization/errors.js';
import { parseAdminCommand,createSocketAdmin } from './socket.js';
import { provisionRoster,createAuth0Provisioner } from './provision.js';
import { createSmtpInvitationSender } from './mail.js';
import type { OperatorDependencies,EnrollmentAdmin,ProvisionRecord,RosterRow } from './types.js';

export async function readPrivateFile(path:string):Promise<string>{
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid())||info.size>65536)throw new PolicyError('PRIVATE_FILE_REQUIRED');
  const file=await open(path,'r');try{const opened=await file.stat();if(opened.ino!==info.ino||opened.dev!==info.dev)throw new PolicyError('PRIVATE_FILE_REQUIRED');return await file.readFile('utf8');}finally{await file.close();}
}
export async function createFileEnrollmentAdmin(directory:string,admin:OperatorDependencies['admin']):Promise<EnrollmentAdmin>{
  await mkdir(directory,{recursive:true,mode:0o700});const info=await lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o777)!==0o700||(process.getuid&&info.uid!==process.getuid()))throw new PolicyError('PRIVATE_DIRECTORY_REQUIRED');
  const path=(id:string)=>{if(!/^[0-9a-f-]{36}$/i.test(id))throw new PolicyError('INVALID_ROSTER');return join(directory,id+'.json');};
  return{
    async load(id){try{return JSON.parse(await readPrivateFile(path(id))) as ProvisionRecord;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}},
    async save(record){const target=path(record.id),temporary=target+'.'+randomUUID()+'.tmp';const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(record));await file.sync();}finally{await file.close();}try{await rename(temporary,target);const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}}catch(error){await unlink(temporary).catch(()=>{});throw error;}},
    async recordInvitation(invitation){await admin.execute({kind:'import-invites',invitations:[invitation]});},
  };
}
function argument(args:readonly string[],name:string):string|undefined{const index=args.indexOf(name);return index<0?undefined:args[index+1];}
export async function runOperator(args:readonly string[],deps:OperatorDependencies):Promise<number>{
  const [operation,...rest]=args;
  if(operation==='native-observations'){
    if(rest.length!==0)throw new PolicyError('INVALID_OPERATOR_ARGUMENT');
    const result=await deps.admin.execute({kind:'native-observations'});deps.output(JSON.stringify(result));return 0;
  }
  if(operation==='deny-observed-token'){
    if(rest.length!==4||!argument(rest,'--reference')||!argument(rest,'--reason'))throw new PolicyError('INVALID_OPERATOR_ARGUMENT');
    const result=await deps.admin.execute(parseAdminCommand({kind:'deny-observed-token',reference:argument(rest,'--reference'),reason:argument(rest,'--reason')}));deps.output(JSON.stringify(result));return 0;
  }
  if(operation==='admin'){
    const file=argument(rest,'--file');if(!file||rest.length!==2)throw new PolicyError('INVALID_OPERATOR_ARGUMENT');
    const command=parseAdminCommand(JSON.parse(await readPrivateFile(file)));const result=await deps.admin.execute(command);deps.output(JSON.stringify(result));return 0;
  }
  if(operation==='deny-token'){
    if(rest.length!==4||!argument(rest,'--expires-at')||!argument(rest,'--reason'))throw new PolicyError('INVALID_OPERATOR_ARGUMENT');
    const raw=(await deps.readStdin()).trim();if(!raw||raw.length>16384||/[\s\x00-\x1f]/.test(raw))throw new PolicyError('INVALID_TOKEN_INPUT');
    const result=await deps.admin.execute(parseAdminCommand({kind:'deny-token',fingerprint:createHash('sha256').update(raw).digest('hex'),expiresAt:Number(argument(rest,'--expires-at')),reason:argument(rest,'--reason')}));deps.output(JSON.stringify(result));return 0;
  }
  if(operation==='provision'){
    const file=argument(rest,'--file');if(!file||rest.length!==2||!deps.provisioning)throw new PolicyError('INVALID_OPERATOR_ARGUMENT');
    const rows=JSON.parse(await readPrivateFile(file)) as RosterRow[];
    const result=await provisionRoster(rows,deps.provisioning);deps.output(JSON.stringify(result));return result.failed||result.uncertain?2:0;
  }
  throw new PolicyError('INVALID_OPERATOR_ARGUMENT');
}
async function cli():Promise<void>{
  const admin=createSocketAdmin(process.env.AUTHZ_ADMIN_SOCKET??'/tmp/mpd-identity/admin.sock');
  const readStdin=async()=>{let bytes=0;const chunks:Buffer[]=[];for await(const chunk of process.stdin){bytes+=Buffer.byteLength(chunk);if(bytes>65536)throw new PolicyError('INPUT_TOO_LARGE');chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks).toString('utf8');};
  const deps:OperatorDependencies={admin,readStdin,output:text=>console.log(text)};
  if(process.argv[2]!=='provision'){process.exitCode=await runOperator(process.argv.slice(2),deps);return;}
  const directory=resolve('work/identity-operator');await mkdir(directory,{recursive:true,mode:0o700});
  const lock=join(directory,'.lock');try{await mkdir(lock,{mode:0o700});}catch{throw new PolicyError('OPERATOR_ALREADY_RUNNING');}
  try{
    const local=await createFileEnrollmentAdmin(directory,admin);
    const provider=createAuth0Provisioner({origin:process.env.AUTH0_MANAGEMENT_ORIGIN??'',managementToken:process.env.AUTH0_MANAGEMENT_TOKEN??'',creationMailSuppressionEvidence:process.env.AUTH0_CREATE_MAIL_SUPPRESSION_EVIDENCE});
    const sendAuthorized=process.env.IDENTITY_SEND_AUTHORIZED==='true';
    const sender=sendAuthorized?createSmtpInvitationSender({host:process.env.SMTP_HOST??'',port:Number(process.env.SMTP_PORT) as 465|587,user:process.env.SMTP_USER??'',password:process.env.SMTP_PASSWORD??'',from:process.env.SMTP_FROM??'',signInUrl:process.env.MCP_RESOURCE_URI??''}):{async deliver(){throw new PolicyError('SEND_NOT_AUTHORIZED');}};
    process.exitCode=await runOperator(process.argv.slice(2),{...deps,provisioning:{provider,local,sender,sendAuthorized}});
  }finally{await rmdir(lock);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){cli().catch(error=>{console.error(error instanceof PolicyError?error.code:'OPERATOR_FAILED');process.exitCode=1;});}
