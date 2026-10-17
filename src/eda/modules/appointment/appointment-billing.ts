import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { DomainError, requireScope, type Actor } from "../../contracts/actor.js";

export interface BillingContext {
  appointmentId: string;
  billingLineageId: string;
  appointmentVersion: number;
  associationVersion: number;
  patientAuthId: string;
  doctorAuthId: string;
  consultationType: string;
  amountCentavos: number;
  currency: "PHP";
  status: string;
  payable: boolean;
  reviewRequired: boolean;
  scheduledAt: Date;
  intentId?: string;
}

export interface BillingCommand { operationId: string; requestHash: string }
export interface PreparedBillingContext extends BillingContext { intentId: string }
export type BillingIntentKind = "checkout" | "expire" | "refund" | "complete" | "reassociate";
export interface CommittedBillingIntent extends BillingContext {
  id: string;
  kind: BillingIntentKind;
  reasonCode?: "doctor_cancelled" | "patient_cancelled_before_24h" | "patient_cancelled_within_24h";
  cancelledAt?: Date;
  replacementAppointmentId?: string;
  expectedPaymentVersion?: number;
  completedAt?: Date;
}
export type BillingAuthority = ReturnType<typeof createBillingAuthority>;

interface AppointmentRow {
  appointmentId: string; billingLineageId: string; appointmentVersion: number;
  associationVersion: number; patientAuthId: string; doctorAuthId: string;
  consultationType: string; status: string; scheduledAt: Date;
  sourceAppointmentId?: string | null; hasBillingTransition?: boolean; completedAt?: Date | null; acceptedReplacement?: boolean; expiryProcessedAt?: Date|null;
  proposedEndAt?: Date|null; slotEndsAt?: Date|null;
}
interface QuoteRow {
  billingLineageId: string; patientAuthId: string; doctorAuthId: string;
  consultationType: string; amountCentavos: string | bigint; currency: string;
}
interface IntentRow {
  id: string; appointmentId: string; billingLineageId: string;
  appointmentVersion: number; associationVersion: number; actorAuthId: string;
  operationId: string; requestHash: string; kind: string; state: string;
  expiresAt: Date; committedAt: Date | null; ownerLogId: string | null;
  ownerOperationId: string | null; replacementAppointmentId: string | null;
  expectedPaymentVersion: number | null;
}
type Queryable = Pick<PoolClient, "query">;
export interface PaymentProjectionAppointment {
  id: string;
  status: string;
  version: number;
  billingLineageId: string;
  associationVersion: number;
}

