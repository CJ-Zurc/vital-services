import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { DomainError, type Actor } from '../src/eda/contracts/actor.js';
import { createCompletionProfileOwner } from '../src/eda/modules/profile/profile-completion.js';
import { createCompletionReads } from '../src/eda/modules/composition/completion-reads.js';
import { createAppointmentCompletionOwner } from '../src/eda/modules/appointment/appointment-completion.js';
import { createRecordsCompletionOwner } from '../src/eda/modules/records/completion.js';
import { createPaymentCompletionOwner } from '../src/eda/modules/payment/payment-completion.js';
import type { PaymentRow } from '../src/eda/modules/payment/payment-store.js';
import type { AppointmentReadSnapshot } from '../src/eda/modules/appointment/appointment-reads.js';

function sqlPool(run: (sql: string, args: unknown[]) => unknown[]) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const tx = { query: async (sql: string, args: unknown[] = []) => { calls.push({ sql, args }); return { rows: run(sql, args) }; }, release() {} };
  return { pool: { ...tx, connect: async () => tx } as unknown as Pool, calls };
}
const actor = (role: Actor['role'], scope: string): Actor => { const authId = randomUUID(); return {
  authId, role, scopes: [scope], resource: authId, isSuperAdmin: false, serviceId: 'vital-web', correlationId: randomUUID(),
}; };
function dashboard() {
  const patient = actor('patient', 'completion.patient.dashboard'), patientId = randomUUID(), doctorAuthId = randomUUID(), doctorId = randomUUID();
  const date = new Date('2026-10-20T00:00:00.000Z');
  let member = true, appointmentRevision = 1, paymentRevision = 1;
  const references = Array.from({ length: 620 }, (_, index) => ({ id: randomUUID(), version: 1, status: index < 4 ? 'pending' : 'completed',
    scheduledAt: date, billingLineageId: randomUUID(), associationVersion: 1, doctorAuthId }));
  const payments = references.slice(0, 550).map(ref => ({ id: randomUUID(), version: 1, appointmentId: ref.id,
    billingLineageId: ref.billingLineageId, associationVersion: 1, patientAuthId: patient.authId, doctorAuthId, status: 'paid' }));
  const upcoming = references.slice(0, 4).map(ref => ({ ...ref, patientId, doctorId, patientAuthId: patient.authId, specialty: 'Medicine',
    consultationType: 'in_person', scheduleSlotId: null, scheduleSlot: null, sourceAppointmentId: null, appointmentKind: 'standard', followUpOfAppointmentId: null,
    patientRescheduleCount: 0, doctorRescheduleCount: 0, cancellationReason: null, rejectionReason: null, ehrCaseId: null, proposedEndAt: null,
    createdAt: date, updatedAt: date, doctorConfirmedAt: null, patientConfirmedAt: null, completionDeadlineAt: null, autoCompletedAt: null, paperworkLockedAt: null,
    preConsultation: { chiefComplaint: null, opqrst: null }, statusLogs: [], sourceAppointment: null, rescheduleProposals: [], followUpAppointments: [],
    sessionStartedAt: null, sessionEndedAt: null }));
  const core = sqlPool((sql, args) => {
    if (sql.includes('FROM vital_patients p')) return member ? [{ userId: patientId }] : [];
    if (sql.startsWith('SELECT a.id,a.version')) return references.map(row => ({ ...row, version: appointmentRevision }));
    if (sql.includes('GROUP BY status')) return [{ status: 'pending', count: '4' }, { status: 'completed', count: '616' }];
    if (sql.startsWith('SELECT a.*,p.')) { assert.deepEqual(args, [patientId, new Date('2026-10-16T00:00:00Z')]); return upcoming; }
    if (sql.includes('AS documents')) return [{ documents: '733', files: '21' }];
    return [];
  });
  const integrations = sqlPool(sql => sql.includes('FROM payments') ? payments.map(row => ({ ...row, version: paymentRevision })) : []);
  const profile = createCompletionProfileOwner(core.pool);
  const appointments = createAppointmentCompletionOwner(core.pool, { list: async () => { throw new Error('Capped list must never run'); } }, {
    payment: { byAppointment: async id => ({ ...payments.find(row => row.appointmentId === id)!, amount: '100.00', checkoutUrl: null,
      paidAt: date.toISOString(), refundEligible: null } as PaymentRow) },
  }, () => Date.parse('2026-10-16T00:00:00Z'));
  const records = createRecordsCompletionOwner(core.pool), financial = createPaymentCompletionOwner(integrations.pool, profile);
  return { patient, patientId, references, payments, upcoming, core, integrations, profile, appointments, records, financial,
    reads: createCompletionReads(profile, { appointments, records, financial }),
    revoke: () => { member = false; }, changeAppointment: () => { appointmentRevision++; }, changePayment: () => { paymentRevision++; } };
}

