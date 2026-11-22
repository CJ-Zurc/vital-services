import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError, requireScope, type Actor } from '../../contracts/actor.js';
import { requestHash } from '../../infrastructure/security.js';
import { appendSqlOutbox } from '../../infrastructure/outbox.js';
import { appointmentCommand, appointmentOwn, lockAppointment, membership, appointmentTransition } from './appointment.js';
import { effectiveCompletionDeadline, appointmentFactData, requireOwner, type AppointmentCommand, type AppointmentOwners } from './appointment-contracts.js';

const uuid = z.uuid(), utc = z.iso.datetime();
export const nativeIntakeInput = z.object({
  subject: z.string().trim().min(3).max(255), description: z.string().trim().min(5).max(5000),
  complaint_type: z.enum(['doctor_no_show','missing_paperwork','technical_failure','doctor_conduct','mutual_absence','other']),
  evidence_ids: z.array(uuid).max(5).default([]), expectedVersion: z.number().int().nonnegative().optional(),
}).strict();
export const nativeEvent = z.object({
  contract_version: z.literal(1), event_id: uuid, report_id: uuid, case_id: uuid, appointment_id: uuid,
  state_version: z.number().int().positive(), correlation_id: uuid, occurred_at: utc,
  stage: z.number().int().min(2).max(5), intake_status: z.enum(['approved','rejected','in_process','completed','resolved','auto_resolved']),
  decided_by_admin_id: uuid.nullable(), decided_at: utc.nullable(), rejection_reason: z.string().max(5000).nullable(),
  ticket_id: uuid.nullable(), ticket_number: z.string().max(50).nullable(), dispute_seq: z.number().int().nullable(),
  decision_id: uuid.nullable(), supersedes_decision_id: uuid.nullable(),
  outcome_tag: z.enum(['reschedule','invalidate','complete']).nullable(), outcome_explanation: z.string().max(5000).nullable(),
  resolution_method: z.enum(['patient_acknowledged','auto_resolved_72h']).nullable(),
  fault_classification:z.enum(['doctor_fault','patient_fault','mutual_absence','other']).nullable(),
  refund_approved: z.boolean(), refund_reference: z.string().max(255).nullable(), refund_issued_at: utc.nullable(),
}).strict().superRefine((value,ctx)=>{
  const stages={approved:2,rejected:2,in_process:3,completed:4,resolved:5,auto_resolved:5};
  if(stages[value.intake_status]!==value.stage||value.stage===5&&(value.intake_status==='resolved'?value.resolution_method!=='patient_acknowledged':value.resolution_method!=='auto_resolved_72h')||value.stage!==5&&value.resolution_method!==null)
    ctx.addIssue({code:'custom',message:'Inconsistent dispute stage and resolution method'});
});
export type NativeEvent = z.infer<typeof nativeEvent>;
export const nativeResponse = z.object({decision_id: uuid, reason: z.string().trim().min(5).max(2000).optional()}).strict();
const unavailable = (code: string, status = 409): never => { throw new DomainError(status, code, 'The dispute action is unavailable. Refresh the appointment or contact BGH.'); };
export const disputesEnabled = () => process.env.VITAL_TRACE_DISPUTES_ENABLED === 'true';
function enabled() { if (!disputesEnabled()) unavailable('APPOINTMENT_DISPUTES_DISABLED', 503); }
export async function enqueueDispute(tx: PoolClient, reportId: string, kind: string, payload: unknown, correlationId: string, id = randomUUID()) {
  await tx.query(`INSERT INTO trace_dispute_deliveries (id,"reportId",kind,payload,"correlationId") VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(id) DO NOTHING`,
    [id, reportId, kind, JSON.stringify(payload), correlationId]);
}
export async function submitNativeDispute(pool: Pool, actor: Actor, id: string, meta: AppointmentCommand, body: unknown, clock = Date.now) {
  enabled(); const input = nativeIntakeInput.parse(body);
  return appointmentCommand(pool, actor, 'appeal', id, meta, input, async tx => {
    const row = await lockAppointment(tx, id); appointmentOwn(actor, row);
    if (actor.role !== 'patient') unavailable('APPOINTMENT_OWNER_DENIED', 403);
    const existing = (await tx.query('SELECT * FROM appointment_disputes WHERE "appointmentId"=$1', [id])).rows[0];
    if (existing) {
      if (existing.reporterAuthId !== actor.authId || existing.rejectionReason || existing.stage === 5) unavailable('APPOINTMENT_DISPUTE_CONTACT_BGH');
      return {reportId: existing.id, disputeStage: existing.stage, operationStatus: 'completed', deliveryStatus: existing.deliveryStatus};
    }
    if (row.consultationType !== 'virtual' || row.status !== 'confirmed') unavailable('APPOINTMENT_APPEAL_INELIGIBLE');
    if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) unavailable('APPOINTMENT_VERSION_CHANGED');
    if (row.scheduledAt.getTime() > clock() || effectiveCompletionDeadline(row).getTime() <= clock()) unavailable('APPOINTMENT_APPEAL_INELIGIBLE');
    if (input.complaint_type === 'doctor_no_show' && clock() < row.scheduledAt.getTime() + 15 * 60000) unavailable('APPOINTMENT_NO_SHOW_TOO_EARLY');
    const evidence = (await tx.query(`SELECT * FROM trace_dispute_evidence WHERE id=ANY($1::uuid[]) AND "appointmentId"=$2 AND "reporterAuthId"=$3 AND "reportId" IS NULL AND status IN ('quarantined','verified') FOR UPDATE`,
      [input.evidence_ids, id, actor.authId])).rows;
    if (evidence.length !== input.evidence_ids.length || new Set(input.evidence_ids).size !== input.evidence_ids.length) unavailable('APPOINTMENT_EVIDENCE_DENIED', 403);
    const reportId = randomUUID(), submittedAt = new Date(clock()).toISOString(), deadline = effectiveCompletionDeadline(row);
    await tx.query(`INSERT INTO appointment_disputes (id,"appointmentId",stage,subject,category,description,"reporterAuthId","originalStatus","originalCompletionDeadlineAt","deliveryStatus","evidenceIds","createdAt","updatedAt")
      VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,'pending',$9::jsonb,$10,$10)`,
      [reportId, id, input.subject, input.complaint_type, input.description, actor.authId, row.status, deadline, JSON.stringify(input.evidence_ids), submittedAt]);
    await tx.query('UPDATE trace_dispute_evidence SET "reportId"=$1 WHERE id=ANY($2::uuid[])', [reportId, input.evidence_ids]);
    await tx.query(`UPDATE appointments SET status='in_review',"reviewHold"=true,"completionDeadlineAt"=COALESCE("completionDeadlineAt",$2),version=version+1,"updatedAt"=now() WHERE id=$1`, [id, deadline]);
    row.version++;
    await enqueueDispute(tx, reportId, 'intake', {
      contract_version: 1, report_id: reportId, appointment_id: id, patient_id: row.patientId, doctor_id: row.doctorId,
      reporter_auth_id: actor.authId, source_system: 'vital', appointment_type: 'telemedicine', submitted_at: submittedAt,
      subject: input.subject, description: input.description, complaint_type: input.complaint_type,
      evidence: evidence.map(e => ({attachment_id: e.id, title: e.title, mime_type: e.mimeType, sha256: e.contentHash, byte_length: e.byteLength})),
    }, actor.correlationId);
    await appendSqlOutbox(tx, {producer:'appointment',eventType:'vital.appointment.appeal_started',aggregateId:id,aggregateVersion:row.version,
      correlationId:actor.correlationId,causationId:meta.operationId,data:appointmentFactData(row,actor.authId,meta.operationId)});
    await appendSqlOutbox(tx, {producer:'appointment',eventType:'vital.audit.requested',aggregateId:id,aggregateVersion:row.version,
      correlationId:actor.correlationId,causationId:meta.operationId,data:{auditType:'vital.appointment.appeal_started',actorAuthId:actor.authId,resourceId:id,resourceType:'appointment'}});
    return {reportId, disputeStage:1, reviewHold:true, status:'in_review', deliveryStatus:'pending', operationStatus:'completed'};
  });
}
export async function respondNativeDispute(pool: Pool, actor: Actor, id: string, meta: AppointmentCommand, body: unknown, action: 'acknowledge'|'reject', clock = Date.now) {
  enabled(); const input = nativeResponse.parse(body);
  if (action === 'reject' && !input.reason) unavailable('APPOINTMENT_DISPUTE_REASON_REQUIRED', 400);
  return appointmentCommand(pool, actor, action === 'reject' ? 'reject-completion' : 'acknowledge-dispute', id, meta, input, async tx => {
    const row = await lockAppointment(tx, id); appointmentOwn(actor, row);
    const dispute = (await tx.query('SELECT * FROM appointment_disputes WHERE "appointmentId"=$1 FOR UPDATE', [id])).rows[0];
    if (actor.role !== 'patient' || dispute?.reporterAuthId !== actor.authId) unavailable('APPOINTMENT_OWNER_DENIED', 403);
    const old = (await tx.query('SELECT * FROM trace_dispute_responses WHERE "reportId"=$1 AND "decisionId"=$2',[dispute.id,input.decision_id])).rows[0];
    if (old) {
      if (old.action !== action || old.reason !== (input.reason ?? null)) unavailable('APPOINTMENT_DISPUTE_RESPONSE_CONFLICT');
      return {operationId:old.id, operationStatus:old.status};
    }
    const timeout = await tx.query('SELECT id FROM trace_dispute_timeouts WHERE "reportId"=$1 AND "decisionId"=$2',[dispute.id,input.decision_id]);
    if (row.status!=='in_review'||!row.reviewHold||dispute.stage !== 4 || dispute.decisionId !== input.decision_id || !dispute.acknowledgmentDeadlineAt || clock() >= new Date(dispute.acknowledgmentDeadlineAt).getTime() || timeout.rows.length) unavailable('APPOINTMENT_DISPUTE_RESPONSE_CLOSED');
    const operationId = randomUUID(), acceptedAt = new Date(clock()).toISOString();
    await tx.query(`INSERT INTO trace_dispute_responses (id,"reportId","decisionId",action,reason,"acceptedAt") VALUES($1,$2,$3,$4,$5,$6)`,[operationId,dispute.id,input.decision_id,action,input.reason??null,acceptedAt]);
    await enqueueDispute(tx,dispute.id,'response',{contract_version:1,operation_id:operationId,report_id:dispute.id,case_id:dispute.traceCaseId,appointment_id:id,
      reporter_auth_id:actor.authId,decision_id:input.decision_id,action,feedback_reason:input.reason??null,accepted_at:acceptedAt},actor.correlationId,operationId);
    return {operationId,operationStatus:'pending'};
  });
}
export async function readNativeDispute(pool:Pool,actor:Actor,id:string){
  requireScope(actor,'appointments.dispute',id);await membership(pool,actor,'patient');
  const row=await locklessOwned(pool,actor,id);
  const report=(await pool.query(`SELECT ad.*,r.id AS "responseOperationId",r.status AS "responseStatus" FROM appointment_disputes ad
    LEFT JOIN trace_dispute_responses r ON r."reportId"=ad.id AND r."decisionId"=ad."decisionId" WHERE ad."appointmentId"=$1`,[id])).rows[0];
  if(report&&report.reporterAuthId!==actor.authId)unavailable('APPOINTMENT_DISPUTE_REVIEW_REQUIRED');
  return {enabled:disputesEnabled(),contactRequired:row.status==='completed'||Boolean(report?.rejectionReason),
    hospitalPhone:process.env.VITAL_BGH_CONTACT_PHONE??null,hospitalAddress:process.env.VITAL_BGH_CONTACT_ADDRESS??null,
    report:report?{reportId:report.id,caseId:report.traceCaseId,stage:report.stage,rejectionReason:report.rejectionReason,
      ticketNumber:report.traceTicketNumber,disputeSeq:report.traceDisputeSeq,decisionId:report.decisionId,proposedOutcomeTag:report.proposedOutcomeTag,
      proposedExplanation:report.proposedExplanation,acknowledgmentDeadlineAt:report.acknowledgmentDeadlineAt,resolutionMethod:report.resolutionMethod,
      deliveryStatus:report.deliveryStatus,responseOperationId:report.responseOperationId??null,responseStatus:report.responseStatus??null,
      refundApproved:report.refundApproved,refundIssuedAt:report.refundIssuedAt,rescheduleGranted:report.rescheduleGranted&&!report.rescheduleConsumedAt}:null};
}
export async function locklessOwned(pool:Pool,actor:Actor,id:string){
  const row=(await pool.query(`SELECT a.*,p."authId" AS "patientAuthId" FROM appointments a JOIN vital_patients p ON p."userId"=a."patientId" WHERE a.id=$1`,[uuid.parse(id)])).rows[0];
  if(!row||actor.role!=='patient'||row.patientAuthId!==actor.authId)unavailable('APPOINTMENT_OWNER_DENIED',403);return row;
}
async function review(tx:PoolClient,report:any,reason:string){
  await tx.query(`INSERT INTO trace_dispute_reviews(id,"reportId","decisionId",reason) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[randomUUID(),report.id,report.decisionId,reason]);
}
export function serviceActor(actor:Actor,reportId:string){
  if(actor.role!=='service'||!process.env.VITAL_TRACE_SERVICE_ACTOR_ID||actor.authId!==process.env.VITAL_TRACE_SERVICE_ACTOR_ID)unavailable('ACTOR_SCOPE_DENIED',403);
  requireScope(actor,'trace-disputes.receive',reportId);
}
export async function receiveNativeEvent(pool:Pool,actor:Actor,body:unknown,clock=Date.now,owners:AppointmentOwners={}){
  enabled();const event=nativeEvent.parse(body);serviceActor(actor,event.report_id);
  const tx=await pool.connect();try{
    await tx.query('BEGIN');const row=await lockAppointment(tx,event.appointment_id);
    const report=(await tx.query('SELECT * FROM appointment_disputes WHERE id=$1 AND "appointmentId"=$2 FOR UPDATE',[event.report_id,row.id])).rows[0];
    if(!report||!report.reporterAuthId||report.traceCaseId&&report.traceCaseId!==event.case_id)unavailable('APPOINTMENT_DISPUTE_CASE_MISMATCH');
    const hash=requestHash('TRACE-EVENT','v1',event),old=(await tx.query('SELECT * FROM trace_dispute_inbox WHERE "eventId"=$1',[event.event_id])).rows[0];
    if(old){if(old.hash!==hash)unavailable('APPOINTMENT_DISPUTE_EVENT_CONFLICT');await tx.query('COMMIT');return old.result;}
    let result:Record<string,unknown>={applied:true};
    if(event.state_version<=report.stateVersion)result={applied:false,reason:'stale_event'};
    else if(report.decisionId&&event.decision_id!==report.decisionId&&event.supersedes_decision_id!==report.decisionId){
      await review(tx,report,'decision_predecessor_conflict');result={applied:false,reason:'admin_review'};
    }else if(report.rejectionReason&&event.intake_status!=='rejected'||report.traceTicketId&&event.ticket_id!==report.traceTicketId){
      await review(tx,report,'decided_intake_or_ticket_conflict');result={applied:false,reason:'admin_review'};
    }else if(report.decisionId===event.decision_id&&report.stage>=4&&event.stage>=4&&(
      report.proposedOutcomeTag!==event.outcome_tag||report.proposedExplanation!==event.outcome_explanation||report.refundApproved!==event.refund_approved||report.faultClassification!==event.fault_classification||report.stage===5&&event.stage!==5)){
      await review(tx,report,'decision_content_conflict');result={applied:false,reason:'admin_review'};
    }else if(event.stage===5&&report.outcomeAppliedDecisionId!==event.decision_id&&row.status!=='in_review'){
      await review(tx,report,'appointment_transition_conflict');result={applied:false,reason:'admin_review'};
    }else if(['completed','invalid','cancelled','rescheduled'].includes(row.status)&&event.stage!==5){
      await review(tx,report,'terminal_appointment_correction');result={applied:false,reason:'admin_review'};
    }else{
      if(!event.decided_by_admin_id||!event.decided_at)unavailable('APPOINTMENT_DISPUTE_DECISION_INVALID');
      if(event.stage===4&&(!event.decision_id||!event.outcome_tag||!event.outcome_explanation))unavailable('APPOINTMENT_DISPUTE_DECISION_INVALID');
      if(event.refund_approved&&(report.category==='mutual_absence'||event.fault_classification!=='doctor_fault'))unavailable('PAYMENT_REFUND_INELIGIBLE');
      const sameDecision=report.decisionId===event.decision_id;
      const available=event.stage===4?(sameDecision&&report.resolutionAvailableAt?new Date(report.resolutionAvailableAt):new Date(clock())):null;
      const deadline=available?new Date(available.getTime()+72*3600000):null;
      if(event.stage===4&&report.stage===5&&report.outcomeAppliedDecisionId&&report.outcomeAppliedDecisionId!==event.decision_id){
        await tx.query(`UPDATE appointments SET status='in_review',"reviewHold"=true,version=version+1 WHERE id=$1`,[row.id]);
      }
      if(event.stage===5&&report.outcomeAppliedDecisionId!==event.decision_id){
        if(!sameDecision||!event.decision_id)unavailable('APPOINTMENT_DISPUTE_DECISION_INVALID');
        const response=(await tx.query('SELECT * FROM trace_dispute_responses WHERE "reportId"=$1 AND "decisionId"=$2',[report.id,event.decision_id])).rows[0];
        const timeout=(await tx.query('SELECT id FROM trace_dispute_timeouts WHERE "reportId"=$1 AND "decisionId"=$2',[report.id,event.decision_id])).rows[0];
        if(event.resolution_method==='patient_acknowledged'&&response?.action!=='acknowledge'||event.resolution_method==='auto_resolved_72h'&&(!timeout||response))unavailable('APPOINTMENT_DISPUTE_RESOLUTION_UNCONFIRMED');
        if(!event.resolution_method)unavailable('APPOINTMENT_DISPUTE_RESOLUTION_UNCONFIRMED');
        // Completion is resumed by the existing maintenance owner, including payment and clinical checks.
        if(report.proposedOutcomeTag==='complete')await tx.query(`UPDATE appointments SET status='confirmed',"reviewHold"=false,"maintenanceDueAt"=now(),version=version+1 WHERE id=$1`,[row.id]);
        else if(report.proposedOutcomeTag==='invalidate'){
          if(row.status!=='in_review')unavailable('APPOINTMENT_DISPUTE_TRANSITION_INVALID');
          await requireOwner(owners.records,'records').apply(tx,row,'cancel',{operationId:event.event_id,beforeState:row.status,afterState:'invalid',effectiveAt:new Date(clock())});
          await tx.query('UPDATE appointments SET "reviewHold"=false WHERE id=$1',[row.id]);
          await appointmentTransition(tx,row,'invalid',null,event.event_id,event.correlation_id);
        }
        else if(report.proposedOutcomeTag==='reschedule'){
          await tx.query('UPDATE appointment_disputes SET "rescheduleGranted"=true WHERE id=$1',[report.id]);
          if(event.resolution_method==='auto_resolved_72h')await review(tx,report,'reschedule_selection_required');
        }
        await tx.query('UPDATE appointment_disputes SET "outcomeAppliedDecisionId"=$2 WHERE id=$1',[report.id,event.decision_id]);
      }else if(event.intake_status==='rejected'){
        if(!event.rejection_reason||report.stage>2)unavailable('APPOINTMENT_DISPUTE_REJECTION_INVALID');
        await tx.query(`UPDATE appointments SET status=$2::"AppointmentStatus","reviewHold"=false,"maintenanceDueAt"=now(),version=version+1 WHERE id=$1`,[row.id,report.originalStatus]);
      }
      await tx.query(`UPDATE appointment_disputes SET "traceCaseId"=$2,"stateVersion"=$3,stage=$4,"rejectionReason"=$5,"traceTicketId"=$6,"traceTicketNumber"=$7,"traceDisputeSeq"=$8,
        "decisionId"=$9,"proposedOutcomeTag"=$10,"proposedExplanation"=$11,"resolutionAvailableAt"=$12,"acknowledgmentDeadlineAt"=$13,"resolutionMethod"=$14,
        "refundApproved"=$15,"refundIssuedAt"=COALESCE("refundIssuedAt",$16),"refundReference"=COALESCE("refundReference",$17),"deliveryStatus"='delivered',"resolvedAt"=CASE WHEN $4=5 THEN now() ELSE NULL END,"updatedAt"=now() WHERE id=$1`,
        [report.id,event.case_id,event.state_version,event.stage,event.rejection_reason,event.ticket_id,event.ticket_number,event.dispute_seq,event.decision_id,event.outcome_tag,event.outcome_explanation,available,deadline,event.resolution_method,event.refund_approved,event.refund_issued_at,event.refund_reference]);
      await tx.query('UPDATE appointment_disputes SET "faultClassification"=$2 WHERE id=$1',[report.id,event.fault_classification]);
      if(event.stage===3||event.stage===5)await tx.query(`UPDATE trace_dispute_responses SET status='completed' WHERE "reportId"=$1 AND status='pending'`,[report.id]);
      if(available)result={applied:true,resolution_available_at:available.toISOString(),acknowledgment_deadline_at:deadline!.toISOString()};
      if(event.refund_issued_at){
        if(!event.refund_approved||!event.refund_reference||report.refundReference&&report.refundReference!==event.refund_reference)unavailable('PAYMENT_REFUND_CONFLICT');
        await enqueueDispute(tx,report.id,'refund-reconcile',{event_id:event.event_id,appointment_id:row.id,report_id:report.id,case_id:event.case_id,reference:event.refund_reference,issued_at:event.refund_issued_at},event.correlation_id);
      }
    }
    await tx.query('INSERT INTO trace_dispute_inbox("eventId","reportId",hash,result) VALUES($1,$2,$3,$4::jsonb)',[event.event_id,report.id,hash,JSON.stringify(result)]);
    await tx.query('COMMIT');return result;
  }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
}
export async function confirmNativeTimeout(pool:Pool,actor:Actor,body:unknown,clock=Date.now){
  enabled();const input=z.object({report_id:uuid,case_id:uuid,appointment_id:uuid,decision_id:uuid}).strict().parse(body);serviceActor(actor,input.report_id);
  const tx=await pool.connect();try{await tx.query('BEGIN');const appointment=await lockAppointment(tx,input.appointment_id);
    const report=(await tx.query('SELECT * FROM appointment_disputes WHERE id=$1 AND "appointmentId"=$2 FOR UPDATE',[input.report_id,input.appointment_id])).rows[0];
    if(!report||report.traceCaseId!==input.case_id||report.decisionId!==input.decision_id||report.stage!==4||!report.acknowledgmentDeadlineAt)unavailable('APPOINTMENT_DISPUTE_DECISION_INVALID');
    if(appointment.status!=='in_review'||!appointment.reviewHold){await review(tx,report,'timeout_appointment_conflict');await tx.query('COMMIT');return{confirmed:false};}
    const response=(await tx.query('SELECT id FROM trace_dispute_responses WHERE "reportId"=$1 AND "decisionId"=$2',[report.id,input.decision_id])).rows[0];
    if(response||new Date(report.acknowledgmentDeadlineAt).getTime()>clock()){await tx.query('COMMIT');return{confirmed:false};}
    await tx.query('INSERT INTO trace_dispute_timeouts(id,"reportId","decisionId") VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[randomUUID(),report.id,input.decision_id]);
    const receipt=(await tx.query('SELECT id,"confirmedAt" FROM trace_dispute_timeouts WHERE "reportId"=$1 AND "decisionId"=$2',[report.id,input.decision_id])).rows[0];
    await tx.query('COMMIT');return{confirmed:true,confirmation_id:receipt.id,confirmed_at:new Date(receipt.confirmedAt).toISOString()};
  }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
}
