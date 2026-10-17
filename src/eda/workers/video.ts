import type { Pool } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { parseEvent,type EventEnvelope } from '../contracts/events.js';
import { processWithInbox } from '../infrastructure/outbox.js';

export async function consumeVideoWorkflow(core:Pool,raw:EventEnvelope){
  const event=parseEvent(raw);
  if(event.eventType!=='vital.video.workflow.finalization.requested'||event.producer!=='appointment')throw new Error('VIDEO_EVENT_SUBSCRIPTION_MISMATCH');
  await processWithInbox(core,'video-workflow',event,async tx=>{
    const source=(await tx.query('SELECT "eventType","aggregateId","aggregateVersion",payload FROM outbox_events WHERE id=$1',[event.eventId])).rows[0];
    const workflow=(await tx.query('SELECT state,"targetAppointmentId","videoReceipt","commitOperationId" FROM appointment_workflows WHERE id=$1::uuid',[event.data.workflowId])).rows[0];
    if(!source||source.eventType!==event.eventType||source.aggregateId!==event.aggregateId||source.aggregateVersion!==event.aggregateVersion||
      !isDeepStrictEqual(source.payload,event.data)||event.aggregateId!==event.data.appointmentId||event.aggregateVersion!==event.data.appointmentVersion||
      !workflow||workflow.state!=='committed'||workflow.targetAppointmentId!==event.data.appointmentId||workflow.commitOperationId!==event.data.operationId||!workflow.videoReceipt)throw new Error('VIDEO_COMMITTED_WORKFLOW_REQUIRED');
    // Persist the wake-up before ACK; the bounded scan retries real finalization.
    await tx.query(`UPDATE appointment_workflows SET "videoProcessingState"='finalization_pending',"updatedAt"=NOW() WHERE id=$1::uuid AND "videoProcessingState"='prepared'`,[event.data.workflowId]);
  });
}

export async function consumeVideoFact(integrations:Pool,raw:EventEnvelope){
  const event=parseEvent(raw);
  if(event.producer!=='video'||!['vital.video.resource.changed','vital.video.generation.changed'].includes(event.eventType))throw new Error('VIDEO_EVENT_SUBSCRIPTION_MISMATCH');
  await processWithInbox(integrations,'video-state',event,async tx=>{
    const source=(await tx.query('SELECT "eventType","aggregateId","aggregateVersion",payload FROM outbox_events WHERE id=$1',[event.eventId])).rows[0];
    if(!source||source.eventType!==event.eventType||source.aggregateId!==event.aggregateId||source.aggregateVersion!==event.aggregateVersion||!isDeepStrictEqual(source.payload,event.data))throw new Error('VIDEO_SOURCE_EVIDENCE_REQUIRED');
    // Facts are durable observation receipts, never requests to generate another room.
  });
}
