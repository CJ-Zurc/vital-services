import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import type { Actor } from "../src/eda/contracts/actor.js";
import { DomainError } from "../src/eda/contracts/actor.js";
import { upgradeScheduleAvailability, type ProfileAvailability } from "../src/eda/modules/profile/profile-schedule.js";
import { createAppointmentModule } from '../src/eda/modules/appointment/appointment.js';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { saveBookingContact } from '../src/eda/modules/profile/profile-booking.js';
import { appendProfileSqlEffects } from '../src/eda/modules/profile/profile-sql-effects.js';

const authId = "11111111-1111-4111-8111-111111111111";
const doctorId = "22222222-2222-4222-8222-222222222222";
const slotId = "33333333-3333-4333-8333-333333333333";
const actor = (resource = authId): Actor => ({ authId, role: "doctor", serviceId: "vital-web", resource,
  scopes: ["appointments.schedule.write"], correlationId: slotId, isSuperAdmin: false });

function fixture(availabilityType: ProfileAvailability | null, present = true) {
  const statements: { sql: string; values: unknown[] }[] = [];
  let type = availabilityType;
  let version = 4;
  let failOutbox = false;
  const tx = { async query(sql: string, values: unknown[] = []) {
    statements.push({ sql, values });
    if (sql.startsWith("SELECT d.")) return { rows: present ? [{ userId: doctorId, availabilityType: type }] : [] };
    if (sql.startsWith("UPDATE vital_doctors")) type = "both";
    if (sql.startsWith("UPDATE vital_users")) {
      assert.equal(sql, 'UPDATE vital_users SET version=version+1 WHERE id=$1 RETURNING version');
      assert.deepEqual(values, [doctorId]);
      return { rows: [{ version: ++version }] };
    }
    if (sql.startsWith("INSERT INTO outbox_events") && failOutbox) throw new Error("unavailable");
    return { rows: [] };
  } } as unknown as PoolClient;
  return { tx, statements, type: () => type, version: () => version, fail: () => { failOutbox = true; } };
}

test("profile schedule: opposite and hybrid slot types upgrade availability with durable effects", async () => {
  for (const [previous, requested] of [["virtual", "in_person"], ["in_person", "virtual"], ["virtual", "both"], ["in_person", "both"]] as const) {
    const f = fixture(previous);
    assert.deepEqual(await upgradeScheduleAvailability(f.tx, actor(), { doctorId, consultationType: requested, resource: authId }),
      { doctorId, availabilityType: "both", changed: true });
    assert.equal(f.type(), "both");
    assert.equal(f.version(), 5);
    const lock = f.statements[0]!;
    assert.match(lock.sql, /FOR UPDATE OF u,d/);
    assert.match(lock.sql, /u.role='doctor' AND d.role='doctor'/);
    assert.deepEqual(lock.values, [doctorId, authId]);
    const events = f.statements.filter(item => item.sql.startsWith("INSERT INTO outbox_events"));
    assert.equal(events.length, 3);
    assert.deepEqual(events.map(item => item.values[1]), ["vital.profile.changed", "vital.audit.requested", "vital.profile.sync.requested"]);
    assert.ok(events.every(item => item.values[4] === 5));
    assert.equal(f.statements.filter(item => item.sql.startsWith("INSERT INTO profile_sync_intents")).length, 1);
    assert.ok(!f.statements.some(item => /virtualFee|inPersonFee|INSERT INTO schedules|COMMIT|BEGIN/.test(item.sql)));
    // Appointment command replay skips its callback; a fresh schedule after an upgrade is also a no-op here.
    await upgradeScheduleAvailability(f.tx, actor(slotId), { doctorId, consultationType: previous, resource: slotId });
    assert.equal(f.version(), 5);
  }
});

test("profile schedule: compatible availability produces no writes or effects", async () => {
  for (const type of ["virtual", "in_person", "both"] as const) {
    const f = fixture(type);
    assert.deepEqual(await upgradeScheduleAvailability(f.tx, actor(), { doctorId, consultationType: type, resource: authId }),
      { doctorId, availabilityType: type, changed: false });
    assert.equal(f.statements.length, 1);
    assert.equal(f.version(), 4);
  }
});

