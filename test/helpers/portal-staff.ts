import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { CorePrismaClient } from '../../src/eda/infrastructure/databases.js';
import { createPaymentStore } from '../../src/eda/modules/payment/payment-store.js';
import { createPortalVideoProjection } from '../../src/eda/modules/video/portal-projection.js';
import { createPortalStaffComposer } from '../../src/eda/modules/portal-integrations/portal-integrations-staff.js';
import { createPortalStaffAppointmentReader } from '../../src/eda/modules/portal-integrations/portal-integrations-appointments.js';
import type { PortalSource } from '../../src/eda/modules/portal-integrations/portal-integrations-contracts.js';

type Row = Record<string, any>;
export function portalStaffFixture() {
  const reference = { id: randomUUID(), version: 3, patientId: randomUUID(), doctorId: randomUUID(),
    billingLineageId: randomUUID(), associationVersion: 2 };
  const source: PortalSource = { subject: randomUUID(), system: 'ehr', systems: ['ehr'], roles: ['nurse'],
    isAdmin: false, isSuperAdmin: false, expiresAt: Math.floor(Date.now() / 1000) + 300 };
  const row: Row = { ...reference, patientAuthId: randomUUID(), doctorAuthId: randomUUID(),
    status: 'confirmed', consultationType: 'virtual', appointmentKind: 'standard',
    sourceAppointmentId: randomUUID(), scheduleSlotId: randomUUID(), slotDate: '2026-10-17',
    startTime: '09:00:00', endTime: '09:30:00', chiefComplaint: 'fixture complaint', opqrst: { onset: 'today' },
    sessionStartedAt: null, sessionEndedAt: null };
  const payment: Row = { appointmentId: reference.id, billingLineageId: reference.billingLineageId,
    associationVersion: reference.associationVersion, patientAuthId: row.patientAuthId, doctorAuthId: row.doctorAuthId,
    status: 'paid', amount: '200.00', amountCentavos: 20000, paidAt: new Date('2026-10-16T01:00:00Z'),
    checkoutUrl: 'https://checkout.example.test/fixture', refundEligible: true, paymentIntentId: 'private-provider-id' };
  const context: Row = { ...reference, status: row.status, videoResourceId: randomUUID(), videoResourceVersion: 4 };
  const resource: Row = { id: context.videoResourceId, appointmentId: reference.id, doctorId: reference.doctorId,
    billingLineageId: reference.billingLineageId, associationVersion: reference.associationVersion, version: 4,
    provider: 'gmeet', meetingUrl: 'https://meet.google.com/abc-defg-hij', normalizedMeetingUrl: 'https://meet.google.com/abc-defg-hij',
    validationStatus: 'validated', preparedWorkflowId: null, retiredAt: null, accessToken: 'never-project' };
  const logs = Array.from({ length: 51 }, (_, index) => ({ id: String(index).padStart(3, '0'),
    fromStatus: 'approved', toStatus: 'confirmed', changedByRole: 'doctor', note: 'fixture-' + index,
    changedAt: new Date(1_700_000_000_000 + index * 1000) }));
  const related: Row[] = [
    { id: row.sourceAppointmentId, patientId: row.patientId, doctorId: row.doctorId, status: 'rescheduled' },
    ...Array.from({ length: 51 }, (_, index) => ({ id: 'proposal-' + String(index).padStart(3, '0'),
      patientId: row.patientId, doctorId: row.doctorId, sourceAppointmentId: row.id, status: 'pending_patient_confirmation', updatedAt: new Date(index * 1000) })),
    { id: 'follow-up', patientId: row.patientId, doctorId: row.doctorId, followUpOfAppointmentId: row.id, status: 'confirmed' },
    { id: 'other-patient', patientId: randomUUID(), doctorId: row.doctorId, sourceAppointmentId: row.id },
    { id: 'other-doctor', patientId: row.patientId, doctorId: randomUUID(), followUpOfAppointmentId: row.id },
  ];
  const calls: { owner: string; sql: string; values: any[] }[] = [];
  let paymentPresent = true, resourcePresent = true, contextPresent = true;
  let hook: ((owner: string) => void) | undefined;
  const core = { query: async (sql: string, values: any[]) => {
    calls.push({ owner: 'core', sql, values }); hook?.('core');
    if (sql.includes('SELECT a.*,p.')) { assert.deepEqual(values, [reference.id]); return { rows: [structuredClone(row)] }; }
    if (sql.includes('SELECT a.version')) { assert.deepEqual(values, [reference.id]); return { rows: contextPresent ? [structuredClone(context)] : [] }; }
    if (sql.includes('FROM appointment_logs')) {
      const candidates = values[0] === reference.id ? logs : logs.slice(0, 1);
      return { rows: structuredClone(candidates.filter(item => !values[1] || item.changedAt > values[1]
        || +item.changedAt === +values[1] && item.id > values[2]).slice(0, 50)) };
    }
    if (sql.includes('FROM appointments a LEFT JOIN schedules')) {
      assert.ok(sql.includes('a."patientId"=$3 AND a."doctorId"=$4'));
      const [id, parent, patient, doctor, cursor] = values;
      return { rows: structuredClone(related.filter(item => (item.id === parent || item.sourceAppointmentId === id || item.followUpOfAppointmentId === id)
        && item.patientId === patient && item.doctorId === doctor && (!cursor || item.id > cursor))
        .sort((a, b) => a.id.localeCompare(b.id)).slice(0, 50)) };
    }
    throw new Error('Unexpected portal Core query: ' + sql);
  } } as unknown as Pool;
  const integrations = { query: async (sql: string, values: any[]) => {
    calls.push({ owner: 'integrations', sql, values });
    if (sql.includes('FROM payments')) {
      hook?.('payment'); assert.deepEqual(values, [reference.id]);
      return { rows: paymentPresent ? [structuredClone(payment)] : [] };
    }
    if (sql.includes('FROM video_resources')) {
      hook?.('video');
      const matches = sql.includes('WHERE id=$1')
        ? resource.id === values[0] && resource.doctorId === values[1] && resource.billingLineageId === values[2]
        : resource.appointmentId === values[0] && resource.doctorId === values[1]
          && resource.billingLineageId === values[2] && resource.associationVersion === values[3];
      return { rows: resourcePresent && matches ? [structuredClone(resource)] : [] };
    }
    throw new Error('Unexpected portal Integrations query: ' + sql);
  } } as unknown as Pool;
  const video = createPortalVideoProjection(core, integrations);
  const compose = createPortalStaffComposer(core, { payment: createPaymentStore(integrations), video });
  const decoy = { ...reference, id: randomUUID() };
  const db = {
    $transaction: async (run: (tx: any) => Promise<unknown>, options: Row) => {
      assert.equal(options.isolationLevel, 'RepeatableRead');
      return run({ appointment: {
        count: async ({ where }: Row) => { assert.equal(where.patientId, reference.patientId); return 2; },
        findMany: async ({ skip, take, orderBy }: Row) => {
          assert.deepEqual(orderBy, [{ scheduledAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }]);
          return structuredClone([decoy, reference].slice(skip, skip + take));
        },
      } });
    },
    appointment: { findMany: async () => [{ id: reference.id, version: row.version }] },
  } as unknown as CorePrismaClient;
  return { reference, source, row, payment, context, resource, related, calls, compose, video,
    read: () => createPortalStaffAppointmentReader(db, compose)(source, { patientId: reference.patientId, page: '2', pageSize: '1' }),
    hook: (run: (owner: string) => void) => { hook = run; },
    noPayment: () => { paymentPresent = false; }, noResource: () => { resourcePresent = false; }, noContext: () => { contextPresent = false; },
  };
}
