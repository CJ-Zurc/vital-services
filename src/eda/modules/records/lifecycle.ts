import type { PoolClient } from "pg";
import type { AppointmentOwners,AppointmentRow,RecordsTransitionContext } from "../appointment/appointment-contracts.js";
import { assertPaperwork,medicalConsent,paperworkDeadline,recordsDenied } from "./authorization.js";
import { freezeLocalEvidence } from "./freeze.js";
import type { RecordsKeyring } from "./protection.js";

export function createRecordsLifecycle(keyring:RecordsKeyring,clock=Date.now):NonNullable<AppointmentOwners["records"]> {
  async function grant(tx:PoolClient,row:AppointmentRow,status:string,version:number) {
    await tx.query(`INSERT INTO records_episode_grants ("appointmentId","patientId","doctorId","associationVersion","appointmentVersion",status,"createdAt","updatedAt")
      VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW()) ON CONFLICT ("appointmentId") DO UPDATE SET status=EXCLUDED.status,
      "appointmentVersion"=EXCLUDED."appointmentVersion","associationVersion"=EXCLUDED."associationVersion","updatedAt"=NOW()
      WHERE records_episode_grants."patientId"=EXCLUDED."patientId" AND records_episode_grants."doctorId"=EXCLUDED."doctorId"`,[row.id,row.patientId,row.doctorId,row.associationVersion,version,status]);
  }
  async function freeze(tx:PoolClient,row:AppointmentRow,effectiveAt:Date) {
    const episode=(await tx.query<{snapshotId:string|null;frozenSnapshotId:string|null}>(
      'SELECT "snapshotId","frozenSnapshotId" FROM records_episode_grants WHERE "appointmentId"=$1 FOR UPDATE',[row.id])).rows[0];
    const snapshotId=episode?.frozenSnapshotId??episode?.snapshotId;
    const snapshot=snapshotId?(await tx.query<{id:string}>(`SELECT s.id FROM records_snapshots s JOIN records_workflows w ON w.id=s."workflowId" WHERE s.id=$1::uuid AND s."appointmentId"=$2 AND s."patientId"=$3
      AND s."doctorId"=$4 AND s."associationVersion"=$5 AND (s."capturedAt"<=$6 OR w.recovery=true)`,[snapshotId,row.id,row.patientId,row.doctorId,row.associationVersion,effectiveAt])).rows[0]:null;
    if(!snapshot)recordsDenied(409,"RECORD_SNAPSHOT_REQUIRED");
    await freezeLocalEvidence(tx,keyring,row,snapshot.id,effectiveAt);
    await tx.query(`UPDATE records_episode_grants SET "frozenSnapshotId"=COALESCE("frozenSnapshotId",$2::uuid),
      "paperworkCutoffAt"=COALESCE("paperworkCutoffAt",$3),"updatedAt"=NOW() WHERE "appointmentId"=$1`,[row.id,snapshot.id,effectiveAt]);
    await tx.query('UPDATE appointments SET "recordsBlockCode"=NULL WHERE id=$1',[row.id]);
  }
  async function freezeExisting(tx:PoolClient,row:AppointmentRow,effectiveAt:Date){
    const episode=(await tx.query<{snapshotId:string|null;frozenSnapshotId:string|null}>('SELECT "snapshotId","frozenSnapshotId" FROM records_episode_grants WHERE "appointmentId"=$1 FOR UPDATE',[row.id])).rows[0];
    if(episode?.snapshotId||episode?.frozenSnapshotId)await freeze(tx,row,new Date(Math.min(effectiveAt.getTime(),paperworkDeadline(row).getTime())));
  }
  return {
    async beforeDoctorAcknowledgement(tx,row,context) {
      if(context.beforeState!==row.status||context.afterState!=="confirmed")recordsDenied(409,"RECORDS_TRANSITION_CONTEXT_INVALID");
      assertPaperwork(row,context.effectiveAt.getTime());
      await medicalConsent(tx,row.patientId,row.id);await freeze(tx,row,new Date(Math.min(context.effectiveAt.getTime(),paperworkDeadline(row).getTime())));
    },
    async apply(tx,row,action,context) {
      if(!context||context.beforeState!==row.status)recordsDenied(503,"RECORDS_TRANSITION_CONTEXT_REQUIRED");
      if(action==="approve") {await medicalConsent(tx,row.patientId,row.id);await grant(tx,row,"prepared",row.version+1);}
      if(action==="confirm") {
        const p=context.financialEvidence;
        if(!p||p.status!=="paid"||p.billingLineageId!==row.billingLineageId||p.associationVersion!==row.associationVersion)
          recordsDenied(409,"RECORDS_FINANCIAL_EVIDENCE_REQUIRED");
        await medicalConsent(tx,row.patientId,row.id);await grant(tx,row,"live",row.version+1);
      }
      if(action==="cancel"){
        await freezeExisting(tx,row,context.effectiveAt);
        await tx.query(`UPDATE records_episode_grants SET status=CASE WHEN "snapshotId" IS NULL THEN 'revoked' ELSE 'historical' END,
        "paperworkCutoffAt"=COALESCE("paperworkCutoffAt",$2),"appointmentVersion"=$3,"updatedAt"=NOW() WHERE "appointmentId"=$1`,[row.id,context.effectiveAt,row.version+1]);
      }
      if(action==="expire") {
        // Booking expiry must not revoke an independently valid paid clinical window.
        if(row.status==="confirmed"&&paperworkDeadline(row).getTime()>clock())return;
        await freezeExisting(tx,row,context.effectiveAt);
        await tx.query(`UPDATE records_episode_grants SET status=CASE WHEN "snapshotId" IS NULL THEN 'revoked' ELSE 'historical' END,
          "paperworkCutoffAt"=COALESCE("paperworkCutoffAt",$2),"updatedAt"=NOW() WHERE "appointmentId"=$1`,[row.id,context.effectiveAt]);
      }
      if(action==="complete") {
        await medicalConsent(tx,row.patientId,row.id);await freeze(tx,row,context.effectiveAt);
        await tx.query(`UPDATE records_episode_grants SET status='historical',"appointmentVersion"=$2,"updatedAt"=NOW() WHERE "appointmentId"=$1`,[row.id,row.version+1]);
      }
      if(action==="reschedule") {
        if(!context.replacement)recordsDenied(503,"RECORDS_REPLACEMENT_REQUIRED");
        await freezeExisting(tx,row,context.effectiveAt);
        await tx.query(`UPDATE records_episode_grants SET status=CASE WHEN "snapshotId" IS NULL THEN 'revoked' ELSE 'historical' END,
          "paperworkCutoffAt"=COALESCE("paperworkCutoffAt",$2),"updatedAt"=NOW() WHERE "appointmentId"=$1`,[row.id,context.effectiveAt]);
        await grant(tx,{...context.replacement,associationVersion:row.associationVersion+1},"transferring",context.replacement.version+1);
      }
    },
    async finalizeReschedule(tx,_source,replacement,context) {
      if(context.afterState!==replacement.status)recordsDenied(409,"RECORDS_TRANSITION_CONTEXT_INVALID");
      await tx.query(`UPDATE records_episode_grants SET status=$3,"appointmentVersion"=$2,"updatedAt"=NOW()
        WHERE "appointmentId"=$1 AND status='transferring' AND "associationVersion"=$4`,[replacement.id,replacement.version,replacement.status==="confirmed"?"live":"prepared",replacement.associationVersion]);
    },
  };
}
