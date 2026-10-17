import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import { parseEvent, type EventEnvelope } from "../src/eda/contracts/events.js";
import { consumePayment, type PaymentProjectionAppointmentReader } from "../src/eda/workers/handlers.js";

function fixture() {
  const appointmentId = randomUUID();
  const paymentId = randomUUID();
  const lineage = randomUUID();
  const paidAt = new Date("2026-10-13T00:00:00.000Z");
  const event = parseEvent({ eventId: randomUUID(), eventType: "vital.payment.completed", schemaVersion: 1,
    producer: "payment", occurredAt: paidAt.toISOString(), aggregateId: paymentId, aggregateVersion: 1,
    correlationId: randomUUID(), causationId: null, data: { appointmentId, paymentId, paymentVersion: 1,
      billingLineageId: lineage, associationVersion: 1, reviewRequired: false, paidAt: paidAt.toISOString() } });
  const payment = { id: paymentId, appointmentId, version: 1, status: "paid", paidAt,
    providerMode: "sandbox", billingLineageId: lineage, associationVersion: 1, reviewRequired: false };
  const appointment = { id: appointmentId, status: "approved", version: 4, billingLineageId: lineage, associationVersion: 1 };
  type Projection = { paymentId: string; sourceVersion: number; status: string; paidAt: Date | null;
    billingLineageId: string; associationVersion: number; reviewRequired: boolean };
  let state: { inbox: Set<string>; projection: Projection | null } = { inbox: new Set(), projection: null };
  let rollbackState = structuredClone(state);
  const calls: string[] = [];
  const committed = new Map<string, EventEnvelope>([[event.eventId, structuredClone(event)]]);
  let failProjection = false;
  let appointmentReads = 0;
  const tx = {
    async query(sql: string, args: unknown[] = []) {
      calls.push(sql);
      if (sql === "BEGIN") { rollbackState = structuredClone(state); return { rows: [], rowCount: 0 }; }
      if (sql === "COMMIT") return { rows: [], rowCount: 0 };
      if (sql === "ROLLBACK") { state = rollbackState; return { rows: [], rowCount: 0 }; }
      if (sql.includes("INSERT INTO inbox_events")) {
        const id = String(args[1]);
        if (state.inbox.has(id)) return { rows: [], rowCount: 0 };
        state.inbox.add(id);
        return { rows: [{ eventId: id }], rowCount: 1 };
      }
      if (sql.includes("SELECT") && sql.includes("appointment_payment_projections")) {
        return { rows: state.projection ? [state.projection] : [], rowCount: state.projection ? 1 : 0 };
      }
      if (sql.includes("INSERT INTO appointment_payment_projections")) {
        if (failProjection) throw new Error("TEST_PROJECTION_FAILURE");
        state.projection = { paymentId: String(args[1]), sourceVersion: Number(args[2]), status: String(args[3]),
          paidAt: args[4] as Date | null, billingLineageId: String(args[5]), associationVersion: Number(args[6]),
          reviewRequired: args[7] as boolean };
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected Core effect: ${sql}`);
    },
    release() { calls.push("RELEASE"); },
  };
  const core = { connect: async () => tx } as unknown as Pool;
  const integrations = { async query(sql: string, args: unknown[]) {
    if (sql.includes("FROM payments")) return { rows: [payment], rowCount: 1 };
    if (sql.includes("FROM outbox_events")) {
      const fact = committed.get(String(args[0]));
      return { rows: fact ? [{ ...fact, id: fact.eventId, occurredAt: new Date(fact.occurredAt), payload: fact.data }] : [], rowCount: fact ? 1 : 0 };
    }
    throw new Error(`Unexpected Integrations query: ${sql}`);
  } } as unknown as Pool;
  const read: PaymentProjectionAppointmentReader = async (client, id) => {
    appointmentReads += 1;
    assert.equal(client, tx as unknown as PoolClient);
    assert.equal(id, payment.appointmentId);
    return appointment;
  };
  return { event, payment, appointment, committed, core, integrations, read, calls,
    run: (input = event) => consumePayment(core, integrations, input, read),
    state: () => state, reads: () => appointmentReads,
    fail: (value: boolean) => { failProjection = value; },
    prior: (value: Projection) => { state.projection = value; } };
}

test("EDA payment projection deduplicates inbox and commits only financial effects before return", async () => {
  const f = fixture();
  await f.run();
  await f.run();
  assert.equal(f.state().inbox.size, 1);
  assert.equal(f.reads(), 1);
  assert.equal(f.appointment.status, "approved");
  assert.equal(f.appointment.version, 4);
  assert.equal(f.state().projection?.status, "paid");
  assert.equal(f.state().projection?.billingLineageId, f.payment.billingLineageId);
  assert.equal(f.calls.filter(sql => sql.includes("INSERT INTO appointment_payment_projections")).length, 1);
  assert.ok(f.calls.indexOf("COMMIT") > f.calls.findIndex(sql => sql.includes("INSERT INTO appointment_payment_projections")));
  assert.ok(f.calls.every(sql => !/UPDATE appointments|appointment_logs|outbox_events|record_access/.test(sql)));
});

test("EDA payment projection rolls back inbox with failed effects and permits redelivery", async () => {
  const f = fixture();
  f.fail(true);
  await assert.rejects(f.run(), /TEST_PROJECTION_FAILURE/);
  assert.equal(f.state().inbox.size, 0);
  assert.equal(f.state().projection, null);
  assert.ok(f.calls.includes("ROLLBACK"));
  f.fail(false);
  await f.run();
  assert.equal(f.state().inbox.size, 1);
});

test("EDA payment projection records terminal appointment facts without lifecycle or audit writes", async () => {
  for (const status of ["cancelled", "rejected", "rescheduled", "expired"]) {
    const f = fixture();
    f.appointment.status = status;
    await f.run();
    assert.equal(f.state().projection?.status, "paid");
    assert.equal(f.state().projection?.reviewRequired, true);
    assert.equal(f.appointment.status, status);
  }
});

test("EDA payment projection does not force review for normally completed appointments", async () => {
  for (const reviewRequired of [false, true]) {
    const f = fixture();
    f.appointment.status = "completed";
    f.payment.reviewRequired = reviewRequired;
    f.event.data.reviewRequired = reviewRequired;
    f.committed.set(f.event.eventId, structuredClone(f.event));
    await f.run();
    assert.equal(f.state().projection?.reviewRequired, reviewRequired);
    assert.equal(f.state().projection?.status, "paid");
    assert.equal(f.appointment.status, "completed");
    assert.equal(f.appointment.version, 4);
  }
});

test("EDA payment projection requires Appointment owner association version to match source", async () => {
  for (const associationVersion of [0, 2, 1.5, Number.NaN]) {
    const f = fixture();
    f.appointment.associationVersion = associationVersion;
    await assert.rejects(f.run(), /PAYMENT_APPOINTMENT_UNVERIFIED/);
    assert.equal(f.state().inbox.size, 0);
    assert.equal(f.state().projection, null);
    assert.ok(f.calls.includes("ROLLBACK"));
  }
});

test("EDA payment projection preserves source review requirement for active appointments", async () => {
  const f = fixture();
  f.payment.reviewRequired = true;
  f.event.data.reviewRequired = true;
  f.committed.set(f.event.eventId, structuredClone(f.event));
  await f.run();
  assert.equal(f.state().projection?.reviewRequired, true);
});

test("EDA payment projection rejects future forged and nonsandbox source facts", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.payment.version = 0; },
    (f: ReturnType<typeof fixture>) => { f.payment.providerMode = "live"; },
    (f: ReturnType<typeof fixture>) => { f.payment.id = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.payment.billingLineageId = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.payment.associationVersion = 0; },
    (f: ReturnType<typeof fixture>) => { f.payment.appointmentId = randomUUID(); },
    (f: ReturnType<typeof fixture>) => { f.payment.status = "pending"; },
    (f: ReturnType<typeof fixture>) => { f.payment.paidAt = new Date(); },
    (f: ReturnType<typeof fixture>) => { f.payment.reviewRequired = true; },
    (f: ReturnType<typeof fixture>) => { f.committed.clear(); },
    (f: ReturnType<typeof fixture>) => { f.event.correlationId = randomUUID(); },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(f.run());
    assert.equal(f.state().inbox.size, 0);
    assert.equal(f.state().projection, null);
  }
});

test("EDA payment projection uses latest committed state without reordered regression", async () => {
  const f = fixture();
  f.payment.version = 3;
  f.payment.status = "refunded";
  await f.run();
  assert.equal(f.state().projection?.sourceVersion, 3);
  assert.equal(f.state().projection?.status, "refunded");
  const second = { ...f.event, eventId: randomUUID() };
  f.committed.set(second.eventId, structuredClone(second));
  await f.run(second);
  assert.equal(f.calls.filter(sql => sql.includes("INSERT INTO appointment_payment_projections")).length, 1);
});

test("EDA payment projection acknowledges superseded associations without binding replacement", async () => {
  const f = fixture();
  f.payment.version = 2;
  f.payment.associationVersion = 2;
  f.payment.appointmentId = randomUUID();
  await f.run();
  assert.equal(f.state().inbox.size, 1);
  assert.equal(f.state().projection, null);
  assert.equal(f.reads(), 0);
});

test("EDA payment projection rejects forged historical association and appointment lineage", async () => {
  const f = fixture();
  f.payment.version = 2;
  f.event.data.associationVersion = 2;
  f.committed.set(f.event.eventId, structuredClone(f.event));
  await assert.rejects(f.run(), /PAYMENT_SOURCE_UNVERIFIED/);
  const g = fixture();
  g.appointment.billingLineageId = randomUUID();
  await assert.rejects(g.run(), /PAYMENT_APPOINTMENT_UNVERIFIED/);
  assert.equal(g.state().inbox.size, 0);
});

test("EDA payment projection rejects payment identity rebinding and ignores newer associations", async () => {
  for (const field of ["paymentId", "billingLineageId", "associationVersion"] as const) {
    const f = fixture();
    f.prior({ paymentId: f.payment.id, sourceVersion: 0, status: "pending", paidAt: null,
      billingLineageId: f.payment.billingLineageId, associationVersion: 1, reviewRequired: false,
      [field]: field === "associationVersion" ? 2 : randomUUID() });
    if (field === "associationVersion") {
      await f.run();
      assert.equal(f.state().projection?.associationVersion, 2);
    } else {
      await assert.rejects(f.run(), /PAYMENT_PROJECTION_REBOUND/);
      assert.equal(f.state().inbox.size, 0);
    }
    assert.equal(f.calls.filter(sql => sql.includes("INSERT INTO appointment_payment_projections")).length, 0);
  }
});

test("EDA payment projection fails closed without the Appointment owner interface", async () => {
  const f = fixture();
  await assert.rejects(consumePayment(f.core, f.integrations, f.event), /APPOINTMENT_PAYMENT_READER_REQUIRED/);
  assert.equal(f.state().inbox.size, 0);
});
