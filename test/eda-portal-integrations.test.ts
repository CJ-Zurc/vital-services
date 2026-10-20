import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Actor } from '../src/eda/contracts/actor.js';
import type { CorePrismaClient } from '../src/eda/infrastructure/databases.js';
import { requestHash } from '../src/eda/infrastructure/security.js';
import { authorizePortalIntegration, portalStatuses, type PortalSource } from '../src/eda/modules/portal-integrations/portal-integrations-contracts.js';
import { createPortalIntegrations } from '../src/eda/modules/portal-integrations/portal-integrations.js';
import { createPortalProfileReaders, createPortalPatientCounts } from '../src/eda/modules/portal-integrations/portal-integrations-profile.js';
import { createPortalAppointmentHistory, createPortalStaffAppointmentReader } from '../src/eda/modules/portal-integrations/portal-integrations-appointments.js';
import { verifyPortalIntegrationAssertion } from '../src/eda/http/portal-integrations-router.js';
import { createPortalProfileBootstrap } from '../src/eda/modules/portal-integrations/portal-integrations-bootstrap.js';
import { createPortalIdentityLookup } from '../src/eda/modules/portal-integrations/portal-integrations-auth.js';

function delegation(route: string, system = 'ehr', roles = ['nurse']) {
  const subject = randomUUID();
  const source: PortalSource = { subject, system, systems: ['vital', system], roles, isAdmin: false, isSuperAdmin: false, expiresAt: Math.floor(Date.now() / 1000) + 120 };
  const actor: Actor = { authId: subject, role: 'service', serviceId: 'vital-web', correlationId: randomUUID(),
    scopes: ['portal.integration.' + route.replaceAll('/', '.')], resource: 'portal:' + route, isSuperAdmin: false };
  const method = route.endsWith('bootstrap') ? 'POST' : 'GET', path = '/internal/v1/portal-integrations/' + route;
  return { actor, source, method, path };
}
test('portal integration delegation cannot impersonate local administrators', async () => {
  const f = delegation('doctors');
  assert.equal(authorizePortalIntegration(f.actor, f.source, f.method, f.path).route, 'doctors');
  for (const changed of [{ ...f.actor, role: 'admin' as const }, { ...f.actor, isSuperAdmin: true },
    { ...f.actor, resource: 'portal:patients' }, { ...f.actor, authId: randomUUID() }])
    assert.throws(() => authorizePortalIntegration(changed, f.source, f.method, f.path));
  for (const source of [{ ...f.source, roles: ['med-tech'] }, { ...f.source, system: 'vital', roles: ['admin'] },
    { ...f.source, expiresAt: 1 }]) assert.throws(() => authorizePortalIntegration(f.actor, source, f.method, f.path));
  assert.throws(() => authorizePortalIntegration(f.actor, f.source, 'POST', f.path));
  assert.throws(() => authorizePortalIntegration(f.actor, f.source, 'GET', f.path + '?unknown=1'));
  assert.throws(() => authorizePortalIntegration(f.actor, f.source, 'GET', f.path + '?page=1&page=2'));
  assert.equal(authorizePortalIntegration(f.actor, { ...f.source, system: 'trace', isSuperAdmin: true }, 'GET', f.path).route, 'doctors');
  for (const [system, role] of [['uhse', 'guest'], ['ehr', 'patient'], ['vital', 'patient']]) {
    const p = delegation('patient/appointments', system, [role!]);
    assert.doesNotThrow(() => authorizePortalIntegration(p.actor, p.source, p.method, p.path));
    assert.throws(() => authorizePortalIntegration(p.actor, { ...p.source, systems: ['ehr'] }, p.method, p.path));
  }
  const guest = delegation('patient/appointments', 'vital', ['guest']);
  assert.throws(() => authorizePortalIntegration(guest.actor, guest.source, guest.method, guest.path));
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config = { publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }).toString(), keyId: 'portal-test', issuer: 'vital-web', audience: 'vital-services', peerName: 'vital-web' };
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign({ actor: f.actor, action: f.method + ' ' + f.path, requestHash: requestHash(f.method, f.path, null),
    portalDelegation: f.source, iat: now }, key.privateKey, { algorithm: 'RS256', keyid: config.keyId, subject: f.actor.authId,
    issuer: config.issuer, audience: config.audience, expiresIn: 45, jwtid: randomUUID() });
  const input = { token, peerAuthorized: true, peerName: 'vital-web', method: f.method, path: f.path, body: null, config };
  assert.equal(verifyPortalIntegrationAssertion(input).source.subject, f.actor.authId);
  assert.throws(() => verifyPortalIntegrationAssertion({ ...input, peerAuthorized: false }));
  assert.throws(() => verifyPortalIntegrationAssertion({ ...input, path: '/internal/v1/portal-integrations/patients' }));
  assert.throws(() => verifyPortalIntegrationAssertion({ ...input, token: token.slice(0, -8) + 'tampered' }));
  let called = false;
  const owner = createPortalIntegrations({ profile: { doctors: async () => { called = true; return { data: [], meta: { page: 1, pageSize: 50, total: 0, totalPages: 1 } }; } } as never });
  await assert.rejects(owner.execute({ ...f.actor, role: 'admin' }, f.source, f.method, f.path, {}));
  assert.equal(called, false);
});

