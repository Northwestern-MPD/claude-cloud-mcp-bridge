import type { RecoveryManifest } from '../../packages/storage/recovery.js';
import type { InvitationInput } from '../../packages/storage/enrollment.js';

export type AdminCommand =
  | Readonly<{kind:'import-invites';invitations:readonly InvitationInput[]}>
  | Readonly<{kind:'disable-user';userId:string;reason:string}>
  | Readonly<{kind:'remove-membership';userId:string;teamId:string;reason:string}>
  | Readonly<{kind:'block-resource';userId:string;resource:string;reason:string}>
  | Readonly<{kind:'deny-token';fingerprint:string;expiresAt:number;reason:string;userId?:string;resource?:string}>
  | Readonly<{kind:'maintenance';enabled:boolean}>
  | Readonly<{kind:'revoke-device';deviceId:string;reason:string}>
  | Readonly<{kind:'reconcile-roster';manifest:RecoveryManifest}>
  | Readonly<{kind:'retention'}>
  | Readonly<{kind:'close-course';courseId:string}>;
export type AdminResult=Readonly<{ok:true;affected:number}>;
export type RosterRow=Omit<InvitationInput,'subject'>&Readonly<{subject?:string}>;
export type ProviderIdentity=Readonly<{subject:string;email:string;connection:'email'}>;
export type Auth0Provisioner=Readonly<{reconcile(input:Readonly<{email:string;subject?:string}>):Promise<ProviderIdentity>}>;
export type DeliveryOutcome=Readonly<{state:'sent'|'failed'|'uncertain'}>;
export type InvitationSender=Readonly<{deliver(invitation:Readonly<{id:string;email:string}>):Promise<DeliveryOutcome>}>;
export type ProvisionRecord=Readonly<{
  id:string;rowHash:string;subject:string;email:string;providerEmail:string;confirmed:boolean;
  phase:'subject-recorded'|'persisted'|'sending'|'sent'|'failed'|'uncertain';
}>;
export type EnrollmentAdmin=Readonly<{
  load(id:string):Promise<ProvisionRecord|null>;
  save(record:ProvisionRecord):Promise<void>;
  recordInvitation(input:InvitationInput):Promise<void>;
}>;
export type ProvisionSummary=Readonly<{persisted:number;sent:number;failed:number;uncertain:number;skipped:number}>;
export type OperatorDependencies=Readonly<{
  admin:{execute(command:AdminCommand):Promise<AdminResult>};
  output(text:string):void;
  readStdin():Promise<string>;
  provisioning?:{provider:Auth0Provisioner;local:EnrollmentAdmin;sender:InvitationSender;sendAuthorized:boolean};
}>;
