import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { envelopeFromRow, processWithInbox, type OutboxRow } from "../infrastructure/outbox.js";
import { parseEvent, type EventEnvelope } from "../contracts/events.js";

export interface PaymentProjectionAppointment {
  id: string;
  status: string;
  version: number;
  billingLineageId: string;
  associationVersion: number;
}

// The Appointment owner supplies a transaction-bound, locked association read.
export type PaymentProjectionAppointmentReader = (tx: PoolClient, appointmentId: string) => Promise<PaymentProjectionAppointment | null>;

interface ProjectionPayment {
  id: string;
  appointmentId: string;
  version: number;
  status: string;
  paidAt: Date | null;
  providerMode: string;
  billingLineageId: string;
  associationVersion: number;
  reviewRequired: boolean;
}

export async function consumePayment(core: Pool, integrations: Pool, input: EventEnvelope,
  readAppointment?: PaymentProjectionAppointmentReader) {
  const event = parseEvent(input);
  if (!["vital.payment.completed", "vital.payment.changed"].includes(event.eventType) || event.producer !== "payment") throw new Error("PAYMENT_SUBSCRIPTION_MISMATCH");
  if (!readAppointment) throw new Error("APPOINTMENT_PAYMENT_READER_REQUIRED");
  const source = await integrations.query<ProjectionPayment>(
    `SELECT id,"appointmentId",version,status,"paidAt","providerMode","billingLineageId","associationVersion","reviewRequired"
      FROM payments WHERE id=$1`, [event.data.paymentId]);
  const payment = source.rows[0];
  if (!payment || payment.id !== event.aggregateId || payment.providerMode !== "sandbox" ||
      payment.version < event.aggregateVersion || !Number.isInteger(payment.version) ||
      !Number.isInteger(payment.associationVersion) || payment.associationVersion < 1 ||
      typeof payment.reviewRequired !== "boolean" || payment.billingLineageId !== event.data.billingLineageId ||
      payment.associationVersion < Number(event.data.associationVersion)) throw new Error("PAYMENT_SOURCE_UNVERIFIED");
  // Older facts must also match their committed outbox row, not just a newer ledger revision.
  const committed = await integrations.query<OutboxRow>(`SELECT * FROM outbox_events WHERE id=$1`, [event.eventId]);
  if (!committed.rows[0] || !isDeepStrictEqual(envelopeFromRow(committed.rows[0]), event)) throw new Error("PAYMENT_FACT_UNCOMMITTED");
  if (payment.associationVersion === event.data.associationVersion && payment.appointmentId !== event.data.appointmentId) {
    throw new Error("PAYMENT_ASSOCIATION_UNVERIFIED");
  }
  if (payment.version === event.aggregateVersion &&
      (payment.associationVersion !== event.data.associationVersion || payment.reviewRequired !== event.data.reviewRequired ||
       (event.eventType === "vital.payment.changed" ? payment.status !== event.data.status :
         payment.status !== "paid" || payment.paidAt?.toISOString() !== event.data.paidAt))) throw new Error("PAYMENT_SOURCE_UNVERIFIED");
  const snapshot = parseEvent({ ...event, eventType: "vital.payment.changed", aggregateVersion: payment.version,
    data: { appointmentId: payment.appointmentId, paymentId: payment.id, paymentVersion: payment.version,
      billingLineageId: payment.billingLineageId, associationVersion: payment.associationVersion,
      reviewRequired: payment.reviewRequired, status: payment.status } });
  await processWithInbox(core, "appointment-payment", event, async (tx) => {
    if (payment.associationVersion > Number(event.data.associationVersion)) return;
    const appointment = await readAppointment(tx, payment.appointmentId);
    if (!appointment || appointment.id !== payment.appointmentId || appointment.billingLineageId !== payment.billingLineageId ||
        appointment.associationVersion !== payment.associationVersion ||
        !Number.isInteger(appointment.version) || appointment.version < 0) throw new Error("PAYMENT_APPOINTMENT_UNVERIFIED");
    const projection = await tx.query<{ paymentId: string; billingLineageId: string | null; associationVersion: number; sourceVersion: number }>(
      `SELECT "paymentId","billingLineageId","associationVersion","sourceVersion" FROM appointment_payment_projections WHERE "appointmentId"=$1`, [appointment.id]);
    const prior = projection.rows[0];
    if (prior && (prior.paymentId !== payment.id || prior.billingLineageId !== payment.billingLineageId)) throw new Error("PAYMENT_PROJECTION_REBOUND");
    if (prior && (prior.associationVersion > payment.associationVersion || prior.sourceVersion >= payment.version)) return;
    const reviewRequired = payment.reviewRequired || ["cancelled", "rejected", "rescheduled", "expired"].includes(appointment.status);
    await tx.query(`INSERT INTO appointment_payment_projections
      ("appointmentId","paymentId","sourceVersion",status,"paidAt","billingLineageId","associationVersion","reviewRequired","observedAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT ("appointmentId") DO UPDATE SET
      "sourceVersion"=EXCLUDED."sourceVersion",status=EXCLUDED.status,"paidAt"=EXCLUDED."paidAt",
      "associationVersion"=EXCLUDED."associationVersion","reviewRequired"=EXCLUDED."reviewRequired","observedAt"=NOW()
      WHERE appointment_payment_projections."paymentId"=EXCLUDED."paymentId"
        AND appointment_payment_projections."billingLineageId"=EXCLUDED."billingLineageId"
        AND appointment_payment_projections."associationVersion"<=EXCLUDED."associationVersion"
        AND appointment_payment_projections."sourceVersion"<EXCLUDED."sourceVersion"`,
    [appointment.id, payment.id, payment.version, snapshot.data.status, payment.paidAt, payment.billingLineageId, payment.associationVersion, reviewRequired]);
  });
}

export async function consumeProfile(core: Pool, integrations: Pool, event: EventEnvelope) {
  if (event.eventType !== "vital.profile.changed" || event.producer !== "profile") throw new Error("PROFILE_SUBSCRIPTION_MISMATCH");
  const source = await core.query<{ authId: string; role: string; version: number }>(`SELECT "authId",role,version FROM vital_users WHERE id=$1`, [event.aggregateId]);
  const profile = source.rows[0];
  if (!profile || profile.authId !== event.data.authId || profile.version < event.aggregateVersion) throw new Error("PROFILE_SOURCE_UNVERIFIED");
  await processWithInbox(integrations, "profile-projection", event, async (tx) => {
    await tx.query(`INSERT INTO profile_revision_projections ("profileId","authId","sourceVersion",role,"observedAt")
      VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT ("profileId") DO UPDATE SET "sourceVersion"=EXCLUDED."sourceVersion",
      role=EXCLUDED.role,"observedAt"=NOW() WHERE profile_revision_projections."sourceVersion"<EXCLUDED."sourceVersion"`,
    [event.aggregateId, profile.authId, profile.version, profile.role]);
  });
}
