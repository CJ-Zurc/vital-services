import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { DomainError } from "../../contracts/actor.js";
import { appendSqlOutbox } from "../../infrastructure/outbox.js";
import type { AppointmentParticipant, ParticipantReceipt, RescheduleIntent } from "../appointment/appointment-contracts.js";

function fail(code:string):never{throw new DomainError(409,code,"Payment association is unavailable.");}
interface Hold {operationId:string;billingLineageId:string;freezeToken:string;state:string;receipt:ParticipantReceipt;paymentId:string|null;paymentVersion:number|null;requestHash:string}
export function createPaymentAssociation(pool:Pool,authority:(operationId:string)=>Promise<RescheduleIntent>,clock=Date.now):AppointmentParticipant {
  async function transaction<T>(intent:RescheduleIntent,run:(tx:PoolClient)=>Promise<T>){const tx=await pool.connect();try{await tx.query("BEGIN");await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["payment:"+intent.billingLineageId]);const result=await run(tx);await tx.query("COMMIT");return result;}catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}}
  const hold=async(tx:PoolClient,id:string)=>(await tx.query<Hold>('SELECT * FROM payment_association_holds WHERE "operationId"=$1 FOR UPDATE',[id])).rows[0];
  const binding=(receipt:ParticipantReceipt,intent:RescheduleIntent)=>receipt.operationId===intent.operationId&&receipt.participant==="payment"&&receipt.requestHash===intent.requestHash
    &&receipt.sourceAppointmentId===intent.sourceAppointmentId&&receipt.replacementAppointmentId===intent.replacementAppointmentId&&receipt.billingLineageId===intent.billingLineageId
    &&receipt.associationVersion===intent.associationVersion&&receipt.expectedSourceVersion===intent.expectedSourceVersion&&receipt.expectedReplacementVersion===intent.expectedReplacementVersion;
  return{
    async prepare(operationId){const intent=await authority(operationId);return transaction(intent,async tx=>{
      const existing=await hold(tx,operationId);if(existing){if(!binding(existing.receipt,intent)||existing.state==="aborted")fail("PAYMENT_PREPARATION_CONFLICT");return existing.receipt;}
      if(intent.pivotCommittedAt||intent.state!=="preparing"||intent.deadlineAt.getTime()<=clock())fail("PAYMENT_PREPARATION_EXPIRED");
      const conflict=await tx.query('SELECT "operationId" FROM payment_association_holds WHERE "billingLineageId"=$1 AND state=\'prepared\'',[intent.billingLineageId]);if(conflict.rows.length)fail("PAYMENT_ALREADY_FROZEN");
      const payment=(await tx.query('SELECT * FROM payments WHERE "billingLineageId"=$1 FOR UPDATE',[intent.billingLineageId])).rows[0];
      if(payment&&(payment.appointmentId!==intent.sourceAppointmentId||payment.associationVersion!==intent.associationVersion||payment.providerMode!=="sandbox"
        ||payment.patientAuthId!==intent.patientAuthId||payment.doctorAuthId!==intent.doctorAuthId||payment.currency!=="PHP"||Number(payment.amountCentavos)!==intent.amountCentavos
        ||payment.reviewRequired||payment.refundId||!['pending','paid','failed'].includes(payment.status)||payment.reconcileLeaseUntil&&payment.reconcileLeaseUntil.getTime()>clock()))fail("PAYMENT_TRANSFER_NOT_ELIGIBLE");
      if(payment){const operations=await tx.query(`SELECT id FROM payment_operations WHERE "paymentId"=$1 AND status IN ('unknown','pending') LIMIT 1`,[payment.id]);if(operations.rows.length)fail("PAYMENT_PROVIDER_OUTCOME_UNRESOLVED");
        if(payment.status==="pending"&&!payment.checkoutSessionId)fail("PAYMENT_PROVIDER_EVIDENCE_MISSING");}
      const receipt:ParticipantReceipt={operationId,participant:"payment",freezeToken:randomUUID(),requestHash:intent.requestHash,billingLineageId:intent.billingLineageId,
        associationVersion:intent.associationVersion,sourceAppointmentId:intent.sourceAppointmentId,replacementAppointmentId:intent.replacementAppointmentId,
        expectedSourceVersion:intent.expectedSourceVersion,expectedReplacementVersion:intent.expectedReplacementVersion,resourceId:payment?.id??null,resourceVersion:payment?.version??null,verifiedPaid:payment?.status==='paid'};
      await tx.query(`INSERT INTO payment_association_holds ("operationId","billingLineageId","sourceAppointmentId","replacementAppointmentId","requestHash","expectedSourceVersion","expectedReplacementVersion","associationVersion","paymentId","paymentVersion","freezeToken",state,receipt,"expiresAt","createdAt","updatedAt")
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'prepared',$12::jsonb,$13,NOW(),NOW())`,[operationId,intent.billingLineageId,intent.sourceAppointmentId,intent.replacementAppointmentId,intent.requestHash,intent.expectedSourceVersion,intent.expectedReplacementVersion,intent.associationVersion,receipt.resourceId,receipt.resourceVersion,receipt.freezeToken,JSON.stringify(receipt),intent.deadlineAt]);return receipt;
    });},
    async abort(operationId,token){const intent=await authority(operationId);if(intent.pivotCommittedAt)fail("PAYMENT_PIVOT_CANNOT_ABORT");await transaction(intent,async tx=>{const row=await hold(tx,operationId);
      if(intent.state!=="compensating")fail("PAYMENT_ABORT_INTENT_REQUIRED");
      if(!row){
        const payment=(await tx.query('SELECT * FROM payments WHERE "billingLineageId"=$1 FOR UPDATE',[intent.billingLineageId])).rows[0];
        const receipt:ParticipantReceipt={operationId,participant:"payment",freezeToken:randomUUID(),requestHash:intent.requestHash,billingLineageId:intent.billingLineageId,
          associationVersion:intent.associationVersion,sourceAppointmentId:intent.sourceAppointmentId,replacementAppointmentId:intent.replacementAppointmentId,
          expectedSourceVersion:intent.expectedSourceVersion,expectedReplacementVersion:intent.expectedReplacementVersion,resourceId:payment?.id??null,resourceVersion:payment?.version??null};
        await tx.query(`INSERT INTO payment_association_holds ("operationId","billingLineageId","sourceAppointmentId","replacementAppointmentId","requestHash","expectedSourceVersion","expectedReplacementVersion","associationVersion","paymentId","paymentVersion","freezeToken",state,receipt,"expiresAt","createdAt","updatedAt")
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'aborted',$12::jsonb,$13,NOW(),NOW())`,[operationId,intent.billingLineageId,intent.sourceAppointmentId,intent.replacementAppointmentId,intent.requestHash,intent.expectedSourceVersion,intent.expectedReplacementVersion,intent.associationVersion,receipt.resourceId,receipt.resourceVersion,receipt.freezeToken,JSON.stringify(receipt),intent.deadlineAt]);return;
      }
      if(token!==undefined&&row.freezeToken!==token||!binding(row.receipt,intent)||row.state==="finalized")fail("PAYMENT_FREEZE_RECEIPT_INVALID");if(row.state==="aborted")return;
      // Core compensating state prevents a pivot while this participant releases its hold.
      if(intent.state!=="compensating")fail("PAYMENT_ABORT_INTENT_REQUIRED");await tx.query('UPDATE payment_association_holds SET state=\'aborted\',"updatedAt"=NOW() WHERE "operationId"=$1',[operationId]);});},
    async finalize(operationId,token){const intent=await authority(operationId);if(!intent.pivotCommittedAt)fail("PAYMENT_PIVOT_REQUIRED");await transaction(intent,async tx=>{
      const row=await hold(tx,operationId);if(!row||row.freezeToken!==token||!binding(row.receipt,intent)||!intent.receipt||!isDeepStrictEqual(intent.receipt,row.receipt)||row.state==="aborted")fail("PAYMENT_FREEZE_RECEIPT_INVALID");if(row.state==="finalized")return;
      if(row.paymentId){const payment=(await tx.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE',[row.paymentId])).rows[0];if(!payment||payment.version!==row.paymentVersion||payment.appointmentId!==intent.sourceAppointmentId||payment.associationVersion!==intent.associationVersion)fail("PAYMENT_FROZEN_RESOURCE_CHANGED");
        const changed=await tx.query(`UPDATE payments SET "providerOriginAppointmentId"=COALESCE("providerOriginAppointmentId","appointmentId"),"appointmentId"=$2,"associationVersion"=$3,
          "appointmentVersion"=$4,version=version+1,"updatedAt"=NOW() WHERE id=$1 RETURNING *`,[payment.id,intent.replacementAppointmentId,intent.associationVersion+1,intent.expectedReplacementVersion+1]);const current=changed.rows[0];
        const correlationId=intent.correlationId;await appendSqlOutbox(tx,{producer:"payment",eventType:"vital.payment.changed",aggregateId:current.id,aggregateVersion:current.version,correlationId,causationId:operationId,
          data:{appointmentId:current.appointmentId,paymentId:current.id,paymentVersion:current.version,billingLineageId:current.billingLineageId,associationVersion:current.associationVersion,reviewRequired:current.reviewRequired,status:current.status}});
        await appendSqlOutbox(tx,{producer:"payment",eventType:"vital.audit.requested",aggregateId:current.id,aggregateVersion:current.version,correlationId,causationId:operationId,
          data:{auditType:"vital.payment.status_changed",actorAuthId:null,resourceId:current.id,resourceType:"payment"}});
      }
      await tx.query('UPDATE payment_association_holds SET state=\'finalized\',"finalizedAt"=NOW(),"updatedAt"=NOW() WHERE "operationId"=$1',[operationId]);
    });},
  };
}
