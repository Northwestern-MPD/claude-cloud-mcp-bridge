import nodemailer from 'nodemailer';
import type {SendMailOptions} from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';

export type SmtpTransportFactory=(options:SMTPTransport.Options)=>{sendMail(message:SendMailOptions):Promise<{accepted:unknown[]}>};
import { PolicyError } from '../../packages/authorization/errors.js';
import type { InvitationSender } from './types.js';

export function createSmtpInvitationSender(options:Readonly<{host:string;port:465|587;user:string;password:string;from:string;signInUrl:string}>,createTransport:SmtpTransportFactory=options=>nodemailer.createTransport(options)):InvitationSender{
  const link=new URL(options.signInUrl);
  if(![465,587].includes(options.port)||link.protocol!=='https:'||link.username||link.password||link.search||link.hash||!options.host||/[\r\n]/.test(options.host+options.from)||!/^\S+@\S+$/.test(options.from)||!options.user||!options.password)throw new PolicyError('INVALID_MAIL_CONFIGURATION');
  const transporter=createTransport({host:options.host,port:options.port,secure:options.port===465,requireTLS:true,
    auth:{user:options.user,pass:options.password},tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},
    connectionTimeout:5000,greetingTimeout:5000,socketTimeout:10000,logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true});
  return{async deliver(invitation){
    try{
      const result=await transporter.sendMail({from:options.from,to:invitation.email,
        messageId:`<invitation-${invitation.id}@${options.from.split('@')[1]}>`,subject:'Your class MCP invitation',
        text:`You have been invited to your class MCP service. Sign in through your approved client using ${link.href}. This invitation does not grant access to desktop controls.`});
      return{state:result.accepted.length===1?'sent':'failed'};
    }catch(error){
      const failure=error as {code?:string;originalCode?:string;command?:string;responseCode?:number};
      const knownFailure=['EAUTH','ENOAUTH','EDNS','ETLS','EENVELOPE','ECONFIG','EFILEACCESS','EURLACCESS'].includes(failure.code??'')||
        ['EHLO','HELO','STARTTLS','AUTH','MAIL FROM','RCPT TO'].includes(failure.command??'')||Boolean(failure.responseCode&&failure.responseCode>=400)||
        ['ECONNREFUSED','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(failure.originalCode??'');
      // Nodemailer also labels a disconnect after DATA as CONN: it is not proof of non-delivery.
      return{state:knownFailure?'failed':'uncertain'};
    }
  }};
}
