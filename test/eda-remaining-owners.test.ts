import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Pool } from 'pg';
import type { Actor } from '../src/eda/contracts/actor.js';
import { createAppointmentExtras } from '../src/eda/modules/appointment/appointment-extras.js';
import { createPaymentStore } from '../src/eda/modules/payment/payment-store.js';
import { createPortalIdentityLookup } from '../src/eda/modules/portal-integrations/portal-integrations-runtime.js';

function fixture() {
  const patientId = randomUUID(), doctorId = randomUUID(), authId = randomUUID(), doctorAuthId = randomUUID(), id = randomUUID();
  const row = { id, patientId, doctorId, patientAuthId: authId, doctorAuthId, version: 3, status: 'completed', billingLineageId: randomUUID(), associationVersion: 1 };
  let state = { feedback: null as Record<string, unknown> | null, command: null as Record<string, any> | null, events: [] as unknown[][], ratingWrites: 0 };
  let previous = structuredClone(state), revoked = false, failAudit = false, paid = true, verified = 0, intakeCount = 1;
  const calls: { sql: string; args: unknown[] }[] = [];
  const tx = { release() {}, async query(sql: string, args: unknown[] = []) {
    calls.push({ sql, args });
    if (sql === 'BEGIN') previous = structuredClone(state);
    else if (sql === 'ROLLBACK') state = previous;
    else if (sql.includes('pg_advisory_xact_lock') || sql === 'COMMIT') { /* Transaction fence. */ }
    else if (sql.includes('SELECT p.* FROM vital_')) return { rows: revoked ? [] : [{ userId: sql.includes('vital_doctors') ? doctorId : patientId }] };
    else if (sql.includes('SELECT a.*')) return { rows: [row] };
    else if (sql.includes('FROM command_operations')) return { rows: state.command ? [state.command] : [] };
    else if (sql.includes('FROM saga_operations')) return { rows: [] };
    else if (sql.includes('FROM appointment_payment_projections')) return { rows: [{ paymentId: randomUUID(), status: paid ? 'paid' : 'pending', sourceVersion: 4, billingLineageId: row.billingLineageId, associationVersion: 1 }] };
    else if (sql.startsWith('INSERT INTO feedback')) { if(state.feedback)return {rows:[]}; state.feedback = { id: args[0], appointmentId: args[1], patientId: args[2], doctorId: args[3], starRating: args[4], feedback: args[5], submittedAt: args[6] }; return { rows: [state.feedback] }; }
    else if (sql.startsWith('UPDATE vital_doctors')) state.ratingWrites++;
    else if (sql.startsWith('INSERT INTO command_operations')) state.command = { action: 'appointment.feedback', resourceId: args[3], requestHash: args[4], status: 'completed', result: JSON.parse(String(args[5])) };
    else if (sql.startsWith('SELECT * FROM feedback')) return { rows: state.feedback ? [state.feedback] : [] };
    else if (sql.startsWith('INSERT INTO outbox_events')) { if (failAudit) throw new Error('audit failed'); state.events.push(args); }
    else if (sql.includes('FROM appointments a LEFT JOIN pre_consultations')) return { rows: Array.from({ length: intakeCount }, () => ({ appointmentId: randomUUID(), scheduledAt: new Date('2026-10-01T01:00:00Z'), submittedAt: new Date('2026-09-30T22:00:00Z'), chiefComplaint: 'private intake', opqrst: null })) };
    else throw new Error('Unhandled SQL: ' + sql);
    return { rows: [], rowCount: 1 };
  } };
  const pool = { connect: async () => tx, query: tx.query.bind(tx) } as unknown as Pool;
  const actor = (scope = 'appointments.feedback', role: 'patient' | 'doctor' = 'patient', resource = id): Actor => ({ authId: role === 'patient' ? authId : doctorAuthId, role, resource, scopes: [scope], correlationId: randomUUID(), serviceId: 'vital-web', isSuperAdmin: false });
  return { id, row, patientId, calls, pool, actor, meta: { operationId: randomUUID(), requestHash: 'a'.repeat(64) }, input: { expectedVersion: 3, rating: 5 },
    owner: createAppointmentExtras(pool, { financial: { verifyPaid: async () => { verified++; } } }), state: () => state, verified: () => verified,
    revoke: () => { revoked = true; }, fail: () => { failAudit = true; }, unpaid: () => { paid = false; }, manyIntakes: () => { intakeCount = 11; } };
}

