import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import type { Pool } from "pg";
import { DomainError, type Actor } from "../src/eda/contracts/actor.js";
import { createPaymentRouter } from "../src/eda/http/payment-router.js";
import { createPaymentModule, type BillingAuthority, type BillingParticipantIntent } from "../src/eda/modules/payment/payment.js";
import type { BillingContext } from "../src/eda/modules/appointment/appointment-billing.js";
import { createPaymongoProvider, ProviderError, type CheckoutObservation, type PaymentProvider, type RefundObservation } from "../src/eda/modules/payment/payment-provider.js";
import { createPaymentStore, decimalCentavos } from "../src/eda/modules/payment/payment-store.js";
import { paymentRuntime } from "../src/eda/modules/payment/payment-runtime.js";
import { MemoryPaymentStore } from "./helpers/payment-memory.js";

function fixture() {
  const store = new MemoryPaymentStore(); let clock = Date.now(); let writes = 0; let reads = 0; let adminValid = true;
  const context: BillingContext = { appointmentId: randomUUID(), billingLineageId: randomUUID(), appointmentVersion: 1, associationVersion: 1,
    patientAuthId: randomUUID(), doctorAuthId: randomUUID(), consultationType: "virtual", amountCentavos: 50000, currency: "PHP",
    status: "approved", payable: true, reviewRequired: false, scheduledAt: new Date(clock + 172800000), intentId: randomUUID() };
  let observation: CheckoutObservation = { checkoutSessionId: "cs_test", checkoutUrl: "https://checkout.paymongo.com/cs_test#key", paymentIntentId: "pi_test",
    paymentId: null, status: "pending", checkoutState: "active", amountCentavos: 50000, currency: "PHP", paidAt: null,
    livemode: false, appointmentId: context.appointmentId, billingLineageId: context.billingLineageId };
  let refund: RefundObservation = { refundId: "ref_test", paymentId: "pay_test", amountCentavos: 50000, currency: "PHP", status: "pending", livemode: false };
  const intents = new Map<string, BillingParticipantIntent>();
  const billing: BillingAuthority = {
    async authorize(actor, id) { if (actor.authId !== context.patientAuthId || id !== context.appointmentId) throw new DomainError(403, "OWNER", "Denied."); return { ...context }; },
    async prepare(actor, id) { return this.authorize(actor, id); },
    async current() { return { ...context }; }, async verifyIntent() { return { ...context }; },
    async assertAdmin() { if (!adminValid) throw new DomainError(403, "REVOKED", "Denied."); },
    async committedIntent(id) { const value = intents.get(id); if (!value) throw new DomainError(503, "GATED", "Gated."); return value; },
  };
  const provider: PaymentProvider = {
    async createCheckout() { writes++; return structuredClone(observation); }, async retrieveCheckout() { reads++; return structuredClone(observation); },
    async expireCheckout() { writes++; observation.checkoutState = "expired"; observation.status = "failed"; return structuredClone(observation); },
    async createRefund() { writes++; return structuredClone(refund); }, async retrieveRefund() { reads++; return structuredClone(refund); },
  };
  const actor = (scope = "payments.checkout"): Actor => ({ authId: context.patientAuthId, role: "patient", serviceId: "vital-web", scopes: [scope],
    resource: context.appointmentId, correlationId: randomUUID(), isSuperAdmin: false });
  const admin = (paymentId: string, scope = "payments.review.write"): Actor => ({ ...actor(), role: "admin", authId: randomUUID(), resource: paymentId, scopes: [scope] });
  const metadata = () => ({ operationId: randomUUID(), requestHash: "a".repeat(64) });
  const module = createPaymentModule({ store, billing, provider, appOrigin: "https://vital.test", enabled: true, clock: () => clock });
  const paid = () => { observation = { ...observation, status: "paid", paymentId: "pay_test", paidAt: new Date(clock).toISOString() }; };
  const intent = (kind: BillingParticipantIntent["kind"], extra: Partial<BillingParticipantIntent> = {}) => {
    const id = randomUUID(); intents.set(id, { id, kind, ...context, ...extra }); return id;
  };
  return { store, context, module, provider, billing, actor, admin, metadata, paid, intent,
    writes: () => writes, reads: () => reads, advance: (ms = 61000) => { clock += ms; },
    revoke: () => { adminValid = false; }, observation: () => observation, setObservation: (value: Partial<CheckoutObservation>) => { observation = { ...observation, ...value }; },
    setRefund: (value: Partial<RefundObservation>) => { refund = { ...refund, ...value }; } };
}

