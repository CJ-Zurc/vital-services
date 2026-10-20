import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError, requireScope, type Actor } from "../../contracts/actor.js";
import { requestHash } from "../../infrastructure/security.js";
import type { BillingContext } from "../appointment/appointment-billing.js";
import type { AppointmentParticipant } from "../appointment/appointment-contracts.js";
import type { CheckoutObservation, PaymentProvider, RefundObservation } from "./payment-provider.js";
import { decimalCentavos, type OperationStatus, type PaymentCommand, type PaymentOperationRow, type PaymentRow, type PaymentStore, type PaymentTx } from "./payment-store.js";

export interface PaymentMetadata { operationId: string; requestHash: string }
export interface BillingParticipantIntent {
  id: string; kind: "checkout" | "expire" | "refund" | "complete" | "reassociate";
  appointmentId: string; billingLineageId: string; appointmentVersion: number; associationVersion: number;
  reasonCode?: string; cancelledAt?: Date; scheduledAt: Date; replacementAppointmentId?: string; expectedPaymentVersion?: number;
  completedAt?: Date;
}
export interface BillingAuthority {
  authorizeApproval?(actor:Actor,appointmentId:string):Promise<BillingContext>;
  authorize(actor: Actor, appointmentId: string): Promise<BillingContext>;
  prepare(actor: Actor, appointmentId: string, command: PaymentMetadata): Promise<BillingContext>;
  current(appointmentId: string): Promise<BillingContext>;
  verifyIntent(intentId: string): Promise<BillingContext>;
  assertAdmin(actor: Actor): Promise<void>;
  committedIntent(intentId: string): Promise<BillingParticipantIntent>;
}
export type PaymentV1 = Pick<PaymentRow, "id" | "appointmentId" | "billingLineageId" | "associationVersion" | "version" | "paymentProvider" |
  "providerMode" | "amount" | "currency" | "status" | "checkoutSessionId" | "checkoutUrl" | "paymentIntentId" | "paymongoPaymentId" |
  "refundId" | "refundReason" | "refundEligible" | "paidAt" | "verifiedAt" | "failedAt" | "refundRequestedAt" | "refundedAt" |
  "reviewRequired" | "reviewCode" | "lastReconciledAt">;
export interface PaymentResult { payment: PaymentV1 | null; operationStatus: OperationStatus; operationId?: string }
type AuditType = "checkout_prepared" | "paid" | "status_changed" | "review_requested" | "receipt_linked" | "refund_requested" | "invoice_created";
const safeDate = (date: string | null) => date === null || Number.isFinite(Date.parse(date));
function fail(status: number, code: string): never { throw new DomainError(status, code, "Payment operation could not be completed."); }
const delay = (seconds: number, now: number) => new Date(now + seconds * 1000).toISOString();
const backoffs = [60, 300, 900, 3600];
function operationState(operations: PaymentOperationRow[], fallback: OperationStatus = "completed"): OperationStatus {
  if (operations.some(row => row.status === "unknown")) return "unknown";
  if (operations.some(row => row.status === "pending")) return "pending";
  if (operations.some(row => row.status === "failed")) return "failed";
  return fallback;
}

