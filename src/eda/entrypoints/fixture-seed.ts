import { createHash } from 'node:crypto';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type AppointmentStatus } from '../generated/core/client.js';
import { createMessageCrypto } from '../modules/messaging/crypto.js';
import { messageExpiryDate } from '../modules/messaging/retention.js';

type Identity = { authId: string; systems: Record<string, string>; ehrPatientId?: string };
type StatusChange = { toStatus: string; fromStatus: string | null; changedAt: Date; changedByRole: string; changedByAuthId: string };
type Plan = {
  fingerprint: string; seed: number; start: string; anchor: string;
  counts: { appointments: number }; activity: { appointments: string[] }; identities: Identity[];
};

const DAY = 86_400_000;
const MINUTE = 60_000;
const MESSAGE = 'Simulation: please bring your appointment reference to the clinic.';

function fixtureId(key: string, name: string): string {
  const hex = createHash('sha256').update(`vital-fixture:${key}:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function atBusinessTime(day: string, hour: number, minute: number): Date {
  return new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`);
}

async function main() {
  const mode = process.env.VITAL_FIXTURE_MODE;
  if (!['fixture-seed', 'fixture-verify', 'fixture-refresh'].includes(mode ?? '') ||
      !/^bgh-fixture-[a-z0-9][a-z0-9-]{0,31}$/.test(process.env.BGH_FIXTURE_PROJECT ?? '')) {
    throw new Error('FIXTURE_PROJECT_REQUIRED');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk);
    if (size > 2_000_000) throw new Error('FIXTURE_PLAN_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  const plan = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Plan;
  const count = plan.counts.appointments;
  const stamps = plan.activity.appointments;
  const anchor = atBusinessTime(plan.anchor, 0, 0);
  const start = atBusinessTime(plan.start, 0, 0);
  if (!Number.isInteger(count) || count < 12 || count > 6000 || stamps.length !== count ||
      !/^[a-f0-9]{64}$/.test(plan.fingerprint) || !Number.isFinite(anchor.getTime()) || !Number.isFinite(start.getTime())) {
    throw new Error('FIXTURE_PLAN_INVALID');
  }
  const url = process.env.VITAL_CORE_MIGRATION_URL;
  if (!url || new URL(url).pathname !== '/vital_core' || new URL(url).hostname !== 'postgres' ||
      new URL(url).username !== 'vital_core_migrator') throw new Error('FIXTURE_DATABASE_BOUNDARY_INVALID');
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
  const db = new PrismaClient({ adapter: new PrismaPg(pool) });
  const crypto = createMessageCrypto();
  try {
    const relevant = plan.identities.filter(row => row.systems.vital === 'doctor' || row.systems.vital === 'patient');
    const users = await db.vitalUser.findMany({ where: { authId: { in: relevant.map(item => item.authId) } },
      include: { doctor: true, patient: true }, orderBy: { authId: 'asc' } });
    const byAuthId = new Map(users.map(user => [user.authId, user]));
    for (const item of relevant) {
      const user = byAuthId.get(item.authId);
      if (!user || user.role !== item.systems.vital || (item.systems.vital === 'doctor' && !user.doctor?.specialty) ||
          (item.systems.vital === 'patient' && (!item.ehrPatientId || user.patient?.ehrPatientId !== item.ehrPatientId))) {
        throw new Error('FIXTURE_VITAL_IDENTITY_LINK_MISMATCH');
      }
    }
    const doctors = users.flatMap(user => user.doctor ? [user.doctor] : []);
    const patients = users.flatMap(user => user.patient ? [user.patient] : []);
    if (!doctors.length || !patients.length) throw new Error('FIXTURE_VITAL_ROLES_MISSING');
    if (mode === 'fixture-refresh') {
      // Place unreserved slots on the next three business days. Keep booked slots intact.
      const today = new Date(Date.now() + 8 * 60 * MINUTE).toISOString().slice(0, 10);
      let published = 0;
      for (let offset = 1; published < 3; offset++) {
        const date = new Date(Date.parse(today) + offset * DAY);
        if ([0, 6].includes(date.getUTCDay())) continue;
        const day = date.toISOString().slice(0, 10);
        const doctor = doctors[published % doctors.length]!;
        const id = fixtureId(plan.fingerprint, `live:${day}:${published}`);
        await db.schedule.upsert({ where: { id }, update: {},
          create: { id, doctorId: doctor.userId, slotDate: date, startTime: new Date('1970-01-01T10:00:00Z'),
            endTime: new Date('1970-01-01T10:30:00Z'), consultationType: 'in_person', isPublished: true } });
        published++;
      }
      console.log(JSON.stringify({ upcoming_slots: published }));
      return;
    }

    const perDay = new Map<string, number>();
    const previousVisits = new Map<string, { id: string; patient: (typeof patients)[number]; completedAt: Date }>();
    const states: Record<string, number> = {};
    let messageCount = 0;
    let feedbackCount = 0;
    let followUpCount = 0;
    for (const [i, stamp] of stamps.entries()) {
      const day = stamp.slice(0, 10);
      const index = perDay.get(day) ?? 0;
      perDay.set(day, index + 1);
      const doctor = doctors[index % doctors.length]!;
      const slotOrdinal = Math.floor(index / doctors.length);
      if (slotOrdinal >= 16) throw new Error('FIXTURE_CLINIC_IS_OVERBOOKED');
      const hour = 8 + Math.floor(slotOrdinal / 2);
      const minute = slotOrdinal % 2 * 30;
      const scheduledAt = atBusinessTime(day, hour, minute);
      if (!(scheduledAt >= start && scheduledAt < anchor)) throw new Error('FIXTURE_APPOINTMENT_DATE_INVALID');
      const id = fixtureId(plan.fingerprint, `appointment:${i}`);
      const slotId = fixtureId(plan.fingerprint, `slot:${i}`);
      const minutesBefore = (2 + i % 22) * 60;
      const createdAt = new Date(Math.max(start.getTime() + MINUTE, scheduledAt.getTime() - minutesBefore * MINUTE));
      const prior = previousVisits.get(doctor.userId);
      const followUp = prior && prior.completedAt < createdAt && i % 7 === 0 ? prior : null;
      const patient = followUp?.patient ?? patients[(i * 11 + 3) % patients.length]!;
      const slotPublishedAt = new Date(Math.max(start.getTime(), createdAt.getTime() - 30 * MINUTE));
      const decidedAt = new Date(createdAt.getTime() + (scheduledAt.getTime() - createdAt.getTime()) / 2);
      const end = new Date(scheduledAt.getTime() + 30 * MINUTE);
      const variant = (i * 37 + plan.seed % 100 + 100) % 100;
      const status: AppointmentStatus = variant < 69 ? 'completed' : variant < 85 ? 'cancelled' : variant < 94 ? 'rejected' : 'pending';
      const updatedAt = status === 'completed' ? end : status === 'pending' ? createdAt : decidedAt;
      const completedAt = status === 'completed' ? end : null;
      const logged: StatusChange[] = [{ toStatus: 'pending', fromStatus: null, changedAt: createdAt,
        changedByRole: 'patient', changedByAuthId: patient.authId }];
      if (status === 'completed') {
        logged.push({ toStatus: 'confirmed', fromStatus: 'pending', changedAt: decidedAt,
          changedByRole: 'doctor', changedByAuthId: doctor.authId });
      }
      if (status !== 'pending') logged.push({ toStatus: status, fromStatus: status === 'completed' ? 'confirmed' : 'pending',
        changedAt: updatedAt, changedByRole: status === 'cancelled' ? 'patient' : 'doctor',
        changedByAuthId: status === 'cancelled' ? patient.authId : doctor.authId });

      // Conversation eligibility uses the owning service's retention calculation.
      const messageAt = new Date(decidedAt.getTime() + 5 * MINUTE);
      const expiry = messageExpiryDate({ status, completedAt, updatedAt, lastCompletedVisitAt: completedAt,
        lastMessageAt: messageAt, legalHoldAt: null });
      const recent = messageAt.getTime() >= anchor.getTime() - 45 * DAY && (!expiry || expiry >= anchor);
      const withMessage = recent && i % 4 === 0 && status === 'completed';
      const withFeedback = i % 5 === 0 && status === 'completed';
      const consultationType = status !== 'completed' && i % 5 === 0 ? 'virtual' : 'in_person';
      const messageId = fixtureId(plan.fingerprint, `message:${i}`);
      const reason = status === 'cancelled' ? 'Simulation: patient requested cancellation' : null;
      if (mode === 'fixture-seed') {
        await db.$transaction(async tx => {
          if (await tx.appointment.findUnique({ where: { id }, select: { id: true } })) return;
          const startTime = new Date(Date.UTC(1970, 0, 1, hour, minute));
          await tx.schedule.create({ data: { id: slotId, doctorId: doctor.userId, slotDate: new Date(day), startTime,
            endTime: new Date(startTime.getTime() + 30 * MINUTE), consultationType, isPublished: true, createdAt: slotPublishedAt } });
          const message = withMessage ? crypto.encrypt(MESSAGE, id, messageId) : null;
          await tx.appointment.create({ data: { id, patientId: patient.userId, doctorId: doctor.userId, scheduleSlotId: slotId,
            scheduledAt, proposedEndAt: end, createdAt, updatedAt, status, consultationType, billingLineageId: fixtureId(plan.fingerprint, `billing:${i}`),
            completedAt, maintenanceDueAt: new Date(anchor.getTime() + 30 * DAY), cancellationReason: reason,
            appointmentKind: followUp ? 'follow_up' : 'standard', followUpOfAppointmentId: followUp?.id,
            rejectionReason: status === 'rejected' ? 'Simulation: refer to a different clinic' : null,
            statusLogs: { create: logged.map((entry, n) => ({ id: fixtureId(plan.fingerprint, `log:${i}:${n}`), ...entry })) },
            preConsultation: { create: { id: fixtureId(plan.fingerprint, `intake:${i}`),
              chiefComplaint: ['Follow-up consultation', 'Routine check-up', 'Review of test results'][i % 3],
              isSubmitted: true, submittedAt: createdAt } },
            ...(status === 'completed' ? { consultation: { create: { id: fixtureId(plan.fingerprint, `consult:${i}`),
              sessionStartedAt: scheduledAt, sessionEndedAt: end } } } : {}),
            ...(withFeedback ? { feedback: { create: { id: fixtureId(plan.fingerprint, `feedback:${i}`),
              patientId: patient.userId, doctorId: doctor.userId, starRating: 3 + i % 3,
              feedback: 'Simulation: appointment feedback submitted after the visit.', submittedAt: new Date(end.getTime() + 10 * MINUTE) } } } : {}),
            ...(message ? { messageConversation: { create: { id: fixtureId(plan.fingerprint, `conversation:${i}`), createdAt: messageAt,
              messages: { create: { id: messageId, senderUserId: doctor.userId, senderRole: 'doctor',
                clientMessageId: messageId, createdAt: messageAt, ...message } } } } } : {}),
          } });
        });
      }
      const row = await db.appointment.findUniqueOrThrow({ where: { id }, include: { scheduleSlot: true,
        statusLogs: true, preConsultation: true, consultation: true, feedback: true,
        messageConversation: { include: { messages: true } } } });
      if (row.patientId !== patient.userId || row.doctorId !== doctor.userId || row.status !== status || row.scheduleSlotId !== slotId ||
          row.followUpOfAppointmentId !== (followUp?.id ?? null) ||
          row.scheduleSlot?.createdAt.getTime() !== slotPublishedAt.getTime() || row.scheduleSlot.createdAt >= row.createdAt ||
          row.scheduledAt.getTime() !== scheduledAt.getTime() ||
          row.createdAt.getTime() !== createdAt.getTime() || row.statusLogs.length !== logged.length || !row.preConsultation?.isSubmitted ||
          Boolean(row.consultation) !== Boolean(completedAt)) throw new Error('FIXTURE_APPOINTMENT_MISMATCH');
      for (const entry of logged) {
        if (!row.statusLogs.some(log => log.toStatus === entry.toStatus && log.fromStatus === entry.fromStatus &&
            log.changedByAuthId === entry.changedByAuthId && log.changedAt.getTime() === entry.changedAt.getTime())) {
          throw new Error('FIXTURE_APPOINTMENT_HISTORY_MISMATCH');
        }
      }
      if (withMessage) {
        const message = row.messageConversation?.messages[0];
        if (!message || message.id !== messageId || crypto.decrypt(message, id) !== MESSAGE) throw new Error('FIXTURE_MESSAGE_MISMATCH');
        messageCount++;
      }
      if (withFeedback) {
        if (!row.feedback || row.feedback.patientId !== patient.userId || row.feedback.submittedAt < end) {
          throw new Error('FIXTURE_FEEDBACK_MISMATCH');
        }
        feedbackCount++;
      }
      if (completedAt) previousVisits.set(doctor.userId, { id, patient, completedAt });
      if (followUp) followUpCount++;
      states[status] = (states[status] ?? 0) + 1;
    }
    console.log(JSON.stringify({ appointments: count, slots: count, messages: messageCount, feedback: feedbackCount,
      follow_ups: followUpCount, states }));
  } finally {
    await db.$disconnect();
    await pool.end();
  }
}

main().catch(error => {
  console.error(error instanceof Error && /^FIXTURE_[A-Z_]+$/.test(error.message) ? error.message : 'FIXTURE_VITAL_OPERATION_FAILED');
  process.exitCode = 1;
});