test('feedback requires completed paid eligibility and updates doctor rating atomically', async () => {
  for (const status of ['completed']) {
    const f = fixture(); f.row.status = status;
    const result = await f.owner.feedback(f.actor(), f.id, f.meta, f.input);
    assert.equal(result.feedback.starRating, 5); assert.equal(f.verified(), 1); assert.equal(f.state().ratingWrites, 1);
    assert.equal(f.state().events.length, 1);
    assert.doesNotMatch(JSON.stringify(f.state().command), /private|DROP/);
    assert.doesNotMatch(JSON.stringify(f.state().events), /private|DROP/);
    assert.ok(f.calls.findIndex(call => call.sql.includes('pg_advisory_xact_lock')) < f.calls.findIndex(call => call.sql.startsWith('INSERT INTO feedback')));
  }
  const confirmed=fixture();confirmed.row.status='confirmed';await assert.rejects(confirmed.owner.feedback(confirmed.actor(),confirmed.id,confirmed.meta,confirmed.input),{code:'APPOINTMENT_FEEDBACK_INELIGIBLE'});
  const unpaid = fixture(); unpaid.unpaid(); await assert.rejects(unpaid.owner.feedback(unpaid.actor(), unpaid.id, unpaid.meta, unpaid.input), { code: 'APPOINTMENT_PAYMENT_UNVERIFIED' });
});
test('feedback replay conflicts rollback and revoked ownership fail closed', async () => {
  const f = fixture(), actor = f.actor();
  await f.owner.feedback(actor, f.id, f.meta, f.input); await f.owner.feedback(actor, f.id, f.meta, f.input);
  assert.equal(f.state().events.length, 1); assert.equal(f.state().ratingWrites, 1);
  await assert.rejects(f.owner.feedback(actor, f.id, f.meta, { ...f.input, rating: 1 }), { code: 'COMMAND_REPLAY_CONFLICT' });
  f.revoke(); await assert.rejects(f.owner.feedback(actor, f.id, f.meta, f.input), { code: 'APPOINTMENT_MEMBERSHIP_REVOKED' });
  const failed = fixture(); failed.fail(); await assert.rejects(failed.owner.feedback(failed.actor(), failed.id, failed.meta, failed.input), /audit failed/);
  assert.equal(failed.state().feedback, null); assert.equal(failed.state().command, null); assert.equal(failed.state().ratingWrites, 0);
});
test('intake reads preserve submitted dates and deny unrelated clinicians', async () => {
  const f = fixture();
  const page = await f.owner.intakes(f.actor('appointments.intake.read', 'doctor', f.patientId), f.patientId, {});
  assert.equal(page.items[0].submittedAt.toISOString(), '2026-09-30T22:00:00.000Z');
  const query = f.calls.find(call => call.sql.includes('LEFT JOIN pre_consultations'))!;
  assert.equal(query.args[1], f.patientId); assert.match(query.sql, /a\."doctorId"=\$1 AND a\."patientId"=\$2/);
  f.manyIntakes(); const many = await f.owner.intakes(f.actor('appointments.intake.read', 'doctor', f.patientId), f.patientId, {});
  assert.equal(many.items.length, 10); assert.equal(many.next?.cursorId, many.items[9].appointmentId);
  await assert.rejects(f.owner.intakes(f.actor('appointments.intake.read'), f.patientId, {}), { code: 'ACTOR_SCOPE_DENIED' });
  f.revoke(); await assert.rejects(f.owner.intakes(f.actor('appointments.intake.read', 'doctor', f.patientId), f.patientId, {}), { code: 'APPOINTMENT_MEMBERSHIP_REVOKED' });
});
test('remaining owner SQL binds hostile values and rejects dynamic identifiers', async () => {
  const f = fixture(); await f.owner.feedback(f.actor(), f.id, f.meta, f.input);
  await assert.rejects(f.owner.feedback(f.actor(),f.id,{...f.meta,operationId:randomUUID()},{...f.input,comment:"private"}));
  assert.equal(f.state().feedback?.feedback,null);
  const hostile = "x'; DROP TABLE payments; --";
  const calls: { sql: string; args: unknown[] }[] = [];
  const store = createPaymentStore({ query: async (sql: string, args: unknown[]) => { calls.push({ sql, args }); return { rows: [] }; } } as unknown as Pool);
  await store.byAppointment(hostile); assert.equal(calls[0]!.args[0], hostile); assert.ok(!calls[0]!.sql.includes(hostile));
  const source = readFileSync(new URL('../src/eda/modules/payment/payment-store.ts', import.meta.url), 'utf8');
  assert.match(source, /Object\.hasOwn\(writeTables, table\)/); assert.doesNotMatch(source, /async function (?:insert|update)\(table: string/);
});

test('portal identity runtime batches bounded Auth projections and rejects substituted subjects', async () => {
  const ids = Array.from({ length: 130 }, () => randomUUID()), batches: string[][] = [];
  const environment = { NODE_ENV: 'production', VITAL_AUTH_INTERNAL_URL: 'https://auth.test', VITAL_SERVICES_AUTH_PROFILE_KEY: 'fixture-only' };
  const lookup = createPortalIdentityLookup(environment, async (url, init) => {
    assert.equal(String(url), 'https://auth.test/internal/users/profiles/batch');
    const batch = JSON.parse(String(init?.body)).user_ids as string[]; batches.push(batch);
    return Response.json({ success: true, data: { profiles: batch.map(id => ({ id, first_name: 'Given', last_name: 'Family', email: 'fixture@example.test' })), missing_ids: [] } });
  });
  assert.equal((await lookup(ids)).size, 130); assert.deepEqual(batches.map(batch => batch.length), [100, 30]);
  await assert.rejects(createPortalIdentityLookup(environment, async () => Response.json({ success: true, data: { profiles: [{ id: randomUUID(), first_name: 'Foreign', last_name: 'Person' }], missing_ids: [] } }))([ids[0]!]), { code: 'PORTAL_AUTH_PROFILE_MISMATCH' });
  await assert.rejects(createPortalIdentityLookup({ ...environment, VITAL_AUTH_INTERNAL_URL: 'http://auth.test' })(ids), { code: 'PORTAL_AUTH_CONFIGURATION_REQUIRED' });
});
