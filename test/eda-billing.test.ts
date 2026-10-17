import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Actor } from "../src/eda/contracts/actor.js";
import { createBillingAuthority, exactCentavos, readPaymentProjectionAppointment } from "../src/eda/modules/appointment/appointment-billing.js";

function fixture() {
  const id = randomUUID(); const patientId = randomUUID(); const doctorId = randomUUID();
  const row = { appointmentId: id as string, billingLineageId: randomUUID(), appointmentVersion: 4, associationVersion: 1,
    patientAuthId: patientId, doctorAuthId: doctorId, consultationType: "virtual", status: "approved",
    scheduledAt: new Date(Date.now() + 3 * 86_400_000), sourceAppointmentId: null as string | null, hasBillingTransition: false,
    completedAt: null as Date | null };
  const actor: Actor = { authId: patientId, role: "patient", resource: id, scopes: ["payments.checkout"],
    serviceId: "vital-web", correlationId: randomUUID(), isSuperAdmin: false };
  type Intent = { id: string; appointmentId: string; billingLineageId: string; appointmentVersion: number;
    associationVersion: number; actorAuthId: string; operationId: string; requestHash: string; expiresAt: Date;
    kind: string; state: string; committedAt: Date | null; ownerLogId: string | null; ownerOperationId: string | null;
    replacementAppointmentId: string | null; expectedPaymentVersion: number | null };
  const state = {
    row, fee: "1250.25" as string | null, admin: true, queries: [] as string[], failCommit: false,
    quote: undefined as undefined | { billingLineageId: string; patientAuthId: string; doctorAuthId: string;
      consultationType: string; amountCentavos: string; currency: string },
    intents: [] as Intent[],
    log: undefined as undefined | { appointmentId: string; toStatus: string; changedByRole: string; changedAt: Date },
    saga: undefined as undefined | { sourceAppointmentId: string; replacementAppointmentId: string; pivotCommittedAt: Date },
    replacement: undefined as undefined | typeof row,
  };
  let snapshot: { quote: typeof state.quote; intents: Intent[] } | undefined;
  const query = async (sql: string, values: unknown[] = []) => {
    state.queries.push(sql);
    const result = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    if (sql === "BEGIN") snapshot = { quote: state.quote && { ...state.quote }, intents: state.intents.map(item => ({ ...item })) };
    if (sql === "ROLLBACK" && snapshot) { state.quote = snapshot.quote; state.intents = snapshot.intents; }
    if (sql === "COMMIT" && state.failCommit) throw new Error("CORE_COMMIT_FAILED");
    if (sql.includes("FROM appointments a")) return result([values[0] === id ? state.row : state.replacement].filter(Boolean));
    if (sql.includes("FROM vital_doctors d")) return result([{ virtualFee: state.fee, inPersonFee: "2000.50" }]);
    if (sql.includes("FROM vital_admins")) return result(state.admin ? [{ userId: randomUUID() }] : []);
    if (sql.startsWith("SELECT * FROM appointment_billing_quotes")) return result(state.quote ? [state.quote] : []);
    if (sql.startsWith("INSERT INTO appointment_billing_quotes")) {
      state.quote ??= { billingLineageId: String(values[0]), patientAuthId: String(values[2]), doctorAuthId: String(values[3]),
        consultationType: String(values[4]), amountCentavos: String(values[5]), currency: "PHP" };
    }
    if (sql.startsWith("INSERT INTO appointment_billing_intents")) {
      if (!state.intents.some(item => item.actorAuthId === values[5] && item.operationId === values[6])) {
        state.intents.push({ id: String(values[0]), appointmentId: String(values[1]), billingLineageId: String(values[2]),
          appointmentVersion: Number(values[3]), associationVersion: Number(values[4]), actorAuthId: String(values[5]),
          operationId: String(values[6]), requestHash: String(values[7]), expiresAt: values[8] as Date,
          kind: "checkout", state: "prepared", committedAt: null, ownerLogId: null, ownerOperationId: null,
          replacementAppointmentId: null, expectedPaymentVersion: null });
      }
    }
    if (sql.startsWith("SELECT * FROM appointment_billing_intents")) return result(state.intents.filter(item =>
      sql.includes("WHERE id=") ? item.id === values[0] : item.actorAuthId === values[0] && item.operationId === values[1]));
    if (sql.startsWith("UPDATE appointment_billing_intents")) {
      const intent = state.intents.find(item => item.id === values[0]); if (intent) intent.expiresAt = values[1] as Date;
    }
    if (sql.includes("FROM appointment_logs")) return result(state.log ? [state.log] : []);
    if (sql.includes("FROM saga_operations")) return result(state.saga ? [state.saga] : []);
    return result([]);
  };
  const pool = { query, async connect() { return { query, release() {} }; } } as unknown as Pool;
  const authority = createBillingAuthority(pool);
  const command = { operationId: randomUUID(), requestHash: "a".repeat(64) };
  async function prepare() { return authority.prepare(actor, id, command); }
  async function committed(kind: string, role = "doctor", at = new Date()) {
    await prepare();
    const intent = state.intents[0]!;
    state.row.status = kind === "complete" ? "completed" : kind === "reassociate" ? "rescheduled" : "cancelled";
    if (kind === "complete") state.row.completedAt = at;
    intent.kind = kind; intent.state = "committed"; intent.committedAt = at; intent.ownerLogId = randomUUID();
    intent.actorAuthId = role === "doctor" ? doctorId : patientId;
    state.log = { appointmentId: id, toStatus: state.row.status, changedByRole: role, changedAt: at };
    return intent;
  }
  return { state, authority, actor, id, command, prepare, committed };
}
const code = (expected: string) => (error: unknown) => typeof error === "object" && error !== null
  && "code" in error && error.code === expected;

