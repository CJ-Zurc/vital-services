import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import type { AppointmentReads, AppointmentReadOwners, AppointmentReadSnapshot } from './appointment-reads.js';
import { DomainError, type Actor } from '../../contracts/actor.js';
import { authorizeExport, completionCount, completionRole, completionUnavailable, type CompletionAppointmentOwner, type CompletionAssociation, type ExportQuery } from '../../contracts/completion.js';
import { createCompletionProfileOwner } from '../profile/profile-completion.js';

type Association = CompletionAssociation & { version: number; status: string; scheduledAt: Date };
type Upcoming = AppointmentReadSnapshot & { billingLineageId: string; associationVersion: number;
  sessionStartedAt: Date | null; sessionEndedAt: Date | null };
const associationsSql = `SELECT a.id,a.version,a.status,a."scheduledAt",a."billingLineageId",a."associationVersion",d."authId" AS "doctorAuthId"
  FROM appointments a JOIN vital_doctors d ON d."userId"=a."doctorId" WHERE a."patientId"=$1 ORDER BY a.id`;
const fingerprint = (rows: unknown[]) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const changed = () => new DomainError(409, 'COMPLETION_APPOINTMENT_CHANGED', 'Appointment state changed during composition.');

// The retained reads argument keeps existing runtime callers source-compatible. Dashboard
// reads intentionally do not invoke its capped list; pass the same real owners as argument 3.
export function createAppointmentCompletionOwner(pool: Pool, _reads: Pick<AppointmentReads, 'list'>,
  owners: AppointmentReadOwners = {}, clock = Date.now): CompletionAppointmentOwner {
  const profile = createCompletionProfileOwner(pool);
  return {
    async patient(actor) {
      completionRole(actor, 'patient', 'completion.patient.dashboard');
      const patientId = await profile.patient(actor), tx = await pool.connect();
      let associations: Association[], statusCounts: Record<string, number>, selected: Upcoming[];
      try {
        await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        if (await profile.patient(actor, tx) !== patientId) throw changed();
        associations = (await tx.query<Association>(associationsSql, [patientId])).rows;
        const counts = (await tx.query<{ status: string; count: string }>(
          'SELECT status,COUNT(*) AS count FROM appointments WHERE "patientId"=$1 GROUP BY status', [patientId])).rows;
        statusCounts = Object.fromEntries(counts.map(row => [row.status, completionCount(row.count)]));
        // Only the four cards are hydrated. Aggregates and financial associations cover all rows.
        selected = (await tx.query<Upcoming>(`SELECT a.*,p."authId" AS "patientAuthId",d."authId" AS "doctorAuthId",d.title,d.specialty,
          CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object('slotDate',s."slotDate"::text,'startTime',LEFT(s."startTime"::text,5),'endTime',LEFT(s."endTime"::text,5)) END AS "scheduleSlot",
          jsonb_build_object('chiefComplaint',pc."chiefComplaint",'opqrst',pc.opqrst) AS "preConsultation",
          c."sessionStartedAt",c."sessionEndedAt",
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id',l.id,'fromStatus',l."fromStatus",'toStatus',l."toStatus",'changedByRole',l."changedByRole",'note',l.note,'changedAt',l."changedAt") ORDER BY l."changedAt",l.id)
            FROM appointment_logs l WHERE l."appointmentId"=a.id),'[]'::jsonb) AS "statusLogs",
          (SELECT jsonb_build_object('id',r.id,'status',r.status,'scheduledAt',r."scheduledAt",'proposedEndAt',r."proposedEndAt",'updatedAt',r."updatedAt",'cancellationReason',r."cancellationReason",
            'scheduleSlot',CASE WHEN rs.id IS NULL THEN NULL ELSE jsonb_build_object('slotDate',rs."slotDate"::text,'startTime',LEFT(rs."startTime"::text,5),'endTime',LEFT(rs."endTime"::text,5)) END,
            'statusLogs',COALESCE((SELECT jsonb_agg(jsonb_build_object('note',l.note,'changedAt',l."changedAt") ORDER BY l."changedAt" DESC,l.id) FROM appointment_logs l WHERE l."appointmentId"=r.id),'[]'::jsonb))
            FROM appointments r LEFT JOIN schedules rs ON rs.id=r."scheduleSlotId" WHERE r.id=a."sourceAppointmentId" AND r."patientId"=a."patientId" AND r."doctorId"=a."doctorId") AS "sourceAppointment",
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'status',r.status,'scheduledAt',r."scheduledAt",'proposedEndAt',r."proposedEndAt",'updatedAt',r."updatedAt",'cancellationReason',r."cancellationReason",
            'scheduleSlot',CASE WHEN rs.id IS NULL THEN NULL ELSE jsonb_build_object('slotDate',rs."slotDate"::text,'startTime',LEFT(rs."startTime"::text,5),'endTime',LEFT(rs."endTime"::text,5)) END,
            'statusLogs',COALESCE((SELECT jsonb_agg(jsonb_build_object('note',l.note,'changedAt',l."changedAt") ORDER BY l."changedAt" DESC,l.id) FROM appointment_logs l WHERE l."appointmentId"=r.id),'[]'::jsonb)) ORDER BY r."updatedAt" DESC,r.id)
            FROM appointments r LEFT JOIN schedules rs ON rs.id=r."scheduleSlotId" WHERE r."sourceAppointmentId"=a.id AND r."patientId"=a."patientId" AND r."doctorId"=a."doctorId"),'[]'::jsonb) AS "rescheduleProposals",
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'status',r.status) ORDER BY r.id) FROM appointments r
            WHERE r."followUpOfAppointmentId"=a.id AND r."patientId"=a."patientId" AND r."doctorId"=a."doctorId"),'[]'::jsonb) AS "followUpAppointments"
          FROM appointments a JOIN vital_patients p ON p."userId"=a."patientId" JOIN vital_doctors d ON d."userId"=a."doctorId"
          LEFT JOIN schedules s ON s.id=a."scheduleSlotId" LEFT JOIN pre_consultations pc ON pc."appointmentId"=a.id
          LEFT JOIN consultations c ON c."appointmentId"=a.id
          WHERE a."patientId"=$1 AND a."scheduledAt">=$2 AND a.status NOT IN ('cancelled','rejected','completed')
          ORDER BY a."scheduledAt",a.id LIMIT 4`, [patientId, new Date(clock())])).rows;
        await tx.query('COMMIT');
      } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
      const appointments: AppointmentReadSnapshot[] = [];
      for (const row of selected) {
        if (row.patientId !== patientId || row.patientAuthId !== actor.authId) throw changed();
        if (!owners.payment) completionUnavailable('PAYMENT');
        const payment = await owners.payment.byAppointment(row.id);
        if (payment && (payment.appointmentId !== row.id || payment.billingLineageId !== row.billingLineageId || payment.associationVersion !== row.associationVersion
          || payment.patientAuthId !== actor.authId || payment.doctorAuthId !== row.doctorAuthId)) throw changed();
        const association = associations.find(item => item.id === row.id);
        if (!association) throw changed();
        association.paymentVersion = payment?.version ?? null;
        let video: Awaited<ReturnType<NonNullable<AppointmentReadOwners['video']>['resource']>> | null = null;
        if (row.consultationType === 'virtual' && !['pending','pending_patient_confirmation','rejected'].includes(row.status)) {
          if (!owners.video) completionUnavailable('VIDEO');
          video = await owners.video.resource({ ...actor, scopes: ['video.resource.read'], resource: row.id }, row.id);
          if (video.appointmentId !== row.id || video.associationVersion !== row.associationVersion) throw changed();
        }
        // Match the normal Appointment read DTO without exposing persistence-only fields.
        const relation = (r: NonNullable<AppointmentReadSnapshot['sourceAppointment']>) => ({ ...r,
          scheduledAt: new Date(r.scheduledAt), proposedEndAt: r.proposedEndAt ? new Date(r.proposedEndAt) : null, updatedAt: new Date(r.updatedAt),
          statusLogs: r.statusLogs.map(l => ({ ...l, changedAt: new Date(l.changedAt).toISOString() })) });
        appointments.push({ id: row.id, version: row.version, patientId: row.patientId, doctorId: row.doctorId, patientAuthId: row.patientAuthId, doctorAuthId: row.doctorAuthId,
          title: row.title, specialty: row.specialty, status: row.status, consultationType: row.consultationType, scheduleSlotId: row.scheduleSlotId, scheduleSlot: row.scheduleSlot,
          sourceAppointmentId: row.sourceAppointmentId, appointmentKind: row.appointmentKind, followUpOfAppointmentId: row.followUpOfAppointmentId,
          patientRescheduleCount: row.patientRescheduleCount, doctorRescheduleCount: row.doctorRescheduleCount, cancellationReason: row.cancellationReason, rejectionReason: row.rejectionReason,
          ehrCaseId: row.ehrCaseId, scheduledAt: row.scheduledAt, proposedEndAt: row.proposedEndAt, createdAt: row.createdAt, updatedAt: row.updatedAt,
          doctorConfirmedAt: row.doctorConfirmedAt, patientConfirmedAt: row.patientConfirmedAt, completionDeadlineAt: row.completionDeadlineAt,
          autoCompletedAt: row.autoCompletedAt, paperworkLockedAt: row.paperworkLockedAt, preConsultation: row.preConsultation,
          statusLogs: row.statusLogs.map(l => ({ ...l, changedAt: new Date(l.changedAt) })), sourceAppointment: row.sourceAppointment ? relation(row.sourceAppointment) : null,
          rescheduleProposals: row.rescheduleProposals.map(relation), followUpAppointments: row.followUpAppointments,
          payment: payment ? { status: payment.status, amount: payment.amount, checkoutUrl: payment.checkoutUrl, paidAt: payment.paidAt, refundEligible: payment.refundEligible } : null,
          consultation: row.sessionStartedAt || row.sessionEndedAt || video ? { meetingProvider: video?.meetingProvider ?? null, meetingUrl: video?.meetingUrl ?? null,
            normalizedMeetingUrl: video?.normalizedMeetingUrl ?? null, meetingValidationStatus: video?.meetingValidationStatus ?? null,
            sessionStartedAt: row.sessionStartedAt, sessionEndedAt: row.sessionEndedAt } : null });
      }
      const expected = fingerprint(associations.map(({ paymentVersion: _paymentVersion, ...row }) => row));
      const validate = async () => {
        if (await profile.patient(actor) !== patientId || fingerprint((await pool.query(associationsSql, [patientId])).rows) !== expected) throw changed();
      };
      await validate();
      return { patientId, appointments, associations, statusCounts, validate };
    },
    async statusCounts(actor) {
      completionRole(actor, 'admin', 'completion.admin.dashboard');
      await profile.admin(actor);
      const rows = (await pool.query<{ status: string; count: string }>('SELECT status,COUNT(*) AS count FROM appointments GROUP BY status')).rows;
      await profile.admin(actor);
      return Object.fromEntries(rows.map(row => [row.status, completionCount(row.count)]));
    },
    async exportSubmitted(actor, query: ExportQuery) {
      authorizeExport(actor);
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const upperBound = query.upperBound ? new Date(query.upperBound) : (await tx.query<{ updatedAt: Date }>(`SELECT a."updatedAt"
          FROM pre_consultations pc JOIN appointments a ON a.id=pc."appointmentId"
          WHERE pc."isSubmitted"=true AND pc."submittedAt" IS NOT NULL ORDER BY a."updatedAt" DESC,pc.id DESC LIMIT 1`)).rows[0]?.updatedAt ?? null;
        const rows = (await tx.query<{ id: string; chiefComplaint: string | null; submittedAt: Date; scheduledAt: Date; updatedAt: Date }>(`SELECT
          pc.id,pc."chiefComplaint",pc."submittedAt",a."scheduledAt",a."updatedAt"
          FROM pre_consultations pc JOIN appointments a ON a.id=pc."appointmentId"
          WHERE pc."isSubmitted"=true AND pc."submittedAt" IS NOT NULL
          AND ($1::timestamp IS NULL OR a."updatedAt">$1 OR (a."updatedAt"=$1 AND pc.id>$2))
          AND ($3::timestamp IS NULL OR a."updatedAt"<=$3)
          ORDER BY a."updatedAt",pc.id LIMIT $4`, [query.cursor ? new Date(query.cursor.updatedAt) : null, query.cursor?.id ?? null, upperBound, query.limit + 1])).rows;
        const page = rows.slice(0, query.limit), last = page.at(-1);
        const lastCursor = last ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt.toISOString(), id: last.id })).toString('base64url') : null;
        const nextCursor = rows.length > query.limit ? lastCursor : null;
        await tx.query('COMMIT');
        return { data: page.map(row => ({ preConsultationId: row.id, chiefComplaint: row.chiefComplaint, submittedAt: row.submittedAt.toISOString(),
          scheduledAt: row.scheduledAt.toISOString(), sourceUpdatedAt: row.updatedAt.toISOString() })),
          meta: { nextCursor, lastCursor, hasMore: Boolean(nextCursor), upperBound: upperBound?.toISOString() ?? null } };
      } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
    },
  };
}
