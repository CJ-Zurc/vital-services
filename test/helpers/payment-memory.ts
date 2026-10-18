import { DomainError } from "../../src/eda/contracts/actor.js";
import { makeEvent, type OutboxInput } from "../../src/eda/infrastructure/outbox.js";
import type { PaymentCommand, PaymentOperationRow, PaymentRow, PaymentStore, PaymentTx } from "../../src/eda/modules/payment/payment-store.js";

export class MemoryPaymentStore implements PaymentStore {
  payments = new Map<string, PaymentRow>();
  operations = new Map<string, PaymentOperationRow>();
  commands = new Map<string, PaymentCommand>();
  invoices = new Map<string, { intentId: string; completedAt: string }>();
  events: OutboxInput[] = [];
  failNextEmit = false;
  failCommitOnce = false;
  private tail: Promise<void> = Promise.resolve();
  async transaction<T>(_lineage: string, run: (tx: PaymentTx) => Promise<T>): Promise<T> {
    const prior = this.tail;
    let unlock!: () => void;
    this.tail = new Promise<void>(resolve => { unlock = resolve; });
    await prior;
    const previous = structuredClone({ payments: this.payments, operations: this.operations, commands: this.commands, invoices: this.invoices, events: this.events });
    const one = <T>(value: T | undefined) => value ? structuredClone(value) : null;
    const tx: PaymentTx = {
      paymentByLineage: async lineage => one([...this.payments.values()].find(row => row.billingLineageId === lineage)),
      paymentById: async id => one(this.payments.get(id)),
      insertPayment: async row => { if ([...this.payments.values()].some(old => old.billingLineageId === row.billingLineageId)) throw new Error("UNIQUE_LINEAGE"); this.payments.set(row.id, structuredClone(row)); },
      savePayment: async row => { this.payments.set(row.id, structuredClone(row)); },
      operation: async key => one(this.operations.get(key)),
      operationsForPayment: async id => structuredClone([...this.operations.values()].filter(row => row.paymentId === id)),
      insertOperation: async row => { if (this.operations.has(row.operationKey)) throw new Error("UNIQUE_OPERATION"); this.operations.set(row.operationKey, structuredClone(row)); },
      saveOperation: async row => { this.operations.set(row.operationKey, structuredClone(row)); },
      command: async (actor, id) => one(this.commands.get(`${actor}:${id}`)),
      saveCommand: async row => {
        const key = `${row.actorId}:${row.operationId}`;
        const old = this.commands.get(key);
        if (old && (old.action !== row.action || old.resourceId !== row.resourceId || old.requestHash !== row.requestHash)) throw new DomainError(409, "COMMAND_REPLAY_CONFLICT", "Conflict.");
        this.commands.set(key, structuredClone(row));
      },
      emit: async event => { if (this.failNextEmit) { this.failNextEmit = false; throw new Error("OUTBOX_FAILED"); } makeEvent(event); this.events.push(structuredClone(event)); },
      insertInvoice: async (payment, intentId, completedAt) => {
        if (this.invoices.has(payment.id)) return false;
        this.invoices.set(payment.id, { intentId, completedAt }); return true;
      },
    };
    try {
      const result = await run(tx);
      if (this.failCommitOnce) { this.failCommitOnce = false; throw new Error("COMMIT_FAILED"); }
      return result;
    } catch (error) {
      this.payments = previous.payments; this.operations = previous.operations; this.commands = previous.commands;
      this.invoices = previous.invoices; this.events = previous.events; throw error;
    } finally { unlock(); }
  }
  async byAppointment(id: string) { return structuredClone([...this.payments.values()].find(row => row.appointmentId === id) ?? null); }
  async byId(id: string) { return structuredClone(this.payments.get(id) ?? null); }
  async due(now: string, limit: number) {
    return structuredClone([...this.payments.values()].filter(row => (row.checkoutSessionId || row.refundId)
      && row.nextReconcileAt && row.nextReconcileAt <= now && (!row.reconcileLeaseUntil || row.reconcileLeaseUntil <= now)).slice(0, limit));
  }
  async expiredOperations(now: string, limit: number) { return structuredClone([...this.operations.values()].filter(row => row.status === "pending" && row.executionStartedAt && row.leaseUntil && row.leaseUntil <= now).slice(0, limit)); }
  async reviews(limit: number) { return structuredClone([...this.payments.values()].filter(row => row.reviewRequired).slice(0, limit)); }
  async operationsForPayment(id: string) { return structuredClone([...this.operations.values()].filter(row => row.paymentId === id)); }
}