test("EDA Billing exact decimal conversion rejects rounding, missing and unsafe fees", () => {
  assert.equal(exactCentavos("0.01"), 1); assert.equal(exactCentavos("21474836.47"), 2_147_483_647);
  assert.equal(exactCentavos("1250.2"), 125020);
  for (const value of [null, 10.25, "0", "-1", "1.001", "1e3", "21474836.48", "99999999.99", "100000000", "9007199254740992", "NaN", " 1.00"]) {
    assert.throws(() => exactCentavos(value), code("BILLING_FEE_INVALID"));
  }
});

test("EDA Billing independently binds patient role scope resource and Auth UUID ownership", async () => {
  const f = fixture();
  const own = await f.authority.authorize(f.actor, f.id);
  assert.equal(own.patientAuthId, f.actor.authId); assert.equal(own.amountCentavos, 125025);
  for (const actor of [{ ...f.actor, authId: randomUUID() }, { ...f.actor, role: "doctor" as const },
    { ...f.actor, role: "service" as const }, { ...f.actor, scopes: ["profile.read"] },
    { ...f.actor, resource: randomUUID() }]) await assert.rejects(f.authority.authorize(actor, f.id));
  await assert.rejects(f.authority.authorize(f.actor, randomUUID()), code("BILLING_APPOINTMENT_NOT_FOUND"));
});

test("EDA Billing first preparation freezes fee and consultation snapshot without lifecycle writes", async () => {
  const f = fixture(); const first = await f.prepare();
  assert.equal(first.amountCentavos, 125025); assert.ok(first.intentId);
  f.state.fee = "999.00";
  const next = await f.authority.prepare(f.actor, f.id, { ...f.command, operationId: randomUUID() });
  assert.equal(next.amountCentavos, 125025); assert.equal(f.state.intents.length, 2);
  assert.equal(f.state.row.status, "approved"); assert.equal(f.state.row.appointmentVersion, 4);
  assert.ok(!f.state.queries.some(sql => /UPDATE appointments|INSERT INTO appointment_logs/.test(sql)));
  f.state.row.consultationType = "in_person";
  await assert.rejects(f.prepare(), code("BILLING_QUOTE_ASSOCIATION_CONFLICT"));
});

test("EDA Billing duplicate command renews only freshly authorized matching current intent", async () => {
  const f = fixture(); const first = await f.prepare(); const intent = f.state.intents[0]!;
  intent.expiresAt = new Date(Date.now() - 1000);
  await assert.rejects(f.authority.verifyIntent(first.intentId!), code("BILLING_INTENT_EXPIRED"));
  const replay = await f.prepare();
  assert.equal(first.intentId, replay.intentId); assert.equal(f.state.intents.length, 1);
  assert.ok(intent.expiresAt.getTime() > Date.now());
  await assert.rejects(f.authority.prepare({ ...f.actor, scopes: ["payments.read"] }, f.id, f.command), code("ACTOR_SCOPE_DENIED"));
  f.state.row.appointmentVersion++;
  await assert.rejects(f.prepare(), code("BILLING_INTENT_STALE"));
});

