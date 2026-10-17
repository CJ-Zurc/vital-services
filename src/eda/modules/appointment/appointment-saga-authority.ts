import type { Pool } from "pg";
import { z } from "zod";
import { DomainError } from "../../contracts/actor.js";
import { readAppointment } from "./appointment.js";
import type { RescheduleIntent, ParticipantReceipt } from "./appointment-contracts.js";

export function createRescheduleAuthority(pool:Pool) {
  return async (operationId:string):Promise<RescheduleIntent> => {
    z.uuid().parse(operationId);
    const saga=(await pool.query('SELECT * FROM saga_operations WHERE id=$1',[operationId])).rows[0];
    if(!saga||saga.kind!=="reschedule"||!saga.replacementAppointmentId||!saga.billingLineageId)throw new DomainError(503,"SAGA_INTENT_UNAVAILABLE","Committed preparation is required.");
    const source=await readAppointment(pool,saga.sourceAppointmentId);
    const replacement=await readAppointment(pool,saga.replacementAppointmentId);
    if(source.billingLineageId!==saga.billingLineageId||replacement.billingLineageId!==saga.billingLineageId||source.doctorId!==replacement.doctorId||source.patientId!==replacement.patientId
      ||replacement.sourceAppointmentId!==source.id||saga.associationVersion!==source.associationVersion)throw new DomainError(409,"SAGA_ASSOCIATION_INVALID","Saga association changed.");
    if(saga.pivotCommittedAt){
      const log=(await pool.query('SELECT * FROM appointment_logs WHERE id=$1',[saga.ownerLogId])).rows[0];
      if(source.status!=="rescheduled"||source.version!==saga.expectedSourceVersion+1||replacement.version<saga.expectedReplacementVersion+1
        ||replacement.associationVersion!==source.associationVersion+1||["pending","pending_patient_confirmation","rejected"].includes(replacement.status)
        ||!log||log.appointmentId!==source.id||log.toStatus!=="rescheduled"||log.changedAt.getTime()!==saga.pivotCommittedAt.getTime())throw new DomainError(409,"SAGA_PIVOT_INVALID","Owner pivot receipt is invalid.");
    }else if(source.version!==saga.expectedSourceVersion||replacement.version!==saga.expectedReplacementVersion
      ||!['approved','confirmed'].includes(source.status)||!['pending','pending_patient_confirmation'].includes(replacement.status))throw new DomainError(409,"SAGA_PREPARATION_STALE","Preparation changed.");
    const quote=(await pool.query('SELECT "amountCentavos",currency,"patientAuthId","doctorAuthId","consultationType" FROM appointment_billing_quotes WHERE "billingLineageId"=$1',[source.billingLineageId])).rows[0];
    if(quote&&(quote.currency!=="PHP"||quote.patientAuthId!==source.patientAuthId||quote.doctorAuthId!==source.doctorAuthId||quote.consultationType!==source.consultationType
      ||!Number.isSafeInteger(Number(quote.amountCentavos))||Number(quote.amountCentavos)<=0))throw new DomainError(409,"SAGA_QUOTE_INVALID","Frozen quote changed.");
    return{operationId,correlationId:saga.correlationId,sourceAppointmentId:source.id,replacementAppointmentId:replacement.id,patientAuthId:source.patientAuthId,doctorAuthId:source.doctorAuthId,...(quote?{amountCentavos:Number(quote.amountCentavos)}:{}),
      expectedSourceVersion:saga.expectedSourceVersion,expectedReplacementVersion:saga.expectedReplacementVersion,
      billingLineageId:saga.billingLineageId,associationVersion:saga.associationVersion,requestHash:saga.requestHash,
      deadlineAt:saga.deadlineAt,pivotCommittedAt:saga.pivotCommittedAt,state:saga.status,
      receipt:saga.prepareReceipts?.payment as ParticipantReceipt|undefined};
  };
}