test('profile booking: changed contacts version the actual VitalUser columns and persist durable effects', async () => {
  const statements: { sql: string; values: unknown[] }[] = [];
  const patientId = randomUUID();
  const contact = { fullName: 'Synthetic contact', relationship: 'Parent', phoneNumber: '+639123456789' };
  let unchanged = false;
  const tx = { async query(sql: string, values: unknown[] = []) {
    statements.push({ sql, values });
    if (sql.startsWith('SELECT p.')) return { rows: [{ role: 'patient', ...(unchanged ? {
      emergency_contact_name: contact.fullName, emergency_contact_relationship: contact.relationship,
      emergency_contact_phone: contact.phoneNumber,
    } : {}) }] };
    if (sql.startsWith('UPDATE vital_users')) {
      assert.equal(sql, 'UPDATE vital_users SET version=version+1 WHERE id=$1 RETURNING version');
      assert.deepEqual(values, [patientId]);
      return { rows: [{ version: 5 }] };
    }
    return { rows: [] };
  } } as unknown as PoolClient;
  const patient: Actor = { ...actor(), role: 'patient', scopes: ['appointments.book'] };
  await saveBookingContact(tx, patient, patientId, contact);
  const events = statements.filter(item => item.sql.startsWith('INSERT INTO outbox_events'));
  assert.deepEqual(events.map(item => item.values[1]), ['vital.profile.changed', 'vital.audit.requested', 'vital.profile.sync.requested']);
  assert.ok(events.every(item => item.values[4] === 5));
  assert.ok(events.every(item => !String(item.values[8]).includes(contact.fullName)));
  assert.equal(statements.filter(item => item.sql.startsWith('INSERT INTO profile_sync_intents')).length, 1);
  unchanged = true;
  statements.length = 0;
  await saveBookingContact(tx, patient, patientId, contact);
  assert.equal(statements.length, 1);
});

test('profile SQL effects: version increments do not reference nonexistent VitalUser timestamps', async () => {
  const statements: { sql: string; values: unknown[] }[] = [];
  const tx = { async query(sql: string, values: unknown[] = []) {
    statements.push({ sql, values });
    if (sql.startsWith('UPDATE vital_users')) {
      assert.equal(sql, 'UPDATE vital_users SET version=version+1 WHERE id=$1 AND "authId"=$2 AND role=$3 RETURNING version');
      assert.deepEqual(values, [doctorId, authId, 'doctor']);
      return { rows: [{ version: 5 }] };
    }
    return { rows: [] };
  } } as unknown as PoolClient;
  await appendProfileSqlEffects(tx, { userId: doctorId, authId, role: 'doctor', correlationId: slotId });
  const events = statements.filter(item => item.sql.startsWith('INSERT INTO outbox_events'));
  assert.equal(events.length, 3);
  assert.ok(events.every(item => item.values[4] === 5));
  assert.equal(statements.filter(item => item.sql.startsWith('INSERT INTO profile_sync_intents')).length, 1);
});

test("profile schedule: role scope resource and current membership fail closed", async () => {
  const fields = { doctorId, consultationType: "both" as const, resource: authId };
  for (const denied of [{ ...actor(), role: "patient" as const }, { ...actor(), role: "admin" as const, isSuperAdmin: true },
    { ...actor(), role: "service" as const }, { ...actor(), scopes: ["profile.write"] }, { ...actor(), resource: slotId }]) {
    const f = fixture("virtual");
    await assert.rejects(upgradeScheduleAvailability(f.tx, denied, fields), (error: unknown) => error instanceof DomainError && error.status === 403);
    assert.equal(f.statements.length, 0);
  }
  for (const f of [fixture(null), fixture("virtual", false)]) {
    await assert.rejects(upgradeScheduleAvailability(f.tx, actor(), fields));
    assert.equal(f.statements.length, 1);
  }
  const f = fixture("virtual");
  await assert.rejects(upgradeScheduleAvailability(f.tx, actor(), { ...fields, doctorId: "invalid" }));
  assert.equal(f.statements.length, 0);
});

