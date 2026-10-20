import type { Pool } from 'pg';
import { DomainError } from '../../contracts/actor.js';
import type { AppointmentReadSnapshot } from '../appointment/appointment-reads.js';
import type { PaymentStore } from '../payment/payment-store.js';
import type { PortalVideoProjection } from '../video/portal-projection.js';
import { requirePortalStaffSource, type PortalSource } from './portal-integrations-contracts.js';
import type { PortalAppointmentReference } from './portal-integrations-appointments.js';

export interface PortalStaffOwners { payment: Pick<PaymentStore, 'byAppointment'>; video: PortalVideoProjection }
export function createPortalStaffComposer(pool: Pool, owners: PortalStaffOwners) {
  return async (source: PortalSource, references: PortalAppointmentReference[]): Promise<AppointmentReadSnapshot[]> => {
    requirePortalStaffSource(source);
    const result: AppointmentReadSnapshot[] = [];
    const deadline = Math.min(Date.now() + 25_000, source.expiresAt * 1000);
    let bytes = 0;
    function bounded(value: unknown) {
      requirePortalStaffSource(source);
      bytes += Buffer.byteLength(JSON.stringify(value));
      if (Date.now() >= deadline || bytes > 16 * 1024 * 1024)
        throw new DomainError(413, 'PORTAL_APPOINTMENT_READ_LIMIT', 'Appointment composition exceeded its resource budget.');
    }
    for (const ref of references) {
      requirePortalStaffSource(source);
      const row = (await pool.query(`SELECT a.*,p."authId" AS "patientAuthId",d."authId" AS "doctorAuthId",d.specialty,
        s."slotDate"::text AS "slotDate",s."startTime"::text AS "startTime",s."endTime"::text AS "endTime",
        pc."chiefComplaint",pc.opqrst,c."sessionStartedAt",c."sessionEndedAt"
        FROM appointments a JOIN vital_patients p ON p."userId"=a."patientId" JOIN vital_doctors d ON d."userId"=a."doctorId"
        LEFT JOIN schedules s ON s.id=a."scheduleSlotId" LEFT JOIN pre_consultations pc ON pc."appointmentId"=a.id
        LEFT JOIN consultations c ON c."appointmentId"=a.id WHERE a.id=$1`, [ref.id])).rows[0];
      if (!row || row.version !== ref.version || row.billingLineageId !== ref.billingLineageId
        || row.associationVersion !== ref.associationVersion || row.patientId !== ref.patientId || row.doctorId !== ref.doctorId)
        throw new DomainError(409, 'PORTAL_APPOINTMENT_READ_CHANGED', 'Appointment changed during composition.');
      const logs: AppointmentReadSnapshot['statusLogs'] = [];
      let cursor: { changedAt: Date; id: string } | undefined;
      do {
        const page:AppointmentReadSnapshot['statusLogs'] = (await pool.query(`SELECT id,"fromStatus","toStatus","changedByRole",note,"changedAt" FROM appointment_logs
          WHERE "appointmentId"=$1 AND ($2::timestamp IS NULL OR ("changedAt",id)>($2::timestamp,$3::text))
          ORDER BY "changedAt",id LIMIT 50`, [ref.id, cursor?.changedAt ?? null, cursor?.id ?? null])).rows;
        bounded(page);logs.push(...page);
        cursor = page.length === 50 ? page.at(-1) : undefined;
      } while (cursor);
      const related: Record<string, unknown>[] = [];
      let next: string | null = null;
      do {
        const page:Record<string,any>[] = (await pool.query(`SELECT a.id,a.status,a."sourceAppointmentId",a."followUpOfAppointmentId",a."scheduledAt",a."proposedEndAt",a."updatedAt",a."cancellationReason",
          s."slotDate"::text AS "slotDate",s."startTime"::text AS "startTime",s."endTime"::text AS "endTime"
          FROM appointments a LEFT JOIN schedules s ON s.id=a."scheduleSlotId"
          WHERE (a.id=$2 OR a."sourceAppointmentId"=$1 OR a."followUpOfAppointmentId"=$1) AND a."patientId"=$3 AND a."doctorId"=$4
          AND ($5::text IS NULL OR a.id>$5) ORDER BY a.id LIMIT 50`, [ref.id, row.sourceAppointmentId, ref.patientId, ref.doctorId, next])).rows;
        for (const item of page) {
          const history: Record<string, unknown>[] = [];
          let after: { changedAt: Date; id: string } | undefined;
          do {
            const events = (await pool.query(`SELECT id,note,"changedAt" FROM appointment_logs WHERE "appointmentId"=$1
              AND ($2::timestamp IS NULL OR ("changedAt",id)>($2::timestamp,$3::text)) ORDER BY "changedAt",id LIMIT 50`,
            [item.id, after?.changedAt ?? null, after?.id ?? null])).rows;
            bounded(events);history.push(...events.map(event => ({ note: event.note, changedAt: event.changedAt })));
            after = events.length === 50 ? events.at(-1) : undefined;
          } while (after);
          bounded(item);related.push({ ...item, statusLogs: history.reverse() });
        }
        next = page.length === 50 ? page.at(-1)!.id : null;
      } while (next);
      const financial = await owners.payment.byAppointment(ref.id);
      if (financial && (financial.appointmentId !== ref.id || financial.billingLineageId !== ref.billingLineageId
        || financial.associationVersion !== ref.associationVersion || financial.patientAuthId !== row.patientAuthId || financial.doctorAuthId !== row.doctorAuthId))
        throw new DomainError(409, 'PORTAL_PAYMENT_ASSOCIATION_CHANGED', 'Financial association changed.');
      const video = row.consultationType === 'virtual' && !['pending', 'pending_patient_confirmation', 'rejected'].includes(row.status)
        ? await owners.video(source, ref) : null;
      const schedule = (value: Record<string, any>) => value.slotDate ? { slotDate: value.slotDate,
        startTime: value.startTime.slice(0, 5), endTime: value.endTime.slice(0, 5) } : null;
      const relation = (value: Record<string, any>) => ({ id: value.id, status: value.status, scheduledAt: value.scheduledAt,
        proposedEndAt: value.proposedEndAt, updatedAt: value.updatedAt, cancellationReason: value.cancellationReason,
        scheduleSlot: schedule(value), statusLogs: value.statusLogs });
      result.push({ id: row.id, version: row.version, patientId: row.patientId, doctorId: row.doctorId, patientAuthId: row.patientAuthId,
        doctorAuthId: row.doctorAuthId, specialty: row.specialty, status: row.status, consultationType: row.consultationType,
        scheduleSlotId: row.scheduleSlotId, scheduleSlot: schedule(row), sourceAppointmentId: row.sourceAppointmentId,
        appointmentKind: row.appointmentKind, followUpOfAppointmentId: row.followUpOfAppointmentId,
        patientRescheduleCount: row.patientRescheduleCount, doctorRescheduleCount: row.doctorRescheduleCount,
        cancellationReason: row.cancellationReason, rejectionReason: row.rejectionReason, ehrCaseId: row.ehrCaseId,
        scheduledAt: row.scheduledAt, proposedEndAt: row.proposedEndAt, createdAt: row.createdAt, updatedAt: row.updatedAt,
        doctorConfirmedAt: row.doctorConfirmedAt, patientConfirmedAt: row.patientConfirmedAt, completionDeadlineAt: row.completionDeadlineAt,
        autoCompletedAt: row.autoCompletedAt, paperworkLockedAt: row.paperworkLockedAt,
        preConsultation: { chiefComplaint: row.chiefComplaint ?? null, opqrst: row.opqrst ?? null }, statusLogs: logs,
        sourceAppointment: related.some(item => item.id === row.sourceAppointmentId) ? relation(related.find(item => item.id === row.sourceAppointmentId)!) : null,
        rescheduleProposals: related.filter(item => item.sourceAppointmentId === row.id)
          .sort((a,b)=>new Date(String(b.updatedAt)).getTime()-new Date(String(a.updatedAt)).getTime()||String(a.id).localeCompare(String(b.id))).map(relation),
        followUpAppointments: related.filter(item => item.followUpOfAppointmentId === row.id).map(item => ({ id: item.id, status: item.status })),
        payment: financial ? { status: financial.status, amount: financial.amount, checkoutUrl: financial.checkoutUrl, paidAt: financial.paidAt, refundEligible: financial.refundEligible } : null,
        consultation: video || row.sessionStartedAt || row.sessionEndedAt ? { ...video, meetingProvider: video?.meetingProvider ?? null,
          meetingUrl: video?.meetingUrl ?? null, normalizedMeetingUrl: video?.normalizedMeetingUrl ?? null, meetingValidationStatus: video?.meetingValidationStatus ?? null,
          sessionStartedAt: row.sessionStartedAt, sessionEndedAt: row.sessionEndedAt } : null } as AppointmentReadSnapshot);
    }
    bounded(result);
    return result;
  };
}
