import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError, requireScope, type Actor } from '../../contracts/actor.js';
import { appendSqlOutbox } from '../../infrastructure/outbox.js';
import { appointmentCommand, calendarLock, membership } from './appointment.js';
import { dateOnly, type AppointmentCommand } from './appointment-contracts.js';

export const blockSelection = z.object({ mode: z.enum(['range', 'custom', 'weekly']),
  startDate: dateOnly.optional(), endDate: dateOnly.optional(), dates: z.array(dateOnly).max(2000).refine(dates => new Set(dates).size <= 100).optional(),
  weekday: z.number().int().min(0).max(6).optional() }).strict();
export function selectedBlockDates(raw: unknown, now = Date.now()) {
  const input = blockSelection.parse(raw), today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  let dates: string[];
  if (input.mode === 'custom') {
    if (input.startDate || input.endDate || input.weekday !== undefined) throw new DomainError(400, 'DATE_BLOCK_INVALID', 'Use individual dates for Custom selection.');
    dates = [...new Set(input.dates ?? [])].sort();
  } else {
    if (!input.startDate || !input.endDate || input.dates || input.endDate < input.startDate || input.mode === 'range' && input.weekday !== undefined || input.mode === 'weekly' && input.weekday === undefined)
      throw new DomainError(400, 'DATE_BLOCK_INVALID', 'Select a valid date range.');
    const days = (Date.parse(input.endDate) - Date.parse(input.startDate)) / 86400000 + 1;
    if (days > 366) throw new DomainError(400, 'DATE_BLOCK_LIMIT', 'Select at most 366 calendar days.');
    dates = Array.from({ length: days }, (_, index) => new Date(Date.parse(input.startDate!) + index * 86400000))
      .filter(day => input.mode !== 'weekly' || day.getUTCDay() === input.weekday).map(day => day.toISOString().slice(0, 10));
  }
  if (!dates.length || dates[0]! < today) throw new DomainError(400, 'DATE_BLOCK_INVALID', 'Select dates on or after today.');
  return dates;
}

async function review(tx: PoolClient, doctorId: string, dates: string[]) {
  const blocks = (await tx.query(`SELECT id,version,start_date::text AS "startDate",end_date::text AS "endDate",weekday
    FROM doctor_date_blocks WHERE doctor_id=$1 AND EXISTS(SELECT 1 FROM unnest($2::date[]) selected(day)
      WHERE day BETWEEN start_date AND end_date AND (weekday IS NULL OR weekday=EXTRACT(DOW FROM day))) ORDER BY id`, [doctorId, dates])).rows;
  const appointments = (await tx.query(`SELECT a.id,a.version,a.status,a."scheduledAt",a."proposedEndAt",a."scheduleSlotId"
    FROM appointments a LEFT JOIN schedules s ON s.id=a."scheduleSlotId" WHERE a."doctorId"=$1
    AND a.status IN ('pending','approved','confirmed','pending_patient_confirmation') AND EXISTS(
      SELECT 1 FROM unnest($2::date[]) selected(day) WHERE day >= ((a."scheduledAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Manila')::date
      AND day <= (COALESCE(s."slotDate"+s."endTime"+CASE WHEN s."endTime"<=s."startTime" THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END,
        (COALESCE(a."proposedEndAt",a."scheduledAt") AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Manila')
        - CASE WHEN s.id IS NOT NULL OR a."proposedEndAt" IS NOT NULL THEN INTERVAL '1 microsecond' ELSE INTERVAL '0 day' END)::date) ORDER BY a.id`, [doctorId, dates])).rows;
  const holds = (await tx.query(`SELECT id,"startsAt","endsAt" FROM slot_reservations WHERE "doctorId"=$1 AND status='reserved' AND "leaseUntil">NOW()
    AND EXISTS(SELECT 1 FROM unnest($2::date[]) selected(day) WHERE day >= (("startsAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Manila')::date
      AND day <= ((("endsAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Manila')-INTERVAL '1 microsecond')::date) ORDER BY id`, [doctorId, dates])).rows;
  const alreadyBlockedDates = dates.filter(day => blocks.some(block => day >= block.startDate && day <= block.endDate &&
    (block.weekday === null || block.weekday === new Date(day).getUTCDay())));
  const previewHash = createHash('sha256').update(JSON.stringify({ doctorId, dates, blocks, appointments, holds })).digest('hex');
  return { dates, alreadyBlockedDates, appointmentCount: appointments.length, previewHash, hasActiveReservations: holds.length > 0 };
}

export async function previewDateBlocks(pool: Pool, actor: Actor, raw: unknown, now: number) {
  requireScope(actor, 'appointments.blocks.read', actor.authId);
  const dates = selectedBlockDates(raw, now), tx = await pool.connect();
  try {
    await tx.query('BEGIN'); const doctor = await membership(tx, actor, 'doctor'); await calendarLock(tx, doctor.userId);
    const result = await review(tx, doctor.userId, dates); await tx.query('COMMIT'); return result;
  } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
}

export async function saveDateBlocks(pool: Pool, actor: Actor, meta: AppointmentCommand, raw: unknown, now: number) {
  const { selection, previewHash } = z.object({ selection: blockSelection, previewHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(raw);
  return appointmentCommand(pool, actor, 'blocks.write', actor.authId, meta, { selection, previewHash }, async tx => {
    const dates = selectedBlockDates(selection, now);
    const doctor = await membership(tx, actor, 'doctor'); await calendarLock(tx, doctor.userId);
    const current = await review(tx, doctor.userId, dates);
    if (current.previewHash !== previewHash) throw new DomainError(409, 'DATE_BLOCK_REVIEW_CHANGED', 'The calendar changed. Review the selected dates again.');
    if (current.hasActiveReservations) throw new DomainError(409, 'CALENDAR_TRANSITION_PENDING', 'Wait for the active appointment operation, then review again.');
    const existing = new Set(current.alreadyBlockedDates), remaining = dates.filter(day => !existing.has(day));
    const segments: { startDate: string; endDate: string; weekday?: number }[] = [];
    if(selection.mode === 'weekly' && remaining.length) segments.push({startDate:selection.startDate!,endDate:selection.endDate!,weekday:selection.weekday!});
    for (const day of selection.mode === 'weekly' ? [] : remaining) {
      const last = segments.at(-1);
      if (last && selection.mode !== 'custom' && Date.parse(day) - Date.parse(last.endDate) === 86400000) last.endDate = day;
      else segments.push({ startDate: day, endDate: day });
    }
    const blocks = [];
    for (const segment of segments) {
      const id = randomUUID();
      await tx.query(`INSERT INTO doctor_date_blocks (id,doctor_id,start_date,end_date,weekday,created_at,version)
        VALUES($1,$2,$3::date,$4::date,$5,NOW(),0)`, [id, doctor.userId, segment.startDate, segment.endDate, segment.weekday ?? null]);
      await appendSqlOutbox(tx, { producer: 'appointment', eventType: 'vital.audit.requested', aggregateId: id, aggregateVersion: 0,
        correlationId: actor.correlationId, causationId: meta.operationId,
        data: { auditType: 'vital.appointment.date_block_created', actorAuthId: actor.authId, resourceId: id, resourceType: 'appointment' } });
      blocks.push({ id, version: 0, ...segment, weekday: segment.weekday ?? null });
    }
    return { blocks, createdDateCount: remaining.length, alreadyBlockedCount: existing.size, appointmentCount: current.appointmentCount };
  });
}
