import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError, requireScope, type Actor } from '../../contracts/actor.js';
import { requestHash } from '../../infrastructure/security.js';
import { appendSqlOutbox } from '../../infrastructure/outbox.js';
import { lockAppointment, membership, appointmentOwn } from './appointment.js';
import type { AppointmentCommand, AppointmentOwners } from './appointment-contracts.js';

const feedbackInput = z.object({ expectedVersion: z.number().int().nonnegative(), rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(4000).nullable() }).strict();
const intakeQuery = z.object({ cursorAt: z.iso.datetime().optional(), cursorId: z.uuid().optional() }).strict()
  .refine(value => Boolean(value.cursorAt) === Boolean(value.cursorId));

export function createAppointmentExtras(pool: Pool, owners: Pick<AppointmentOwners, 'financial'>, clock = Date.now) {
  async function transaction<T>(run: (tx: PoolClient) => Promise<T>) {
    const tx = await pool.connect();
    try { await tx.query('BEGIN'); const result = await run(tx); await tx.query('COMMIT'); return result; }
    catch (error) { await tx.query('ROLLBACK'); throw error; }
    finally { tx.release(); }
  }
  return {
    async feedback(actor: Actor, appointmentId: string, meta: AppointmentCommand, raw: unknown) {
      z.uuid().parse(appointmentId); z.uuid().parse(meta.operationId);
      z.string().regex(/^[a-f0-9]{64}$/).parse(meta.requestHash);
      requireScope(actor, 'appointments.feedback', appointmentId);
      if (actor.role !== 'patient') throw new DomainError(403, 'APPOINTMENT_PATIENT_REQUIRED', 'Patient authority required.');
      const input = feedbackInput.parse(raw);
      const hash = requestHash('APPOINTMENT-EXTRA', 'feedback', { appointmentId, input, transportHash: meta.requestHash });
      return transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`appointment-feedback:${actor.authId}:${meta.operationId}`]);
        const member = await membership(tx, actor, 'patient');
        const row = await lockAppointment(tx, appointmentId);
        appointmentOwn(actor, row);
        if (row.patientId !== member.userId) throw new DomainError(403, 'APPOINTMENT_OWNER_DENIED', 'Patient ownership required.');
        const existing = (await tx.query('SELECT action,"resourceId","requestHash",status,result FROM command_operations WHERE "actorId"=$1 AND "operationId"=$2 FOR UPDATE', [actor.authId, meta.operationId])).rows[0];
        if (existing) {
          if (existing.action !== 'appointment.feedback' || existing.resourceId !== appointmentId || existing.requestHash !== hash) throw new DomainError(409, 'COMMAND_REPLAY_CONFLICT', 'Command is bound to another request.');
          if (existing.status !== 'completed') throw new DomainError(409, 'COMMAND_PENDING', 'Command needs recovery.');
          const feedback = (await tx.query('SELECT * FROM feedback WHERE id=$1 AND "appointmentId"=$2 AND "patientId"=$3', [existing.result?.feedbackId, appointmentId, member.userId])).rows[0];
          if (!feedback) throw new DomainError(409, 'APPOINTMENT_FEEDBACK_CHANGED', 'Feedback no longer available.');
          return { feedback };
        }
        if (row.version !== input.expectedVersion) throw new DomainError(409, 'APPOINTMENT_VERSION_CONFLICT', 'Appointment changed.');
        if (!['confirmed', 'completed'].includes(row.status)) throw new DomainError(400, 'APPOINTMENT_FEEDBACK_INELIGIBLE', 'Review is not available.');
        const blocked = await tx.query(`SELECT 1 FROM saga_operations WHERE "billingLineageId"=$1 AND status NOT IN ('completed','compensated','cancelled','failed') LIMIT 1`, [row.billingLineageId]);
        if (blocked.rows.length) throw new DomainError(409, 'APPOINTMENT_PROCESSING', 'Appointment transfer is pending.');
        const projection = (await tx.query('SELECT * FROM appointment_payment_projections WHERE "appointmentId"=$1', [row.id])).rows[0];
        if (!owners.financial) throw new DomainError(503, 'APPOINTMENT_FINANCIAL_OWNER_UNAVAILABLE', 'Financial owner required.');
        if (!projection || projection.status !== 'paid' || projection.reviewRequired || projection.billingLineageId !== row.billingLineageId || projection.associationVersion !== row.associationVersion) throw new DomainError(409, 'APPOINTMENT_PAYMENT_UNVERIFIED', 'Verified payment required.');
        await owners.financial.verifyPaid(row, projection);
        const feedback = (await tx.query(`INSERT INTO feedback (id,"appointmentId","patientId","doctorId","starRating",feedback,"submittedAt")
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT ("appointmentId") DO UPDATE SET "starRating"=EXCLUDED."starRating",feedback=EXCLUDED.feedback,"submittedAt"=EXCLUDED."submittedAt" RETURNING *`,
        [randomUUID(), row.id, member.userId, row.doctorId, input.rating, input.comment || null, new Date(clock())])).rows[0];
        // Calendar locking also serializes ratings written for the same doctor.
        await tx.query('UPDATE vital_doctors SET "starRating"=(SELECT AVG("starRating") FROM feedback WHERE "doctorId"=$1) WHERE "userId"=$1', [row.doctorId]);
        await tx.query(`INSERT INTO command_operations (id,"actorId","operationId",action,"resourceId","requestHash",status,result,"createdAt","updatedAt")
          VALUES ($1,$2,$3,'appointment.feedback',$4,$5,'completed',$6::jsonb,NOW(),NOW())`, [randomUUID(), actor.authId, meta.operationId, row.id, hash, JSON.stringify({ feedbackId: feedback.id })]);
        await appendSqlOutbox(tx, { eventType: 'vital.audit.requested', producer: 'appointment', aggregateId: row.id,
          aggregateVersion: row.version, correlationId: actor.correlationId, data: { auditType: 'vital.appointment.feedback_saved', actorAuthId: actor.authId, resourceId: row.id, resourceType: 'appointment' } });
        return { feedback };
      });
    },
    async intakes(actor: Actor, patientId: string, raw: unknown) {
      z.uuid().parse(patientId); requireScope(actor, 'appointments.intake.read', patientId);
      if (actor.role !== 'doctor') throw new DomainError(403, 'APPOINTMENT_DOCTOR_REQUIRED', 'Doctor authority required.');
      const query = intakeQuery.parse(raw);
      return transaction(async tx => {
        const doctor = await membership(tx, actor, 'doctor');
        const result = await tx.query(`SELECT a.id AS "appointmentId",a."scheduledAt",p."submittedAt",COALESCE(p."chiefComplaint",'') AS "chiefComplaint",p.opqrst
          FROM appointments a LEFT JOIN pre_consultations p ON p."appointmentId"=a.id
          WHERE a."doctorId"=$1 AND a."patientId"=$2 AND a.status IN ('pending','approved','confirmed','completed','pending_patient_confirmation')
          AND ($3::timestamp IS NULL OR (a."scheduledAt",a.id)<($3::timestamp,$4::text)) ORDER BY a."scheduledAt" DESC,a.id DESC LIMIT 11`,
        [doctor.userId, patientId, query.cursorAt ?? null, query.cursorId ?? null]);
        if (!result.rows.length && !query.cursorId) throw new DomainError(404, 'APPOINTMENT_PATIENT_ACCESS_NOT_FOUND', 'Patient access not found.');
        const items = result.rows.slice(0, 10), last = items.at(-1);
        return { items, next: result.rows.length > 10 && last ? { cursorAt: new Date(last.scheduledAt).toISOString(), cursorId: last.appointmentId } : null };
      });
    },
  };
}
export type AppointmentExtras = ReturnType<typeof createAppointmentExtras>;
