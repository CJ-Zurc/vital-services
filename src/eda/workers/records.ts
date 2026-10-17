import type { Pool } from "pg";
import { parseEvent,type EventEnvelope } from "../contracts/events.js";
import { processWithInbox } from "../infrastructure/outbox.js";

export async function consumeRecordsEvent(pool:Pool,raw:EventEnvelope,consumer:'records-artifact'|'records-appointment') {
  const event=parseEvent(raw);
  if(consumer==='records-artifact'?event.producer!=='records':event.producer!=='appointment')throw new Error('RECORDS_EVENT_SUBSCRIPTION_MISMATCH');
  await processWithInbox(pool,consumer,event,async tx=>{
    const committed=(await tx.query<{eventType:string;aggregateId:string;aggregateVersion:number}>(
      'SELECT "eventType","aggregateId","aggregateVersion" FROM outbox_events WHERE id=$1',[event.eventId])).rows[0];
    if(!committed||committed.eventType!==event.eventType||committed.aggregateId!==event.aggregateId||committed.aggregateVersion!==event.aggregateVersion)throw new Error('RECORDS_SOURCE_EVIDENCE_MISSING');
    if(event.eventType==='vital.records.artifact.requested'){
      const op=(await tx.query<{resourceId:string}>('SELECT "resourceId" FROM record_operations WHERE id=$1::uuid',[event.data.operationId])).rows[0];
      if(!op||op.resourceId!==event.data.assetId||op.resourceId!==event.aggregateId)throw new Error('RECORDS_OPERATION_EVIDENCE_MISSING');
      await tx.query(`UPDATE record_operations SET "nextAttemptAt"=LEAST("nextAttemptAt",NOW()) WHERE id=$1::uuid AND state='pending'`,[event.data.operationId]);
    }else if(event.eventType==='vital.records.snapshot.captured'){
      const snapshot=(await tx.query<{appointmentId:string;patientId:string}>('SELECT "appointmentId","patientId" FROM records_snapshots WHERE id=$1::uuid',[event.aggregateId])).rows[0];
      if(!snapshot||snapshot.appointmentId!==event.data.appointmentId||snapshot.patientId!==event.data.patientId)throw new Error('RECORDS_SNAPSHOT_EVIDENCE_MISSING');
      await tx.query('UPDATE appointments SET "maintenanceDueAt"=LEAST("maintenanceDueAt",NOW()) WHERE id=$1',[snapshot.appointmentId]);
    }else if(event.eventType==='vital.records.artifact.ready'){
      const asset=(await tx.query<{state:string;version:number}>(`SELECT state,version FROM records_file_assets WHERE id=$1::uuid`,[event.aggregateId])).rows[0];
      if(!asset||asset.state!=='ready'||asset.version<event.aggregateVersion)throw new Error('RECORDS_PUBLICATION_EVIDENCE_MISSING');
    }else if(consumer==='records-appointment'){
      // Lifecycle access effects already committed with Appointment in Core.
      // This consumer verifies their source and wakes persisted work, not a second grant writer.
      const appointment=(await tx.query<{version:number}>('SELECT version FROM appointments WHERE id=$1',[event.aggregateId])).rows[0];
      if(!appointment||appointment.version<event.aggregateVersion)throw new Error('RECORDS_APPOINTMENT_EVIDENCE_MISSING');
      await tx.query('UPDATE appointments SET "maintenanceDueAt"=LEAST("maintenanceDueAt",NOW()) WHERE id=$1',[event.aggregateId]);
    }else throw new Error('RECORDS_EVENT_SUBSCRIPTION_MISMATCH');
  });
}
