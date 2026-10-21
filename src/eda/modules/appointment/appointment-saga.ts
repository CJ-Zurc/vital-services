import { rescheduleNotification } from './appointment-notifications.js';
import { randomUUID,createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { DomainError, requireScope, type Actor } from "../../contracts/actor.js";
import { appointmentCommand, appointmentOwn, appointmentTransition, assertCalendarAvailable, calendarLock, lockAppointment, membership, readAppointment } from "./appointment.js";
import { appointmentExpired,appointmentFactData,rescheduleAllowed, requireOwner, versionSchema, type AppointmentCommand, type AppointmentOwners, type ParticipantReceipt,type AppointmentRow } from "./appointment-contracts.js";
import { appendSqlOutbox } from "../../infrastructure/outbox.js";

const acceptInput=z.object({expectedVersion:versionSchema,expectedSourceVersion:versionSchema}).strict();
type Saga={id:string;sourceAppointmentId:string;replacementAppointmentId:string;expectedSourceVersion:number;expectedReplacementVersion:number;
  billingLineageId:string;associationVersion:number;requestHash:string;status:string;actorAuthId:string;actorRole:"doctor"|"patient";
  correlationId:string;reservationId:string;deadlineAt:Date;pivotCommittedAt:Date|null;fence:number;leaseOwner:string;leaseUntil:Date;
  attempts:number;prepareReceipts:Record<string,ParticipantReceipt>|null;targetRequest:{initiator:"doctor"|"patient"}};
function fail(code:string):never{throw new DomainError(409,code,"Appointment reschedule is unavailable.");}
export function createAppointmentSaga(pool:Pool,owners:AppointmentOwners,clock=Date.now){
  const participants=()=>({payment:requireOwner(owners.payment,"payment"),video:requireOwner(owners.video,"video").participant});
  const read=async(id:string):Promise<Saga>=>{const row=(await pool.query<Saga>('SELECT * FROM saga_operations WHERE id=$1',[id])).rows[0];if(!row)fail("SAGA_NOT_FOUND");return row;};
  async function participantCommand(tx:import("pg").PoolClient,saga:Pick<Saga,'id'|'actorAuthId'|'correlationId'>,source:AppointmentRow,phase:'prepare'|'abort'|'finalize'){
    const bytes=createHash('sha256').update('appointment-saga:'+saga.id+':'+phase).digest().subarray(0,16);bytes[6]=(bytes[6]!&15)|80;bytes[8]=(bytes[8]!&63)|128;
    const hex=bytes.toString('hex');const eventId=[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
    if((await tx.query('SELECT id FROM outbox_events WHERE id=$1',[eventId])).rows.length)return;
    await appendSqlOutbox(tx,{eventId,producer:'appointment',eventType:'vital.appointment.participant.requested',aggregateId:source.id,aggregateVersion:source.version,
      correlationId:saga.correlationId,causationId:saga.id,data:{...appointmentFactData(source,saga.actorAuthId,saga.id),phase,participants:['payment','video']}});
  }
  async function local<T>(id:string,owner:string,fence:number,run:(tx:import("pg").PoolClient,saga:Saga)=>Promise<T>){const tx=await pool.connect();try{
    await tx.query("BEGIN");const preview=(await tx.query<Saga>('SELECT * FROM saga_operations WHERE id=$1',[id])).rows[0];if(!preview)fail("SAGA_NOT_FOUND");await calendarLock(tx,(await readAppointment(tx,preview.sourceAppointmentId)).doctorId);
    const saga=(await tx.query<Saga>('SELECT * FROM saga_operations WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!saga||saga.leaseOwner!==owner||saga.fence!==fence||!saga.leaseUntil||saga.leaseUntil.getTime()<=clock())fail("SAGA_LEASE_LOST");
    const result=await run(tx,saga);await tx.query("COMMIT");return result;
  }catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}}
  function validReceipt(receipt:ParticipantReceipt,saga:Saga,name:string){
    if(receipt.participant!==name||receipt.operationId!==saga.id||receipt.requestHash!==saga.requestHash||receipt.billingLineageId!==saga.billingLineageId
      ||receipt.sourceAppointmentId!==saga.sourceAppointmentId||receipt.replacementAppointmentId!==saga.replacementAppointmentId
      ||receipt.expectedSourceVersion!==saga.expectedSourceVersion||receipt.expectedReplacementVersion!==saga.expectedReplacementVersion
      ||receipt.associationVersion!==saga.associationVersion||!z.uuid().safeParse(receipt.freezeToken).success
      ||receipt.resourceId===null&&receipt.resourceVersion!==null||receipt.resourceId!==null&&(!z.uuid().safeParse(receipt.resourceId).success||!Number.isInteger(receipt.resourceVersion)))fail("SAGA_PARTICIPANT_RECEIPT_INVALID");
  }
  async function advance(id:string){
    const owner=randomUUID();const claim=(await pool.query<Saga>(`UPDATE saga_operations SET "leaseOwner"=$2,"leaseUntil"=$3,fence=fence+1,"updatedAt"=NOW()
      WHERE id=$1 AND status IN ('preparing','compensating','finalizing') AND ("leaseUntil" IS NULL OR "leaseUntil"<=NOW()) RETURNING *`,[id,owner,new Date(clock()+60000)])).rows[0];
    if(!claim)return;const required=participants();requireOwner(owners.records,"records");let saga=claim;
    const renewals=new Set<Promise<void>>();
    const heartbeat=setInterval(()=>{const task=local(id,owner,claim.fence,async(tx,current)=>{
      await tx.query('UPDATE saga_operations SET "leaseUntil"=$2 WHERE id=$1',[id,new Date(clock()+60000)]);
      if(!current.pivotCommittedAt)await tx.query('UPDATE slot_reservations SET "leaseUntil"=$2 WHERE id=$1 AND status=\'reserved\'',[current.reservationId,new Date(clock()+60000)]);
    }).catch(()=>undefined).finally(()=>renewals.delete(task));renewals.add(task);},15000);
    try{
      if(!saga.pivotCommittedAt&&(saga.status==="compensating"||saga.deadlineAt.getTime()<=clock())){
        await local(id,owner,claim.fence,async(tx,current)=>{await tx.query('UPDATE saga_operations SET status=\'compensating\' WHERE id=$1',[id]);
          await participantCommand(tx,current,await readAppointment(tx,current.sourceAppointmentId),'abort');});
        for(const [name,participant]of Object.entries(required)){
          // The owning participant resolves its own uncertain freeze under its lock.
          // Never prepare new resources merely to compensate an uncommitted attempt.
          const receipt=saga.prepareReceipts?.[name];if(receipt)validReceipt(receipt,saga,name);await participant.abort(id,receipt?.freezeToken);
        }
        await local(id,owner,claim.fence,async(tx)=>{await tx.query('UPDATE slot_reservations SET status=\'released\',"releasedAt"=NOW() WHERE id=$1 AND status=\'reserved\'',[saga.reservationId]);
          await tx.query('UPDATE saga_operations SET status=\'compensated\',"completedAt"=NOW(),"leaseOwner"=NULL,"leaseUntil"=NULL WHERE id=$1',[id]);});return;
      }
      if(!saga.pivotCommittedAt){
        for(const[name,participant]of Object.entries(required)){
          const receipt=saga.prepareReceipts?.[name]??await participant.prepare(id);validReceipt(receipt,saga,name);
          await local(id,owner,claim.fence,async(tx,current)=>{
            const reservation=(await tx.query('SELECT * FROM slot_reservations WHERE id=$1 FOR UPDATE',[current.reservationId])).rows[0];
            if(!reservation||reservation.status!=="reserved")fail("SAGA_RESERVATION_LOST");
            await assertCalendarAvailable(tx,reservation.doctorId,reservation.startsAt,reservation.endsAt,[current.sourceAppointmentId,current.replacementAppointmentId],id);
            await tx.query('UPDATE slot_reservations SET "leaseUntil"=$2 WHERE id=$1',[current.reservationId,new Date(clock()+60000)]);
            await tx.query('UPDATE saga_operations SET "prepareReceipts"=$2::jsonb,"leaseUntil"=$3 WHERE id=$1',[id,JSON.stringify({...current.prepareReceipts,[name]:receipt}),new Date(clock()+60000)]);
          });saga=await read(id);
        }
        await local(id,owner,claim.fence,async(tx,current)=>{
          const source=await readAppointment(tx,current.sourceAppointmentId,true);const next=await readAppointment(tx,current.replacementAppointmentId,true);
          if(source.version!==current.expectedSourceVersion||next.version!==current.expectedReplacementVersion||!['approved','confirmed'].includes(source.status)
            ||!['pending','pending_patient_confirmation'].includes(next.status)||appointmentExpired(source,clock())||appointmentExpired(next,clock())||current.deadlineAt.getTime()<=clock())fail("SAGA_PREPARATION_STALE");
          for(const name of Object.keys(required)){const receipt=current.prepareReceipts?.[name];if(!receipt)fail("SAGA_RECEIPT_REQUIRED");validReceipt(receipt,current,name);}
          const reservation=(await tx.query('SELECT * FROM slot_reservations WHERE id=$1 AND status=\'reserved\' FOR UPDATE',[current.reservationId])).rows[0];
          if(!reservation||reservation.leaseUntil.getTime()<=clock())fail("SAGA_RESERVATION_LOST");
          await assertCalendarAvailable(tx,source.doctorId,next.scheduledAt,next.proposedEndAt??next.scheduledAt,[source.id,next.id],id);
          if(source.status==='confirmed'&&!current.prepareReceipts?.payment?.verifiedPaid)fail("SAGA_PAID_RECEIPT_REQUIRED");
          await requireOwner(owners.records,"records").apply(tx,source,"reschedule",{operationId:id,beforeState:source.status,afterState:"rescheduled",replacement:next,effectiveAt:new Date(clock())});
          const initiator=current.targetRequest.initiator;if(!rescheduleAllowed(source,initiator))fail("RESCHEDULE_LIMIT_REACHED");
          await tx.query('UPDATE appointments SET "ehrCaseId"=NULL WHERE id=$1',[source.id]);
          await tx.query(`INSERT INTO consultations (id,"appointmentId","videoResourceId","videoResourceVersion") VALUES($1,$2,$3,$4)
            ON CONFLICT ("appointmentId") DO NOTHING`,[randomUUID(),next.id,current.prepareReceipts?.video?.resourceId??null,
            current.prepareReceipts?.video?.resourceVersion===null?null:(current.prepareReceipts?.video?.resourceVersion??0)+1]);
          await tx.query('UPDATE appointments SET "ehrCaseId"=$2,"ehrCaseCreatedAt"=(SELECT "ehrCaseCreatedAt" FROM appointments WHERE id=$3),"associationVersion"=$4,"patientRescheduleCount"=$5,"doctorRescheduleCount"=$6 WHERE id=$1',
            [next.id,source.ehrCaseId,source.id,source.associationVersion+1,source.patientRescheduleCount+(initiator==='patient'?1:0),source.doctorRescheduleCount+(initiator==='doctor'?1:0)]);
          next.associationVersion=source.associationVersion+1;
          const actor:Actor={authId:current.actorAuthId,role:current.actorRole,serviceId:"vital-web",scopes:[],resource:source.id,correlationId:current.correlationId,isSuperAdmin:false};
          const receipt=await appointmentTransition(tx,source,"rescheduled",actor,id,current.correlationId,null,{replacementAppointmentId:next.id,replacementVersion:next.version+1},
            {initiatorRole:initiator,initiatorAuthId:initiator==='doctor'?source.doctorAuthId:source.patientAuthId,acceptedByAuthId:current.actorAuthId,
              originalStart:source.scheduledAt.toISOString(),originalEnd:(source.slotEndsAt??source.proposedEndAt)?.toISOString()??null,
              replacementStart:next.scheduledAt.toISOString(),replacementEnd:next.proposedEndAt?.toISOString()??null});
          await appointmentTransition(tx,next,current.prepareReceipts?.payment?.verifiedPaid?'confirmed':'approved',actor,id,current.correlationId);
          await tx.query('UPDATE slot_reservations SET status=\'consumed\',"consumedAt"=NOW() WHERE id=$1',[current.reservationId]);
          await tx.query('UPDATE saga_operations SET status=\'finalizing\',"pivotCommittedAt"=$2,"ownerLogId"=$3,"leaseUntil"=$4 WHERE id=$1',[id,receipt.changedAt,receipt.logId,new Date(clock()+60000)]);
          await participantCommand(tx,current,source,'finalize');
        });saga=await read(id);
      }
      for(const[name,participant]of Object.entries(required)){const receipt=saga.prepareReceipts?.[name];if(!receipt)fail("SAGA_RECEIPT_REQUIRED");validReceipt(receipt,saga,name);await participant.finalize(id,receipt.freezeToken);}
      await local(id,owner,claim.fence,async(tx,current)=>{
        const records=requireOwner(owners.records,"records");
        const source=await readAppointment(tx,current.sourceAppointmentId,true),replacement=await readAppointment(tx,current.replacementAppointmentId,true);
        await records.finalizeReschedule?.(tx,source,replacement,{operationId:id,beforeState:source.status,afterState:replacement.status,replacement,effectiveAt:new Date(clock())});
        await rescheduleNotification(tx,replacement,{authId:current.actorAuthId,role:current.actorRole,correlationId:current.correlationId} as Actor,
          id,'appointment.rescheduled',current.targetRequest.initiator==='doctor'?replacement.patientAuthId:replacement.doctorAuthId);
        await tx.query('UPDATE saga_operations SET status=\'completed\',"completedAt"=NOW(),"leaseOwner"=NULL,"leaseUntil"=NULL WHERE id=$1',[id]);});
    }catch(error){
      const permanent=error instanceof DomainError&&[400,403,404,409,422].includes(error.status);
      await pool.query(`UPDATE saga_operations SET status=CASE WHEN attempts>=9 THEN 'review_required' WHEN "pivotCommittedAt" IS NULL AND $4 THEN 'compensating' ELSE status END,
        attempts=attempts+1,"lastErrorCode"=$5,"nextAttemptAt"=$6,"leaseOwner"=NULL,"leaseUntil"=NULL WHERE id=$1 AND "leaseOwner"=$2 AND fence=$3`,
        [id,owner,claim.fence,permanent,error instanceof DomainError?error.code:"SAGA_DEPENDENCY_UNAVAILABLE",new Date(clock()+Math.min(60*2**Math.min(saga.attempts,6),3600)*1000)]);
    }finally{clearInterval(heartbeat);await Promise.allSettled(renewals);}
  }
  return{
    async accept(actor:Actor,proposalId:string,meta:AppointmentCommand,body:unknown){const input=acceptInput.parse(body);
      const response=await appointmentCommand(pool,actor,"accept-reschedule",proposalId,meta,input,async tx=>{
        await membership(tx,actor);const proposal=await lockAppointment(tx,proposalId);appointmentOwn(actor,proposal);
        if(!proposal.sourceAppointmentId||proposal.version!==input.expectedVersion||!(actor.role==='patient'&&proposal.status==='pending_patient_confirmation'||actor.role==='doctor'&&proposal.status==='pending'))fail("RESCHEDULE_ACCEPT_INVALID");
        const source=await readAppointment(tx,proposal.sourceAppointmentId,true);if(source.version!==input.expectedSourceVersion||!['approved','confirmed'].includes(source.status)||appointmentExpired(source,clock())||appointmentExpired(proposal,clock()))fail("RESCHEDULE_SOURCE_CHANGED");
        participants();requireOwner(owners.records,"records");
        const active=await tx.query(`SELECT id FROM saga_operations WHERE "billingLineageId"=$1 AND status NOT IN ('completed','compensated','cancelled','failed') LIMIT 1`,[source.billingLineageId]);if(active.rows.length)fail("APPOINTMENT_TRANSITION_PENDING");
        await assertCalendarAvailable(tx,source.doctorId,proposal.scheduledAt,proposal.proposedEndAt??proposal.scheduledAt,[source.id,proposal.id]);
        const initiator=proposal.proposalRole;if(!['doctor','patient'].includes(initiator??''))fail("RESCHEDULE_INITIATOR_UNVERIFIED");if(!rescheduleAllowed(source,initiator as 'doctor'|'patient'))fail("RESCHEDULE_LIMIT_REACHED");
        const id=meta.operationId;const reservationId=randomUUID();
        // Reclaim only uncommitted expired holds while holding the same doctor calendar lock.
        await tx.query(`UPDATE slot_reservations r SET status='released',"releasedAt"=NOW() WHERE r."doctorId"=$1 AND r.status='reserved' AND r."leaseUntil"<=NOW()
          AND NOT EXISTS(SELECT 1 FROM saga_operations s WHERE s.id=r."operationId" AND s."pivotCommittedAt" IS NOT NULL)`,[source.doctorId]);
        await tx.query(`INSERT INTO slot_reservations (id,"slotKey","doctorId","operationId","appointmentId","startsAt","endsAt","leaseUntil",status,fence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved',1)`,
          [reservationId,source.doctorId+':'+proposal.scheduledAt.toISOString(),source.doctorId,id,proposal.id,proposal.scheduledAt,proposal.proposedEndAt??proposal.scheduledAt,new Date(clock()+60000)]);
        await tx.query(`INSERT INTO saga_operations (id,kind,"sourceAppointmentId","replacementAppointmentId","actorAuthId","actorRole","expectedSourceVersion","expectedReplacementVersion","billingLineageId","associationVersion","requestHash",status,"deadlineAt","correlationId","reservationId","requiredParticipants","targetRequest","createdAt","updatedAt")
          VALUES($1,'reschedule',$2,$3,$4,$5,$6,$7,$8,$9,$10,'preparing',$11,$12,$13,'["payment","video"]'::jsonb,$14::jsonb,NOW(),NOW())`,
          [id,source.id,proposal.id,actor.authId,actor.role,source.version,proposal.version,source.billingLineageId,source.associationVersion,meta.requestHash,new Date(clock()+300000),actor.correlationId,reservationId,JSON.stringify({initiator})]);
        await participantCommand(tx,{id,actorAuthId:actor.authId,correlationId:actor.correlationId},source,'prepare');
        return{operationId:id,appointmentId:proposal.id,operationStatus:"processing"};
      });await advance(response.operationId);return response;
    },
    async status(actor:Actor,id:string){requireScope(actor,"appointments.operation.read",id);
      if(actor.role==='admin'){
        const admin=await pool.query('SELECT a."userId" FROM vital_admins a JOIN vital_users u ON u.id=a."userId" AND u."authId"=a."authId" WHERE a."authId"=$1',[actor.authId]);
        if(!admin.rows.length)throw new DomainError(403,'SAGA_ADMIN_REVOKED','Independent administrator membership required.');
      }else await membership(pool,actor);
      const saga=await read(id);if(actor.role!=='admin')appointmentOwn(actor,await readAppointment(pool,saga.sourceAppointmentId));
      return{operationId:id,status:saga.status,fence:saga.fence,pivotCommittedAt:saga.pivotCommittedAt,lastErrorCode:(saga as Saga&{lastErrorCode:string}).lastErrorCode};},
    advance,
    async recover(){if(!owners.records||!owners.video||!owners.payment)return 0;const due=(await pool.query<{id:string}>(`SELECT id FROM saga_operations WHERE kind='reschedule' AND status IN ('preparing','compensating','finalizing')
      AND "nextAttemptAt"<=NOW() AND ("leaseUntil" IS NULL OR "leaseUntil"<=NOW()) ORDER BY "nextAttemptAt",id LIMIT 20`)).rows;
      for(let i=0;i<due.length;i+=2)await Promise.all(due.slice(i,i+2).map(row=>advance(row.id)));return due.length;},
  };
}