/** The caller owns the Core transaction; retain the row lock through inbox commit. */
export async function readPaymentProjectionAppointment(tx: PoolClient, id: string): Promise<PaymentProjectionAppointment | null> {
  z.uuid().parse(id);
  const result = await tx.query<PaymentProjectionAppointment>(`SELECT id, status::text, version,
    "billingLineageId", "associationVersion" FROM appointments WHERE id=$1 FOR UPDATE`, [id]);
  const row = result.rows[0];
  if (!row) return null;
  if (row.id !== id || !row.billingLineageId || !Number.isSafeInteger(row.version) || row.version < 0
    || !Number.isSafeInteger(row.associationVersion) || row.associationVersion < 1) denied(409, "BILLING_CONTEXT_INVALID");
  return row;
}
const commandSchema = z.object({ operationId: z.uuid(), requestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const accepted = new Set(["approved", "pending_payment_verification", "confirmed"]);
const revoked = new Set(["cancelled", "rejected", "rescheduled", "expired"]);
const scopes = ["payments.read", "payments.checkout", "payments.reconcile"];
const maximumCentavos = 2_147_483_647n;
function denied(status: number, code: string): never { throw new DomainError(status, code, "Billing authorization is unavailable."); }

/** Parse the stored Decimal string, never a floating-point intermediate. */
export function exactCentavos(value: unknown): number {
  if (typeof value !== "string" || !/^\d{1,8}(?:\.\d{1,2})?$/.test(value)) denied(409, "BILLING_FEE_INVALID");
  const [whole, fraction = ""] = value.split(".");
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents < 1n || cents > maximumCentavos) denied(409, "BILLING_FEE_INVALID");
  return Number(cents);
}

function quoteAmount(value: string | bigint): number {
  if (!/^\d+$/.test(String(value))) denied(409, "BILLING_QUOTE_INVALID");
  const cents = BigInt(value);
  if (cents < 1n || cents > maximumCentavos || cents > BigInt(Number.MAX_SAFE_INTEGER)) denied(409, "BILLING_QUOTE_INVALID");
  return Number(cents);
}
function own(actor: Actor, appointmentId: string, row: AppointmentRow, scope?: string) {
  z.uuid().parse(actor.authId);
  if (actor.role !== "patient") denied(403, "BILLING_PATIENT_REQUIRED");
  if (scope) requireScope(actor, scope, appointmentId);
  else if (actor.resource !== appointmentId || !scopes.some(item => actor.scopes.includes(item))) denied(403, "ACTOR_SCOPE_DENIED");
  if (row.patientAuthId !== actor.authId) denied(403, "BILLING_PATIENT_DENIED");
}
async function ownApproval(db:Queryable,actor:Actor,id:string,row:AppointmentRow){
  requireScope(actor,"payments.approval.checkout",id);
  if(actor.role!=="doctor"||row.doctorAuthId!==actor.authId)denied(403,"BILLING_DOCTOR_DENIED");
  const proof=await db.query(`SELECT id FROM appointment_workflows WHERE COALESCE("targetAppointmentId","appointmentId")=$1
    AND "actorAuthId"=$2 AND state='committed' AND kind IN ('approve','follow-up') LIMIT 1`,[id,actor.authId]);
  if(!proof.rows.length)denied(403,"BILLING_APPROVAL_RECEIPT_REQUIRED");
}

async function appointment(db: Queryable, id: string, lock = false): Promise<AppointmentRow> {
  z.uuid().parse(id);
  const result = await db.query<AppointmentRow>(`SELECT a.id AS "appointmentId", a."billingLineageId",
    a.version AS "appointmentVersion", a."associationVersion", p."authId" AS "patientAuthId",
    d."authId" AS "doctorAuthId", a."consultationType"::text, a.status::text, a."scheduledAt", a."sourceAppointmentId", a."completedAt",a."expiryProcessedAt",a."proposedEndAt",
    CASE WHEN schedule.id IS NOT NULL THEN (schedule."slotDate"+schedule."endTime"+CASE WHEN schedule."endTime"<=schedule."startTime" THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END) AT TIME ZONE 'Asia/Manila' END AS "slotEndsAt",
    EXISTS (SELECT 1 FROM saga_operations accepted_saga WHERE accepted_saga."replacementAppointmentId"=a.id AND accepted_saga.status='completed' AND accepted_saga."pivotCommittedAt" IS NOT NULL) AS "acceptedReplacement",
    (EXISTS (SELECT 1 FROM saga_operations s
      WHERE (s."sourceAppointmentId"=a.id OR s."replacementAppointmentId"=a.id)
      AND s.status NOT IN ('completed','compensated','cancelled','failed'))
    OR EXISTS (SELECT 1 FROM slot_reservations r WHERE r."appointmentId"=a.id
      AND r.status='reserved' AND r."leaseUntil">CURRENT_TIMESTAMP)
    OR EXISTS (SELECT 1 FROM appointments proposal WHERE proposal."sourceAppointmentId"=a.id
      AND proposal.status::text IN ('pending','pending_patient_confirmation'))
    OR EXISTS (SELECT 1 FROM appointment_workflows workflow WHERE workflow."targetAppointmentId"=a.id
      AND workflow.state='committed' AND workflow."videoProcessingState"<>'finalized')) AS "hasBillingTransition"
    FROM appointments a
    JOIN vital_patients p ON p."userId"=a."patientId"
    JOIN vital_users pu ON pu.id=p."userId" AND pu."authId"=p."authId"
    JOIN vital_doctors d ON d."userId"=a."doctorId"
    JOIN vital_users du ON du.id=d."userId" AND du."authId"=d."authId"
    LEFT JOIN schedules schedule ON schedule.id=a."scheduleSlotId"
    WHERE a.id=$1 ${lock ? "FOR UPDATE OF a" : ""}`, [id]);
  const row = result.rows[0];
  if (!row) denied(404, "BILLING_APPOINTMENT_NOT_FOUND");
  if (!["virtual", "in_person"].includes(row.consultationType) || !Number.isSafeInteger(row.appointmentVersion)
    || row.appointmentVersion < 0 || !Number.isSafeInteger(row.associationVersion) || row.associationVersion < 1
    || !(row.scheduledAt instanceof Date) || !Number.isFinite(row.scheduledAt.getTime())) denied(409, "BILLING_CONTEXT_INVALID");
  return row;
}

// Profile owns fee storage; Appointment asks this local boundary for an exact
// snapshot while holding its preparation transaction, never the Auth database.
async function profileFee(db: Queryable, row: AppointmentRow, lock = false): Promise<number> {
  const result = await db.query<{ virtualFee: string | null; inPersonFee: string | null }>(`SELECT
    d."virtualFee"::text, d."inPersonFee"::text FROM vital_doctors d
    JOIN vital_users u ON u.id=d."userId" AND u."authId"=d."authId"
    WHERE d."authId"=$1 ${lock ? "FOR SHARE OF d" : ""}`, [row.doctorAuthId]);
  const profile = result.rows[0];
  return exactCentavos(row.consultationType === "virtual" ? profile?.virtualFee : profile?.inPersonFee);
}
async function quote(db: Queryable, lineage: string): Promise<QuoteRow | undefined> {
  return (await db.query<QuoteRow>(`SELECT * FROM appointment_billing_quotes WHERE "billingLineageId"=$1`, [lineage])).rows[0];
}
function assertQuote(row: AppointmentRow, frozen: QuoteRow) {
  if (frozen.billingLineageId !== row.billingLineageId || frozen.patientAuthId !== row.patientAuthId
    || frozen.doctorAuthId !== row.doctorAuthId || frozen.consultationType !== row.consultationType
    || frozen.currency !== "PHP") denied(409, "BILLING_QUOTE_ASSOCIATION_CONFLICT");
}
async function context(db: Queryable, row: AppointmentRow, now: Date): Promise<BillingContext> {
  const frozen = await quote(db, row.billingLineageId);
  if (frozen) assertQuote(row, frozen);
  const payable = accepted.has(row.status) && (row.slotEndsAt??row.proposedEndAt??row.scheduledAt).getTime() > now.getTime() && !row.expiryProcessedAt
    && row.hasBillingTransition !== true && (!row.sourceAppointmentId || row.acceptedReplacement === true);
  return { appointmentId: row.appointmentId, billingLineageId: row.billingLineageId,
    appointmentVersion: row.appointmentVersion, associationVersion: row.associationVersion,
    patientAuthId: row.patientAuthId, doctorAuthId: row.doctorAuthId, consultationType: row.consultationType,
    status: row.status, scheduledAt: row.scheduledAt,
    amountCentavos: frozen ? quoteAmount(frozen.amountCentavos) : await profileFee(db, row),
    currency: "PHP", payable, reviewRequired: revoked.has(row.status) || row.status!=="completed" &&
      ((row.slotEndsAt??row.proposedEndAt??row.scheduledAt).getTime()<=now.getTime() || Boolean(row.expiryProcessedAt) || !accepted.has(row.status)) };
}
function currentIntent(row: AppointmentRow, intent: IntentRow) {
  if (row.appointmentId !== intent.appointmentId || row.billingLineageId !== intent.billingLineageId
    || row.appointmentVersion !== intent.appointmentVersion || row.associationVersion !== intent.associationVersion) {
    denied(409, "BILLING_INTENT_STALE");
  }
}
async function intentById(db: Queryable, id: string): Promise<IntentRow> {
  z.uuid().parse(id);
  const result = await db.query<IntentRow>("SELECT * FROM appointment_billing_intents WHERE id=$1::uuid", [id]);
  if (!result.rows[0]) denied(503, "BILLING_OWNER_INTENT_UNAVAILABLE");
  return result.rows[0];
}

export function createBillingAuthority(corePool: Pool) {
  async function verify(db: Queryable, id: string): Promise<PreparedBillingContext> {
    const intent = await intentById(db, id);
    if (intent.kind !== "checkout" || intent.state !== "prepared") denied(503, "BILLING_CHECKOUT_INTENT_REQUIRED");
    if (!(intent.expiresAt instanceof Date) || intent.expiresAt.getTime() <= Date.now()) denied(409, "BILLING_INTENT_EXPIRED");
    const row = await appointment(db, intent.appointmentId);
    currentIntent(row, intent);
    if (row.patientAuthId !== intent.actorAuthId) {
      if(row.doctorAuthId!==intent.actorAuthId)denied(403,"BILLING_PATIENT_DENIED");
      const proof=await db.query(`SELECT id FROM appointment_workflows WHERE COALESCE("targetAppointmentId","appointmentId")=$1 AND "actorAuthId"=$2 AND state='committed' LIMIT 1`,[row.appointmentId,intent.actorAuthId]);
      if(!proof.rows.length)denied(403,"BILLING_APPROVAL_RECEIPT_REQUIRED");
    }
    if (!await quote(db, row.billingLineageId)) denied(409, "BILLING_QUOTE_MISSING");
    const value = await context(db, row, new Date());
    if (!value.payable) denied(409, "BILLING_NOT_PAYABLE");
    return { ...value, intentId: intent.id };
  }

  return {
    async authorizeApproval(actor:Actor,id:string):Promise<BillingContext>{const row=await appointment(corePool,id);await ownApproval(corePool,actor,id,row);return context(corePool,row,new Date());},
    async authorize(actor: Actor, appointmentId: string): Promise<BillingContext> {
      const row = await appointment(corePool, appointmentId);
      own(actor, appointmentId, row);
      return context(corePool, row, new Date());
    },
    async current(appointmentId: string): Promise<BillingContext> {
      return context(corePool, await appointment(corePool, appointmentId), new Date());
    },
    async assertAdmin(actor: Actor): Promise<void> {
      z.uuid().parse(actor.authId);
      if (actor.role !== "admin") denied(403, "BILLING_ADMIN_REQUIRED");
      const result = await corePool.query(`SELECT a."userId" FROM vital_admins a
        JOIN vital_users u ON u.id=a."userId" AND u."authId"=a."authId" WHERE a."authId"=$1`, [actor.authId]);
      if (!result.rows.length) denied(403, "BILLING_ADMIN_REVOKED");
    },
    async prepare(actor: Actor, appointmentId: string, command: BillingCommand): Promise<PreparedBillingContext> {
      const metadata = commandSchema.parse(command);
      const db = await corePool.connect();
      try {
        await db.query("BEGIN");
        const row = await appointment(db, appointmentId, true);
        if(actor.role==="doctor")await ownApproval(db,actor,appointmentId,row);else own(actor, appointmentId, row, "payments.checkout");
        if (!accepted.has(row.status) || (row.slotEndsAt??row.proposedEndAt??row.scheduledAt).getTime() <= Date.now() || row.expiryProcessedAt) denied(409, "BILLING_NOT_PAYABLE");
        if (row.hasBillingTransition === true || row.sourceAppointmentId && row.acceptedReplacement !== true) denied(409, "BILLING_TRANSITION_PENDING");
        let frozen = await quote(db, row.billingLineageId);
        if (!frozen) {
          const cents = await profileFee(db, row, true);
          await db.query(`INSERT INTO appointment_billing_quotes
            ("billingLineageId","appointmentId","patientAuthId","doctorAuthId","consultationType","amountCentavos",currency)
            VALUES ($1,$2,$3,$4,$5,$6::bigint,'PHP') ON CONFLICT ("billingLineageId") DO NOTHING`,
          [row.billingLineageId, appointmentId, row.patientAuthId, row.doctorAuthId, row.consultationType, String(cents)]);
          frozen = await quote(db, row.billingLineageId);
          if (!frozen) denied(409, "BILLING_QUOTE_MISSING");
        }
        assertQuote(row, frozen);
        const now = new Date(); const expiresAt = new Date(now.getTime() + 60_000);
        await db.query(`INSERT INTO appointment_billing_intents
          (id,"appointmentId","billingLineageId","appointmentVersion","associationVersion","actorAuthId",
           "operationId","requestHash",kind,state,"expiresAt")
          VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::uuid,$8,'checkout','prepared',$9)
          ON CONFLICT ("actorAuthId","operationId") DO NOTHING`,
        [randomUUID(), appointmentId, row.billingLineageId, row.appointmentVersion, row.associationVersion,
          actor.authId, metadata.operationId, metadata.requestHash, expiresAt]);
        const existing = (await db.query<IntentRow>(`SELECT * FROM appointment_billing_intents
          WHERE "actorAuthId"=$1 AND "operationId"=$2::uuid FOR UPDATE`, [actor.authId, metadata.operationId])).rows[0];
        if (!existing || existing.requestHash !== metadata.requestHash || existing.appointmentId !== appointmentId
          || existing.kind !== "checkout" || existing.state !== "prepared") denied(409, "BILLING_COMMAND_CONFLICT");
        currentIntent(row, existing);
        await db.query('UPDATE appointment_billing_intents SET "expiresAt"=$2 WHERE id=$1::uuid', [existing.id, expiresAt]);
        const value = { ...await context(db, row, now), intentId: existing.id };
        await db.query("COMMIT");
        return value;
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      } finally { db.release(); }
    },
    async verifyIntent(intentId: string): Promise<PreparedBillingContext> { return verify(corePool, intentId); },
    async committedIntent(intentId: string): Promise<CommittedBillingIntent> {
      const intent = await intentById(corePool, intentId);
      if (intent.kind === "checkout") return { ...await verify(corePool, intentId), id: intent.id, kind: "checkout" };
      if (!["expire", "refund", "complete", "reassociate"].includes(intent.kind) || intent.state !== "committed"
        || !(intent.committedAt instanceof Date) || !intent.ownerLogId) denied(503, "BILLING_OWNER_INTENT_UNAVAILABLE");
      const row = await appointment(corePool, intent.appointmentId);
      currentIntent(row, intent);
      if (!await quote(corePool, row.billingLineageId)) denied(409, "BILLING_QUOTE_MISSING");
      const log = (await corePool.query<{ appointmentId: string; toStatus: string; changedByRole: string | null; changedAt: Date }>(
        'SELECT "appointmentId","toStatus","changedByRole","changedAt" FROM appointment_logs WHERE id=$1', [intent.ownerLogId])).rows[0];
      if (!log || log.appointmentId !== row.appointmentId || log.toStatus !== row.status
        || !(log.changedAt instanceof Date) || log.changedAt.getTime() !== intent.committedAt.getTime()) denied(503, "BILLING_OWNER_RECEIPT_INVALID");
      const value: CommittedBillingIntent = { ...await context(corePool, row, new Date()), id: intent.id,
        intentId: intent.id, kind: intent.kind as BillingIntentKind };
      if (intent.expectedPaymentVersion !== null) {
        if (!Number.isSafeInteger(intent.expectedPaymentVersion) || intent.expectedPaymentVersion < 0) denied(409, "BILLING_INTENT_STALE");
        value.expectedPaymentVersion = intent.expectedPaymentVersion;
      }
      if (intent.kind === "complete") {
        if (row.status !== "completed" || !(row.completedAt instanceof Date)
          || !Number.isFinite(row.completedAt.getTime()) || row.completedAt.getTime() > intent.committedAt.getTime()) {
          denied(503, "BILLING_OWNER_RECEIPT_INVALID");
        }
        value.completedAt = row.completedAt;
      } else if (intent.kind === "refund") {
        if (row.status !== "cancelled" || !["doctor", "patient"].includes(log.changedByRole ?? "")
          || intent.actorAuthId !== (log.changedByRole === "doctor" ? row.doctorAuthId : row.patientAuthId)) denied(503, "BILLING_OWNER_RECEIPT_INVALID");
        value.cancelledAt = intent.committedAt;
        value.reasonCode = log.changedByRole === "doctor" ? "doctor_cancelled"
          : row.scheduledAt.getTime() - intent.committedAt.getTime() >= 86_400_000
            ? "patient_cancelled_before_24h" : "patient_cancelled_within_24h";
      } else if (intent.kind === "expire") {
        if (!revoked.has(row.status) && (!(row.expiryProcessedAt instanceof Date) || row.expiryProcessedAt.getTime()!==intent.committedAt.getTime())) denied(503, "BILLING_OWNER_RECEIPT_INVALID");
      } else {
        if (row.status !== "rescheduled" || !intent.ownerOperationId || !intent.replacementAppointmentId) denied(503, "BILLING_OWNER_RECEIPT_INVALID");
        const saga = (await corePool.query<{ sourceAppointmentId: string; replacementAppointmentId: string; pivotCommittedAt: Date | null }>(
          'SELECT "sourceAppointmentId","replacementAppointmentId","pivotCommittedAt" FROM saga_operations WHERE id=$1',
          [intent.ownerOperationId])).rows[0];
        const replacement = await appointment(corePool, intent.replacementAppointmentId);
        if (!saga?.pivotCommittedAt || saga.sourceAppointmentId !== row.appointmentId
          || saga.replacementAppointmentId !== replacement.appointmentId || replacement.billingLineageId !== row.billingLineageId
          || replacement.patientAuthId !== row.patientAuthId || replacement.doctorAuthId !== row.doctorAuthId
          || replacement.associationVersion !== row.associationVersion + 1) denied(503, "BILLING_OWNER_RECEIPT_INVALID");
        value.replacementAppointmentId = replacement.appointmentId;
      }
      return value;
    },
  };
}
