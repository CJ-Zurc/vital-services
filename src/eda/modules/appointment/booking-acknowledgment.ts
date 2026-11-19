import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError, requireScope, type Actor } from '../../contracts/actor.js';
import { appendSqlOutbox } from '../../infrastructure/outbox.js';
import { appointmentPayloadCrypto } from './access-crypto.js';
import { appointmentOwn, membership, readAppointment } from './appointment.js';
import type { AppointmentRow } from './appointment-contracts.js';
import { bookingAcknowledgmentPdf } from '../records/bgh-pdf.js';
import type { RecordsFontConfig } from '../records/pdf.js';

export const bookingSnapshot = z.object({
  reference: z.string(), patientName: z.string().min(1), doctorName: z.string().min(1),
  consultationType: z.literal('in_person'),
  appointmentId: z.uuid(), startsAt: z.iso.datetime(), endsAt: z.iso.datetime(),
  issuedAt: z.iso.datetime(), hospital: z.string(), address: z.string(),
}).strict();
export type BookingSnapshot = z.infer<typeof bookingSnapshot>;
export type BookingNames = (patientAuthId: string, doctorAuthId: string) => Promise<{ patientName: string; doctorName: string }>;

export async function saveBookingAcknowledgment(tx: PoolClient, row: AppointmentRow, names: BookingNames, now: Date) {
  const snapshot = bookingSnapshot.parse({
    ...await names(row.patientAuthId, row.doctorAuthId),
    reference: 'VITAL-BOOK-' + row.id.toUpperCase(), appointmentId: row.id, consultationType: 'in_person',
    startsAt: row.scheduledAt.toISOString(), endsAt: (row.slotEndsAt ?? row.proposedEndAt ?? row.scheduledAt).toISOString(),
    issuedAt: now.toISOString(), hospital: 'Bernardino General Hospital 1',
    address: '680 Quirino Highway, Novaliches, Quezon City',
  });
  await tx.query(`INSERT INTO appointment_booking_acknowledgments ("appointmentId",reference,snapshot,"issuedAt")
    VALUES($1,$2,$3::jsonb,$4) ON CONFLICT ("appointmentId") DO NOTHING`,
    [row.id, snapshot.reference, JSON.stringify(appointmentPayloadCrypto().encrypt(snapshot, 'booking:' + row.id)), now]);
}

export function createBookingAcknowledgments(pool: Pool, fonts: RecordsFontConfig) {
  return async (actor: Actor, id: string, file = false) => {
    requireScope(actor, 'appointments.booking-acknowledgment.read', id);
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await membership(tx, actor);
      const appointment = await readAppointment(tx, id);
      appointmentOwn(actor, appointment);
      if (appointment.consultationType !== 'in_person') throw new DomainError(404, 'BOOKING_ACKNOWLEDGMENT_NOT_FOUND', 'Booking acknowledgment unavailable.');
      const row = (await tx.query(`SELECT * FROM appointment_booking_acknowledgments WHERE "appointmentId"=$1 FOR UPDATE`, [id])).rows[0];
      if (!row) throw new DomainError(409, 'BOOKING_ACKNOWLEDGMENT_NOT_READY', 'Booking acknowledgment unavailable until acceptance.');
      const crypto = appointmentPayloadCrypto();
      const snapshot = bookingSnapshot.parse(crypto.decrypt(row.snapshot, 'booking:' + id));
      const result: Record<string, unknown> = { appointmentId: id, reference: row.reference, status: appointment.status,
        issuedAt: row.issuedAt, supersededBy: row.supersededBy };
      if (file) {
        const base64 = row.protectedPdf ? crypto.decrypt(row.protectedPdf, 'booking-pdf:' + id) as string
          : (await bookingAcknowledgmentPdf(snapshot, fonts)).toString('base64');
        const hash = createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
        if (row.pdfHash && hash !== row.pdfHash) throw new DomainError(503, 'BOOKING_ACKNOWLEDGMENT_HASH_INVALID', 'Booking acknowledgment unavailable.');
        if (!row.protectedPdf) await tx.query(`UPDATE appointment_booking_acknowledgments
          SET "protectedPdf"=$2::jsonb,"pdfHash"=$3 WHERE "appointmentId"=$1`,
          [id, JSON.stringify(crypto.encrypt(base64, 'booking-pdf:' + id)), hash]);
        Object.assign(result, { base64, sha256: hash });
      }
      await appendSqlOutbox(tx, { producer: 'appointment', eventType: 'vital.audit.requested',
        aggregateId: id, aggregateVersion: appointment.version, correlationId: actor.correlationId,
        data: { auditType: 'vital.document.accessed',
          actorAuthId: actor.authId, resourceId: id, resourceType: 'document' } });
      await tx.query('COMMIT');
      return result;
    } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
  };
}
