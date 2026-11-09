import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Actor } from '../../contracts/actor.js';
import { appendSqlOutbox } from '../../infrastructure/outbox.js';
import type { AppointmentRow } from './appointment-contracts.js';

function stableId(value: string) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const h = bytes.toString('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export async function appointmentNotification(tx: PoolClient, row: AppointmentRow, actor: Pick<Actor, 'authId'|'role'|'correlationId'>,
  operationId: string, template: 'appointment_requested'|'appointment_approved'|'appointment_rejected'|'appointment.cancelled'|'appointment.follow_up'|'appointment.reschedule_proposed'|'appointment.rescheduled'|'appointment.reschedule_declined',
  recipientAuthId: string, targetId = row.id) {
  const key = `${operationId}:${row.id}:${template}:${recipientAuthId}`;
  await appendSqlOutbox(tx, { eventId: stableId(`notification-event:${key}`),
    producer: 'appointment', eventType: 'vital.notification.requested', aggregateId: row.id, aggregateVersion: row.version,
    correlationId: actor.correlationId, causationId: operationId,
    data: { requestId: stableId(`notification-request:${key}`), recipientAuthId,
      appointmentId: targetId, template, parameters: { scheduledAt: row.scheduledAt.toISOString() } } });
}