test("EDA Billing command hash and cross-resource replay conflicts preserve original authorization", async () => {
  const f = fixture(); await f.prepare();
  await assert.rejects(f.authority.prepare(f.actor, f.id, { ...f.command, requestHash: "b".repeat(64) }), code("BILLING_COMMAND_CONFLICT"));
  assert.equal(f.state.intents[0]!.requestHash, f.command.requestHash);
  f.state.intents[0]!.appointmentId = randomUUID();
  await assert.rejects(f.prepare(), code("BILLING_COMMAND_CONFLICT"));
  assert.ok(f.state.queries.includes("ROLLBACK"));
});

test("EDA Billing rejects invalid fees and rolls quote and intent back after Core failure", async () => {
  const f = fixture(); f.state.fee = null;
  await assert.rejects(f.prepare(), code("BILLING_FEE_INVALID"));
  assert.equal(f.state.quote, undefined); assert.equal(f.state.intents.length, 0);
  f.state.fee = "1.00"; f.state.failCommit = true;
  await assert.rejects(f.prepare(), /CORE_COMMIT_FAILED/);
  assert.equal(f.state.quote, undefined); assert.equal(f.state.intents.length, 0);
});

test("EDA Billing nonpayable lifecycle and expired schedule prevent preparation but permit owned review", async () => {
  const f = fixture();
  for (const status of ["pending", "pending_patient_confirmation", "cancelled", "rejected", "rescheduled", "expired", "completed"]) {
    f.state.row.status = status;
    await assert.rejects(f.prepare(), code("BILLING_NOT_PAYABLE"));
    const context = await f.authority.authorize({ ...f.actor, scopes: ["payments.reconcile"] }, f.id);
    assert.equal(context.payable, false); assert.equal(context.reviewRequired, status !== "completed");
  }
  f.state.row.status = "approved"; f.state.row.scheduledAt = new Date(Date.now() - 1000);
  await assert.rejects(f.prepare(), code("BILLING_NOT_PAYABLE"));
  assert.equal((await f.authority.current(f.id)).reviewRequired, true);
});

test("EDA Billing provider boundary revalidates current versions association eligibility and quote", async () => {
  const f = fixture(); const prepared = await f.prepare();
  assert.equal((await f.authority.verifyIntent(prepared.intentId!)).payable, true);
  f.state.row.status = "cancelled";
  await assert.rejects(f.authority.verifyIntent(prepared.intentId!), code("BILLING_NOT_PAYABLE"));
  f.state.row.status = "approved"; f.state.row.associationVersion++;
  await assert.rejects(f.authority.verifyIntent(prepared.intentId!), code("BILLING_INTENT_STALE"));
  f.state.row.associationVersion--; f.state.quote!.patientAuthId = randomUUID();
  await assert.rejects(f.authority.verifyIntent(prepared.intentId!), code("BILLING_QUOTE_ASSOCIATION_CONFLICT"));
});

test("EDA Billing current admin marker is required despite delegated admin claim", async () => {
  const f = fixture(); const actor = { ...f.actor, role: "admin" as const };
  await f.authority.assertAdmin(actor); f.state.admin = false;
  await assert.rejects(f.authority.assertAdmin(actor), code("BILLING_ADMIN_REVOKED"));
  await assert.rejects(f.authority.assertAdmin(f.actor), code("BILLING_ADMIN_REQUIRED"));
});

test("EDA Billing open proposal saga or slot transition blocks new provider authorization", async () => {
  const f = fixture(); const prepared = await f.prepare();
  f.state.row.hasBillingTransition = true;
  await assert.rejects(f.prepare(), code("BILLING_TRANSITION_PENDING"));
  await assert.rejects(f.authority.verifyIntent(prepared.intentId!), code("BILLING_NOT_PAYABLE"));
  assert.equal((await f.authority.current(f.id)).payable, false);
  f.state.row.hasBillingTransition = false; f.state.row.sourceAppointmentId = randomUUID();
  await assert.rejects(f.prepare(), code("BILLING_TRANSITION_PENDING"));
});

