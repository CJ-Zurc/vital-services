import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { PaymentModule } from "../../http/payment-router.js";
import { DomainError } from "../../contracts/actor.js";
import { appendSqlOutbox } from "../../infrastructure/outbox.js";
import { requestHash } from "../../infrastructure/security.js";
import { appointmentExpired, appointmentFactData, effectiveCompletionDeadline, type AppointmentOwners } from "./appointment-contracts.js";
import { appointmentTransition, lockAppointment, resolveOpenProposals } from "./appointment.js";

export function completionDue(row:{scheduledAt:Date;proposedEndAt:Date|null;slotEndsAt:Date|null;completionDeadlineAt:Date|null},now:number){
  return effectiveCompletionDeadline(row).getTime()<=now;
}

async function checkTraceAppealStatus(appealReference: string, deadline: Date): Promise<{ status: "submitted" | "confirmed_no_response" | "sync_pending"; caseId?: string | null; submittedAt?: string; watermark?: string }> {
  const traceUrl = process.env.TRACE_BASE_URL?.replace(/\/$/, "");
  const traceKey = process.env.TRACE_INTERNAL_SERVICE_KEY;
  if (!traceUrl || !traceKey) return { status: "sync_pending" };
  try {
    const query = new URLSearchParams({ appeal_reference: appealReference, deadline: deadline.toISOString() });
    const res = await fetch(traceUrl + "/api/patient-forms/responses/check?" + query, {
      method: "GET",
      headers: {
        "X-Internal-Service": "vital",
        "X-Internal-Service-Key": traceKey,
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return { status: "sync_pending" };
    const json = (await res.json()) as { status: "submitted" | "confirmed_no_response" | "sync_pending"; case_id?: string | null; submitted_at?: string; sync_watermark?: string };
    return { status: json.status, caseId: json.case_id, submittedAt: json.submitted_at, watermark: json.sync_watermark };
  } catch {
    return { status: "sync_pending" };
  }
}
export function createAppointmentMaintenance(core:Pool,owners:AppointmentOwners,payment:PaymentModule|undefined,clock=Date.now){
  async function lifecycle(){
    if(!owners.records)return{processed:0,blocked:"RECORDS_OWNER_UNAVAILABLE"};
    const cutoffEnabled = process.env.VITAL_TRACE_DISPUTES_ENABLED === "true";
    const candidates=(await core.query<{id:string}>(`SELECT a.id FROM appointments a LEFT JOIN schedules s ON s.id=a."scheduleSlotId"
      WHERE a.status IN ('pending','approved','confirmed','pending_patient_confirmation') AND a."maintenanceDueAt"<=NOW() AND (
        (a.status='confirmed' AND NOT a."reviewHold" AND COALESCE(a."completionDeadlineAt",COALESCE(a."proposedEndAt",a."scheduledAt")+INTERVAL '48 hours')<=NOW()) OR
        (a."expiryProcessedAt" IS NULL AND COALESCE((s."slotDate"+s."endTime"+CASE WHEN s."endTime"<=s."startTime" THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END) AT TIME ZONE 'Asia/Manila',a."proposedEndAt",a."scheduledAt")<=NOW()) OR
        ($1::boolean AND a.status IN ('pending','approved','pending_patient_confirmation') AND a."expiryProcessedAt" IS NULL AND a."scheduledAt"-INTERVAL '3 hours'<=NOW()))
      ORDER BY a."maintenanceDueAt",a.id LIMIT 20`,[cutoffEnabled])).rows;
    let processed=0;
    for(const candidate of candidates){const tx=await core.connect();try{
      await tx.query("BEGIN");const row=await lockAppointment(tx,candidate.id);
      await tx.query('UPDATE appointments SET "maintenanceDueAt"=$2 WHERE id=$1',[row.id,new Date(clock()+60000)]);
      if(row.reviewHold||row.status==='in_review'){await tx.query("COMMIT");continue;}
      const busy=await tx.query(`SELECT id FROM saga_operations WHERE "billingLineageId"=$1 AND status NOT IN ('completed','compensated','cancelled','failed') LIMIT 1`,[row.billingLineageId]);
      const proposal=await tx.query(`SELECT id FROM appointments WHERE "sourceAppointmentId"=$1 AND status IN ('pending','pending_patient_confirmation') LIMIT 1`,[row.id]);
      if(busy.rows.length){await tx.query("COMMIT");continue;}
      const operationId=randomUUID();let logId:string|null=null;let committedAt:Date|null=null;let kind:string|null=null;
      if(row.status==='confirmed'&&completionDue(row,clock())){
        if(proposal.rows.length){await tx.query("COMMIT");continue;}
        if(!owners.financial){await tx.query("COMMIT");continue;}
        const projection=(await tx.query('SELECT * FROM appointment_payment_projections WHERE "appointmentId"=$1',[row.id])).rows[0];
        if(!projection||projection.status!=='paid'||projection.reviewRequired||projection.billingLineageId!==row.billingLineageId||projection.associationVersion!==row.associationVersion){await tx.query("COMMIT");continue;}
        await owners.financial.verifyPaid(row,projection);
        try{await owners.records.apply(tx,row,"complete",{operationId,beforeState:row.status,afterState:"completed",effectiveAt:effectiveCompletionDeadline(row),financialEvidence:projection});}
        catch(error){if(error instanceof DomainError&&error.code==='RECORD_SNAPSHOT_REQUIRED'){
          await tx.query('UPDATE appointments SET "recordsBlockCode"=\'RECORD_SNAPSHOT_REQUIRED\' WHERE id=$1',[row.id]);await tx.query("COMMIT");continue;}throw error;}
        await tx.query('UPDATE appointments SET "completedAt"=$2,"autoCompletedAt"=$2,"paperworkLockedAt"=COALESCE("paperworkLockedAt",$2) WHERE id=$1',[row.id,new Date(clock())]);
        const receipt=await appointmentTransition(tx,row,'completed',null,operationId,operationId);logId=receipt.logId;committedAt=receipt.changedAt;kind='complete';
      }else if(['pending','approved','confirmed','pending_patient_confirmation'].includes(row.status)&&(appointmentExpired(row,clock())||(cutoffEnabled&&['pending','approved','pending_patient_confirmation'].includes(row.status)&&(row.scheduledAt.getTime()-10800000)<=clock()))){
        const isCutoff=!appointmentExpired(row,clock());
        if (isCutoff) {
          const activePayment = await tx.query(
            'SELECT 1 FROM appointment_payment_projections WHERE "appointmentId" = $1 AND status IN ($2, $3)',
            [row.id, "pending", "paid"],
          );
          if (activePayment.rows.length) {
            await tx.query("COMMIT");
            continue;
          }
        }
        const terminal=row.sourceAppointmentId?'rejected':isCutoff?'cancelled':row.status;
        await owners.records.apply(tx,row,"expire",{operationId,beforeState:row.status,afterState:terminal,effectiveAt:new Date(clock())});committedAt=new Date(clock());logId=randomUUID();kind='expire';
        const prior=row.status;
        const cancelReason=isCutoff?'payment_deadline_expired':null;
        const changed=await tx.query('UPDATE appointments SET "expiryProcessedAt"=$2,status=$4::"AppointmentStatus","cancellationReason"=COALESCE("cancellationReason",$5),version=version+1,"updatedAt"=NOW() WHERE id=$1 AND version=$3 AND "expiryProcessedAt" IS NULL RETURNING version',[row.id,committedAt,row.version,terminal,cancelReason]);
        if(changed.rowCount!==1){await tx.query("COMMIT");continue;}row.version=changed.rows[0].version;
        row.status=terminal;
        await tx.query('INSERT INTO appointment_logs (id,"appointmentId","fromStatus","toStatus","changedByRole",note,"changedAt") VALUES($1,$2,$3,$4,\'service\',$6,$5)',[logId,row.id,prior,terminal,committedAt,isCutoff?'payment_deadline_expired':'expired']);
        await resolveOpenProposals(tx,row,null,operationId,operationId,isCutoff?'source_cancelled':'source_expired');
        await appendSqlOutbox(tx,{producer:"appointment",eventType:isCutoff?"vital.appointment.cancelled":"vital.appointment.expired",aggregateId:row.id,aggregateVersion:row.version,correlationId:operationId,causationId:operationId,data:appointmentFactData(row,null,operationId)});
        await appendSqlOutbox(tx,{producer:"appointment",eventType:"vital.audit.requested",aggregateId:row.id,aggregateVersion:row.version,correlationId:operationId,
          data:{auditType:isCutoff?"vital.appointment.cancelled":"vital.appointment.expired",actorAuthId:null,resourceId:row.id,resourceType:"appointment"}});
      }
      if(kind&&logId&&committedAt){
        const quote=(await tx.query('SELECT "billingLineageId" FROM appointment_billing_quotes WHERE "billingLineageId"=$1',[row.billingLineageId])).rows[0];
        const projection=kind==='complete'?(await tx.query('SELECT "sourceVersion" FROM appointment_payment_projections WHERE "appointmentId"=$1',[row.id])).rows[0]:null;
        if(quote)await tx.query(`INSERT INTO appointment_billing_intents (id,"appointmentId","billingLineageId","appointmentVersion","associationVersion","actorAuthId","operationId","requestHash",kind,state,"expiresAt","committedAt","ownerLogId","expectedPaymentVersion","createdAt")
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'committed',$10,$10,$11,$12,NOW())`,[randomUUID(),row.id,row.billingLineageId,row.version,row.associationVersion,operationId,operationId,requestHash("MAINTENANCE",kind,{id:row.id,version:row.version}),kind,committedAt,logId,projection?.sourceVersion??null]);
        processed++;
      }await tx.query("COMMIT");
    }catch(error){await tx.query("ROLLBACK");if(!(error instanceof DomainError))throw error;}finally{tx.release();}}

    try {
      const expiredHolds = (await core.query<{ id: string; appealReference: string; appealDeadlineAt: Date; disputedAt: Date | null; version: number }>(
        `SELECT id, "appealReference", "appealDeadlineAt", "disputedAt", version FROM appointments
         WHERE status = 'in_review' AND "reviewHold" = true AND "traceCaseId" IS NULL AND "appealDeadlineAt" <= NOW()
         LIMIT 10`
      )).rows;

      for (const hold of expiredHolds) {
        if (!hold.appealReference) continue;
        const traceCheck = await checkTraceAppealStatus(hold.appealReference, hold.appealDeadlineAt);
        const submittedAt = Date.parse(traceCheck.submittedAt ?? "");
        if (traceCheck.status === "submitted" && traceCheck.caseId && hold.disputedAt &&
            submittedAt >= hold.disputedAt.getTime() && submittedAt <= hold.appealDeadlineAt.getTime()) {
          await core.query(
            `UPDATE appointments SET "traceCaseId" = $2, "updatedAt" = NOW() WHERE id = $1 AND "appealReference" = $3 AND "reviewHold" AND "traceCaseId" IS NULL`,
            [hold.id, traceCheck.caseId, hold.appealReference]
          );
        } else if (traceCheck.status === "confirmed_no_response" &&
                   Date.parse(traceCheck.watermark ?? "") >= hold.appealDeadlineAt.getTime()) {
          const tx = await core.connect();
          try {
            await tx.query("BEGIN");
            const row = await lockAppointment(tx, hold.id);
            if (!row.reviewHold || row.status !== "in_review" || row.traceCaseId ||
                row.appealReference !== hold.appealReference || row.version !== hold.version) {
              await tx.query("COMMIT");
              continue;
            }
            const nextStatus = "confirmed";

            await tx.query(
              `UPDATE appointments SET
                "reviewHold" = false,
                status = $2::"AppointmentStatus",
                version = version + 1,
                "updatedAt" = NOW()
              WHERE id = $1`,
              [hold.id, nextStatus]
            );

            await tx.query(
              `INSERT INTO appointment_logs (id, "appointmentId", "fromStatus", "toStatus", "changedByRole", note, "changedAt")
               VALUES ($1, $2, 'in_review', $3, 'service', $4, NOW())`,
              [randomUUID(), hold.id, nextStatus, "abandoned_appeal_hold_released"]
            );

            await appendSqlOutbox(tx, {
              producer: "appointment",
              eventType: "vital.appointment.appeal_hold_released",
              aggregateId: hold.id,
              aggregateVersion: row.version + 1,
              correlationId: randomUUID(),
              causationId: randomUUID(),
              data: { appointmentId: hold.id }
            });

            await tx.query("COMMIT");
          } catch {
            await tx.query("ROLLBACK");
          } finally {
            tx.release();
          }
        }
      }
    } catch {}

    return{processed,blocked:null};
  }
  async function deliverBilling(){
    if(!payment)return 0;const owner=randomUUID();
    const rows=(await core.query<{id:string;kind:string;deliveryAttempts:number}>(`WITH due AS (SELECT id FROM appointment_billing_intents WHERE state='committed' AND kind IN ('refund','expire','complete')
      AND (("deliveryStatus"='pending' AND "nextDeliveryAt"<=NOW()) OR ("deliveryStatus"='processing' AND "deliveryLeaseUntil"<=NOW())) ORDER BY "nextDeliveryAt",id LIMIT 20 FOR UPDATE SKIP LOCKED)
      UPDATE appointment_billing_intents i SET "deliveryStatus"='processing',"deliveryLeaseOwner"=$1,"deliveryLeaseUntil"=NOW()+INTERVAL '60 seconds'
      FROM due WHERE i.id=due.id RETURNING i.id,i.kind,i."deliveryAttempts"`,[owner])).rows;
    for(let start=0;start<rows.length;start+=2)await Promise.all(rows.slice(start,start+2).map(async row=>{
      try{const outcome=row.kind==='complete'?await payment.completeInvoice(row.id,row.id):await payment.applyAppointmentIntent(row.id,row.id);
        const uncertain=typeof outcome==='object'&&outcome!==null&&'operationStatus'in outcome&&['unknown','pending'].includes(String(outcome.operationStatus));
        await core.query('UPDATE appointment_billing_intents SET "deliveryStatus"=$3,"deliveryLeaseOwner"=NULL,"deliveryLeaseUntil"=NULL,"deliveryErrorCode"=$4 WHERE id=$1::uuid AND "deliveryLeaseOwner"=$2 AND "deliveryLeaseUntil">NOW()',[row.id,owner,uncertain?'blocked':'delivered',uncertain?'FINANCIAL_OUTCOME_UNRESOLVED':null]);
      }catch(error){const permanent=error instanceof DomainError&&[400,403,404,409,422].includes(error.status);
        await core.query('UPDATE appointment_billing_intents SET "deliveryStatus"=$3,"deliveryAttempts"="deliveryAttempts"+1,"nextDeliveryAt"=$4,"deliveryErrorCode"=$5,"deliveryLeaseOwner"=NULL,"deliveryLeaseUntil"=NULL WHERE id=$1::uuid AND "deliveryLeaseOwner"=$2',[row.id,owner,permanent||row.deliveryAttempts>=9?'blocked':'pending',new Date(clock()+Math.min(60*2**row.deliveryAttempts,3600)*1000),error instanceof DomainError?error.code:'BILLING_DELIVERY_UNAVAILABLE']);}
    }));return rows.length;
  }
  return{lifecycle,deliverBilling};
}
