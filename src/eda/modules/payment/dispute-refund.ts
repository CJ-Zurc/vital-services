import type { Pool } from 'pg';
import { z } from 'zod';
import { createPaymentStore } from './payment-store.js';
import { DomainError } from '../../contracts/actor.js';
import { appendSqlOutbox } from '../../infrastructure/outbox.js';
import { requestHash } from '../../infrastructure/security.js';

/** Payment owns external-refund receipts. This operation never calls a provider. */
export async function reconcileExternalDisputeRefund(core:Pool,integrations:Pool,body:unknown){
  const input=z.object({event_id:z.uuid(),appointment_id:z.uuid(),report_id:z.uuid(),case_id:z.uuid(),reference:z.string().min(1).max(255),issued_at:z.iso.datetime()}).strict().parse(body);
  const approval=(await core.query(`SELECT ad.*,a."billingLineageId",a."associationVersion" FROM appointment_disputes ad JOIN appointments a ON a.id=ad."appointmentId"
    WHERE ad.id=$1 AND ad."appointmentId"=$2 AND ad."traceCaseId"=$3`,[input.report_id,input.appointment_id,input.case_id])).rows[0];
  if(!approval?.refundApproved||approval.category==='mutual_absence'||approval.faultClassification!=='doctor_fault')throw new DomainError(409,'PAYMENT_REFUND_INELIGIBLE','External refund is not approved.');
  const store=createPaymentStore(integrations);
  return store.transaction(approval.billingLineageId,async tx=>{
    const payment=await tx.paymentByLineage(approval.billingLineageId);
    if(!payment||payment.appointmentId!==input.appointment_id||payment.associationVersion!==approval.associationVersion)throw new DomainError(409,'PAYMENT_ASSOCIATION_CHANGED','Refund requires review.');
    const old=await tx.operation('trace-external-refund:'+input.case_id);
    if(old){if(old.providerId!==input.reference)throw new DomainError(409,'PAYMENT_REFUND_CONFLICT','Refund confirmation conflict.');return{applied:true,duplicate:true};}
    if(payment.refundedAt||!['paid','non_refundable'].includes(payment.status)||payment.refundId)throw new DomainError(409,'PAYMENT_REFUND_CONFLICT','Existing financial activity requires review.');
    const pending=await tx.operationsForPayment(payment.id);
    if(pending.some(op=>op.operationType==='refund'&&op.status!=='failed'))throw new DomainError(409,'PAYMENT_REFUND_CONFLICT','Existing financial activity requires review.');
    payment.status='refunded';payment.refundEligible=true;payment.refundedAt=input.issued_at;payment.refundReason='TRACE external refund confirmed';payment.version++;
    await tx.savePayment(payment);
    await tx.insertOperation({id:input.event_id,operationKey:'trace-external-refund:'+input.case_id,operationType:'refund',paymentId:payment.id,requestHash:requestHash('TRACE-EXTERNAL-REFUND',input.case_id,{reportId:input.report_id,reference:input.reference}),
      status:'completed',providerId:input.reference,result:{external:true,caseId:input.case_id},error:null,actorAuthId:null,authorizationIntentId:null,executionStartedAt:input.issued_at,
      firstAttemptAt:input.issued_at,leaseOwner:null,leaseUntil:null,attempts:1,requestBody:null,correlationId:input.event_id});
    await tx.emit({producer:'payment',eventType:'vital.payment.changed',aggregateId:payment.id,aggregateVersion:payment.version,correlationId:input.event_id,
      data:{appointmentId:payment.appointmentId,paymentId:payment.id,paymentVersion:payment.version,billingLineageId:payment.billingLineageId,associationVersion:payment.associationVersion,reviewRequired:payment.reviewRequired,status:payment.status}});
    return{applied:true};
  });
}