test("EDA Payment checkout duplicates freeze the quote and execute one provider write", async () => {
  const f = fixture(); const command = f.metadata();
  const results = await Promise.all([f.module.checkout(f.actor(), f.context.appointmentId, command), f.module.checkout(f.actor(), f.context.appointmentId, command)]);
  assert.equal(f.writes(), 1); assert.equal(f.store.payments.size, 1); assert.equal(f.store.operations.size, 1);
  f.context.amountCentavos = 70000;
  const retry = await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata());
  assert.equal(retry.payment?.amount, "500.00"); assert.equal(f.writes(), 1);
  assert.ok(results.some(value => value.operationStatus === "completed"));
});
test("EDA Payment temporary proposal fencing does not misclassify verified payment as late",async()=>{
  const f=fixture();await f.module.checkout(f.actor(),f.context.appointmentId,f.metadata());
  f.context.payable=false;f.context.reviewRequired=false;f.paid();f.advance();
  const outcome=await f.module.reconcile(f.actor("payments.reconcile"),f.context.appointmentId,f.metadata());
  assert.equal(outcome.payment?.status,"paid");assert.equal(outcome.payment?.reviewRequired,false);
  assert.equal(f.store.events.filter(event=>event.eventType==='vital.payment.completed').length,1);
});
test("EDA Payment commands reject changed hashes roles resources and actor ownership", async () => {
  const f = fixture(); const command = f.metadata(); await f.module.checkout(f.actor(), f.context.appointmentId, command);
  await assert.rejects(f.module.checkout(f.actor(), f.context.appointmentId, { ...command, requestHash: "b".repeat(64) }));
  await assert.rejects(f.module.checkout({ ...f.actor(), role: "admin" }, f.context.appointmentId, f.metadata()));
  await assert.rejects(f.module.read({ ...f.actor("payments.read"), authId: randomUUID() }, f.context.appointmentId));
  await assert.rejects(f.module.read({ ...f.actor("payments.read"), resource: randomUUID() }, f.context.appointmentId));
  assert.equal(f.writes(), 1);
});
test("EDA Payment unknown and rejected creation outcomes never reopen the provider operation", async () => {
  for (const definite of [false, true]) {
    const f = fixture(); let attempts = 0;
    f.provider.createCheckout = async () => { attempts++; throw new ProviderError("SAFE", definite); };
    const first = await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata());
    const retry = await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata());
    assert.equal(first.operationStatus, definite ? "failed" : "unknown"); assert.equal(retry.operationStatus, first.operationStatus);
    assert.equal(attempts, 1); assert.equal(first.payment?.checkoutUrl, null); assert.equal(first.payment?.reviewRequired, true);
  }
});
test("EDA Payment outbox rollback before execution prevents provider writes and retries safely", async () => {
  const f = fixture(); f.store.failNextEmit = true; const command = f.metadata();
  await assert.rejects(f.module.checkout(f.actor(), f.context.appointmentId, command));
  assert.equal(f.writes(), 0); assert.equal(f.store.payments.size, 0); assert.equal(f.store.commands.size, 0);
  assert.equal((await f.module.checkout(f.actor(), f.context.appointmentId, command)).operationStatus, "completed");
});
test("EDA Payment provider success followed by Core or Integrations uncertainty requires receipt recovery", async () => {
  const f = fixture();
  f.provider.createCheckout = async () => { f.store.failCommitOnce = true; return f.observation(); };
  const first = await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata());
  assert.equal(first.operationStatus, "unknown"); assert.equal(first.payment?.checkoutSessionId, null);
  const row = [...f.store.payments.values()][0]!;
  const recovered = await f.module.linkReceipt(f.admin(row.id), row.id, f.metadata(), { kind: "checkout", providerId: "cs_test", expectedVersion: row.version });
  assert.equal(recovered.operationStatus, "completed"); assert.equal(recovered.payment?.checkoutSessionId, "cs_test");
});
test("EDA Payment stale preparation before execution fails without an external write", async () => {
  const f = fixture(); const command = f.metadata(); f.billing.verifyIntent = async () => ({ ...f.context, payable: false });
  const value = await f.module.checkout(f.actor(), f.context.appointmentId, command);
  assert.equal(value.operationStatus, "failed"); assert.equal(f.writes(), 0);
  f.billing.verifyIntent = async () => ({ ...f.context });
  assert.equal((await f.module.checkout(f.actor(), f.context.appointmentId, command)).operationStatus, "failed");
  assert.equal((await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata())).operationStatus, "completed");
  assert.equal(f.writes(), 1);
});
test("EDA Payment transient authorization failure recovers before provider execution", async () => {
  const f = fixture(); const command = f.metadata();
  f.billing.verifyIntent = async () => { throw new Error("CORE_UNAVAILABLE"); };
  const pending = await f.module.checkout(f.actor(), f.context.appointmentId, command);
  assert.equal(pending.operationStatus, "pending"); assert.equal(f.writes(), 0);
  f.billing.verifyIntent = async () => ({ ...f.context });
  const recovered = await f.module.checkout(f.actor(), f.context.appointmentId, command);
  assert.equal(recovered.operationStatus, "completed"); assert.equal(f.writes(), 1);
});
test("EDA Payment unavailable billing context clears only after verified current ownership", async () => {
  const f = fixture(); f.billing.current = async () => { throw new Error("CORE_UNAVAILABLE"); };
  const created = await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata());
  assert.equal(created.payment?.reviewCode, "BILLING_CONTEXT_UNAVAILABLE"); assert.equal(created.payment?.checkoutUrl, null);
  f.billing.current = async () => ({ ...f.context });
  const recovered = await f.module.reconcile(f.actor("payments.reconcile"), f.context.appointmentId, f.metadata());
  assert.equal(recovered.payment?.reviewRequired, false); assert.ok(recovered.payment?.checkoutUrl);
});
test("EDA Payment unknown refund stays visible through unavailable Core observations", async () => {
  const f = fixture(); await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata()); f.paid();
  f.context.status = "cancelled"; f.context.payable = false; f.context.reviewRequired = true;
  await f.module.reconcile(f.actor("payments.reconcile"), f.context.appointmentId, f.metadata());
  f.provider.createRefund = async () => { throw new ProviderError("UNKNOWN", false); };
  const row = [...f.store.payments.values()][0]!;
  await f.module.reviewRefund(f.admin(row.id), row.id, f.metadata(), { expectedVersion: row.version });
  f.billing.current = async () => { throw new Error("CORE_UNAVAILABLE"); }; f.advance();
  await f.module.workerTick();
  f.billing.current = async () => ({ ...f.context });
  const read = await f.module.read(f.actor("payments.read"), f.context.appointmentId);
  assert.equal(read.operationStatus, "unknown"); assert.equal(read.payment?.reviewCode, "PROVIDER_OUTCOME_UNKNOWN");
});
test("EDA Payment fresh authorization recovers an expired never-started lease and fences the old caller", async () => {
  const f = fixture(); let notify!: () => void; let release!: () => void;
  const waiting = new Promise<void>(resolve => { notify = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  f.billing.verifyIntent = async () => { notify(); await gate; return { ...f.context }; };
  const old = f.module.checkout(f.actor(), f.context.appointmentId, f.metadata()); await waiting;
  f.advance(); f.billing.verifyIntent = async () => ({ ...f.context });
  const recovered = await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata()); release(); await old;
  assert.equal(recovered.operationStatus, "completed"); assert.equal(f.writes(), 1);
  assert.equal(f.store.operations.size, 1);
});
test("EDA Payment completed invoice keeps the verified owner completion timestamp across retries", async () => {
  const f = fixture(); await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata()); f.paid();
  await f.module.reconcile(f.actor("payments.reconcile"), f.context.appointmentId, f.metadata());
  f.context.status = "completed"; f.context.payable = false;
  const completedAt = new Date("2026-01-01T10:00:00.000Z"); const id = f.intent("complete", { completedAt });
  await f.module.completeInvoice(id, randomUUID()); f.advance(86400000); await f.module.completeInvoice(id, randomUUID());
  assert.equal([...f.store.invoices.values()][0]!.completedAt, completedAt.toISOString());
  await assert.rejects(f.module.completeInvoice(f.intent("complete"), randomUUID()));
});
test("EDA Payment refresh and worker leases coalesce observations and emit paid only once", async () => {
  const f = fixture(); await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata()); f.paid();
  await Promise.all([f.module.reconcile(f.actor("payments.reconcile"), f.context.appointmentId, f.metadata()), f.module.workerTick()]);
  assert.equal(f.reads(), 1); assert.equal(f.store.events.filter(event => event.eventType === "vital.payment.completed").length, 1);
  f.advance(); await f.module.reconcile(f.actor("payments.reconcile"), f.context.appointmentId, f.metadata());
  assert.equal(f.store.events.filter(event => event.eventType === "vital.payment.completed").length, 1);
  assert.equal(f.context.status, "approved");
  assert.equal(f.store.events.some(event => event.producer === "appointment"), false);
});
test("EDA Payment unchanged observations update polling metadata without duplicate facts or audit transitions", async () => {
  const f = fixture(); await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata());
  const version = [...f.store.payments.values()][0]!.version; const facts = f.store.events.length;
  await f.module.reconcile(f.actor("payments.reconcile"), f.context.appointmentId, f.metadata());
  const first = [...f.store.payments.values()][0]!.lastReconciledAt; f.advance();
  await f.module.reconcile(f.actor("payments.reconcile"), f.context.appointmentId, f.metadata());
  const row = [...f.store.payments.values()][0]!;
  assert.notEqual(row.lastReconciledAt, first); assert.equal(row.version, version); assert.equal(f.store.events.length, facts);
});
test("EDA Payment late paid observations require review without revival access grants or automatic refunds", async () => {
  const f = fixture(); await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata());
  f.context.status = "cancelled"; f.context.payable = false; f.context.reviewRequired = true; f.paid();
  const result = await f.module.reconcile(f.actor("payments.reconcile"), f.context.appointmentId, f.metadata());
  assert.equal(result.payment?.status, "paid"); assert.equal(result.payment?.reviewCode, "LATE_PAYMENT");
  assert.equal(result.payment?.checkoutUrl, null); assert.equal(f.context.status, "cancelled"); assert.equal(f.writes(), 1);
});
test("EDA Payment stale pending observations never downgrade paid or completed consultations", async () => {
  const f = fixture(); await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata()); f.paid();
  await f.module.reconcile(f.actor("payments.reconcile"), f.context.appointmentId, f.metadata()); f.advance();
  f.context.status = "completed"; f.context.payable = false;
  f.setObservation({ status: "pending", paymentId: null, paidAt: null });
  const next = await f.module.reconcile(f.actor("payments.reconcile"), f.context.appointmentId, f.metadata());
  assert.equal(next.payment?.status, "paid"); assert.equal(next.payment?.reviewRequired, false);
});
test("EDA Payment wrong provider amount mode and association stay unknown without accepted financial facts", async () => {
  for (const changed of [{ amountCentavos: 1 }, { livemode: true }, { appointmentId: randomUUID() }, { billingLineageId: randomUUID() }]) {
    const f = fixture(); f.setObservation(changed as Partial<CheckoutObservation>);
    const value = await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata());
    assert.equal(value.operationStatus, "unknown"); assert.equal(value.payment?.paidAt, null);
    assert.equal(f.store.events.filter(event => event.eventType === "vital.payment.completed").length, 0);
  }
});
test("EDA Payment reconciliation backs off honors Retry-After and exhausts to review", async () => {
  const f = fixture(); await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata());
  f.provider.retrieveCheckout = async () => { throw new ProviderError("RATE_LIMIT", false, 7200); };
  for (let index = 0; index < 10; index++) {
    const output = await f.module.reconcile(f.actor("payments.reconcile"), f.context.appointmentId, f.metadata());
    assert.equal(output.operationStatus, "unknown");
    const row = [...f.store.payments.values()][0]!;
    if (index < 9) assert.ok(Date.parse(row.nextReconcileAt!) - Date.parse(row.lastReconciledAt!) >= 7200000);
    f.advance(7200001);
  }
  assert.equal([...f.store.payments.values()][0]!.reviewCode, "RECONCILIATION_EXHAUSTED"); assert.equal(await f.module.workerTick(), 0);
});
test("EDA Payment same refresh command recovers unknown retrieval after backoff without repeating writes", async () => {
  const f = fixture(); await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata());
  const retrieve = f.provider.retrieveCheckout; let attempts = 0;
  f.provider.retrieveCheckout = async () => { attempts++; throw new ProviderError("RATE_LIMIT", false, 300); };
  const command = f.metadata(); const actor = f.actor("payments.reconcile");
  assert.equal((await f.module.reconcile(actor, f.context.appointmentId, command)).operationStatus, "unknown");
  f.advance(61000);
  assert.equal((await f.module.reconcile(actor, f.context.appointmentId, command)).operationStatus, "unknown"); assert.equal(attempts, 1);
  f.advance(300001); f.provider.retrieveCheckout = retrieve; f.paid();
  const recovered = await f.module.reconcile(actor, f.context.appointmentId, command);
  assert.equal(recovered.operationStatus, "completed"); assert.equal(recovered.payment?.status, "paid"); assert.equal(f.writes(), 1);
});
test("EDA Payment reviewed known receipt recovers exhausted reads without clearing other unknown writes", async () => {
  const f = fixture(); await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata());
  const retrieve = f.provider.retrieveCheckout; f.provider.retrieveCheckout = async () => { throw new ProviderError("UNAVAILABLE", false); };
  for (let index = 0; index < 10; index++) {
    await f.module.reconcile(f.actor("payments.reconcile"), f.context.appointmentId, f.metadata()); f.advance(3600001);
  }
  f.provider.retrieveCheckout = retrieve;
  let row = [...f.store.payments.values()][0]!;
  const first = await f.module.linkReceipt(f.admin(row.id), row.id, f.metadata(), { kind: "checkout", providerId: "cs_test", expectedVersion: row.version });
  assert.equal(first.payment?.reviewRequired, false); assert.equal(f.store.payments.get(row.id)?.reconcileFailures, 0); assert.equal(f.writes(), 1);
  const op = [...f.store.operations.values()][0]!;
  f.store.operations.set("unresolved-refund", { ...op, id: randomUUID(), operationKey: "unresolved-refund", operationType: "refund", status: "unknown" });
  row = [...f.store.payments.values()][0]!; row.reviewRequired = true; row.reviewCode = "RECONCILIATION_EXHAUSTED";
  const second = await f.module.linkReceipt(f.admin(row.id), row.id, f.metadata(), { kind: "checkout", providerId: "cs_test", expectedVersion: row.version });
  assert.equal(second.payment?.reviewRequired, true); assert.equal(second.payment?.reviewCode, "PROVIDER_OUTCOME_UNKNOWN");
  assert.equal(f.store.operations.get("unresolved-refund")?.status, "unknown"); assert.equal(f.writes(), 1);
});
test("EDA Payment expired execution leases become unknown and never repeat creation", async () => {
  const f = fixture(); await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata());
  const op = [...f.store.operations.values()][0]!;
  op.status = "pending"; op.leaseOwner = randomUUID(); op.leaseUntil = new Date(0).toISOString();
  f.store.operations.set(op.operationKey, op); await f.module.workerTick();
  assert.equal(f.store.operations.get(op.operationKey)?.status, "unknown"); assert.equal(f.writes(), 1);
});
test("EDA Payment abandoned unstarted claims cannot starve expired execution recovery", async () => {
  const f = fixture(); await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata());
  const op = [...f.store.operations.values()][0]!; f.store.operations.clear();
  for (let index = 0; index < 20; index++) f.store.operations.set(`abandoned:${index}`, {
    ...op, id: randomUUID(), operationKey: `abandoned:${index}`, status: "pending", executionStartedAt: null, leaseUntil: new Date(0).toISOString(),
  });
  f.store.operations.set(op.operationKey, { ...op, status: "pending", leaseUntil: new Date(0).toISOString() });
  await f.module.workerTick(); assert.equal(f.store.operations.get(op.operationKey)?.status, "unknown");
  const queries: string[] = [];
  const sql = createPaymentStore({ query: async (query: string) => { queries.push(query); return { rows: [] }; } } as unknown as Pool);
  await sql.expiredOperations(new Date().toISOString(), 20);
  assert.match(queries[0]!, /"executionStartedAt" IS NOT NULL[\s\S]*LIMIT/);
});
test("EDA Payment admin review independently checks membership versions and provider receipt binding", async () => {
  const f = fixture(); f.provider.createCheckout = async () => { throw new ProviderError("UNKNOWN", false); };
  await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata()); const row = [...f.store.payments.values()][0]!;
  const body = { kind: "checkout" as const, providerId: "cs_test", expectedVersion: row.version };
  await assert.rejects(f.module.linkReceipt(f.admin(row.id), row.id, f.metadata(), { ...body, expectedVersion: row.version - 1 }));
  f.setObservation({ billingLineageId: randomUUID() }); await assert.rejects(f.module.linkReceipt(f.admin(row.id), row.id, f.metadata(), body));
  f.revoke(); await assert.rejects(f.module.linkReceipt(f.admin(row.id), row.id, f.metadata(), body));
  assert.equal(f.store.payments.get(row.id)?.status, "pending");
});
test("EDA Payment reviewed refunds reconcile processing success and reject stale rollback", async () => {
  const f = fixture(); await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata()); f.paid();
  f.context.status = "cancelled"; f.context.payable = false; f.context.reviewRequired = true;
  await f.module.reconcile(f.actor("payments.reconcile"), f.context.appointmentId, f.metadata());
  const row = [...f.store.payments.values()][0]!; const actor = f.admin(row.id); const command = f.metadata();
  const created = await f.module.reviewRefund(actor, row.id, command, { expectedVersion: row.version });
  assert.equal(created.payment?.status, "refund_pending"); assert.equal(f.writes(), 2);
  assert.deepEqual(await f.module.reviewRefund(actor, row.id, command, { expectedVersion: row.version }), created);
  f.setRefund({ status: "processing" }); f.advance(); await f.module.workerTick();
  f.setRefund({ status: "succeeded" }); f.advance(); await f.module.workerTick();
  assert.equal([...f.store.payments.values()][0]!.status, "refunded");
  f.setRefund({ status: "pending" }); f.advance(); await f.module.reconcile(f.actor("payments.reconcile"), f.context.appointmentId, f.metadata());
  assert.equal([...f.store.payments.values()][0]!.status, "refunded"); assert.equal(f.writes(), 2);
});
test("EDA Payment unknown refund cannot be resubmitted by review commands", async () => {
  const f = fixture(); await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata()); f.paid();
  f.context.status = "cancelled"; f.context.payable = false; f.context.reviewRequired = true;
  await f.module.reconcile(f.actor("payments.reconcile"), f.context.appointmentId, f.metadata());
  let writes = 0; f.provider.createRefund = async () => { writes++; throw new ProviderError("UNKNOWN", false); };
  let row = [...f.store.payments.values()][0]!; await f.module.reviewRefund(f.admin(row.id), row.id, f.metadata(), { expectedVersion: row.version });
  row = [...f.store.payments.values()][0]!;
  await assert.rejects(f.module.reviewRefund(f.admin(row.id), row.id, f.metadata(), { expectedVersion: row.version })); assert.equal(writes, 1);
});
test("EDA Payment committed participant refunds preserve cancellation-time policy and never trust an eligible flag", async () => {
  for (const eligible of [true, false]) {
    const f = fixture(); await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata()); f.paid();
    await f.module.reconcile(f.actor("payments.reconcile"), f.context.appointmentId, f.metadata());
    f.context.status = "cancelled"; f.context.payable = false;
    const id = f.intent("refund", { reasonCode: eligible ? "patient_cancelled_before_24h" : "patient_cancelled_within_24h",
      cancelledAt: new Date(f.context.scheduledAt.getTime() - (eligible ? 86400000 : 86399999)) });
    const result = await f.module.applyAppointmentIntent(id, randomUUID());
    assert.equal(result.payment?.status, eligible ? "refund_pending" : "non_refundable"); assert.equal(f.writes(), eligible ? 2 : 1);
  }
});
test("EDA Payment failed expiry is verified by retrieval instead of locally inventing failure", async () => {
  const f = fixture(); await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata()); f.context.status = "cancelled"; f.context.payable = false;
  f.provider.expireCheckout = async () => { throw new ProviderError("HTTP400", true); };
  const value = await f.module.applyAppointmentIntent(f.intent("expire"), randomUUID());
  assert.equal(value.operationStatus, "unknown"); assert.equal(value.payment?.status, "pending");
});
test("EDA Payment doctor refunds require committed cancellation evidence and invoice versions fence first creation", async () => {
  const f = fixture(); await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata()); f.paid();
  await f.module.reconcile(f.actor("payments.reconcile"), f.context.appointmentId, f.metadata());
  f.context.status = "completed"; f.context.payable = false;
  const row = [...f.store.payments.values()][0]!;
  await assert.rejects(f.module.completeInvoice(f.intent("complete", { completedAt: new Date(), expectedPaymentVersion: row.version - 1 }), randomUUID()));
  assert.equal(f.store.invoices.size, 0);
  const complete = f.intent("complete", { completedAt: new Date(), expectedPaymentVersion: row.version });
  await f.module.completeInvoice(complete, randomUUID()); await f.module.completeInvoice(complete, randomUUID());
  assert.equal(f.store.invoices.size, 1);
  f.context.status = "cancelled";
  await assert.rejects(f.module.applyAppointmentIntent(f.intent("refund"), randomUUID()));
  assert.equal(f.writes(), 1);
  const refund = f.intent("refund", { reasonCode: "doctor_cancelled", cancelledAt: new Date(f.context.scheduledAt.getTime() - 1000) });
  assert.equal((await f.module.applyAppointmentIntent(refund, randomUUID())).payment?.status, "refund_pending");
  assert.equal(f.writes(), 2);
});
test("EDA Payment invoice metadata requires committed completion and remains idempotent while reassociation is gated", async () => {
  const f = fixture(); await f.module.checkout(f.actor(), f.context.appointmentId, f.metadata()); f.paid();
  await f.module.reconcile(f.actor("payments.reconcile"), f.context.appointmentId, f.metadata());
  f.context.status = "completed"; f.context.payable = false; const id = f.intent("complete", { completedAt: new Date() });
  assert.equal(await f.module.completeInvoice(id, randomUUID()), true); assert.equal(await f.module.completeInvoice(id, randomUUID()), false);
  assert.equal(f.store.invoices.size, 1); await assert.rejects(f.module.prepareReassociation(f.intent("reassociate")));
  await assert.rejects(f.module.completeInvoice(randomUUID(), randomUUID()));
});
test("EDA Payment runtime defaults off and centavo serialization never rounds amounts", () => {
  const pools = {} as { corePool: Pool; integrationsPool: Pool };
  assert.equal(paymentRuntime(pools, {}), undefined);
  assert.throws(() => paymentRuntime(pools, { VITAL_EDA_PAYMENT_RECONCILE_ENABLED: "true" }));
  assert.equal(decimalCentavos(50001), "500.01"); assert.throws(() => decimalCentavos(1.1));
});
test("EDA Payment actual router module and PayMongo adapter compose through one envelope and reject caller authority", async () => {
  const f = fixture(); let calls = 0;
  const provider = createPaymongoProvider({ secret: "sk_test_mock", fetcher: async (_url, options) => {
    calls++; const input = JSON.parse(options!.body as string).data.attributes;
    return Response.json({ data: { id: "cs_native", type: "checkout_session", attributes: { livemode: false, status: "active",
      checkout_url: "https://checkout.paymongo.com/cs_native", line_items: input.line_items, payments: [], metadata: input.metadata } } });
  } });
  const payment = createPaymentModule({ store: f.store, billing: f.billing, provider, appOrigin: "https://vital.test", enabled: true });
  const app = express(); app.use(express.json()); app.use((_req, res, next) => { res.locals.actor = f.actor(); res.locals.command = f.metadata(); next(); });
  app.use("/internal/v1/payments", createPaymentRouter(payment));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error instanceof DomainError ? error.status : 400).json({ success: false }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address === "object");
  try {
    const url = `http://127.0.0.1:${address.port}/internal/v1/payments/appointments/${f.context.appointmentId}/checkout`;
    assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount: 1, eligible: true }) })).status, 400);
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 200); const data = await response.json(); assert.equal(data.contractVersion, 1);
    assert.equal(data.data.payment.amount, "500.00"); assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