export function paymentDto(payment: PaymentRow | null, allowCheckout = false): PaymentV1 | null {
  if (!payment) return null;
  const keys = ["id", "appointmentId", "billingLineageId", "associationVersion", "version", "paymentProvider", "providerMode", "amount", "currency",
    "status", "checkoutSessionId", "checkoutUrl", "paymentIntentId", "paymongoPaymentId", "refundId", "refundReason", "refundEligible", "paidAt",
    "verifiedAt", "failedAt", "refundRequestedAt", "refundedAt", "reviewRequired", "reviewCode", "lastReconciledAt"] as const;
  const dto = Object.fromEntries(keys.map(key => [key, payment[key]])) as unknown as PaymentV1;
  if (!allowCheckout || payment.reviewRequired || payment.status !== "pending") dto.checkoutUrl = null;
  return dto;
}
function association(payment: PaymentRow, context: BillingContext) {
  if (payment.appointmentId !== context.appointmentId || payment.billingLineageId !== context.billingLineageId
    || payment.patientAuthId !== context.patientAuthId || payment.doctorAuthId !== context.doctorAuthId
    || payment.associationVersion !== context.associationVersion) fail(409, "PAYMENT_ASSOCIATION_CHANGED");
}
function command(actor: Actor, action: string, metadata: PaymentMetadata, body: unknown = {}): PaymentCommand {
  z.uuid().parse(metadata.operationId);
  z.string().regex(/^[a-f0-9]{64}$/).parse(metadata.requestHash);
  return { actorId: actor.authId, operationId: metadata.operationId, action, resourceId: actor.resource,
    requestHash: requestHash("PAYMENT-COMMAND", action, { role: actor.role, resourceId: actor.resource, body, transportHash: metadata.requestHash }),
    status: "pending", result: null };
}
async function replay(tx: PaymentTx, input: PaymentCommand): Promise<PaymentResult | null> {
  const existing = await tx.command(input.actorId, input.operationId);
  if (!existing) return null;
  if (existing.requestHash !== input.requestHash || existing.action !== input.action || existing.resourceId !== input.resourceId) fail(409, "COMMAND_REPLAY_CONFLICT");
  return existing.status === "completed" ? existing.result as PaymentResult : null;
}
async function saved(tx: PaymentTx, input: PaymentCommand, result: PaymentResult) {
  await tx.saveCommand({ ...input, status: "completed", result });
  return result;
}
export function createPaymentModule(config: {
  store: PaymentStore; billing: BillingAuthority; provider: PaymentProvider; appOrigin: string; enabled: boolean; clock?: () => number;
  association?: AppointmentParticipant;
  acknowledgmentNames?:(patientAuthId:string,doctorAuthId:string)=>Promise<{patientName:string;doctorName:string}>;
}) {
  const { store, billing, provider } = config;
  const now = config.clock ?? Date.now;
  let origin: URL;
  try {
    origin = new URL(config.appOrigin);
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/"
      || !(origin.protocol === "https:" || origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))) throw new Error();
  } catch { throw new Error("PAYMENT_APP_ORIGIN_INVALID"); }
  const active = () => { if (!config.enabled) fail(503, "PAYMENT_OWNER_DISABLED"); };
  const result = (row: PaymentRow | null, status: OperationStatus = "completed", operationId?: string, allowCheckout = false): PaymentResult =>
    ({ payment: paymentDto(row, allowCheckout), operationStatus: status, ...(operationId ? { operationId } : {}) });
  async function patient(actor: Actor, id: string, scope: string) {
    active(); z.uuid().parse(id);
    if (actor.role !== "patient") fail(403, "PAYMENT_ACTOR_DENIED");
    requireScope(actor, scope, id);
    return billing.authorize(actor, id);
  }
  async function effect(tx: PaymentTx, row: PaymentRow, type: AuditType, actor: Actor | null, correlationId: string, firstPaid = false) {
    row.version += 1;
    await tx.savePayment(row);
    const event = { producer: "payment" as const, aggregateId: row.id, aggregateVersion: row.version, correlationId,
      data: { appointmentId: row.appointmentId, paymentId: row.id, paymentVersion: row.version,
        billingLineageId: row.billingLineageId, associationVersion: row.associationVersion, reviewRequired: row.reviewRequired } };
    await tx.emit({ ...event, eventType: "vital.payment.changed", data: { ...event.data, status: row.status } });
    if (firstPaid && row.paidAt) await tx.emit({ ...event, eventType: "vital.payment.completed", data: { ...event.data, paidAt: row.paidAt } });
    await tx.emit({ producer: "payment", eventType: "vital.audit.requested", aggregateId: row.id, aggregateVersion: row.version, correlationId,
      data: { auditType: `vital.payment.${type}`, actorAuthId: actor?.authId ?? null, resourceId: row.id, resourceType: "payment" } });
  }
  function validateCheckout(observed: CheckoutObservation, row: PaymentRow) {
    if (observed.livemode !== false || observed.currency !== "PHP" || observed.amountCentavos !== row.amountCentavos
      || observed.appointmentId !== (row.providerOriginAppointmentId ?? row.appointmentId) || observed.billingLineageId !== row.billingLineageId
      || row.checkoutSessionId && observed.checkoutSessionId !== row.checkoutSessionId
      || row.paymentIntentId && observed.paymentIntentId !== row.paymentIntentId
      || row.paymongoPaymentId && observed.paymentId && observed.paymentId !== row.paymongoPaymentId
      || !safeDate(observed.paidAt) || observed.status === "paid" && (!observed.paidAt || !observed.paymentId)) fail(409, "PAYMENT_PROVIDER_BINDING_INVALID");
  }
  function validateRefund(observed: RefundObservation, row: PaymentRow) {
    if (observed.livemode !== false || observed.currency !== "PHP" || observed.amountCentavos !== row.amountCentavos
      || observed.paymentId !== row.paymongoPaymentId || row.refundId && observed.refundId !== row.refundId) fail(409, "REFUND_PROVIDER_BINDING_INVALID");
  }
  async function contextForOutcome(row: PaymentRow) {
    try { const context = await billing.current(row.appointmentId); association(row, context); return context; }
    catch { return null; }
  }
  function applyCheckout(row: PaymentRow, observation: CheckoutObservation, context: BillingContext | null) {
    validateCheckout(observation, row);
    row.providerOriginAppointmentId ??= row.appointmentId;
    row.checkoutSessionId = observation.checkoutSessionId; row.checkoutUrl = observation.checkoutUrl;
    row.paymentIntentId = observation.paymentIntentId; row.paymongoPaymentId = observation.paymentId ?? row.paymongoPaymentId;
    row.checkoutState = observation.checkoutState;
    const firstPaid = observation.status === "paid" && row.paidAt === null;
    if (observation.status === "paid") {
      row.paidAt ??= observation.paidAt; row.verifiedAt ??= observation.paidAt;
      if (!["refund_pending", "refunded", "refund_failed", "non_refundable"].includes(row.status)) row.status = "paid";
    } else if (row.paidAt === null && !["refund_pending", "refunded", "refund_failed", "non_refundable"].includes(row.status)) {
      row.status = observation.checkoutState === "expired" ? "failed" : "pending";
      if (row.status === "failed") row.failedAt ??= new Date(now()).toISOString();
    }
    if (context && row.reviewCode === "BILLING_CONTEXT_UNAVAILABLE" && (context.payable || context.status === "completed" && row.paidAt)) {
      row.reviewRequired = false; row.reviewCode = null;
    }
    if (!context || firstPaid && context.reviewRequired) {
      row.reviewRequired = true;
      if (!["PROVIDER_OUTCOME_UNKNOWN", "PROVIDER_REQUEST_REJECTED", "RECONCILIATION_EXHAUSTED"].includes(row.reviewCode ?? "")) {
        row.reviewCode = context ? "LATE_PAYMENT" : "BILLING_CONTEXT_UNAVAILABLE";
      }
    }
    return firstPaid;
  }
  function applyRefund(row: PaymentRow, observation: RefundObservation) {
    validateRefund(observation, row);
    row.refundId = observation.refundId;
    if (row.status === "refunded") return;
    if (row.status === "refund_failed" && ["pending", "processing"].includes(observation.status)) return;
    row.status = observation.status === "succeeded" ? "refunded" : observation.status === "failed" ? "refund_failed" : "refund_pending";
    if (row.status === "refunded") row.refundedAt ??= new Date(now()).toISOString();
  }
  const financialHash = (row: PaymentRow) => {
    const state = { ...paymentDto(row, true) }; delete state.lastReconciledAt;
    return requestHash("STATE", row.id, state);
  };
  async function operationOutcome(key: string, lineage: string, owner: string, input: PaymentCommand | null,
    actor: Actor | null, execute: () => Promise<CheckoutObservation | RefundObservation>, correlationId: string) {
    let operation: PaymentOperationRow;
    try {
      operation = await store.transaction(lineage, async tx => {
        const row = await tx.operation(key);
        if (!row || row.status !== "pending" || row.executionStartedAt || row.leaseOwner !== owner
          || !row.leaseUntil || Date.parse(row.leaseUntil) <= now()) fail(409, "PAYMENT_OPERATION_LEASE_LOST");
        row.executionStartedAt = new Date(now()).toISOString(); row.firstAttemptAt ??= row.executionStartedAt; row.attempts += 1;
        await tx.saveOperation(row); return row;
      });
      // The execution marker commits before the provider call. No transaction retries external I/O.
      const observation = await execute();
      const snapshot = await store.byId(operation.paymentId);
      if (!snapshot) fail(409, "PAYMENT_ASSOCIATION_CHANGED");
      const context = await contextForOutcome(snapshot);
      return await store.transaction(lineage, async tx => {
        const row = await tx.paymentById(operation.paymentId); const claimed = await tx.operation(key);
        if (!row || !claimed || claimed.status !== "pending" || claimed.leaseOwner !== owner
          || !claimed.leaseUntil || Date.parse(claimed.leaseUntil) <= now()) fail(409, "PAYMENT_OPERATION_LEASE_LOST");
        const firstPaid = "checkoutSessionId" in observation ? applyCheckout(row, observation, context) : (applyRefund(row, observation), false);
        claimed.status = "completed"; claimed.providerId = "checkoutSessionId" in observation ? observation.checkoutSessionId : observation.refundId;
        claimed.result = { providerId: claimed.providerId }; claimed.error = null; claimed.leaseOwner = null; claimed.leaseUntil = null;
        await tx.saveOperation(claimed);
        row.nextReconcileAt = ["paid", "refunded", "failed", "refund_failed", "non_refundable"].includes(row.status) ? null : delay(60, now());
        await effect(tx, row, firstPaid ? "paid" : operation.operationType === "refund" ? "refund_requested" : "status_changed", actor, correlationId, firstPaid);
        const outcome = result(row, "completed", claimed.id, context?.payable === true);
        return input ? saved(tx, input, outcome) : outcome;
      });
    } catch (error) {
      const definite = typeof error === "object" && error !== null && "definite" in error && error.definite === true;
      return store.transaction(lineage, async tx => {
        const op = await tx.operation(key);
        if (!op) throw error;
        const row = await tx.paymentById(op.paymentId);
        if (!row) throw error;
        // A replacement owner cannot be overwritten by a delayed response from an expired lease.
        if (op.leaseOwner !== owner || op.status !== "pending") return result(row, op.status, op.id);
        op.status = definite ? "failed" : "unknown"; op.error = definite ? "PROVIDER_REQUEST_REJECTED" : "PROVIDER_OUTCOME_UNKNOWN";
        op.leaseOwner = null; op.leaseUntil = null; await tx.saveOperation(op);
        row.reviewRequired = true; row.reviewCode = op.error;
        await effect(tx, row, "review_requested", actor, correlationId);
        const outcome = result(row, op.status, op.id);
        return input ? saved(tx, input, outcome) : outcome;
      });
    }
  }
  async function reconcileRow(snapshot: PaymentRow, correlationId: string, actor: Actor | null = null) {
    const owner = randomUUID();
    const claimed = await store.transaction(snapshot.billingLineageId, async tx => {
      const row = await tx.paymentById(snapshot.id);
      if (!row) return null;
      if (row.reconcileLeaseUntil && Date.parse(row.reconcileLeaseUntil) > now()
        || row.lastReconciledAt && Date.parse(row.lastReconciledAt) + 15_000 > now()
        || row.reconcileFailures > 0 && row.nextReconcileAt && Date.parse(row.nextReconcileAt) > now()) return null;
      if (!row.checkoutSessionId && !row.refundId) return null;
      row.reconcileLeaseOwner = owner; row.reconcileLeaseUntil = delay(60, now()); await tx.savePayment(row); return row;
    });
    if (!claimed) {
      const row = await store.byId(snapshot.id); const context = row ? await contextForOutcome(row) : null;
      return result(row, operationState(await store.operationsForPayment(snapshot.id), row?.reconcileFailures ? "unknown" : "pending"), undefined, context?.payable === true);
    }
    try {
      const observation = claimed.refundId ? await provider.retrieveRefund(claimed.refundId) : await provider.retrieveCheckout(claimed.checkoutSessionId!);
      const context = await contextForOutcome(claimed);
      return await store.transaction(claimed.billingLineageId, async tx => {
        const row = await tx.paymentById(claimed.id);
        if (!row || row.reconcileLeaseOwner !== owner || !row.reconcileLeaseUntil || Date.parse(row.reconcileLeaseUntil) <= now()) fail(409, "PAYMENT_RECONCILE_LEASE_LOST");
        const before = financialHash(row);
        const firstPaid = "checkoutSessionId" in observation ? applyCheckout(row, observation, context) : (applyRefund(row, observation), false);
        row.lastReconciledAt = new Date(now()).toISOString(); row.reconcileFailures = 0;
        row.nextReconcileAt = ["paid", "refunded", "failed", "refund_failed", "non_refundable"].includes(row.status) ? null : delay(60, now());
        row.reconcileLeaseOwner = null; row.reconcileLeaseUntil = null;
        // Observation timestamps are not a new financial transition.
        const after = { ...row, lastReconciledAt: claimed.lastReconciledAt };
        if (before !== financialHash(after)) await effect(tx, row, firstPaid ? "paid" : "status_changed", actor, correlationId, firstPaid);
        else await tx.savePayment(row);
        return result(row, operationState(await tx.operationsForPayment(row.id)), undefined, context?.payable === true);
      });
    } catch (error) {
      await store.transaction(claimed.billingLineageId, async tx => {
        const row = await tx.paymentById(claimed.id);
        if (!row || row.reconcileLeaseOwner !== owner) return;
        row.reconcileFailures += 1; row.lastReconciledAt = new Date(now()).toISOString();
        const retryAfter = typeof error === "object" && error !== null && "retryAfterSeconds" in error ? Number(error.retryAfterSeconds) : 0;
        const seconds = Math.max(backoffs[Math.min(row.reconcileFailures - 1, 3)]!, Number.isFinite(retryAfter) ? retryAfter : 0);
        row.nextReconcileAt = row.reconcileFailures >= 10 ? null : delay(seconds, now());
        row.reconcileLeaseOwner = null; row.reconcileLeaseUntil = null;
        if (row.reconcileFailures >= 10 && row.reviewCode !== "RECONCILIATION_EXHAUSTED") {
          row.reviewRequired = true; row.reviewCode = "RECONCILIATION_EXHAUSTED"; await effect(tx, row, "review_requested", actor, correlationId);
        } else await tx.savePayment(row);
      });
      return result(await store.byId(claimed.id), "unknown");
    }
  }
  async function admin(actor: Actor, scope: string, resource: string) {
    active(); if (actor.role !== "admin") fail(403, "PAYMENT_ACTOR_DENIED"); requireScope(actor, scope, resource); await billing.assertAdmin(actor);
  }
  return {
    async verifyAppointmentPaid(row:{id:string;patientAuthId:string;doctorAuthId:string;billingLineageId:string;associationVersion:number},projection:{paymentId:string;sourceVersion:number}) {
      active(); const payment=await store.byId(projection.paymentId);
      if(!payment||payment.providerMode!=="sandbox"||payment.appointmentId!==row.id||payment.patientAuthId!==row.patientAuthId||payment.doctorAuthId!==row.doctorAuthId
        ||payment.billingLineageId!==row.billingLineageId||payment.associationVersion!==row.associationVersion||payment.version!==projection.sourceVersion||payment.status!=="paid"||payment.reviewRequired||!payment.paidAt)fail(409,"PAYMENT_AUTHORIZATION_STALE");
    },
    async prepareReassociation(operationId: string) { active(); if (!config.association) fail(503,"APPOINTMENT_PARTICIPANT_GATED"); return config.association.prepare(operationId); },
    async abortReassociation(operationId: string, token?: string) { active(); if (!config.association) fail(503,"APPOINTMENT_PARTICIPANT_GATED"); return config.association.abort(operationId,token); },
    async finalizeReassociation(operationId: string, token: string) { active(); if (!config.association) fail(503,"APPOINTMENT_PARTICIPANT_GATED"); return config.association.finalize(operationId,token); },
    async read(actor: Actor, id: string) {
      const context = await patient(actor, id, "payments.read");
      const row = await store.byAppointment(id); if (row) association(row, context);
      return result(row, row ? operationState(await store.operationsForPayment(row.id)) : "completed", undefined, context.payable);
    },
    async approvalCheckout(actor:Actor,id:string,metadata:PaymentMetadata){active();requireScope(actor,"payments.approval.checkout",id);if(actor.role!=="doctor")fail(403,"PAYMENT_ACTOR_DENIED");return this.checkout(actor,id,metadata,true);},
    async checkout(actor: Actor, id: string, metadata: PaymentMetadata, approval=false) {
      active();if(approval&&!billing.authorizeApproval)fail(503,"BILLING_APPROVAL_OWNER_UNAVAILABLE");
      const context = approval?await billing.authorizeApproval!(actor,id):await patient(actor, id, "payments.checkout");
      if (!context.payable) fail(409, "APPOINTMENT_NOT_PAYABLE");
      const intent = await billing.prepare(actor, id, metadata);
      if (!intent.intentId) fail(503, "BILLING_INTENT_REQUIRED");
      const authorizationIntentId = intent.intentId;
      const input = command(actor, "checkout", metadata); const owner = randomUUID();
      const key = `checkout:${intent.billingLineageId}`;
      const claim = await store.transaction(intent.billingLineageId, async tx => {
        const previous = await replay(tx, input); if (previous) return { result: previous };
        await tx.saveCommand(input);
        let row = await tx.paymentByLineage(intent.billingLineageId);
        if (row) association(row, intent);
        else {
          row = { id: randomUUID(), appointmentId: id, billingLineageId: intent.billingLineageId, associationVersion: intent.associationVersion,
            appointmentVersion: intent.appointmentVersion, patientAuthId: intent.patientAuthId, doctorAuthId: intent.doctorAuthId,
            amountCentavos: intent.amountCentavos, amount: decimalCentavos(intent.amountCentavos), currency: "PHP", paymentProvider: "paymongo",
            providerMode: "sandbox", version: 0, status: "pending", checkoutSessionId: null, checkoutUrl: null, paymentIntentId: null,
            paymongoPaymentId: null, checkoutState: null, refundId: null, refundReason: null, refundEligible: null, paidAt: null,
            verifiedAt: null, failedAt: null, refundRequestedAt: null, refundedAt: null, reviewRequired: false, reviewCode: null,
            nextReconcileAt: null, lastReconciledAt: null, reconcileFailures: 0, reconcileLeaseOwner: null, reconcileLeaseUntil: null };
          await tx.insertPayment(row); await effect(tx, row, "checkout_prepared", actor, actor.correlationId);
        }
        const existing = await tx.operation(key);
        const expiredPreparation = existing?.status === "pending" && !existing.executionStartedAt && existing.leaseUntil && Date.parse(existing.leaseUntil) <= now();
        const rejectedPreparation = existing?.status === "failed" && !existing.executionStartedAt && existing.error === "BILLING_AUTHORIZATION_STALE";
        if (existing && !expiredPreparation && !rejectedPreparation) {
          return { result: await saved(tx, input, result(row, existing.status, existing.id, intent.payable)) };
        }
        const op: PaymentOperationRow = existing ?? { id: randomUUID(), operationKey: key, operationType: "checkout", paymentId: row.id,
          requestHash: requestHash("PROVIDER", key, { amountCentavos: row.amountCentavos, currency: row.currency, appointmentId: id }), status: "pending",
          providerId: null, result: null, error: null, actorAuthId: actor.authId, authorizationIntentId, executionStartedAt: null,
          firstAttemptAt: null, leaseOwner: owner, leaseUntil: delay(60, now()), attempts: 0, requestBody: null, correlationId: actor.correlationId };
        op.status = "pending"; op.error = null; op.leaseOwner = owner; op.leaseUntil = delay(60, now()); op.authorizationIntentId = authorizationIntentId;
        if (existing) await tx.saveOperation(op); else await tx.insertOperation(op);
        return { row, op };
      });
      if ("result" in claim && claim.result) return claim.result;
      const row = claim.row!; const op = claim.op!;
      try { const fresh = await billing.verifyIntent(authorizationIntentId); association(row, fresh); if (!fresh.payable) fail(409, "BILLING_AUTHORIZATION_STALE"); }
      catch (error) {
        return store.transaction(intent.billingLineageId, async tx => {
          const found = await tx.operation(key); const payment = await tx.paymentById(row.id);
          if (!found || !payment || found.leaseOwner !== owner) fail(409, "PAYMENT_OPERATION_LEASE_LOST");
          const denied = error instanceof DomainError && [400, 403, 404, 409].includes(error.status);
          found.status = denied ? "failed" : "pending";
          found.error = denied ? "BILLING_AUTHORIZATION_STALE" : "BILLING_PREPARATION_UNAVAILABLE";
          found.leaseOwner = null; found.leaseUntil = denied ? null : new Date(0).toISOString(); await tx.saveOperation(found);
          const outcome = result(payment, found.status, found.id);
          if (denied) return saved(tx, input, outcome);
          await tx.saveCommand({ ...input, status: "pending", result: null }); return outcome;
        });
      }
      return operationOutcome(key, intent.billingLineageId, owner, input, actor, () => provider.createCheckout({ operationId: op.id,
        appointmentId: id, billingLineageId: row.billingLineageId, amountCentavos: row.amountCentavos, currency: "PHP",
        successUrl: `${origin.origin}/payment/paymongo/return?appointment=${id}&payment=success`,
        cancelUrl: `${origin.origin}/payment/paymongo/return?appointment=${id}&payment=cancelled` }), actor.correlationId);
    },
    async reconcile(actor: Actor, id: string, metadata: PaymentMetadata) {
      const context = await patient(actor, id, "payments.reconcile");
      const input = command(actor, "reconcile", metadata); const row = await store.byAppointment(id);
      if (!row) fail(404, "PAYMENT_NOT_FOUND"); association(row, context);
      const previous = await store.transaction(row.billingLineageId, async tx => { const old = await replay(tx, input); if (!old) await tx.saveCommand(input); return old; });
      if (previous) return previous;
      const outcome = await reconcileRow(row, actor.correlationId, actor);
      return store.transaction(row.billingLineageId, async tx => {
        if (["pending", "unknown"].includes(outcome.operationStatus)) {
          await tx.saveCommand({ ...input, status: "pending", result: null }); return outcome;
        }
        return saved(tx, input, outcome);
      });
    },
    async workerTick() {
      active();
      for (const expired of await store.expiredOperations(new Date(now()).toISOString(), 20)) {
        const snapshot = await store.byId(expired.paymentId); if (!snapshot) continue;
        await store.transaction(snapshot.billingLineageId, async tx => {
          const op = await tx.operation(expired.operationKey); const row = await tx.paymentById(snapshot.id);
          if (!op || !row || op.status !== "pending" || !op.leaseUntil || Date.parse(op.leaseUntil) > now() || !op.executionStartedAt) return;
          op.status = "unknown"; op.error = "PROVIDER_OUTCOME_UNKNOWN"; op.leaseOwner = null; op.leaseUntil = null; await tx.saveOperation(op);
          row.reviewRequired = true; row.reviewCode = op.error; await effect(tx, row, "review_requested", null, op.correlationId);
        });
      }
      const due = await store.due(new Date(now()).toISOString(), 20); let index = 0;
      const run = async () => { while (index < due.length) { const row = due[index++]!; await reconcileRow(row, randomUUID()); } };
      await Promise.all([run(), run()]); return due.length;
    },
    async reviews(actor: Actor) {
      await admin(actor, "payments.review.read", actor.authId);
      return { items: (await store.reviews(100)).map(row => paymentDto(row)), limit: 100 };
    },
    async reviewDetail(actor: Actor, paymentId: string) {
      await admin(actor, "payments.review.read", paymentId);
      const payment = await store.byId(paymentId); if (!payment) fail(404, "PAYMENT_NOT_FOUND");
      const operations = await store.operationsForPayment(paymentId);
      return { payment: paymentDto(payment), operations: operations.map(op => ({ id: op.id, operationType: op.operationType, status: op.status,
        providerId: op.providerId, errorCode: op.error, executionStartedAt: op.executionStartedAt, leaseUntil: op.leaseUntil })) };
    },
    async linkReceipt(actor: Actor, paymentId: string, metadata: PaymentMetadata, body: { kind: "checkout" | "refund"; providerId: string; expectedVersion: number }) {
      await admin(actor, "payments.review.write", paymentId);
      const snapshot = await store.byId(paymentId); if (!snapshot) fail(404, "PAYMENT_NOT_FOUND");
      const input = command(actor, "receipt-link", metadata, body);
      const previous = await store.transaction(snapshot.billingLineageId, tx => replay(tx, input)); if (previous) return previous;
      if (!snapshot.reviewRequired || snapshot.version !== body.expectedVersion) fail(409, "PAYMENT_REVIEW_VERSION_CHANGED");
      const observation = body.kind === "checkout" ? await provider.retrieveCheckout(body.providerId) : await provider.retrieveRefund(body.providerId);
      const context = await contextForOutcome(snapshot); await billing.assertAdmin(actor);
      return store.transaction(snapshot.billingLineageId, async tx => {
        const old = await replay(tx, input); if (old) return old;
        const row = await tx.paymentById(paymentId); if (!row || row.version !== body.expectedVersion) fail(409, "PAYMENT_REVIEW_VERSION_CHANGED");
        const key = body.kind === "checkout" ? `checkout:${row.billingLineageId}` : `refund:${row.billingLineageId}:${row.paymongoPaymentId}`;
        const op = await tx.operation(key);
        const exhaustedRead = row.reviewCode === "RECONCILIATION_EXHAUSTED" && op?.status === "completed" && op.providerId === body.providerId;
        if (!op || op.status !== "unknown" && !exhaustedRead || op.providerId && op.providerId !== body.providerId) fail(409, "PAYMENT_RECEIPT_NOT_RECOVERABLE");
        if ("checkoutSessionId" in observation && observation.checkoutSessionId !== body.providerId || "refundId" in observation && observation.refundId !== body.providerId) fail(409, "PAYMENT_PROVIDER_BINDING_INVALID");
        row.reviewRequired = false; row.reviewCode = null;
        const firstPaid = "checkoutSessionId" in observation ? applyCheckout(row, observation, context) : (applyRefund(row, observation), false);
        op.status = "completed"; op.providerId = body.providerId; op.result = { providerId: body.providerId }; op.error = null;
        await tx.saveOperation(op);
        if ((await tx.operationsForPayment(row.id)).some(operation => operation.status === "unknown")) {
          row.reviewRequired = true; row.reviewCode = "PROVIDER_OUTCOME_UNKNOWN";
        }
        row.reconcileFailures = 0; row.lastReconciledAt = new Date(now()).toISOString();
        row.reconcileLeaseOwner = null; row.reconcileLeaseUntil = null;
        row.nextReconcileAt = ["paid", "refunded", "failed", "refund_failed", "non_refundable"].includes(row.status) ? null : delay(60, now());
        await effect(tx, row, "receipt_linked", actor, actor.correlationId, firstPaid);
        return saved(tx, input, result(row, "completed", op.id));
      });
    },
    async reviewRefund(actor: Actor, paymentId: string, metadata: PaymentMetadata, body: { expectedVersion: number }) {
      await admin(actor, "payments.review.write", paymentId);
      const snapshot = await store.byId(paymentId); if (!snapshot) fail(404, "PAYMENT_NOT_FOUND");
      const input = command(actor, "review-refund", metadata, body); const owner = randomUUID();
      const claim = await store.transaction(snapshot.billingLineageId, async tx => {
        const old = await replay(tx, input); if (old) return { result: old };
        const row = await tx.paymentById(paymentId); if (!row || row.version !== body.expectedVersion || !row.reviewRequired) fail(409, "PAYMENT_REVIEW_VERSION_CHANGED");
        if (row.status !== "paid" || !row.paymongoPaymentId || row.refundId || row.reviewCode === "PROVIDER_OUTCOME_UNKNOWN") fail(409, "PAYMENT_REFUND_NOT_ELIGIBLE");
        const key = `refund:${row.billingLineageId}:${row.paymongoPaymentId}`; const existing = await tx.operation(key);
        const recoverable = existing?.status === "pending" && !existing.executionStartedAt && existing.leaseUntil && Date.parse(existing.leaseUntil) <= now();
        if (existing && !recoverable) return { result: await saved(tx, input, result(row, existing.status, existing.id)) };
        const op: PaymentOperationRow = existing ?? { id: randomUUID(), operationKey: key, operationType: "refund", paymentId, requestHash: requestHash("PROVIDER", key, { amountCentavos: row.amountCentavos }),
          status: "pending", providerId: null, result: null, error: null, actorAuthId: actor.authId, authorizationIntentId: null,
          executionStartedAt: null, firstAttemptAt: null, leaseOwner: owner, leaseUntil: delay(60, now()), attempts: 0, requestBody: null, correlationId: actor.correlationId };
        op.leaseOwner = owner; op.leaseUntil = delay(60, now()); op.actorAuthId = actor.authId;
        await tx.saveCommand(input); if (existing) await tx.saveOperation(op); else await tx.insertOperation(op);
        row.refundReason = "reviewed_late_payment"; row.refundEligible = true; row.refundRequestedAt = new Date(now()).toISOString();
        await effect(tx, row, "refund_requested", actor, actor.correlationId); return { row, op, key };
      });
      if (claim.result) return claim.result;
      await billing.assertAdmin(actor);
      return operationOutcome(claim.key!, snapshot.billingLineageId, owner, input, actor, () => provider.createRefund({
        operationId: claim.op!.id, paymentId: claim.row!.paymongoPaymentId!, amountCentavos: claim.row!.amountCentavos, currency: "PHP", reason: "others" }), actor.correlationId);
    },
    async completeInvoice(intentId: string, correlationId: string) {
      active(); const intent = await billing.committedIntent(intentId);
      if (intent.kind !== "complete") fail(409, "BILLING_INTENT_KIND_INVALID");
      const context = await billing.current(intent.appointmentId);
      if (context.status !== "completed" || context.reviewRequired || context.appointmentVersion !== intent.appointmentVersion) fail(409, "BILLING_AUTHORIZATION_STALE");
      if (!intent.completedAt || !Number.isFinite(intent.completedAt.getTime())) fail(409, "BILLING_COMPLETION_RECEIPT_REQUIRED");
      const names=await config.acknowledgmentNames?.(context.patientAuthId,context.doctorAuthId);
      return store.transaction(intent.billingLineageId, async tx => {
        const row = await tx.paymentByLineage(intent.billingLineageId);
        if (!row || row.status !== "paid" || row.reviewRequired || row.associationVersion !== intent.associationVersion) fail(409, "PAYMENT_INVOICE_NOT_ELIGIBLE");
        association(row, context);
        const inserted = await tx.insertInvoice(row, intent.id, intent.completedAt!.toISOString(),names?{
          ...names,reference:'VITAL-ACK-'+row.id.toUpperCase(),appointmentId:row.appointmentId,paymentReference:row.paymongoPaymentId??row.paymentIntentId??row.id,
          paymentMethod:row.paymentProvider,amountCentavos:row.amountCentavos,paidAt:row.paidAt!,completedAt:intent.completedAt!.toISOString(),issuedAt:intent.completedAt!.toISOString(),sandbox:row.providerMode==='sandbox',service:'Consultation',templateVersion:'bgh-capstone-v1'
        }:undefined);
        if (inserted && intent.expectedPaymentVersion !== undefined && row.version !== intent.expectedPaymentVersion) fail(409, "PAYMENT_VERSION_CHANGED");
        if (inserted) await effect(tx, row, "invoice_created", null, correlationId); return inserted;
      });
    },
    async applyAppointmentIntent(intentId: string, correlationId: string) {
      active(); z.uuid().parse(correlationId);
      const intent = await billing.committedIntent(intentId);
      if (!["expire", "refund"].includes(intent.kind)) fail(409, "BILLING_INTENT_KIND_INVALID");
      const context = await billing.current(intent.appointmentId);
      if (context.appointmentVersion !== intent.appointmentVersion || context.associationVersion !== intent.associationVersion
        || context.billingLineageId !== intent.billingLineageId || !(intent.kind==='expire'&&!context.payable || ["cancelled", "rejected", "expired"].includes(context.status))) fail(409, "BILLING_AUTHORIZATION_STALE");
      const snapshot = await store.byAppointment(intent.appointmentId);
      if (!snapshot) return result(null);
      association(snapshot, context);
      const owner = randomUUID();
      const claim = await store.transaction(intent.billingLineageId, async tx => {
        const row = await tx.paymentById(snapshot.id); if (!row) fail(404, "PAYMENT_NOT_FOUND");
        if (intent.expectedPaymentVersion !== undefined && row.version !== intent.expectedPaymentVersion) fail(409, "PAYMENT_VERSION_CHANGED");
        const refund = intent.kind === "refund";
        if (refund && row.status !== "paid" || !refund && (!row.checkoutSessionId || row.paidAt)) return { result: result(row) };
        if (refund) {
          if (!["doctor_cancelled", "patient_cancelled_before_24h", "patient_cancelled_within_24h"].includes(intent.reasonCode ?? "")
            || !intent.cancelledAt || !Number.isFinite(intent.cancelledAt.getTime())) fail(409, "BILLING_CANCELLATION_RECEIPT_REQUIRED");
          const eligible = intent.reasonCode === "doctor_cancelled" || intent.reasonCode === "patient_cancelled_before_24h"
            && intent.cancelledAt !== undefined && intent.scheduledAt.getTime() - intent.cancelledAt.getTime() >= 86_400_000;
          if (!eligible) {
            row.status = "non_refundable"; row.refundEligible = false;
            row.refundReason = "patient_cancelled_within_24h"; row.nextReconcileAt = null;
            await effect(tx, row, "status_changed", null, correlationId); return { result: result(row) };
          }
          if (!row.paymongoPaymentId || row.refundId || row.reviewRequired) fail(409, "PAYMENT_REFUND_NOT_ELIGIBLE");
        }
        const key = refund ? `refund:${row.billingLineageId}:${row.paymongoPaymentId}` : `expire:${row.billingLineageId}:${row.checkoutSessionId}`;
        const existing = await tx.operation(key);
        const recoverable = existing?.status === "pending" && !existing.executionStartedAt && existing.leaseUntil && Date.parse(existing.leaseUntil) <= now();
        if (existing && !recoverable) return { result: result(row, existing.status, existing.id) };
        const op: PaymentOperationRow = existing ?? { id: randomUUID(), operationKey: key, operationType: refund ? "refund" : "expire", paymentId: row.id,
          requestHash: requestHash("PROVIDER", key, { amountCentavos: row.amountCentavos, intentId }), status: "pending", providerId: null,
          result: null, error: null, actorAuthId: null, authorizationIntentId: intent.id, executionStartedAt: null, firstAttemptAt: null,
          leaseOwner: owner, leaseUntil: delay(60, now()), attempts: 0, requestBody: null, correlationId };
        op.leaseOwner = owner; op.leaseUntil = delay(60, now()); op.authorizationIntentId = intent.id;
        if (existing) await tx.saveOperation(op); else await tx.insertOperation(op);
        if (refund) {
          row.refundReason = intent.reasonCode ?? "doctor_cancelled"; row.refundEligible = true;
          row.refundRequestedAt = new Date(now()).toISOString(); await effect(tx, row, "refund_requested", null, correlationId);
        }
        return { key, row, op };
      });
      if (claim.result) return claim.result;
      // Recheck the committed owner intent immediately before crossing the provider boundary.
      await billing.committedIntent(intentId);
      return operationOutcome(claim.key!, snapshot.billingLineageId, owner, null, null, async () => {
        if (intent.kind === "refund") return provider.createRefund({ operationId: claim.op!.id, paymentId: claim.row!.paymongoPaymentId!,
          amountCentavos: claim.row!.amountCentavos, currency: "PHP", reason: "others" });
        try { return await provider.expireCheckout(claim.row!.checkoutSessionId!); }
        catch {
          const observed = await provider.retrieveCheckout(claim.row!.checkoutSessionId!);
          if (observed.status !== "paid" && observed.checkoutState !== "expired") throw new Error("CHECKOUT_EXPIRY_UNVERIFIED");
          return observed;
        }
      }, correlationId);
    },
  };
}
