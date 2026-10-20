import type { PoolClient } from 'pg';
import type { Actor } from '../../contracts/actor.js';
import { DomainError } from '../../contracts/actor.js';
import { appointmentOwn, lockAppointment, membership, readAppointment } from './appointment.js';

export type MessagingAppointment = {
  id: string; patientId: string; doctorId: string; status: string; completedAt: Date | null;
  appointmentKind: string; followUpOfAppointmentId: string | null; sourceAppointmentId: string | null;
  scheduledAt: Date; proposedEndAt: Date | null; slotEndsAt: Date | null;
  statusLogs: { fromStatus: string | null; toStatus: string; changedAt: Date }[];
};
export type MessageAccess = { canSend: boolean; sendUntil: string | null; hasActiveFollowUp: boolean;
  nextOpenAt: string | null; availabilityReason: 'open' | 'before_follow_up' | 'window_closed' | 'cancelled' | 'rescheduled' | 'schedule_unavailable' | 'processing' | 'purged' };
const active = new Set(['approved', 'confirmed']);
export const messageHistoryStatuses = ['approved', 'confirmed', 'completed', 'cancelled', 'rescheduled'];
function cancellationDate(row: MessagingAppointment) {
  const times = row.statusLogs.filter(log => log.toStatus === 'cancelled' && active.has(log.fromStatus ?? '')).map(log => log.changedAt.getTime());
  return times.length ? Math.max(...times) : null;
}
function accepted(row: MessagingAppointment) {
  return active.has(row.status) || ['completed', 'rescheduled'].includes(row.status) ||
    row.status === 'cancelled' && (cancellationDate(row) !== null || row.statusLogs.some(log => active.has(log.toStatus)));
}
export function linkedMessageAppointments(seed: MessagingAppointment, rows: MessagingAppointment[]) {
  const scoped = new Map(rows.filter(row => row.patientId === seed.patientId && row.doctorId === seed.doctorId).map(row => [row.id, row]));
  scoped.set(seed.id, seed);
  const edges = new Map<string, Set<string>>();
  for (const row of scoped.values()) if (accepted(row)) for (const parent of [row.followUpOfAppointmentId, row.sourceAppointmentId]) {
    if (!parent || !scoped.has(parent)) continue;
    edges.set(row.id, new Set([...(edges.get(row.id) ?? []), parent]));
    edges.set(parent, new Set([...(edges.get(parent) ?? []), row.id]));
  }
  const visited = new Set<string>(), pending = [seed.id];
  while (pending.length) { const id = pending.pop()!; if (visited.has(id)) continue; visited.add(id); pending.push(...edges.get(id) ?? []); }
  return [...visited].map(id => scoped.get(id)!);
}
export function calculateMessageAccess(seed: MessagingAppointment, rows: MessagingAppointment[] = [seed], now = new Date()): MessageAccess {
  const closed: MessageAccess = { canSend: false, sendUntil: null, hasActiveFollowUp: false, nextOpenAt: null, availabilityReason: 'window_closed' };
  if (seed.status === 'cancelled' || seed.status === 'rescheduled') return { ...closed, availabilityReason: seed.status };
  if (!active.has(seed.status) && seed.status !== 'completed') return closed;
  const chain = linkedMessageAppointments(seed, rows);
  const byId = new Map(chain.map(row => [row.id, row]));
  const isFollowUp = (row: MessagingAppointment) => {
    const seen = new Set<string>();
    let current: MessagingAppointment | undefined = row;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.appointmentKind === 'follow_up') return true;
      current = current.sourceAppointmentId ? byId.get(current.sourceAppointmentId) : undefined;
    }
    return false;
  };
  const validSchedule = (row: MessagingAppointment) => {
    const end = row.slotEndsAt ?? row.proposedEndAt;
    return end instanceof Date && row.scheduledAt instanceof Date && Number.isFinite(+end) && Number.isFinite(+row.scheduledAt) && end > row.scheduledAt ? end : null;
  };
  if (!validSchedule(seed)) return { ...closed, availabilityReason: 'schedule_unavailable' };
  const day = 86_400_000;
  const windows = chain.flatMap(row => {
    if (!active.has(row.status) && row.status !== 'completed') return [];
    const followUp = isFollowUp(row), end = validSchedule(row);
    if (!end || row.id !== seed.id && (seed.status !== 'completed' || !followUp)) return [];
    return [{ start: followUp ? +row.scheduledAt - day : -Infinity, end: +end + day, followUp }];
  }).sort((a, b) => a.start - b.start);
  const current = windows.filter(window => window.start <= +now && +now < window.end);
  if (current.length) {
    let end = Math.max(...current.map(window => window.end));
    for (const window of windows) if (window.start <= end && window.end > end) end = window.end;
    return { ...closed, canSend: true, sendUntil: new Date(end).toISOString(),
      hasActiveFollowUp: current.some(window => window.followUp), availabilityReason: 'open' };
  }
  const next = windows.find(window => window.start > +now);
  return next ? { ...closed, nextOpenAt: new Date(next.start).toISOString(), availabilityReason: 'before_follow_up' } : closed;
}
export async function loadMessagingChain(tx: Pick<PoolClient, 'query'>, seed: { patientId: string; doctorId: string }) {
  const rows = (await tx.query<MessagingAppointment>(`SELECT a.id,a."patientId",a."doctorId",a.status,a."completedAt",a."appointmentKind",a."followUpOfAppointmentId",a."sourceAppointmentId",a."scheduledAt",a."proposedEndAt",
    CASE WHEN s.id IS NOT NULL THEN (s."slotDate"+s."endTime"+CASE WHEN s."endTime"<=s."startTime" THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END) AT TIME ZONE 'Asia/Manila' END AS "slotEndsAt"
    FROM appointments a LEFT JOIN schedules s ON s.id=a."scheduleSlotId" WHERE a."patientId"=$1 AND a."doctorId"=$2 ORDER BY a.id LIMIT 2001`, [seed.patientId, seed.doctorId])).rows;
  if (rows.length > 2000) throw new DomainError(503, 'MESSAGING_CHAIN_LIMIT', 'Conversation eligibility is temporarily unavailable.');
  const logs = (await tx.query<{ appointmentId: string; fromStatus: string | null; toStatus: string; changedAt: Date }>(
    `SELECT "appointmentId","fromStatus","toStatus","changedAt" FROM appointment_logs WHERE "appointmentId"=ANY($1::text[]) AND "toStatus" IN ('approved','confirmed','cancelled')`, [rows.map(row => row.id)])).rows;
  return rows.map(row => ({ ...row, statusLogs: logs.filter(log => log.appointmentId === row.id) }));
}
export async function appointmentMessagingProcessing(tx: Pick<PoolClient, 'query'>, row: { id: string; billingLineageId: string }) {
  return (await tx.query(`SELECT id FROM saga_operations WHERE "billingLineageId"=$1 AND status NOT IN ('completed','compensated','cancelled','failed') LIMIT 1`, [row.billingLineageId])).rows.length > 0 ||
    (await tx.query(`SELECT id FROM appointment_workflows WHERE "targetAppointmentId"=$1 AND state='committed' AND "videoProcessingState"<>'finalized' LIMIT 1`, [row.id])).rows.length > 0;
}
export async function messagingAppointment(tx: PoolClient, actor: Actor, id: string, lock = false) {
  await membership(tx, actor);
  // Hide a foreign appointment using the same contract as an unknown one.
  const row = await (lock ? lockAppointment(tx, id) : readAppointment(tx, id)).catch(error => {
    if (error instanceof DomainError && error.status === 404) throw new DomainError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
    throw error;
  });
  if (lock) await membership(tx, actor);
  try { appointmentOwn(actor, row); } catch { throw new DomainError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.'); }
  if (!messageHistoryStatuses.includes(row.status)) throw new DomainError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
  const chain = await loadMessagingChain(tx, row);
  const seed = chain.find(item => item.id === id);
  if (!seed) throw new DomainError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
  const processing = await appointmentMessagingProcessing(tx, row);
  return { row, seed, chain, processing };
}

export type MessagingListAppointment = { id: string; patientId: string; doctorId: string; billingLineageId: string; status: string; scheduledAt: Date; counterpartAuthId: string; specialty: string | null };
export async function listMessagingAppointments(tx: PoolClient, actor: Actor, boundary: { at: Date; id: string } | null, requested?: string) {
  const member = await membership(tx, actor);
  const roleColumn = actor.role === 'patient' ? 'patientId' : 'doctorId';
  const select = `SELECT a.id,a."patientId",a."doctorId",a."billingLineageId",a.status,a."scheduledAt",
    ${actor.role === 'patient' ? 'd' : 'p'}."authId" AS "counterpartAuthId",${actor.role === 'patient' ? 'd.specialty' : 'NULL::text'} AS specialty
    FROM appointments a JOIN vital_patients p ON p."userId"=a."patientId" JOIN vital_doctors d ON d."userId"=a."doctorId"
    WHERE a."${roleColumn}"=$1 AND a.status=ANY($2::"AppointmentStatus"[])`;
  const rows = (await tx.query<MessagingListAppointment>(select + ` AND ($3::timestamp IS NULL OR (a."scheduledAt",a.id)<($3,$4)) ORDER BY a."scheduledAt" DESC,a.id DESC LIMIT 51`,
    [member.userId, messageHistoryStatuses, boundary?.at ?? null, boundary?.id ?? null])).rows;
  const page = rows.slice(0, 50);
  const oldest = page.at(-1);
  const nextCursor = rows.length > 50 && oldest ? Buffer.from(JSON.stringify({ at: oldest.scheduledAt.toISOString(), id: oldest.id })).toString('base64url') : null;
  if (!boundary && requested && !page.some(row => row.id === requested)) {
    const extra = (await tx.query<MessagingListAppointment>(select + ' AND a.id=$3', [member.userId, messageHistoryStatuses, requested])).rows[0];
    if (extra) page.push(extra);
  }
  return { page, nextCursor };
}
