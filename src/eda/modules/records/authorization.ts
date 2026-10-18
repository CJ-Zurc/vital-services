import type { PoolClient } from "pg";
import { DomainError, type Actor } from "../../contracts/actor.js";
import type { AppointmentRow } from "../appointment/appointment-contracts.js";
import type { AppointmentOwners } from "../appointment/appointment-contracts.js";
import { effectiveCompletionDeadline } from "../appointment/appointment-contracts.js";

export function recordsDenied(status:number,code:string):never {throw new DomainError(status,code,"Records operation is unavailable.");}
export function paperworkDeadline(row:Pick<AppointmentRow,"completionDeadlineAt"|"scheduledAt"|"proposedEndAt">) {
  return effectiveCompletionDeadline(row);
}
export function assertPaperwork(row:AppointmentRow, now:number) {
  if(row.status!=="confirmed"||row.doctorConfirmedAt||row.paperworkLockedAt||paperworkDeadline(row).getTime()<=now)
    recordsDenied(409,"RECORDS_PAPERWORK_CLOSED");
}
export async function medicalConsent(tx:Pick<PoolClient,"query">,patientId:string,appointmentId?:string|null) {
  const receipt=(await tx.query<{accepted:boolean}>(`SELECT accepted FROM consent_records WHERE "patientId"=$1
    AND "consentType"='medical_record' AND ("appointmentId" IS NULL OR "appointmentId"=$2)
    ORDER BY "consentedAt" DESC,id DESC LIMIT 1`,[patientId,appointmentId??null])).rows[0];
  if(!receipt?.accepted)recordsDenied(403,"RECORDS_MEDICAL_CONSENT_REQUIRED");
}
export async function assertRecordsIdle(tx:Pick<PoolClient,"query">,row:AppointmentRow) {
  const saga=(await tx.query(`SELECT id FROM saga_operations WHERE "billingLineageId"=$1
    AND status NOT IN ('completed','compensated','cancelled','failed') LIMIT 1`,[row.billingLineageId])).rows;
  const proposal=(await tx.query(`SELECT id FROM appointments WHERE "sourceAppointmentId"=$1
    AND status IN ('pending','pending_patient_confirmation') LIMIT 1`,[row.id])).rows;
  if(saga.length||proposal.length)recordsDenied(409,"RECORDS_APPOINTMENT_TRANSITION_PENDING");
}
export async function currentPaid(tx:Pick<PoolClient,"query">,row:AppointmentRow,financial:AppointmentOwners["financial"]){
  if(!financial)recordsDenied(503,"RECORDS_FINANCIAL_OWNER_UNAVAILABLE");
  const p=(await tx.query<{paymentId:string;sourceVersion:number;status:string;reviewRequired:boolean;billingLineageId:string;associationVersion:number}>(
    'SELECT * FROM appointment_payment_projections WHERE "appointmentId"=$1',[row.id])).rows[0];
  if(!p||p.status!=="paid"||p.reviewRequired||p.billingLineageId!==row.billingLineageId||p.associationVersion!==row.associationVersion)
    recordsDenied(409,"RECORDS_VERIFIED_PAYMENT_REQUIRED");
  await financial.verifyPaid(row,p);
  return p;
}
export function assignedDoctor(actor:Actor,row:AppointmentRow) {
  if(actor.role!=="doctor"||actor.authId!==row.doctorAuthId)recordsDenied(403,"RECORDS_DOCTOR_DENIED");
}
export function normalizeEhrSnapshot(value:unknown):unknown {
  let nodes=0;
  const walk=(input:unknown,depth:number):unknown=>{
    if(++nodes>50_000||depth>40)recordsDenied(400,"RECORDS_SNAPSHOT_LIMIT");
    if(Array.isArray(input))return input.map(item=>walk(item,depth+1));
    if(input&&typeof input==="object"){
      const source=input as Record<string,unknown>,output:Record<string,unknown>={};
      for(const [key,item]of Object.entries(source)){
        if(["__proto__","prototype","constructor"].includes(key))recordsDenied(400,"RECORDS_SNAPSHOT_INVALID");
        // Signed URLs are transient capabilities, never historical clinical evidence.
        if(/^(?:url|file_url|download_url|signed_url|attachment_url)$/i.test(key)&&typeof item==="string"&&/^https?:\/\//i.test(item)){
          const attachmentId=source.attachment_id??source.file_id??source.id;
          if(typeof attachmentId==="string")output[key]={owner:"uhse-ehr",attachmentId};
          continue;
        }
        output[key]=walk(item,depth+1);
      }return output;
    }
    if(typeof input==="string"&&/^https?:\/\//i.test(input)&&/[?&](?:X-Amz-|Signature=|token=)/i.test(input))return null;
    return input;
  };
  return walk(value,0);
}