test("EDA Billing future owner kinds fail closed without committed matching receipt", async () => {
  const f = fixture();
  await assert.rejects(f.authority.committedIntent(randomUUID()), code("BILLING_OWNER_INTENT_UNAVAILABLE"));
  const prepared = await f.prepare();
  assert.equal((await f.authority.committedIntent(prepared.intentId!)).kind, "checkout");
  f.state.intents[0]!.kind = "refund";
  await assert.rejects(f.authority.committedIntent(prepared.intentId!), code("BILLING_OWNER_INTENT_UNAVAILABLE"));
  const g = fixture(); const intent = await g.committed("refund");
  g.state.log!.appointmentId = randomUUID();
  await assert.rejects(g.authority.committedIntent(intent.id), code("BILLING_OWNER_RECEIPT_INVALID"));
});

test("EDA Billing refund reason derives from committed actor and exact cancellation boundary", async () => {
  for (const [role, hours, expected] of [
    ["doctor", 1, "doctor_cancelled"], ["patient", 24, "patient_cancelled_before_24h"],
    ["patient", 23, "patient_cancelled_within_24h"],
  ] as const) {
    const f = fixture(); const at = new Date();
    f.state.row.scheduledAt = new Date(at.getTime() + hours * 3_600_000);
    const intent = await f.committed("refund", role, at);
    const receipt = await f.authority.committedIntent(intent.id);
    assert.equal(receipt.reasonCode, expected); assert.equal(receipt.cancelledAt!.getTime(), at.getTime());
    intent.actorAuthId = randomUUID();
    await assert.rejects(f.authority.committedIntent(intent.id), code("BILLING_OWNER_RECEIPT_INVALID"));
  }
});

test("EDA Billing completion requires owner status receipt and payment version fence", async () => {
  const f = fixture(); const intent = await f.committed("complete");
  intent.expectedPaymentVersion = 7;
  assert.equal((await f.authority.committedIntent(intent.id)).expectedPaymentVersion, 7);
  assert.equal((await f.authority.committedIntent(intent.id)).completedAt!.getTime(), f.state.row.completedAt!.getTime());
  const verifiedTime = f.state.row.completedAt;
  f.state.row.completedAt = null;
  await assert.rejects(f.authority.committedIntent(intent.id), code("BILLING_OWNER_RECEIPT_INVALID"));
  f.state.row.completedAt = new Date(intent.committedAt!.getTime() + 1);
  await assert.rejects(f.authority.committedIntent(intent.id), code("BILLING_OWNER_RECEIPT_INVALID"));
  f.state.row.completedAt = verifiedTime;
  f.state.row.appointmentVersion++;
  await assert.rejects(f.authority.committedIntent(intent.id), code("BILLING_INTENT_STALE"));
});
test("EDA Billing projection reader locks current association without Profile fee queries", async () => {
  const value = { id: randomUUID(), status: "approved", version: 1, billingLineageId: randomUUID(), associationVersion: 1 };
  const calls: string[] = [];
  const tx = { query: async (sql: string) => { calls.push(sql); return { rows: [value] }; } } as unknown as PoolClient;
  assert.deepEqual(await readPaymentProjectionAppointment(tx, value.id), value);
  assert.equal(calls.length, 1); assert.match(calls[0]!, /FOR UPDATE/); assert.doesNotMatch(calls[0]!, /vital_doctors/);
});

test("EDA Billing reassociation requires committed saga and same lineage next association", async () => {
  const f = fixture(); const intent = await f.committed("reassociate");
  intent.ownerOperationId = randomUUID(); intent.replacementAppointmentId = randomUUID();
  const replacement = { ...f.state.row, appointmentId: intent.replacementAppointmentId, associationVersion: 2, status: "approved" };
  f.state.replacement = replacement;
  f.state.saga = { sourceAppointmentId: f.id, replacementAppointmentId: intent.replacementAppointmentId, pivotCommittedAt: new Date() };
  assert.equal((await f.authority.committedIntent(intent.id)).replacementAppointmentId, intent.replacementAppointmentId);
  replacement.associationVersion = 1;
  await assert.rejects(f.authority.committedIntent(intent.id), code("BILLING_OWNER_RECEIPT_INVALID"));
});