test('staff integration readers preserve doctor patient and appointment contracts', async () => {
  const authId = randomUUID(), patientId = randomUUID(), doctorId = randomUUID(), id = randomUUID();
  const doctors = Array.from({ length: 230 }, (_, index) => ({ userId: index === 0 ? doctorId : randomUUID(), authId,
    user: { role: 'doctor' }, specialty: 'General', departmentExternalId: null, departmentName: null,
    prcLicense: 'PRC', availabilityType: 'both', virtualFee: '0', inPersonFee: '200.00', starRating: 0,
    isDoctorOnboardingComplete: true, hospitalAffiliations: [{ hospitalName: 'BGH' }] }));
  const calls: Record<string, unknown>[] = [];
  const row = { id, patientId, doctorId, version: 1, billingLineageId: randomUUID(), associationVersion: 1,
    status: 'confirmed', scheduledAt: new Date('2026-10-17T01:00:00Z'), proposedEndAt: null, updatedAt: new Date(),
    doctor: { authId, userId: doctorId, specialty: 'General' }, scheduleSlot: null, appointmentKind: 'standard', consultationType: 'virtual' };
  const tx = {
    vitalUser: { findUnique: async () => ({ id: patientId, authId, role: 'patient', patient: { userId: patientId, authId, isOnboardingComplete: false }, doctor: null, admin: null }) },
    appointment: { count: async () => 230, findMany: async (query: Record<string, unknown>) => { calls.push(query); return [row]; },
      groupBy: async () => [{ patientId, status: 'confirmed', _count: { _all: 230 } }], findFirst: async () => row },
    recordsDocument: { groupBy: async () => [{ patientId, kind: 'prescription', _count: { _all: 7 } }] },
  };
  const db = { ...tx, $transaction: async (fn: (value: typeof tx) => Promise<unknown>, options: { isolationLevel: string }) => { assert.ok(['RepeatableRead', 'Serializable'].includes(options.isolationLevel)); return fn(tx); },
    vitalDoctor: { findMany: async ({ skip, take }: { skip: number; take: number }) => doctors.slice(skip, skip + take) },
    vitalPatient: { findMany: async ({ skip }: { skip: number }) => skip ? [] : [{ userId: patientId, authId, user: { role: 'patient' },
      ehrPatientId: null, ehrRecordOrigin: 'none', isRecordAvailable: false, isOnboardingComplete: false }],
      findUnique: async () => ({ userId: patientId, authId, user: { authId, role: 'patient' }, isOnboardingComplete: false }) },
  } as unknown as CorePrismaClient;
  const readers = createPortalProfileReaders(db, { identities: async () => new Map([[authId, { name: 'Trusted Name', email: null }]]),
    syncStatuses: async ids => new Map(ids.map(id => [id, 'pending'])), patientCounts: createPortalPatientCounts(db) });
  const list = await readers.doctors({ page: '3', pageSize: '100', search: 'trusted' });
  assert.equal(list.data.length, 30); assert.equal(list.meta.total, 230); assert.equal(list.meta.totalPages, 3);
  assert.equal(list.data[0]?.syncStatus, 'pending'); assert.equal(list.data[0]?.virtualFee, 0);
  assert.equal((await readers.doctors({ onboarding: 'unknown' })).meta.total, 0);
  const patients = await readers.patients({ ehrLinked: 'false' });
  assert.deepEqual(patients.data[0]?.counts, { appointments: 230, prescriptions: 7, medicalCertificates: 0 });
  const history = createPortalAppointmentHistory(db);
  const result = await history(patientId, { page: '2', pageSize: '20', status: 'confirmed' });
  assert.equal(result.meta.total, 230); assert.equal(result.summary.statusTotals.confirmed, 230);
  assert.equal(result.summary.nextAppointment?.id, id); assert.equal(calls[0]?.skip, 20);
  const f = delegation('appointments');
  const staff = createPortalStaffAppointmentReader(db, async (source, refs) => { assert.equal(source.subject, f.source.subject); return refs.map(item => ({ id: item.id })); });
  const staffResult = await staff(f.source, { page: '1', dateFrom: '2026-10-16', dateTo: '2026-10-17' });
  assert.equal(staffResult.meta.total, 230);
  assert.deepEqual((calls[1]?.where as { scheduledAt: unknown }).scheduledAt, { gte: new Date('2026-10-15T16:00:00Z'), lte: new Date('2026-10-17T15:59:59Z') });
  await assert.rejects(createPortalStaffAppointmentReader(db, async () => [])(f.source, {}));
  const p = delegation('patient/bootstrap', 'uhse', ['guest']);
  const command = { operationId: randomUUID(), requestHash: 'a'.repeat(64) };
  const owner = createPortalIntegrations({ profile: readers, history });
  const bootstrap = await owner.execute({ ...p.actor, authId }, { ...p.source, subject: authId }, p.method, p.path, {}, {}, command);
  assert.deepEqual(bootstrap, { patientReady: true, onboardingComplete: false });
  const missing = createPortalIntegrations({ profile: { ...readers, patientMarker: async () => null } });
  const h = delegation('patient/appointments', 'ehr', ['patient']);
  const empty = await missing.execute(h.actor, h.source, h.method, h.path, {}) as { meta: { patientReady: boolean }; summary: { statusTotals: unknown } };
  assert.equal(empty.meta.patientReady, false); assert.equal(Object.keys(empty.summary.statusTotals as object).length, portalStatuses.length);
  await assert.rejects(owner.execute(f.actor, f.source, f.method, f.path, {}), { code: 'APPOINTMENT_INTEGRATION_STAFF_READ_UNAVAILABLE' });
  const lookup = createPortalIdentityLookup({ baseUrl: 'https://auth.example.invalid', key: 'fixture-key' }, async (url, options) => {
    assert.equal(String(url), 'https://auth.example.invalid/internal/users/' + authId + '/profile');
    assert.equal((options?.headers as Record<string, string>)['X-Internal-Service'], 'vital-services');
    return Response.json({ success: true, data: { id: authId, first_name: 'Trusted', middle_name: null, last_name: 'Name', extension_name: null, email: null } });
  });
  assert.deepEqual((await lookup([authId])).get(authId), { name: 'Trusted Name', email: null });

  let state: { user: Record<string, unknown> | null; marker: Record<string, unknown> | null; commands: Record<string, unknown>[]; events: Record<string, unknown>[]; intents: unknown[] } = {
    user: null, marker: null, commands: [], events: [], intents: [],
  };
  let breakEffects = true;
  const bootstrapTx = {
    vitalUser: {
      findUnique: async () => state.user ? { ...state.user, patient: state.marker, doctor: null, admin: null } : null,
      create: async ({ data }: { data: Record<string, unknown> }) => (state.user = { id: patientId, version: 0, ...data }),
      update: async () => (state.user = { ...state.user!, version: Number(state.user!.version) + 1 }),
    },
    vitalPatient: { create: async ({ data }: { data: Record<string, unknown> }) => (state.marker = data), findUnique: async () => state.marker },
    commandOperation: {
      findUnique: async ({ where }: { where: { actorId_operationId: { operationId: string } } }) => state.commands.find(row => row.operationId === where.actorId_operationId.operationId) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => { state.commands.push(data); return data; },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(state.commands.find(row => row.id === where.id)!, data),
    },
    outboxEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { if (breakEffects) throw new Error('fixture-rollback'); state.events.push(data); return data; } },
    profileSyncIntent: { create: async ({ data }: { data: Record<string, unknown> }) => { state.intents.push(data); return data; } },
  };
  const bootstrapDb = { $transaction: async (run: (tx: typeof bootstrapTx) => Promise<unknown>) => {
    const previous = structuredClone(state);
    try { return await run(bootstrapTx); } catch (error) { state = previous; throw error; }
  } } as unknown as CorePrismaClient;
  const create = createPortalProfileBootstrap(bootstrapDb, { writes: true });
  await assert.rejects(create(p.actor, p.source, command), /fixture-rollback/);
  assert.equal(state.user, null); assert.equal(state.marker, null); assert.equal(state.commands.length, 0);
  breakEffects = false;
  assert.deepEqual(await create(p.actor, p.source, command), { patientReady: true, onboardingComplete: false });
  assert.equal(state.commands.length, 1); assert.equal(state.events.length, 3); assert.equal(state.intents.length, 1);
  assert.deepEqual(await create(p.actor, p.source, command), { patientReady: true, onboardingComplete: false });
  assert.equal(state.events.length, 3);
  state.marker!.isOnboardingComplete = true;
  assert.deepEqual(await create(p.actor, p.source, command), { patientReady: true, onboardingComplete: true });
  assert.equal(state.events.length, 3);
  await assert.rejects(create(p.actor, p.source, { ...command, requestHash: 'b'.repeat(64) }), { code: 'COMMAND_REPLAY_CONFLICT' });
  state.user!.role = 'doctor';
  await assert.rejects(create(p.actor, p.source, command), { code: 'PORTAL_PATIENT_IDENTITY_CONFLICT' });
  assert.equal(state.events.length, 3);
});