test('completion dashboard aggregates are complete beyond snapshot limits', async () => {
  const f = dashboard(), result = await f.reads.patientDashboard(f.patient);
  assert.equal(result.appointments.length, 4);
  assert.deepEqual(result.statusCounts, { pending: 4, completed: 616 });
  assert.equal(result.paid, 550); assert.equal(result.documents, 733); assert.equal(result.files, 21);
  const query = f.core.calls.find(call => call.sql.startsWith('SELECT a.*,p.'))!;
  assert.match(query.sql, /ORDER BY a\."scheduledAt",a.id LIMIT 4/);
  assert.doesNotMatch(f.core.calls.map(call => call.sql).join('\n'), /LIMIT 50[01]/);
  assert.ok(f.core.calls.filter(call => call.sql.startsWith('SELECT a.id,a.version')).every(call => !call.sql.includes('LIMIT')));
  assert.ok(f.core.calls.every(call => !/INSERT|UPDATE|DELETE/.test(call.sql)));
  assert.ok(f.integrations.calls.every(call => !/JOIN|vital_patients|appointments/.test(call.sql)));
  const financialDb = sqlPool(() => [{ status: 'paid', count: '550', volume: '5500011' }]);
  const summary = await createPaymentCompletionOwner(financialDb.pool, { patient: async () => f.patientId, admin: async () => {} })
    .summary(actor('admin', 'completion.admin.dashboard'));
  assert.deepEqual(summary, { paymentCounts: { paid: 550 }, paidVolume: 55000.11 });
});

test('completion consent keyset pages preserve legacy list parity', async () => {
  const admin = actor('admin', 'profile.consent.read'), patientId = "patient' OR '1'='1", date = new Date('2026-10-16T00:00:00Z');
  const rows = Array.from({ length: 2507 }, (_, index) => ({ id: '00000000-0000-4000-8000-' + String(999999 - index).padStart(12, '0'),
    patientId, appointmentId: null, consentType: 'registration', accepted: true, consentedAt: date }));
  const db = sqlPool((sql, args) => {
    if (sql.includes('FROM vital_admins')) return [{ userId: randomUUID() }];
    if (sql.startsWith('SELECT id,"consentedAt"')) return [rows[0]!];
    if (sql.startsWith('SELECT COUNT(*)')) return [{ total: String(rows.length) }];
    if (sql.startsWith('SELECT id,"patientId"')) return rows.filter(row => !args[4] || row.id < String(args[4])).slice(0, Number(args[5]));
    return [];
  });
  const profile = createCompletionProfileOwner(db.pool), all: unknown[] = []; let cursor: string | null = null;
  do { const page = await profile.consents(admin, { patientId, ...(cursor ? { cursor } : {}) });
    all.push(...page.data); assert.equal(page.meta.total, 2507); cursor = page.meta.nextCursor;
  } while (cursor);
  assert.deepEqual(all, rows);
  const reads = db.calls.filter(call => call.sql.startsWith('SELECT id,"patientId"'));
  assert.equal(reads.length, 13);
  assert.ok(reads.every(call => call.args[0] === patientId && !call.sql.includes(patientId) && call.args[5] === 201));
  assert.match(reads[1]!.sql, /\("consentedAt",id\)<\(\$4::timestamp,\$5::text\)/);
  const first = await profile.consents(admin, { patientId });
  await assert.rejects(profile.consents(admin, { patientId: 'another', cursor: first.meta.nextCursor! }),
    error => error instanceof DomainError && error.code === 'COMPLETION_CONSENT_CURSOR_INVALID');
});

test('completion dashboard summary and upcoming remain owner authorized', async () => {
  const f = dashboard();
  for (const invalid of [{ ...f.patient, role: 'admin' as const }, { ...f.patient, resource: randomUUID() }])
    await assert.rejects(f.appointments.patient(invalid), error => error instanceof DomainError && error.status === 403);
  await assert.rejects(f.records.patientSummary(f.patient, randomUUID()), error => error instanceof DomainError && error.status === 403);
  await assert.rejects(createPaymentCompletionOwner(f.integrations.pool).patientSummary(f.patient, f.patientId, f.references),
    error => error instanceof DomainError && error.code === 'COMPLETION_PAYMENT_AUTHORITY_UNAVAILABLE');
  f.payments[0]!.associationVersion++;
  await assert.rejects(f.reads.patientDashboard(f.patient), error => error instanceof DomainError && error.status === 409);
  const g = dashboard(); g.upcoming[0]!.patientAuthId = randomUUID();
  await assert.rejects(g.reads.patientDashboard(g.patient), error => error instanceof DomainError && error.status === 409);
  const h = dashboard(); h.revoke();
  await assert.rejects(h.appointments.patient(h.patient), error => error instanceof DomainError && error.status === 404);
  await assert.rejects(h.financial.patientSummary(h.patient, h.patientId, h.references), error => error instanceof DomainError && error.status === 404);
});

test('completion dashboard aggregate changes fail closed on owner races', async () => {
  for (const kind of ['appointment', 'payment', 'membership'] as const) {
    const f = dashboard(), summary = f.records.patientSummary;
    f.records.patientSummary = async (...args) => { const result = await summary(...args);
      if (kind === 'appointment') f.changeAppointment(); else if (kind === 'payment') f.changePayment(); else f.revoke();
      return result;
    };
    await assert.rejects(f.reads.patientDashboard(f.patient), error => error instanceof DomainError && [403,404,409].includes(error.status));
  }
  const f = dashboard(), snapshot = await f.financial.patientSummary(f.patient, f.patientId, f.references);
  f.changePayment();
  await assert.rejects(snapshot.validate(), error => error instanceof DomainError && error.code === 'COMPLETION_PAYMENT_CHANGED');
  const g = dashboard(), before = await g.appointments.patient(g.patient);
  g.changeAppointment();
  await assert.rejects(before.validate(), error => error instanceof DomainError && error.code === 'COMPLETION_APPOINTMENT_CHANGED');
});
