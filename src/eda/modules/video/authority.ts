import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError,type Actor } from '../../contracts/actor.js';
import { appointmentOwn,calendarLock,membership,readAppointment,abandonExpiredAppointmentWorkflow } from '../appointment/appointment.js';
import { appointmentExpired } from '../appointment/appointment-contracts.js';
import type { VideoAuthority,VideoWorkflowIntent,VideoPreparationReceipt,VideoSagaIntent } from './contracts.js';

function fail(code:string):never{throw new DomainError(409,'VIDEO_'+code,'Video authority changed.');}
export function createVideoAuthority(pool:Pool):VideoAuthority{
  const doctor=async(actor:Actor)=>({doctorId:(await membership(pool,actor,'doctor')).userId});
  return{
    doctor,
    async appointment(actor,id){await membership(pool,actor);const row=await readAppointment(pool,id);appointmentOwn(actor,row);
      const consultation=(await pool.query('SELECT "videoResourceId","videoResourceVersion" FROM consultations WHERE "appointmentId"=$1',[id])).rows[0];
      return{...row,activeFollowUp:false,videoResourceId:consultation?.videoResourceId??null,videoResourceVersion:consultation?.videoResourceVersion??null};},
    async generation(actor,id,purpose){const d=await doctor(actor),row=await readAppointment(pool,id);appointmentOwn(actor,row);if(row.doctorId!==d.doctorId)fail('DOCTOR_CHANGED');
      const active=(await pool.query(`SELECT id FROM appointments WHERE "followUpOfAppointmentId"=$1 AND status NOT IN ('cancelled','rejected') LIMIT 1`,[id])).rows.length>0;
      const pending=(await pool.query(`SELECT id FROM saga_operations WHERE "billingLineageId"=$1 AND status NOT IN ('completed','compensated','cancelled','failed') LIMIT 1`,[row.billingLineageId])).rows.length>0;
      if(pending||purpose==='approval'&&(row.consultationType!=='virtual'||row.status!=='pending'||!!row.sourceAppointmentId||appointmentExpired(row,Date.now()))||
        purpose==='follow_up'&&(row.status!=='completed'||active))fail('GENERATION_INELIGIBLE');
      return{...row,activeFollowUp:active};},
    async workflow(id):Promise<VideoWorkflowIntent>{z.uuid().parse(id);const workflow=(await pool.query('SELECT * FROM appointment_workflows WHERE id=$1::uuid',[id])).rows[0];
      if(!workflow||!['approve','follow-up'].includes(workflow.kind)||!workflow.targetAppointmentId||!workflow.videoSelectionHash||workflow.videoTargetVersion===null)fail('WORKFLOW_INTENT_REQUIRED');
      const source=await readAppointment(pool,workflow.appointmentId),target=await readAppointment(pool,workflow.targetAppointmentId);
      if(source.doctorAuthId!==workflow.actorAuthId||source.doctorId!==target.doctorId||source.patientId!==target.patientId||
        workflow.kind==='approve'&&target.id!==source.id||workflow.kind==='follow-up'&&(target as typeof target&{followUpOfAppointmentId:string}).followUpOfAppointmentId!==source.id)fail('WORKFLOW_ASSOCIATION_INVALID');
      const state=workflow.state==='committed'?'committed':workflow.state==='abandoned'?'abandoned':'prepared';
      if(state==='committed'&&(!workflow.receipt||target.version<workflow.videoTargetVersion+1||workflow.videoProcessingState!=='finalized'&&(target.version!==workflow.videoTargetVersion+1||target.status!=='approved')))fail('WORKFLOW_COMMIT_INVALID');
      if(state==='prepared'){
        const doctor=(await pool.query('SELECT d."userId" FROM vital_doctors d JOIN vital_users u ON u.id=d."userId" AND u."authId"=d."authId" WHERE d."authId"=$1 AND d."userId"=$2',[workflow.actorAuthId,source.doctorId])).rows[0];
        if(!doctor||source.version!==workflow.expectedVersion||target.version!==workflow.videoTargetVersion||target.status!=='pending')fail('WORKFLOW_PREPARATION_STALE');
      }
      return{workflowId:id,sourceAppointmentId:source.id,targetAppointmentId:target.id,doctorId:source.doctorId,doctorAuthId:source.doctorAuthId,patientAuthId:source.patientAuthId,
        kind:workflow.kind,consultationType:target.consultationType,billingLineageId:target.billingLineageId,quotaLineageId:source.billingLineageId,expectedSourceVersion:workflow.expectedVersion,expectedTargetVersion:workflow.videoTargetVersion,
        associationVersion:target.associationVersion,selectionHash:workflow.videoSelectionHash,state,expiresAt:workflow.expiresAt,externalStartedAt:workflow.externalStartedAt,videoProcessingState:workflow.videoProcessingState,receipt:workflow.videoReceipt,correlationId:workflow.videoCorrelationId};},
    async saga(id):Promise<VideoSagaIntent>{z.uuid().parse(id);const saga=(await pool.query('SELECT * FROM saga_operations WHERE id=$1',[id])).rows[0];
      if(!saga||saga.kind!=='reschedule'||!saga.replacementAppointmentId)fail('SAGA_INTENT_REQUIRED');
      const source=await readAppointment(pool,saga.sourceAppointmentId),replacement=await readAppointment(pool,saga.replacementAppointmentId);
      if(source.billingLineageId!==saga.billingLineageId||replacement.billingLineageId!==saga.billingLineageId||source.doctorId!==replacement.doctorId||source.patientId!==replacement.patientId||replacement.sourceAppointmentId!==source.id||source.associationVersion!==saga.associationVersion)fail('SAGA_ASSOCIATION_INVALID');
      if(saga.pivotCommittedAt){const log=(await pool.query('SELECT * FROM appointment_logs WHERE id=$1',[saga.ownerLogId])).rows[0];
        if(source.status!=='rescheduled'||source.version!==saga.expectedSourceVersion+1||replacement.version<saga.expectedReplacementVersion+1||replacement.associationVersion!==saga.associationVersion+1||
          !['approved','confirmed','completed','cancelled'].includes(replacement.status)||!log||log.appointmentId!==source.id||log.toStatus!=='rescheduled'||log.changedAt.getTime()!==saga.pivotCommittedAt.getTime())fail('SAGA_PIVOT_INVALID');
      }else if(source.version!==saga.expectedSourceVersion||replacement.version!==saga.expectedReplacementVersion||!['approved','confirmed'].includes(source.status)||!['pending','pending_patient_confirmation'].includes(replacement.status))fail('SAGA_PREPARATION_STALE');
      return{operationId:id,doctorId:source.doctorId,correlationId:saga.correlationId,patientAuthId:source.patientAuthId,doctorAuthId:source.doctorAuthId,sourceAppointmentId:source.id,replacementAppointmentId:replacement.id,
        expectedSourceVersion:saga.expectedSourceVersion,expectedReplacementVersion:saga.expectedReplacementVersion,billingLineageId:saga.billingLineageId,associationVersion:saga.associationVersion,requestHash:saga.requestHash,
        deadlineAt:saga.deadlineAt,pivotCommittedAt:saga.pivotCommittedAt,state:saga.status,receipt:saga.prepareReceipts?.video,sourceConsultationType:source.consultationType,replacementConsultationType:replacement.consultationType};},
    abandonExpiredWorkflow:id=>abandonExpiredAppointmentWorkflow(pool,id),
    async expiredWorkflows(){return(await pool.query<{id:string}>(`SELECT id FROM appointment_workflows WHERE state='prepared' AND "externalStartedAt" IS NULL AND "expiresAt"<=NOW() ORDER BY "expiresAt",id LIMIT 20`)).rows.map(row=>row.id);},
    async completeWorkflow(id,receipt:VideoPreparationReceipt){const tx=await pool.connect();try{await tx.query('BEGIN');
      await calendarLock(tx,(await readAppointment(tx,receipt.targetAppointmentId)).doctorId);
      const w=(await tx.query('SELECT * FROM appointment_workflows WHERE id=$1::uuid FOR UPDATE',[id])).rows[0];
      if(!w||w.state!=='committed'||!isDeepStrictEqual(w.videoReceipt,receipt)||w.targetAppointmentId!==receipt.targetAppointmentId||w.videoSelectionHash!==receipt.selectionHash)fail('WORKFLOW_RECEIPT_INVALID');
      const target=await readAppointment(tx,w.targetAppointmentId,true);
      if(w.videoProcessingState==='finalized'){await tx.query('COMMIT');return;}
      if(target.status!=='approved'||target.version!==receipt.expectedTargetVersion+1||target.billingLineageId!==receipt.billingLineageId||target.associationVersion!==receipt.associationVersion)fail('WORKFLOW_TARGET_CHANGED');
      const prior=(await tx.query('SELECT "videoResourceId" FROM consultations WHERE "appointmentId"=$1 FOR UPDATE',[target.id])).rows[0];
      if(prior?.videoResourceId&&prior.videoResourceId!==receipt.resourceId)fail('CONSULTATION_RESOURCE_CHANGED');
      await tx.query(`INSERT INTO consultations (id,"appointmentId","videoResourceId","videoResourceVersion") VALUES($1,$2,$3,$4)
        ON CONFLICT ("appointmentId") DO UPDATE SET "videoResourceId"=EXCLUDED."videoResourceId","videoResourceVersion"=EXCLUDED."videoResourceVersion"`,[randomUUID(),target.id,receipt.resourceId,receipt.resourceVersion===null?null:receipt.resourceVersion+1]);
      await tx.query(`UPDATE appointment_workflows SET "videoProcessingState"='finalized',"updatedAt"=NOW() WHERE id=$1::uuid`,[id]);await tx.query('COMMIT');
    }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}},
  };
}
