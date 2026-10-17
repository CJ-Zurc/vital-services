import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { portalStaffFixture } from './helpers/portal-staff.js';

test('portal staff composer fences every Core and Payment association dimension', async () => {
  for (const field of ['version', 'billingLineageId', 'associationVersion', 'patientId', 'doctorId']) {
    const f = portalStaffFixture(); f.row[field] = typeof f.row[field] === 'number' ? 999 : randomUUID();
    await assert.rejects(f.compose(f.source, [f.reference]), { code: 'PORTAL_APPOINTMENT_READ_CHANGED' });
    assert.equal(f.calls.some(call => call.owner === 'integrations'), false);
  }
  for (const field of ['appointmentId', 'billingLineageId', 'associationVersion', 'patientAuthId', 'doctorAuthId']) {
    const f = portalStaffFixture(); f.payment[field] = typeof f.payment[field] === 'number' ? 999 : randomUUID();
    await assert.rejects(f.compose(f.source, [f.reference]), { code: 'PORTAL_PAYMENT_ASSOCIATION_CHANGED' });
    assert.equal(f.calls.some(call => call.sql.includes('FROM video_resources')), false);
  }
  const f = portalStaffFixture();
  f.hook(owner => { if (owner === 'video') f.row.version++; });
  await assert.rejects(f.read(), { code: 'PORTAL_APPOINTMENT_READ_CHANGED' });
});

test('portal staff composer preserves owner projections pagination and participant isolation', async () => {
  const f = portalStaffFixture();
  const result = await f.read();
  assert.deepEqual(result.meta, { page: 2, pageSize: 1, total: 2, totalPages: 2 });
  const item = result.data[0] as Record<string, any>;
  assert.equal(item.id, f.reference.id); assert.equal(item.statusLogs.length, 51);
  assert.equal(item.statusLogs[0].note, 'fixture-0'); assert.equal(item.statusLogs[50].note, 'fixture-50');
  assert.equal(item.sourceAppointment.id, f.row.sourceAppointmentId);
  assert.equal(item.rescheduleProposals.length, 51); assert.equal(item.rescheduleProposals[0].id, 'proposal-050');
  assert.equal(item.rescheduleProposals[0].statusLogs.length, 1);
  assert.deepEqual(item.followUpAppointments, [{ id: 'follow-up', status: 'confirmed' }]);
  assert.deepEqual(item.scheduleSlot, { slotDate: '2026-10-17', startTime: '09:00', endTime: '09:30' });
  assert.deepEqual(item.preConsultation, { chiefComplaint: 'fixture complaint', opqrst: { onset: 'today' } });
  assert.equal(item.payment.paidAt, '2026-10-16T01:00:00.000Z'); assert.equal(item.payment.amount, '200.00');
  assert.equal(item.consultation.meetingUrl, f.resource.meetingUrl); assert.equal(item.consultation.meetingValidationStatus, 'valid');
  const serialized = JSON.stringify(result);
  for (const secret of ['private-provider-id', 'never-project', 'other-patient', 'other-doctor']) assert.equal(serialized.includes(secret), false);
  assert.equal(f.calls.filter(call => call.sql.includes('FROM payments')).length, 1);
  assert.equal(f.calls.filter(call => call.sql.includes('FROM video_resources')).length, 1);
  const noOwners = portalStaffFixture(); noOwners.noPayment(); noOwners.row.consultationType = 'in_person';
  const [plain] = await noOwners.compose(noOwners.source, [noOwners.reference]);
  assert.equal(plain!.payment, null); assert.equal(plain!.consultation, null);
  assert.equal(noOwners.calls.some(call => call.sql.includes('FROM video_resources')), false);
  for (const status of ['pending', 'pending_patient_confirmation', 'rejected']) {
    const hidden = portalStaffFixture(); hidden.row.status = status;
    assert.equal((await hidden.compose(hidden.source, [hidden.reference]))[0]!.consultation, null);
    assert.equal(hidden.calls.some(call => call.sql.includes('FROM video_resources')), false);
  }
});

test('portal staff composer rejects revoked expired and mid-flight authority without returning partial data', async () => {
  for (const change of [{ roles: ['med-tech'] }, { systems: [] }, { expiresAt: 1 }, { system: 'vital', roles: ['admin'], isAdmin: true }]) {
    const f = portalStaffFixture(); Object.assign(f.source, change);
    await assert.rejects(f.compose(f.source, [f.reference]), { code: 'PORTAL_INTEGRATION_DELEGATION_DENIED' });
    assert.equal(f.calls.length, 0);
  }
  for (const stage of ['payment', 'video']) {
    const f = portalStaffFixture();
    f.hook(owner => { if (owner === stage) f.source.roles = ['patient']; });
    await assert.rejects(f.compose(f.source, [f.reference]), { code: 'PORTAL_INTEGRATION_DELEGATION_DENIED' });
  }
  const expiry = portalStaffFixture();
  expiry.hook(owner => { if (owner === 'payment') expiry.source.expiresAt = 1; });
  await assert.rejects(expiry.read(), { code: 'PORTAL_INTEGRATION_DELEGATION_DENIED' });
  const missing = portalStaffFixture(); missing.noResource();
  await assert.rejects(missing.compose(missing.source, [missing.reference]), { code: 'PORTAL_VIDEO_RESOURCE_NOT_FINALIZED' });
});

test('portal staff video projection fences stale prepared retired and reassociated resources', async () => {
  for (const field of ['version', 'associationVersion', 'billingLineageId', 'doctorId']) {
    const f = portalStaffFixture(); f.context[field] = typeof f.context[field] === 'number' ? 999 : randomUUID();
    await assert.rejects(f.compose(f.source, [f.reference]), { code: 'PORTAL_VIDEO_ASSOCIATION_CHANGED' });
  }
  for (const patch of [{ preparedWorkflowId: randomUUID() }, { retiredAt: new Date() }, { version: 3 },
    { appointmentId: randomUUID() }, { associationVersion: 1 }]) {
    const f = portalStaffFixture(); Object.assign(f.resource, patch);
    await assert.rejects(f.compose(f.source, [f.reference]), { code: 'PORTAL_VIDEO_ASSOCIATION_CHANGED' });
  }
  for (const field of ['id', 'doctorId', 'billingLineageId']) {
    const f = portalStaffFixture(); f.resource[field] = randomUUID();
    await assert.rejects(f.compose(f.source, [f.reference]), { code: 'PORTAL_VIDEO_RESOURCE_NOT_FINALIZED' });
  }
  const absent = portalStaffFixture(); absent.noContext();
  await assert.rejects(absent.compose(absent.source, [absent.reference]), { code: 'PORTAL_VIDEO_ASSOCIATION_CHANGED' });
  const fallback = portalStaffFixture(); fallback.context.videoResourceId = null;
  assert.equal((await fallback.compose(fallback.source, [fallback.reference]))[0]!.consultation!.meetingUrl, fallback.resource.meetingUrl);
  const rescheduled = portalStaffFixture(); rescheduled.context.status = 'rescheduled';
  rescheduled.resource.appointmentId = randomUUID(); rescheduled.resource.associationVersion++;
  assert.equal((await rescheduled.compose(rescheduled.source, [rescheduled.reference]))[0]!.consultation!.meetingUrl, rescheduled.resource.meetingUrl);
});
