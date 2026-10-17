import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { parseEvent, type EventEnvelope } from '../contracts/events.js';
import { processWithInbox } from '../infrastructure/outbox.js';
import { loadMessagingChain, linkedMessageAppointments } from '../modules/appointment/appointment-messaging.js';

export async function consumeMessagingEvent(pool: Pool, raw: EventEnvelope, consumer: 'messaging-appointment' | 'messaging-state') {
  const event = parseEvent(raw);
  if (consumer === 'messaging-state' ? event.eventType !== 'vital.messaging.changed' || event.producer !== 'messaging'
    : event.producer !== 'appointment' || !event.eventType.startsWith('vital.appointment.') || event.eventType === 'vital.appointment.participant.requested') throw new Error('MESSAGING_EVENT_ROUTE_INVALID');
  await processWithInbox(pool, consumer, event, async tx => {
    const source = (await tx.query<{ eventType: string; aggregateId: string; aggregateVersion: number; payload: unknown }>(
      'SELECT "eventType","aggregateId","aggregateVersion",payload FROM outbox_events WHERE id=$1', [event.eventId])).rows[0];
    if (!source || source.eventType !== event.eventType || source.aggregateId !== event.aggregateId || source.aggregateVersion !== event.aggregateVersion || !isDeepStrictEqual(source.payload, event.data)) throw new Error('MESSAGING_SOURCE_EVIDENCE_MISSING');
    if (consumer === 'messaging-state') {
      const found = (await tx.query<{ appointmentId: string; version: number }>('SELECT "appointmentId",version FROM message_conversations WHERE id=$1', [event.aggregateId])).rows[0];
      if (!found || found.appointmentId !== event.data.appointmentId || found.version < event.aggregateVersion) throw new Error('MESSAGING_STATE_EVIDENCE_MISSING');
      await tx.query('SELECT pg_notify($1,$2)::text', ['vital_message_events', JSON.stringify({ appointmentId: found.appointmentId, kind: event.data.kind })]);
      return;
    }
    const appointment = (await tx.query<{ id: string; patientId: string; doctorId: string; version: number }>('SELECT id,"patientId","doctorId",version FROM appointments WHERE id=$1', [event.aggregateId])).rows[0];
    if (!appointment || appointment.version < event.aggregateVersion) throw new Error('MESSAGING_APPOINTMENT_EVIDENCE_MISSING');
    const chain = await loadMessagingChain(tx, appointment), seed = chain.find(row => row.id === appointment.id);
    if (!seed) throw new Error('MESSAGING_CHAIN_EVIDENCE_MISSING');
    // Fence by source appointment, not by incomparable versions from different chain members.
    const fence = await tx.query(`INSERT INTO messaging_eligibility_sources ("appointmentId","sourceVersion","updatedAt") VALUES($1,$2,NOW())
      ON CONFLICT ("appointmentId") DO UPDATE SET "sourceVersion"=EXCLUDED."sourceVersion","updatedAt"=NOW()
      WHERE messaging_eligibility_sources."sourceVersion"<EXCLUDED."sourceVersion" RETURNING "appointmentId"`, [appointment.id, event.aggregateVersion]);
    if (fence.rowCount !== 1) return;
    for (const row of linkedMessageAppointments(seed, chain)) {
      await tx.query('SELECT pg_notify($1,$2)::text', ['vital_message_events', JSON.stringify({ appointmentId: row.id, kind: 'eligibility' })]);
    }
  });
}
