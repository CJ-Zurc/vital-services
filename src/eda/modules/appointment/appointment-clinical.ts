import { saveOperationalBrief } from './appointment-summary.js';
import { requireLiveAppointmentAccess } from './appointment-access.js';
import { reviseIntelligence } from '../intelligence/corrections.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError, requireScope, type Actor } from '../../contracts/actor.js';
import { appendSqlOutbox } from '../../infrastructure/outbox.js';
import { requestHash } from '../../infrastructure/security.js';
import { appointmentOwn, lockAppointment, membership, readAppointment } from './appointment.js';
import { effectiveCompletionDeadline, type AppointmentCommand, type AppointmentRow } from './appointment-contracts.js';

export function complaintEditable(row: AppointmentRow, now: number) {
  return ['pending', 'approved', 'confirmed'].includes(row.status) && !(row.sourceAppointmentId && row.status === 'pending') && !row.paperworkLockedAt && !row.doctorConfirmedAt &&
    now < effectiveCompletionDeadline({ ...row, proposedEndAt: row.slotEndsAt ?? row.proposedEndAt }).getTime();
}

export async function complaintHistory(tx: PoolClient, actor: Actor, id: string, raw: unknown, now: number) {
  requireScope(actor, 'appointments.intake.read', id);
  await membership(tx, actor);
  const row = await readAppointment(tx, id); appointmentOwn(actor, row);if(actor.role==='doctor')await requireLiveAppointmentAccess(tx,row,now);
  const { offset } = z.object({ offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict().parse(raw);
  const current = (await tx.query('SELECT "chiefComplaint" FROM pre_consultations WHERE "appointmentId"=$1', [id])).rows[0];
  const rows = (await tx.query(`SELECT id,"previousText","currentText","doctorAuthId","changedAt","appointmentVersion"
    FROM chief_complaint_history WHERE "appointmentId"=$1 ORDER BY "changedAt" DESC,id DESC LIMIT 21 OFFSET $2`, [id, offset])).rows;
  const processing = (await tx.query(`SELECT 1 FROM appointment_workflows WHERE "appointmentId"=$1
    AND ((state='prepared' AND "expiresAt">NOW()) OR (state='committed' AND "videoProcessingState"<>'finalized'))
    UNION ALL SELECT 1 FROM saga_operations WHERE "billingLineageId"=$2 AND status NOT IN ('completed','compensated','cancelled','failed')
    UNION ALL SELECT 1 FROM appointments WHERE "sourceAppointmentId"=$1 AND status IN ('pending','pending_patient_confirmation') LIMIT 1`, [id, row.billingLineageId])).rows.length > 0;
  return { appointmentId: id, version: row.version, chiefComplaint: current?.chiefComplaint ?? null,
    canEdit: actor.role === 'doctor' && complaintEditable(row, now) && !processing,
    history: rows.slice(0, 20), nextOffset: rows.length > 20 ? offset + 20 : null };
}

export async function updateComplaint(tx: PoolClient, actor: Actor, id: string, meta: AppointmentCommand, raw: unknown, now: number) {
  requireScope(actor, 'appointments.intake.write', id);
  if (actor.role !== 'doctor') throw new DomainError(403, 'APPOINTMENT_DOCTOR_REQUIRED', 'Assigned doctor required.');
  const input = z.object({ expectedVersion: z.number().int().nonnegative(), chiefComplaint: z.string().trim().min(1).max(2000) }).strict().parse(raw);
  z.uuid().parse(meta.operationId); z.string().regex(/^[a-f0-9]{64}$/).parse(meta.requestHash);
  const hash = requestHash('COMPLAINT', id, { input, transportHash: meta.requestHash });
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['complaint:' + actor.authId + ':' + meta.operationId]);
  await membership(tx, actor, 'doctor');
  const row = await lockAppointment(tx, id); appointmentOwn(actor, row);if(actor.role==='doctor')await requireLiveAppointmentAccess(tx,row,now);
  await membership(tx, actor, 'doctor');
  const old = (await tx.query('SELECT * FROM command_operations WHERE "actorId"=$1 AND "operationId"=$2', [actor.authId, meta.operationId])).rows[0];
  if (old) {
    if (old.action !== 'appointment.complaint' || old.resourceId !== id || old.requestHash !== hash || old.status !== 'completed')
      throw new DomainError(409, 'COMMAND_REPLAY_CONFLICT', 'Retry does not match the original correction.');
    return old.result;
  }
  if (row.version !== input.expectedVersion || !complaintEditable(row, now))
    throw new DomainError(409, 'COMPLAINT_EDIT_CLOSED', 'Refresh the appointment. Complaint editing may be locked.');
  const state = await complaintHistory(tx, { ...actor, scopes: [...actor.scopes, 'appointments.intake.read'] }, id, {}, now);
  if (!state.canEdit) throw new DomainError(409, 'APPOINTMENT_PROCESSING', 'Wait for the current appointment operation.');
  if (state.chiefComplaint !== input.chiefComplaint) {
    await tx.query(`INSERT INTO pre_consultations (id,"appointmentId","chiefComplaint") VALUES($1,$2,$3)
      ON CONFLICT ("appointmentId") DO UPDATE SET "chiefComplaint"=EXCLUDED."chiefComplaint"`, [randomUUID(), id, input.chiefComplaint]);
    await tx.query('UPDATE appointments SET version=version+1,"updatedAt"=NOW() WHERE id=$1', [id]);
    row.version++;
    const currentIntake=(await tx.query('SELECT opqrst FROM pre_consultations WHERE "appointmentId"=$1',[id])).rows[0];
    if(currentIntake?.opqrst)await saveOperationalBrief(tx,id,input.chiefComplaint,currentIntake.opqrst,[],row.version);
    if(process.env.VITAL_AI_ENABLED==='true')await reviseIntelligence(tx,id,input.chiefComplaint);
    await tx.query(`INSERT INTO chief_complaint_history (id,"appointmentId","previousText","currentText","doctorAuthId","appointmentVersion","changedAt")
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), id, state.chiefComplaint, input.chiefComplaint, actor.authId, row.version, new Date(now)]);
    await appendSqlOutbox(tx, { producer: 'appointment', eventType: 'vital.audit.requested', aggregateId: id, aggregateVersion: row.version,
      correlationId: actor.correlationId, causationId: meta.operationId,
      data: { auditType: 'vital.appointment.complaint_updated', actorAuthId: actor.authId, resourceId: id, resourceType: 'appointment' } });
  }
  // Journals and broker events contain references only, never complaint text.
  const result = { appointmentId: id, version: row.version };
  await tx.query(`INSERT INTO command_operations (id,"actorId","operationId",action,"resourceId","requestHash",status,result,"createdAt","updatedAt")
    VALUES($1,$2,$3,'appointment.complaint',$4,$5,'completed',$6::jsonb,NOW(),NOW())`, [randomUUID(), actor.authId, meta.operationId, id, hash, JSON.stringify(result)]);
  return result;
}

export async function adminRatings(tx: PoolClient, actor: Actor, doctorAuthId: string, raw: unknown) {
  z.uuid().parse(doctorAuthId); requireScope(actor, 'appointments.ratings.admin.read', doctorAuthId);
  if (actor.role !== 'admin' || !(await tx.query(`SELECT a."userId" FROM vital_admins a JOIN vital_users u
    ON u.id=a."userId" AND u."authId"=a."authId" AND u.role='admin' WHERE a."authId"=$1`, [actor.authId])).rows.length)
    throw new DomainError(403, 'APPOINTMENT_ADMIN_REQUIRED', 'Current administrator membership required.');
  const { page, pageSize } = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(10) }).strict().parse(raw);
  const doctor = (await tx.query('SELECT "userId" FROM vital_doctors WHERE "authId"=$1', [doctorAuthId])).rows[0];
  if (!doctor) throw new DomainError(404, 'DOCTOR_NOT_FOUND', 'Doctor not found.');
  const source = `FROM feedback f JOIN appointments a ON a.id=f."appointmentId" JOIN vital_patients p ON p."userId"=f."patientId"
    WHERE COALESCE(f."doctorId",a."doctorId")=$1 AND a.status='completed' AND f."starRating" BETWEEN 1 AND 5`;
  const summary = (await tx.query(`SELECT COUNT(*)::int AS total,COALESCE(AVG(f."starRating"),0)::float AS average ${source}`, [doctor.userId])).rows[0];
  const items = (await tx.query(`SELECT f.id,f."appointmentId",p."authId" AS "patientAuthId",f."starRating" AS rating,f."submittedAt" ${source}
    ORDER BY f."submittedAt" DESC,f.id DESC LIMIT $2 OFFSET $3`, [doctor.userId, pageSize, (page - 1) * pageSize])).rows;
  return { items, total: summary.total, average: summary.average, page, pageSize };
}
