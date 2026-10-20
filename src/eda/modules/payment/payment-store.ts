import type { AcknowledgmentPdf } from '../records/bgh-pdf.js';
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { DomainError } from "../../contracts/actor.js";
import { appendSqlOutbox, type OutboxInput } from "../../infrastructure/outbox.js";

export type PaymentStatus = "unpaid" | "pending" | "paid" | "failed" | "refund_pending" | "refunded" | "refund_failed" | "non_refundable";
export type OperationStatus = "pending" | "completed" | "failed" | "unknown";
export interface PaymentRow {
  providerOriginAppointmentId?: string | null;
  id: string; appointmentId: string; billingLineageId: string; associationVersion: number; appointmentVersion: number;
  patientAuthId: string; doctorAuthId: string; amountCentavos: number; amount: string; currency: "PHP";
  paymentProvider: "paymongo"; providerMode: "sandbox"; version: number; status: PaymentStatus;
  checkoutSessionId: string | null; checkoutUrl: string | null; paymentIntentId: string | null; paymongoPaymentId: string | null;
  checkoutState: string | null; refundId: string | null; refundReason: string | null; refundEligible: boolean | null;
  paidAt: string | null; verifiedAt: string | null; failedAt: string | null; refundRequestedAt: string | null; refundedAt: string | null;
  reviewRequired: boolean; reviewCode: string | null; nextReconcileAt: string | null; lastReconciledAt: string | null;
  reconcileFailures: number; reconcileLeaseOwner: string | null; reconcileLeaseUntil: string | null;
}
export interface PaymentOperationRow {
  id: string; operationKey: string; operationType: "checkout" | "refund" | "expire"; paymentId: string; requestHash: string;
  status: OperationStatus; providerId: string | null; result: unknown; error: string | null; actorAuthId: string | null;
  authorizationIntentId: string | null; executionStartedAt: string | null; firstAttemptAt: string | null;
  leaseOwner: string | null; leaseUntil: string | null; attempts: number; requestBody: Record<string, unknown> | null;
  correlationId: string;
}
export interface PaymentCommand {
  actorId: string; operationId: string; action: string; resourceId: string; requestHash: string;
  status: string; result: unknown;
}
export interface PaymentTx {
  paymentByLineage(id: string): Promise<PaymentRow | null>;
  paymentById(id: string): Promise<PaymentRow | null>;
  insertPayment(row: PaymentRow): Promise<void>;
  savePayment(row: PaymentRow): Promise<void>;
  operation(key: string): Promise<PaymentOperationRow | null>;
  operationsForPayment(id: string): Promise<PaymentOperationRow[]>;
  insertOperation(row: PaymentOperationRow): Promise<void>;
  saveOperation(row: PaymentOperationRow): Promise<void>;
  command(actorId: string, id: string): Promise<PaymentCommand | null>;
  saveCommand(row: PaymentCommand): Promise<void>;
  emit(input: OutboxInput): Promise<void>;
  insertInvoice(payment: PaymentRow, intentId: string, completedAt: string, snapshot?: AcknowledgmentPdf): Promise<boolean>;
}
export interface PaymentStore {
  transaction<T>(lineage: string, execute: (tx: PaymentTx) => Promise<T>): Promise<T>;
  byAppointment(id: string): Promise<PaymentRow | null>;
  byId(id: string): Promise<PaymentRow | null>;
  due(now: string, limit: number): Promise<PaymentRow[]>;
  expiredOperations(now: string, limit: number): Promise<PaymentOperationRow[]>;
  reviews(limit: number): Promise<PaymentRow[]>;
  operationsForPayment(id: string): Promise<PaymentOperationRow[]>;
}

export function decimalCentavos(amount: number): string {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new DomainError(400, "PAYMENT_AMOUNT_INVALID", "Invalid consultation fee.");
  return `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`;
}
function normalize<T>(raw: Record<string, unknown> | undefined): T | null {
  if (!raw) return null;
  const row = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]));
  if (row.amountCentavos !== undefined && row.amountCentavos !== null) {
    row.amountCentavos = Number(row.amountCentavos);
    if (!Number.isSafeInteger(row.amountCentavos) || Number(row.amountCentavos) <= 0) throw new Error("PAYMENT_STORED_AMOUNT_INVALID");
  }
  return row as T;
}
const paymentColumns = ["appointmentId", "billingLineageId", "associationVersion", "appointmentVersion", "patientAuthId", "doctorAuthId",
  "providerOriginAppointmentId",
  "amountCentavos", "amount", "currency", "paymentProvider", "providerMode", "version", "status", "checkoutSessionId", "checkoutUrl",
  "paymentIntentId", "paymongoPaymentId", "checkoutState", "refundId", "refundReason", "refundEligible", "paidAt", "verifiedAt", "failedAt",
  "refundRequestedAt", "refundedAt", "reviewRequired", "reviewCode", "nextReconcileAt", "lastReconciledAt", "reconcileFailures",
  "reconcileLeaseOwner", "reconcileLeaseUntil"] as const;
