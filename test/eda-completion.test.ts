import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import express, { type ErrorRequestHandler } from 'express';
import { DomainError, type Actor } from '../src/eda/contracts/actor.js';
import { createCompletionRouter, parseCompletionExportQuery } from '../src/eda/http/completion-router.js';
import { ANALYTICS_EXPORT_RESOURCE, ANALYTICS_EXPORT_SUBJECT, type CompletionOwners } from '../src/eda/contracts/completion.js';
import { createCompletionProfileOwner } from '../src/eda/modules/profile/profile-completion.js';
import { createCompletionReads } from '../src/eda/modules/composition/completion-reads.js';
import { createAppointmentCompletionOwner } from '../src/eda/modules/appointment/appointment-completion.js';
import { createRecordsCompletionOwner } from '../src/eda/modules/records/completion.js';
import { createPaymentCompletionOwner } from '../src/eda/modules/payment/payment-completion.js';

function actor(role: Actor['role'], scope: string): Actor {
  const authId = randomUUID();
  return { authId, role, scopes: [scope], resource: authId, serviceId: 'vital-web', isSuperAdmin: false, correlationId: randomUUID() };
}
const command = () => ({ operationId: randomUUID(), requestHash: 'a'.repeat(64) });
const exportActor = (): Actor => ({ ...actor('service', 'analytics.pre-consultations.export'), authId: ANALYTICS_EXPORT_SUBJECT, resource: ANALYTICS_EXPORT_RESOURCE });
function sqlPool(run: (sql: string, args: unknown[]) => unknown[] | Promise<unknown[]>) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const tx = { query: async (sql: string, args: unknown[] = []) => { calls.push({ sql, args }); return { rows: await run(sql, args) }; }, release() {} };
  return { pool: { ...tx, connect: async () => tx } as unknown as Pool, calls };
}
function fixture() {
  const patientId = randomUUID();
  const db = sqlPool(sql => sql.includes('FROM vital_patients p') ? [{ userId: patientId }] : sql.includes('FROM vital_admins a') ? [{ userId: randomUUID() }]
    : sql.includes('AS patients') ? [{ patients: '2', doctors: '3' }] : []);
  const profile = createCompletionProfileOwner(db.pool);
  const owners: CompletionOwners = { appointments: { patient: async () => ({ patientId, appointments: [], associations: [], statusCounts: {}, validate: async () => {} }), statusCounts: async () => ({ pending: 7 }),
    exportSubmitted: async () => ({ data: [], meta: { nextCursor: null, lastCursor: null, hasMore: false, upperBound: null } }) },
    records: { patientSummary: async () => ({ documents: 4, files: 5 }) }, financial: { summary: async () => ({ paymentCounts: { paid: 1 }, paidVolume: 123.45 }),
      patientSummary: async () => ({ paid: 8, validate: async () => {} }) } };
  return { ...db, profile, owners, patientId, reads: createCompletionReads(profile, owners) };
}
test('completion roles, scope, resource and independent admin marker gate composition', async () => {
  const f = fixture(), admin = actor('admin', 'completion.admin.dashboard');
  for (const invalid of [{ ...admin, role: 'patient' as const }, { ...admin, scopes: ['profile.admin.read'] }, { ...admin, resource: randomUUID() }])
    await assert.rejects(f.reads.adminDashboard(invalid), e => e instanceof DomainError && e.status === 403);
  const result = await f.reads.adminDashboard(admin);
  assert.deepEqual(result, { summary: { accounts: 5, patients: 2, doctors: 3, paidVolume: 123.45 }, statusCounts: { pending: 7 }, paymentCounts: { paid: 1 } });
  const revoked = sqlPool(() => []);
  await assert.rejects(createCompletionReads(createCompletionProfileOwner(revoked.pool), f.owners).adminDashboard(admin), e => e instanceof DomainError && e.status === 403);
  assert.ok(f.calls.every(call => !/FROM payments|JOIN payments/.test(call.sql)));
});
test('completion fails closed on missing domain owners and foreign patient snapshots', async () => {
  const f = fixture(), patient = actor('patient', 'completion.patient.dashboard');
  assert.deepEqual(await f.reads.patientDashboard(patient), { patientId: f.patientId, appointments: [], statusCounts: {}, paid: 8, documents: 4, files: 5 });
  await assert.rejects(createCompletionReads(f.profile).patientDashboard(patient), e => e instanceof DomainError && e.code === 'COMPLETION_APPOINTMENT_UNAVAILABLE');
  await assert.rejects(createCompletionReads(f.profile, { appointments: f.owners.appointments }).patientDashboard(patient), e => e instanceof DomainError && e.code === 'COMPLETION_RECORDS_UNAVAILABLE');
  f.owners.appointments!.patient = async () => ({ patientId: f.patientId, appointments: [{ patientAuthId: randomUUID(), patientId: f.patientId } as never],
    associations: [], statusCounts: {}, validate: async () => {} });
  await assert.rejects(f.reads.patientDashboard(patient), e => e instanceof DomainError && e.status === 409);
});
test('consent aliases preserve registration-only patient filter and overflow fails without truncation', async () => {
  const patientId = randomUUID(), admin = actor('admin', 'profile.consent.read');
  const db = sqlPool(sql => sql.includes('FROM vital_admins') ? [{ userId: randomUUID() }] : []);
  const profile = createCompletionProfileOwner(db.pool);
  await profile.consents(admin, { patientId });
  const call = db.calls.find(row => row.sql.includes('FROM consent_records'))!;
  assert.deepEqual(call.args, [patientId]); assert.match(call.sql, /"consentType"='registration'/); assert.match(call.sql, /ORDER BY "consentedAt" DESC,id DESC LIMIT 1/);
  await assert.rejects(profile.consents(admin, { cursor: 'invalid' }), e => e instanceof DomainError && e.code === 'COMPLETION_CONSENT_CURSOR_INVALID');
});
test('consent writes default off, require explicit acceptance, insert once and roll back duplicates', async () => {
  const patient = actor('patient', 'profile.consent.accept'), patientId = randomUUID(), consentId = randomUUID();
  let exists = false;
  const db = sqlPool(sql => sql.includes('FROM vital_patients p') ? [{ userId: patientId }]
    : sql.startsWith('SELECT id FROM consent_records') ? exists ? [{ id: consentId }] : []
      : sql.startsWith('INSERT INTO consent_records') ? (exists = true, [{ consentId, accepted: true, consentType: 'registration', consentedAt: new Date() }])
        : sql.startsWith('UPDATE vital_users') ? [{ version: 1 }] : []);
  const disabled = createCompletionProfileOwner(db.pool);
  await assert.rejects(disabled.acceptConsent(patient, { accepted: false }), e => e instanceof DomainError && e.status === 400);
  await assert.rejects(disabled.acceptConsent(patient, { accepted: true }), e => e instanceof DomainError && e.status === 503);
  assert.equal(db.calls.length, 0);
  const profile = createCompletionProfileOwner(db.pool, { consentWrites: true });
  await assert.rejects(profile.acceptConsent(patient, { accepted: true, injected: 'denied' }, command()));
  assert.equal((await profile.acceptConsent(patient, { accepted: true }, command()) as { consentId: string })?.consentId, consentId);
  await assert.rejects(profile.acceptConsent(patient, { accepted: true }, command()), e => e instanceof DomainError && e.status === 409 && e.message === 'Registration consent already recorded');
  assert.equal(db.calls.filter(row => row.sql.startsWith('INSERT INTO consent_records')).length, 1);
  assert.equal(db.calls.filter(row => row.sql === 'ROLLBACK').length, 1);
  assert.ok(db.calls.some(row => row.sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE'));
  assert.ok(db.calls.every(row => !/UPDATE consent_records|DELETE FROM consent_records/.test(row.sql)));
});
test('consent serializable retry is bounded and rechecks missing patient after rollback', async () => {
  const patient = actor('patient', 'profile.consent.accept'); let attempts = 0;
  const db = sqlPool(sql => { if (sql.includes('FOR UPDATE')) { attempts++; throw Object.assign(new Error('safe test'), { code: '40001' }); } return []; });
  await assert.rejects(createCompletionProfileOwner(db.pool, { consentWrites: true }).acceptConsent(patient, { accepted: true }, command()));
  assert.equal(attempts, 3); assert.equal(db.calls.filter(row => row.sql === 'ROLLBACK').length, 3);
  await assert.rejects(createCompletionProfileOwner(sqlPool(() => []).pool, { consentWrites: true }).acceptConsent(patient, { accepted: true }, command()), e => e instanceof DomainError && e.status === 404);
});

test('consent command replay rechecks current patient and cannot repeat effects or change hash', async () => {
  const patient = actor('patient', 'profile.consent.accept'), meta = command(), patientId = randomUUID();
  const receipt = { consentId: randomUUID(), consentType: 'registration', accepted: true, consentedAt: new Date().toISOString() };
  let member = true;
  const db = sqlPool(sql => sql.includes('FROM vital_patients p') ? member ? [{ userId: patientId }] : []
    : sql.includes('FROM command_operations') ? [{ action: 'profile.consent.accept', resourceId: patient.authId, requestHash: meta.requestHash, result: receipt }] : []);
  const profile = createCompletionProfileOwner(db.pool, { consentWrites: true });
  assert.deepEqual(await profile.acceptConsent(patient, { accepted: true }, meta), receipt);
  assert.equal(db.calls.some(row => /INSERT|UPDATE vital_users/.test(row.sql)), false);
  await assert.rejects(profile.acceptConsent(patient, { accepted: true }, { ...meta, requestHash: 'b'.repeat(64) }), e => e instanceof DomainError && e.code === 'COMMAND_REPLAY_CONFLICT');
  member = false;
  await assert.rejects(profile.acceptConsent(patient, { accepted: true }, meta), e => e instanceof DomainError && e.status === 404);
  assert.equal(db.calls.filter(row => row.sql === 'ROLLBACK').length, 2);
});
test('domain adapters use owner-local queries and derive only scoped appointment reads', async () => {
  const patient = actor('patient', 'completion.patient.dashboard'), patientId = randomUUID();
  let cappedList = false;
  const db = sqlPool(sql => sql.includes('FROM vital_patients p') ? [{ userId: patientId }] : sql.includes('AS documents') ? [{ documents: '3', files: '2' }]
    : sql.includes('AS volume') ? [{ status: 'paid', count: '2', volume: '10050' }] : []);
  const appointments = createAppointmentCompletionOwner(db.pool, { list: async () => { cappedList = true; return { appointments: [] }; } });
  await appointments.patient(patient); assert.equal(cappedList, false);
  assert.deepEqual(await createRecordsCompletionOwner(db.pool).patientSummary(patient, patientId), { documents: 3, files: 2 });
  const records = db.calls.find(row => row.sql.includes('AS documents'))!;
  assert.deepEqual(records.args, [patientId]); assert.doesNotMatch(records.sql, /JOIN|FROM appointments|payments/);
  assert.deepEqual(await createPaymentCompletionOwner(db.pool, { patient: async () => patientId, admin: async () => {} }).summary(actor('admin', 'completion.admin.dashboard')), { paymentCounts: { paid: 2 }, paidVolume: 100.5 });
  assert.doesNotMatch(db.calls.at(-1)!.sql, /JOIN|vital_patients|appointments/);
});
test('analytics parsing preserves clamps, opaque tie cursor and invalid-input messages', () => {
  assert.deepEqual(parseCompletionExportQuery(new URLSearchParams()), { limit: 200, cursor: null, upperBound: null });
  for (const [raw, expected] of [['-9', 1], ['999', 500], ['1.8', 1], ['NaN', 200], ['Infinity', 200], ['', 1]] as const)
    assert.equal(parseCompletionExportQuery(new URLSearchParams({ limit: raw })).limit, expected);
  const cursor = { updatedAt: '2026-10-15T00:00:00Z', id: 'opaque-existing-id' };
  assert.deepEqual(parseCompletionExportQuery(new URLSearchParams({ cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url') })).cursor, cursor);
  assert.throws(() => parseCompletionExportQuery(new URLSearchParams('cursor=bad')), e => e instanceof DomainError && e.status === 422 && e.message === 'Invalid analytics cursor.');
  assert.throws(() => parseCompletionExportQuery(new URLSearchParams('upperBound=bad')), e => e instanceof DomainError && e.message === 'Invalid upperBound.');
});
test('analytics requires its exact readonly service principal and returns no identity/draft fields', async () => {
  const date = new Date('2026-10-15T00:00:00.000Z'), a = randomUUID(), b = randomUUID();
  const db = sqlPool(sql => sql.includes('SELECT a."updatedAt"') ? [{ updatedAt: date }]
    : sql.includes('SELECT\n') ? [{ id: a, chiefComplaint: 'test complaint', submittedAt: date, scheduledAt: date, updatedAt: date },
      { id: b, chiefComplaint: 'not returned', submittedAt: date, scheduledAt: date, updatedAt: date }] : []);
  const owner = createAppointmentCompletionOwner(db.pool, { list: async () => ({ appointments: [] }) });
  const query = { limit: 1, cursor: null, upperBound: null };
  for (const invalid of [{ ...exportActor(), role: 'admin' as const }, { ...exportActor(), authId: randomUUID() }, { ...exportActor(), resource: randomUUID() }])
    await assert.rejects(owner.exportSubmitted(invalid, query), e => e instanceof DomainError && e.status === 403);
  const page = await owner.exportSubmitted(exportActor(), query);
  assert.deepEqual(Object.keys(page.data[0]!).sort(), ['preConsultationId', 'chiefComplaint', 'submittedAt', 'scheduledAt', 'sourceUpdatedAt'].sort());
  assert.equal(page.data.length, 1); assert.equal(page.meta.hasMore, true); assert.equal(page.meta.nextCursor, page.meta.lastCursor);
  assert.deepEqual(JSON.parse(Buffer.from(page.meta.nextCursor!, 'base64url').toString()), { updatedAt: date.toISOString(), id: a });
  const read = db.calls.find(row => row.sql.includes('pc."chiefComplaint"'))!;
  assert.match(read.sql, /pc\."isSubmitted"=true AND pc\."submittedAt" IS NOT NULL/); assert.match(read.sql, /pc.id>\$2/);
  assert.deepEqual(read.args, [null, null, date, 2]);
  assert.ok(db.calls.some(row => row.sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.ok(db.calls.every(row => !/INSERT|UPDATE|DELETE/.test(row.sql)));
});
test('completion router requires verified locals, gates absent owner and returns consent 201', async () => {
  const f = fixture(); let verified: Actor | undefined; let command = false;
  f.reads.acceptConsent = async () => ({ consentId: randomUUID(), consentType: 'registration', accepted: true, consentedAt: new Date() });
  const app = express(); app.use(express.json()); app.use((_req, res, next) => { res.locals.actor = verified; if (command) res.locals.command = { operationId: randomUUID() }; next(); });
  app.use('/internal/v1/completion', createCompletionRouter(f.reads)); app.use('/disabled', createCompletionRouter());
  const errors: ErrorRequestHandler = (error, _req, res, _next) => res.status(error.status ?? 500).json({ success: false, message: error.message }); app.use(errors);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string'); const url = 'http://127.0.0.1:' + address.port;
    assert.equal((await fetch(url + '/internal/v1/completion/patient/dashboard')).status, 401);
    assert.equal((await fetch(url + '/disabled/patient/dashboard')).status, 503);
    verified = actor('patient', 'profile.consent.accept');
    assert.equal((await fetch(url + '/internal/v1/completion/consents', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 401);
    command = true;
    const response = await fetch(url + '/internal/v1/completion/consents', { method: 'POST', body: '{"accepted":true}', headers: { 'Content-Type': 'application/json' } });
    assert.equal(response.status, 201); assert.equal((await response.json()).contractVersion, 1);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