test("profile schedule: effect failure escapes to the enclosing appointment transaction", async () => {
  const f = fixture("virtual");
  f.fail();
  await assert.rejects(upgradeScheduleAvailability(f.tx, actor(), { doctorId, consultationType: "both", resource: authId }), /unavailable/);
  assert.ok(!f.statements.some(item => /COMMIT|ROLLBACK|BEGIN/.test(item.sql)));
  assert.equal(f.statements.filter(item => item.sql.startsWith("INSERT INTO profile_sync_intents")).length, 0);
});

function appointmentFixture() {
  let state = { availabilityType: 'virtual', version: 1, slots: 0, events: [] as string[], commands: new Map<string, Record<string, unknown>>() };
  let before = structuredClone(state), failCalendar = false;
  const tx = { async query(sql: string, args: unknown[] = []) {
    const result = (rows: Record<string, unknown>[] = []) => ({ rows, rowCount: rows.length });
    if (sql === 'BEGIN') { before = structuredClone(state); return result(); }
    if (sql === 'ROLLBACK') { state = before; return result(); }
    if (sql === 'COMMIT' || sql.includes('pg_advisory_xact_lock')) return result();
    if (sql.includes('SELECT p.* FROM vital_')) return result([{ userId: doctorId, specialty: 'Cardiology', availabilityType: state.availabilityType }]);
    if (sql.startsWith('SELECT d.')) return result([{ userId: doctorId, availabilityType: state.availabilityType }]);
    if (sql.includes('SELECT * FROM command_operations')) { const found = state.commands.get(String(args[1])); return result(found ? [found] : []); }
    if (sql.startsWith('INSERT INTO command_operations')) { state.commands.set(String(args[2]), { action: args[3], resourceId: args[4], requestHash: args[5], status: 'completed', result: JSON.parse(String(args[6])) }); return result(); }
    if (sql.startsWith('UPDATE vital_doctors')) { state.availabilityType = 'both'; return result(); }
    if (sql.startsWith('UPDATE vital_users')) return result([{ version: ++state.version }]);
    if (sql.startsWith('INSERT INTO outbox_events')) {
      if (failCalendar && String(args[8]).includes('schedule_created')) throw new Error('CALENDAR_AUDIT_FAILED');
      state.events.push(String(args[1])); return result();
    }
    if (sql.startsWith('INSERT INTO schedules')) { state.slots++; return result(); }
    if (sql.startsWith('INSERT INTO profile_sync_intents') || sql.startsWith('SELECT id FROM doctor_date_blocks') || sql.startsWith('SELECT a.id FROM appointments') || sql.startsWith('SELECT id FROM slot_reservations') || sql.startsWith('SELECT id FROM schedules')) return result();
    throw new Error('UNEXPECTED_PROFILE_CALENDAR_SQL:' + sql);
  }, release() {} };
  const pool = { connect: async () => tx } as unknown as Pool;
  return { module: createAppointmentModule(pool), state: () => state, fail: () => { failCalendar = true; } };
}
const schedule = { slotDate: '2030-01-02', startTime: '09:00', endTime: '10:00', consultationType: 'in_person', isPublished: true };
test('profile schedule: actual Appointment command commits upgrade and slot once on replay', async () => {
  const f = appointmentFixture(), meta = { operationId: randomUUID(), requestHash: 'a'.repeat(64) };
  const first = await f.module.createSchedule(actor(), meta, schedule);
  assert.deepEqual(await f.module.createSchedule(actor(), meta, schedule), first);
  assert.equal(f.state().slots, 1); assert.equal(f.state().availabilityType, 'both'); assert.equal(f.state().version, 2);
  assert.equal(f.state().events.filter(type => type === 'vital.profile.changed').length, 1);
});
test('profile schedule: Appointment failure rolls back availability slot and both audit paths', async () => {
  const f = appointmentFixture(); f.fail();
  await assert.rejects(f.module.createSchedule(actor(), { operationId: randomUUID(), requestHash: 'a'.repeat(64) }, schedule), /CALENDAR_AUDIT_FAILED/);
  assert.equal(f.state().slots, 0); assert.equal(f.state().availabilityType, 'virtual'); assert.equal(f.state().version, 1);
  assert.equal(f.state().events.length, 0); assert.equal(f.state().commands.size, 0);
});
