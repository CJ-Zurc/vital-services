import { copyOperationalBrief } from './appointment-summary.js';
import { assertRecordsIdle,currentPaid } from '../records/authorization.js';
import { appendSqlOutbox } from '../../infrastructure/outbox.js';
import { randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError,requireScope,type Actor } from '../../contracts/actor.js';
import type { AppointmentRow,AppointmentCommand,AppointmentOwners } from './appointment-contracts.js';
import { effectiveCompletionDeadline } from './appointment-contracts.js';
import { accessCrypto,appointmentPayloadCrypto,patientReference,displayReference } from './access-crypto.js';

type DB=Pick<PoolClient,'query'>;
type Access={appointmentId:string;reference:string;patientId:string;doctorId:string;generation:number;digest:string|null;ciphertext:unknown;attempts:number;consumedAt:Date|null;revokedAt:Date|null;grantUntil:Date|null;grantedAt:Date|null;ageYears:number|null;sex:string|null;identityValues?:unknown};
function deny(status:number,code:string):never{throw new DomainError(status,code,'Appointment access is unavailable.');}
export const accessBinding=(a:Access)=>JSON.stringify([a.appointmentId,a.patientId,a.doctorId,a.generation]);
export async function accessRow(db:DB,id:string,lock=false){return(await db.query<Access>('SELECT * FROM appointment_access WHERE "appointmentId"=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];}
export async function ensureAppointmentAccess(db:DB,row:AppointmentRow,ageYears:number|null=null,sex:string|null=null,identityValues:string[]|null=null){
  if(await accessRow(db,row.id))return;
  let reference:string;
  const prior=row.sourceAppointmentId?await accessRow(db,row.sourceAppointmentId):null;
  if(prior){await copyOperationalBrief(db,prior.appointmentId,row.id);reference=prior.reference;ageYears??=prior.ageYears;sex??=prior.sex;if(identityValues===null&&prior.identityValues)identityValues=z.array(z.string()).parse(appointmentPayloadCrypto().decrypt(prior.identityValues,'appointment-identities:'+prior.appointmentId));}
  else for(;;){reference=patientReference();if((await db.query('INSERT INTO appointment_references(reference) VALUES($1) ON CONFLICT DO NOTHING RETURNING reference',[reference])).rowCount)break;}
  await db.query('INSERT INTO appointment_access("appointmentId",reference,"patientId","doctorId","ageYears",sex,"identityValues") VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING',[row.id,reference!,row.patientId,row.doctorId,ageYears,sex,identityValues?JSON.stringify(appointmentPayloadCrypto().encrypt(identityValues,'appointment-identities:'+row.id)):null]);
}
export async function knownReviewIdentities(db:DB,id:string):Promise<string[]|null>{const row=await accessRow(db,id);if(!row?.identityValues)return null;return z.array(z.string()).parse(appointmentPayloadCrypto().decrypt(row.identityValues,'appointment-identities:'+id));}
export async function issueAppointmentCode(db:DB,row:AppointmentRow,environment:NodeJS.ProcessEnv=process.env){
  await ensureAppointmentAccess(db,row);
  const old=(await accessRow(db,row.id,true))!;
  if(old.patientId!==row.patientId)deny(409,'APPOINTMENT_ACCESS_PATIENT_CHANGED');
  const rebound=old.doctorId!==row.doctorId;
  const next={...old,patientId:row.patientId,doctorId:row.doctorId,generation:old.generation+1};
  const secret=accessCrypto(environment).issue(accessBinding(next));
  // A reschedule must never extend a grant obtained for the previous interval.
  await db.query(`UPDATE appointment_access SET "patientId"=$2,"doctorId"=$3,generation=$4,digest=$5,ciphertext=$6::jsonb,attempts=0,"consumedAt"=NULL,"grantedAt"=CASE WHEN $7 THEN NULL ELSE "grantedAt" END,"grantUntil"=CASE WHEN $7 THEN NULL ELSE "grantUntil" END WHERE "appointmentId"=$1`,[row.id,row.patientId,row.doctorId,next.generation,secret.digest,JSON.stringify(secret.ciphertext),rebound]);
}
export async function revokeAppointmentAccess(db:DB,id:string){await db.query('UPDATE appointment_access SET "revokedAt"=COALESCE("revokedAt",NOW()),digest=NULL,ciphertext=NULL WHERE "appointmentId"=$1',[id]);}
export async function hasLiveAppointmentAccess(db:DB,row:AppointmentRow,now=Date.now()){
  const a=await accessRow(db,row.id);
  const consent=(await db.query(`SELECT accepted FROM consent_records WHERE "patientId"=$1 AND "consentType"='medical_record' AND ("appointmentId" IS NULL OR "appointmentId"=$2) ORDER BY "consentedAt" DESC,id DESC LIMIT 1`,[row.patientId,row.id])).rows[0];
  return Boolean(consent?.accepted&&a&&a.patientId===row.patientId&&a.doctorId===row.doctorId&&a.grantedAt&&!a.revokedAt&&a.grantUntil&&a.grantUntil.getTime()>now&&row.status==='confirmed'&&!row.paperworkLockedAt&&!row.doctorConfirmedAt&&effectiveCompletionDeadline(row).getTime()>now);
}
export async function requireLiveAppointmentAccess(db:DB,row:AppointmentRow,now=Date.now()){if(!await hasLiveAppointmentAccess(db,row,now))deny(403,'APPOINTMENT_CODE_REQUIRED');}
export async function appointmentAccessState(db:DB,row:AppointmentRow,now=Date.now()){
 const a=await accessRow(db,row.id),live=await hasLiveAppointmentAccess(db,row,now);
 const closed=['cancelled','rejected','rescheduled','completed'].includes(row.status)||row.paperworkLockedAt||row.doctorConfirmedAt||effectiveCompletionDeadline(row).getTime()<=now;
 const state=live?'unlocked':closed||a?.revokedAt?(a?.grantedAt?'historical_only':'locked'):a&&a.attempts>=5?'locked':row.status==='confirmed'&&a?.digest?'unlock_available':'review_only';
 return{contractVersion:2 as const,appointmentVersion:row.version,state,reference:a?displayReference(a.reference):'Patient #Unavailable',generation:a?.generation??0,ageYears:a?.ageYears??null,sex:a?.sex??null,identityUnlocked:live};
}
export function createAppointmentAccess(pool:Pool,read:(db:DB,id:string,lock?:boolean)=>Promise<AppointmentRow>,environment:NodeJS.ProcessEnv=process.env,clock=Date.now,financial?:AppointmentOwners['financial']){
 return{async execute(actor:Actor,id:string,action:'read'|'code'|'reissue'|'withdraw'|'redeem',raw:unknown={},meta?:AppointmentCommand){
  z.uuid().parse(id);requireScope(actor,'appointments.access.'+action,id);
  const input=action==='redeem'?z.object({expectedVersion:z.number().int().nonnegative(),generation:z.number().int().positive(),code:z.string().regex(/^\d{6}$/)}).strict().parse(raw):z.object({}).strict().parse(raw);
  const db=await pool.connect();try{await db.query('BEGIN');
   const row=await read(db,id,true);
   const table=actor.role==='patient'?'vital_patients':actor.role==='doctor'?'vital_doctors':null;
   if(!table||!(await db.query(`SELECT 1 FROM ${table} p JOIN vital_users u ON u.id=p."userId" AND u."authId"=p."authId" WHERE p."authId"=$1 AND u.role=$2`,[actor.authId,actor.role])).rowCount)deny(403,'APPOINTMENT_ACCESS_MEMBERSHIP_REQUIRED');
   if(actor.role==='patient'?actor.authId!==row.patientAuthId:actor.role!=='doctor'||actor.authId!==row.doctorAuthId)deny(403,'APPOINTMENT_ACCESS_OWNER_DENIED');
   const a=await accessRow(db,id,true);if(!a)deny(409,'APPOINTMENT_ACCESS_CUTOVER_REQUIRED');
   if(a.patientId!==row.patientId||a.doctorId!==row.doctorId)deny(409,'APPOINTMENT_ACCESS_ASSOCIATION_CHANGED');
   const changed=async(kind:string)=>{
     await db.query('UPDATE appointments SET version=version+1,"updatedAt"=NOW() WHERE id=$1',[id]);
     await appendSqlOutbox(db,{producer:'appointment',eventType:'vital.audit.requested',aggregateId:id,aggregateVersion:row.version+1,correlationId:actor.correlationId,causationId:meta?.operationId??randomUUID(),data:{auditType:'vital.appointment.access_'+kind,actorAuthId:actor.authId,resourceId:id,resourceType:'appointment'}});
     await db.query('SELECT pg_notify($1,$2)::text',['vital_appointment_events',JSON.stringify({appointmentId:id,kind:'eligibility'})]);
   };
   if(action==='read'){const result=await appointmentAccessState(db,row,clock());await db.query('COMMIT');return result;}
   if(action==='withdraw'){
    if(actor.role!=='patient')deny(403,'APPOINTMENT_ACCESS_PATIENT_REQUIRED');
    await revokeAppointmentAccess(db,id);await changed('withdrawn');await db.query('COMMIT');return{state:'locked'};
   }
   const consent=(await db.query(`SELECT accepted FROM consent_records WHERE "patientId"=$1 AND "consentType"='medical_record' AND ("appointmentId" IS NULL OR "appointmentId"=$2) ORDER BY "consentedAt" DESC,id DESC LIMIT 1`,[row.patientId,id])).rows[0];
   if(!consent?.accepted||a.revokedAt||!['approved','confirmed'].includes(row.status))deny(403,'APPOINTMENT_ACCESS_INELIGIBLE');
   if(action==='code'||action==='reissue'){
    if(actor.role!=='patient')deny(403,'APPOINTMENT_ACCESS_PATIENT_REQUIRED');
    if(a.consumedAt||a.grantedAt||effectiveCompletionDeadline(row).getTime()<=clock())deny(409,'APPOINTMENT_ACCESS_ALREADY_USED');
    let replay=false;
    if(action==='reissue'&&meta){
      const old=(await db.query('SELECT action,"resourceId",result FROM command_operations WHERE "actorId"=$1 AND "operationId"=$2',[actor.authId,meta.operationId])).rows[0];
      if(old){if(old.action!=='appointment.access.reissue'||old.resourceId!==id)deny(409,'COMMAND_REPLAY_CONFLICT');if(old.result?.generation!==a.generation)deny(409,'APPOINTMENT_CODE_STALE');replay=true;}
    }
    if(action==='reissue'&&!replay){
     const count=(await db.query(`SELECT COUNT(*)::int AS n FROM appointment_access_attempts WHERE "appointmentId"=$1 AND kind='reissue' AND "createdAt">NOW()-INTERVAL '1 hour'`,[id])).rows[0].n;
     if(count>=3)deny(429,'APPOINTMENT_CODE_REISSUE_LIMIT');
     await db.query(`INSERT INTO appointment_access_attempts("appointmentId","doctorId",kind) VALUES($1,$2,'reissue')`,[id,row.doctorId]);await issueAppointmentCode(db,row,environment);
    }
    if(action==='reissue'&&!replay)await changed('code_reissued');
    const current=(await accessRow(db,id))!;
    if(!current.ciphertext)deny(409,'APPOINTMENT_CODE_UNAVAILABLE');
    if(action==='reissue'&&!replay&&meta)await db.query(`INSERT INTO command_operations(id,"actorId","operationId",action,"resourceId","requestHash",status,result,"createdAt","updatedAt") VALUES($1,$2,$3,'appointment.access.reissue',$4,$5,'completed',$6::jsonb,NOW(),NOW())`,[randomUUID(),actor.authId,meta.operationId,id,meta.requestHash,JSON.stringify({generation:current.generation})]);
    const code=accessCrypto(environment).retrieve(current.ciphertext,accessBinding(current));
    await db.query('COMMIT');return{code,generation:current.generation,reference:displayReference(current.reference)};
   }
   if(actor.role!=='doctor'||!('code' in input))deny(403,'APPOINTMENT_ACCESS_DOCTOR_REQUIRED');
   // Serialize the cross-booking doctor throttle, retaining attempts across reissues.
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['appointment-access-doctor:'+row.doctorId]);
   if(input.expectedVersion!==row.version||input.generation!==a.generation)deny(409,'APPOINTMENT_CODE_STALE');
   if(a.consumedAt)deny(409,'APPOINTMENT_CODE_ALREADY_USED');
   if(a.attempts>=5)deny(423,'APPOINTMENT_CODE_LOCKED');
   const end=row.slotEndsAt??row.proposedEndAt??row.scheduledAt;
   if(clock()<row.scheduledAt.getTime()-1800000||clock()>end.getTime()+7200000)deny(403,'APPOINTMENT_CODE_OUTSIDE_WINDOW');
   const paid=(await db.query(`SELECT 1 FROM appointment_payment_projections WHERE "appointmentId"=$1 AND status='paid' AND NOT "reviewRequired" AND "billingLineageId"=$2 AND "associationVersion"=$3`,[id,row.billingLineageId,row.associationVersion])).rowCount;
   if(row.status!=='confirmed'||!paid||row.paperworkLockedAt||row.doctorConfirmedAt||effectiveCompletionDeadline(row).getTime()<=clock())deny(403,'APPOINTMENT_CODE_PAYMENT_REQUIRED');
   await assertRecordsIdle(db,row);await currentPaid(db,row,financial);
   const rate=(await db.query(`SELECT COUNT(*) FILTER(WHERE "doctorId"=$2)::int AS doctor,COUNT(*) FILTER(WHERE "appointmentId"=$1)::int AS booking FROM appointment_access_attempts WHERE kind='redeem' AND "createdAt">NOW()-INTERVAL '1 hour' AND ("appointmentId"=$1 OR "doctorId"=$2)`,[id,row.doctorId])).rows[0];
   if(rate.doctor>=30||rate.booking>=10)deny(429,'APPOINTMENT_CODE_RATE_LIMIT');
   await db.query(`INSERT INTO appointment_access_attempts("appointmentId","doctorId",kind) VALUES($1,$2,'redeem')`,[id,row.doctorId]);
   if(!a.digest||!accessCrypto(environment).verify(input.code,accessBinding(a),a.digest)){
    await db.query('UPDATE appointment_access SET attempts=attempts+1 WHERE "appointmentId"=$1',[id]);await db.query('COMMIT');return{state:a.attempts+1>=5?'locked':'review_only',error:'APPOINTMENT_CODE_INCORRECT',attemptsRemaining:4-a.attempts};
   }
   await db.query('UPDATE appointment_access SET "consumedAt"=NOW(),"grantedAt"=NOW(),"grantUntil"=$2,digest=NULL,ciphertext=NULL WHERE "appointmentId"=$1',[id,effectiveCompletionDeadline(row)]);
   await changed('redeemed');await db.query('COMMIT');return{state:'unlocked'};
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }};
}
