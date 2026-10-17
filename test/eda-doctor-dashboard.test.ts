import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { DomainError } from '../src/eda/contracts/actor.js';
import type { AppointmentReadSnapshot } from '../src/eda/modules/appointment/appointment-reads.js';
import { readDoctorDashboard } from '../src/eda/modules/appointment/doctor-dashboard.js';

function fixture() {
  const doctorId = randomUUID(), todayId = randomUUID(), pendingId = randomUUID();
  const overview = { summary: { today: 17, pending: 900, patients: 751, completed: 1025 },
    statusCounts: { approved: 17, pending: 900, completed: 1025 }, todayAppointmentIds: [todayId], pendingRequestIds: [pendingId], fingerprint: 'a'.repeat(32) };
  const calls: { sql: string; args: unknown[] }[] = [];
  let queryCount = 0, changed = false, membershipChecks = 0;
  const pool = { async query(sql: string, args: unknown[]) {
    calls.push({ sql, args });
    return { rows: [{ ...overview, fingerprint: changed && queryCount++ > 0 ? 'b'.repeat(32) : overview.fingerprint }] };
  } } as unknown as Pool;
  const rows = [{ id: todayId, doctorId, status: 'confirmed' }, { id: pendingId, doctorId, status: 'pending' }] as AppointmentReadSnapshot[];
  const run = (hydrate = async (ids: string[]) => { assert.deepEqual(ids, [todayId, pendingId]); return rows; },
    validate = async () => { membershipChecks++; }) => readDoctorDashboard(pool, doctorId, Date.parse('2026-10-15T17:00:00Z'), hydrate, validate);
  return { doctorId, overview, calls, rows, run, changed: () => { changed = true; }, membershipChecks: () => membershipChecks };
}

test('doctor dashboard uses full aggregates and only hydrates selected cards', async () => {
  const f = fixture(), result = await f.run();
  assert.deepEqual(result.summary, { today: 17, pending: 900, patients: 751, completed: 1025 });
  assert.equal(result.appointments.length, 2);
  assert.equal('fingerprint' in result, false);
  assert.equal(f.membershipChecks(), 1);
  for (const call of f.calls) {
    assert.deepEqual(call.args, [f.doctorId, '2026-10-16']);
    assert.match(call.sql, /COUNT\(DISTINCT "patientId"\)/);
    assert.match(call.sql, /AT TIME ZONE 'UTC' AT TIME ZONE 'Asia\/Manila'/);
    assert.ok(!call.sql.includes(f.doctorId));
    assert.ok(!/INSERT|UPDATE|DELETE/.test(call.sql));
  }
});

test('doctor dashboard rejects state changes during financial and Video composition', async () => {
  const f = fixture(); f.changed();
  await assert.rejects(f.run(), error => error instanceof DomainError && error.code === 'APPOINTMENT_READ_CHANGED');
});

test('doctor dashboard rejects foreign missing duplicate and wrong-state cards', async () => {
  for (const transform of [
    (rows: AppointmentReadSnapshot[]) => rows.slice(0, 1),
    (rows: AppointmentReadSnapshot[]) => [rows[0]!, rows[0]!],
    (rows: AppointmentReadSnapshot[]) => rows.map(row => ({ ...row, doctorId: randomUUID() })),
    (rows: AppointmentReadSnapshot[]) => rows.map(row => ({ ...row, status: 'cancelled' })),
  ]) {
    const f = fixture();
    await assert.rejects(f.run(async () => transform(f.rows)), error => error instanceof DomainError && error.code === 'APPOINTMENT_READ_CHANGED');
  }
});

test('doctor dashboard rechecks current membership before returning', async () => {
  const f = fixture();
  await assert.rejects(f.run(undefined, async () => { throw new DomainError(403, 'REVOKED', 'Forbidden.'); }),
    error => error instanceof DomainError && error.status === 403);
});

test('doctor dashboard empty cards retain historical totals without synthetic owner calls', async () => {
  const f = fixture(); f.overview.todayAppointmentIds = []; f.overview.pendingRequestIds = [];
  const result = await f.run(async () => { throw new Error('NO_CARD_HYDRATION'); });
  assert.deepEqual(result.appointments, []);
  assert.equal(result.summary.completed, 1025);
  assert.equal(f.membershipChecks(), 1);
});
