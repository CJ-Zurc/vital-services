import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError } from '../../contracts/actor.js';
import type { AppointmentReadSnapshot } from './appointment-reads.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const snapshot = z.object({
  summary: z.object({ today: count, pending: count, patients: count, completed: count }).strict(),
  statusCounts: z.record(z.string(), count),
  todayAppointmentIds: z.array(z.uuid()).max(5),
  pendingRequestIds: z.array(z.uuid()).max(5),
  fingerprint: z.string().regex(/^[a-f0-9]{32}$/),
}).strict();

// Prisma timestamp columns store UTC without a PostgreSQL time-zone annotation.
const overviewSql = `WITH owned AS (
  SELECT a.id,a.version,a.status,a."patientId",a."scheduledAt",
    COALESCE(s."slotDate"::date,(a."scheduledAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila')::date) AS "visitDate"
  FROM appointments a LEFT JOIN schedules s ON s.id=a."scheduleSlotId" WHERE a."doctorId"=$1
)
SELECT jsonb_build_object(
  'today',COUNT(*) FILTER (WHERE "visitDate"=$2::date AND status IN ('approved','confirmed')),
  'pending',COUNT(*) FILTER (WHERE status='pending'),
  'patients',COUNT(DISTINCT "patientId") FILTER (WHERE status IN ('approved','confirmed','completed')),
  'completed',COUNT(*) FILTER (WHERE status='completed')) AS summary,
  COALESCE((SELECT jsonb_object_agg(status,total) FROM (SELECT status,COUNT(*) AS total FROM owned GROUP BY status) counts),'{}'::jsonb) AS "statusCounts",
  ARRAY(SELECT id FROM owned WHERE "visitDate"=$2::date AND status IN ('approved','confirmed') ORDER BY "scheduledAt",id LIMIT 5) AS "todayAppointmentIds",
  ARRAY(SELECT id FROM owned WHERE status='pending' ORDER BY "scheduledAt",id LIMIT 5) AS "pendingRequestIds",
  md5(COALESCE(string_agg(id||':'||version::text||':'||"visitDate"::text,',' ORDER BY id),'')) AS fingerprint
FROM owned`;

export async function readDoctorDashboard(pool: Pool, doctorId: string, now: number,
  hydrate: (ids: string[]) => Promise<AppointmentReadSnapshot[]>, validateMembership: () => Promise<unknown>) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now));
  const today = ['year', 'month', 'day'].map(name => parts.find(part => part.type === name)!.value).join('-');
  const read = async () => snapshot.parse((await pool.query(overviewSql, [doctorId, today])).rows[0]);
  const initial = await read();
  const ids = [...initial.todayAppointmentIds, ...initial.pendingRequestIds];
  const changed = () => new DomainError(409, 'APPOINTMENT_READ_CHANGED', 'Appointment changed during composition.');
  if (new Set(ids).size !== ids.length) throw changed();
  // Aggregate the whole history, but only hydrate the existing ten dashboard cards.
  const appointments = ids.length ? await hydrate(ids) : [];
  if (appointments.length !== ids.length || new Set(appointments.map(row => row.id)).size !== ids.length
    || appointments.some(row => row.doctorId !== doctorId || !ids.includes(row.id)
      || (initial.pendingRequestIds.includes(row.id) ? row.status !== 'pending' : !['approved', 'confirmed'].includes(row.status)))) throw changed();
  if (JSON.stringify(await read()) !== JSON.stringify(initial)) throw changed();
  await validateMembership();
  const { fingerprint: _fingerprint, ...data } = initial;
  return { ...data, appointments };
}