const operationColumns = ["operationKey", "operationType", "paymentId", "requestHash", "status", "providerId", "result", "error", "actorAuthId",
  "authorizationIntentId", "executionStartedAt", "firstAttemptAt", "leaseOwner", "leaseUntil", "attempts", "requestBody", "correlationId"] as const;
const writeTables = Object.freeze({ payments: paymentColumns, payment_operations: operationColumns });
type WriteTable = keyof typeof writeTables;
function writeColumns(table: WriteTable) {
  if (!Object.hasOwn(writeTables, table)) throw new Error('PAYMENT_SQL_IDENTIFIER_DENIED');
  return writeTables[table];
}
const sqlValue = (name: string, value: unknown) => ["result", "requestBody"].includes(name) && value !== null ? JSON.stringify(value) : value;

function postgresTx(client: PoolClient): PaymentTx {
  async function one<T>(sql: string, values: unknown[]) {
    const result = await client.query(sql, values);
    return normalize<T>(result.rows[0]);
  }
  async function insert(table: WriteTable, id: string, row: Record<string, unknown>) {
    const columns = writeColumns(table);
    await client.query(`INSERT INTO ${table} (id,${columns.map(key => `"${key}"`).join(",")},"createdAt","updatedAt")
      VALUES ($1,${columns.map((_, index) => `$${index + 2}`).join(",")},NOW(),NOW())`,
    [id, ...columns.map(key => sqlValue(key, row[key]))]);
  }
  async function update(table: WriteTable, id: string, row: Record<string, unknown>) {
    const columns = writeColumns(table);
    const result = await client.query(`UPDATE ${table} SET ${columns.map((key, index) => `"${key}"=$${index + 2}`).join(",")},"updatedAt"=NOW() WHERE id=$1`,
      [id, ...columns.map(key => sqlValue(key, row[key]))]);
    if (result.rowCount !== 1) throw new Error("PAYMENT_ROW_LOST");
  }
  return {
    paymentByLineage: id => one<PaymentRow>(`SELECT * FROM payments WHERE "billingLineageId"=$1 FOR UPDATE`, [id]),
    paymentById: id => one<PaymentRow>(`SELECT * FROM payments WHERE id=$1 FOR UPDATE`, [id]),
    insertPayment: row => insert("payments", row.id, row as unknown as Record<string, unknown>),
    savePayment: row => update("payments", row.id, row as unknown as Record<string, unknown>),
    operation: key => one<PaymentOperationRow>(`SELECT * FROM payment_operations WHERE "operationKey"=$1 FOR UPDATE`, [key]),
    async operationsForPayment(id) {
      const result = await client.query('SELECT * FROM payment_operations WHERE "paymentId"=$1 LIMIT 100', [id]);
      return result.rows.map(row => normalize<PaymentOperationRow>(row)!);
    },
    insertOperation: row => insert("payment_operations", row.id, row as unknown as Record<string, unknown>),
    saveOperation: row => update("payment_operations", row.id, row as unknown as Record<string, unknown>),
    command: (actor, id) => one<PaymentCommand>(`SELECT * FROM command_operations WHERE "actorId"=$1 AND "operationId"=$2 FOR UPDATE`, [actor, id]),
    async saveCommand(row) {
      const result = await client.query(`INSERT INTO command_operations (id,"actorId","operationId",action,"resourceId","requestHash",status,result,"createdAt","updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,NOW(),NOW()) ON CONFLICT ("actorId","operationId") DO UPDATE SET
        status=EXCLUDED.status,result=EXCLUDED.result,"updatedAt"=NOW()
        WHERE command_operations.action=EXCLUDED.action AND command_operations."resourceId"=EXCLUDED."resourceId"
          AND command_operations."requestHash"=EXCLUDED."requestHash" RETURNING id`,
      [randomUUID(), row.actorId, row.operationId, row.action, row.resourceId, row.requestHash, row.status, JSON.stringify(row.result)]);
      if (result.rowCount !== 1) throw new DomainError(409, "COMMAND_REPLAY_CONFLICT", "Mutation ID is already bound to another request.");
    },
    async emit(input) { await appendSqlOutbox(client, input); },
    async insertInvoice(payment, intentId, completedAt, snapshot) {
      const result = await client.query(`INSERT INTO invoices (id,"paymentId","appointmentId",service,"paymentMethod","generatedAt",
        "amountCentavos",currency,"billingLineageId","completedIntentId") VALUES ($1,$2,$3,'Consultation',$8,$4,$5,'PHP',$6,$7)
        ON CONFLICT ("paymentId") DO NOTHING RETURNING id`,
      [randomUUID(), payment.id, payment.appointmentId, completedAt, payment.amountCentavos, payment.billingLineageId, intentId, payment.paymentProvider+(payment.providerMode==='sandbox'?' Sandbox':'')]);
      if (result.rowCount !== 1) {
        const existing = await client.query(`SELECT "appointmentId","billingLineageId","amountCentavos",currency FROM invoices WHERE "paymentId"=$1`, [payment.id]);
        const row = existing.rows[0];
        if (!row || row.appointmentId !== payment.appointmentId || row.billingLineageId !== payment.billingLineageId
          || Number(row.amountCentavos) !== payment.amountCentavos || row.currency !== "PHP") throw new DomainError(409, "PAYMENT_INVOICE_CONFLICT", "Invoice receipt conflicts.");
      }
      if(snapshot)await client.query('UPDATE invoices SET "acknowledgmentSnapshot"=$2::jsonb WHERE "paymentId"=$1 AND "acknowledgmentSnapshot" IS NULL',[payment.id,JSON.stringify(snapshot)]);
      return result.rowCount === 1;
    },
  };
}
export function createPaymentStore(pool: Pool): PaymentStore {
  const read = async (sql: string, values: unknown[]) => {
    const result = await pool.query(sql, values);
    return result.rows.map(row => normalize<PaymentRow>(row)!);
  };
  return {
    async transaction(lineage, execute) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`payment:${lineage}`]);
        const frozen = await client.query(`SELECT "operationId" FROM payment_association_holds WHERE "billingLineageId"=$1 AND state='prepared' LIMIT 1`, [lineage]);
        if (frozen.rows.length) throw new DomainError(409, "PAYMENT_ASSOCIATION_FROZEN", "Payment is preparing an appointment transfer.");
        const result = await execute(postgresTx(client));
        await client.query("COMMIT");
        return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },
    byAppointment: async id => (await read(`SELECT * FROM payments WHERE "appointmentId"=$1`, [id]))[0] ?? null,
    byId: async id => (await read(`SELECT * FROM payments WHERE id=$1`, [id]))[0] ?? null,
    due: (now, limit) => read(`SELECT * FROM payments WHERE "providerMode"='sandbox' AND "reviewCode" IS DISTINCT FROM 'RECONCILIATION_EXHAUSTED'
      AND ("checkoutSessionId" IS NOT NULL OR "refundId" IS NOT NULL) AND "nextReconcileAt"<=$1
      AND ("reconcileLeaseUntil" IS NULL OR "reconcileLeaseUntil"<=$1)
      AND NOT EXISTS (SELECT 1 FROM payment_association_holds h WHERE h."billingLineageId"=payments."billingLineageId" AND h.state='prepared')
      ORDER BY "nextReconcileAt",id LIMIT $2`, [now, limit]),
    async expiredOperations(now, limit) {
      const result = await pool.query(`SELECT * FROM payment_operations WHERE status='pending' AND "executionStartedAt" IS NOT NULL
        AND "leaseUntil"<=$1 ORDER BY "leaseUntil",id LIMIT $2`, [now, limit]);
      return result.rows.map(row => normalize<PaymentOperationRow>(row)!);
    },
    reviews: limit => read(`SELECT * FROM payments WHERE "reviewRequired"=true ORDER BY "updatedAt",id LIMIT $1`, [limit]),
    async operationsForPayment(id) {
      const result = await pool.query(`SELECT * FROM payment_operations WHERE "paymentId"=$1 ORDER BY "createdAt",id LIMIT 100`, [id]);
      return result.rows.map(row => normalize<PaymentOperationRow>(row)!);
    },
  };
}
