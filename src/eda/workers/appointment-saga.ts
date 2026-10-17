import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { parseEvent,type EventEnvelope } from '../contracts/events.js';
import { envelopeFromRow,processWithInbox,type OutboxRow } from '../infrastructure/outbox.js';

// Commit a durable coordinator wake-up before ACK. The existing worker resumes
// the owner protocols under fenced leases; broker delivery is not a business ACK.
export async function consumeSagaCommand(core:Pool,raw:EventEnvelope){
  const event=parseEvent(raw);
  if(event.eventType!=='vital.appointment.participant.requested'||event.producer!=='appointment')throw new Error('SAGA_COMMAND_SUBSCRIPTION_MISMATCH');
  const fact=(await core.query<OutboxRow>('SELECT * FROM outbox_events WHERE id=$1',[event.eventId])).rows[0];
  if(!fact||!isDeepStrictEqual(envelopeFromRow(fact),event))throw new Error('SAGA_COMMAND_UNCOMMITTED');
  await processWithInbox(core,'appointment-saga',event,async tx=>{
    const saga=(await tx.query('SELECT * FROM saga_operations WHERE id=$1 FOR UPDATE',[event.data.operationId])).rows[0];
    if(!saga||saga.sourceAppointmentId!==event.aggregateId||saga.billingLineageId!==event.data.billingLineageId||saga.associationVersion!==event.data.associationVersion)throw new Error('SAGA_COMMAND_BINDING_INVALID');
    const state={prepare:'preparing',abort:'compensating',finalize:'finalizing'}[String(event.data.phase) as 'prepare'|'abort'|'finalize'];
    if(saga.status===state)await tx.query('UPDATE saga_operations SET "nextAttemptAt"=NOW() WHERE id=$1',[saga.id]);
  });
}
