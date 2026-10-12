import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { appendSqlOutbox, processWithInbox } from "../infrastructure/outbox.js";
import { saveDelivery } from "../modules/integrations/delivery.js";
import type { EventEnvelope } from "../contracts/events.js";

export async function consumePayment(core: Pool, integrations: Pool, event: EventEnvelope) {
  if (!["vital.payment.completed", "vital.payment.changed"].includes(event.eventType) || event.producer !== "payment") throw new Error("PAYMENT_SUBSCRIPTION_MISMATCH");
  const source = await integrations.query<{ id: string; appointmentId: string; version: number; status: string; paidAt: Date | null; providerMode: string }>(
    `SELECT id,"appointmentId",version,status,"paidAt","providerMode" FROM payments WHERE id=$1`, [event.data.paymentId]);
  const payment = source.rows[0];
  if (!payment || payment.providerMode !== "sandbox" || payment.version < event.aggregateVersion) throw new Error("PAYMENT_SOURCE_UNVERIFIED");
  await processWithInbox(core, "appointment-payment", event, async (tx) => {
    // A superseded association is not permission to confirm its original appointment.
    if (payment.appointmentId !== event.data.appointmentId) return;
    const found = await tx.query<{ id: string; status: string; version: number }>(`SELECT id,status,version FROM appointments WHERE id=$1 FOR UPDATE`, [payment.appointmentId]);
    const appointment = found.rows[0];
    if (!appointment || ["cancelled", "rejected", "rescheduled"].includes(appointment.status)) return;
    const saga = await tx.query(`SELECT id FROM saga_operations WHERE ("sourceAppointmentId"=$1 OR "replacementAppointmentId"=$1)
      AND status NOT IN ('completed','compensated','rejected') LIMIT 1`, [appointment.id]);
    if (saga.rowCount) throw new Error("APPOINTMENT_SAGA_PENDING");
    const projection = await tx.query<{ sourceVersion: number }>(`SELECT "sourceVersion" FROM appointment_payment_projections WHERE "appointmentId"=$1`, [appointment.id]);
    if ((projection.rows[0]?.sourceVersion ?? -1) >= payment.version) return;
    await tx.query(`INSERT INTO appointment_payment_projections ("appointmentId","paymentId","sourceVersion",status,"paidAt","observedAt")
      VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT ("appointmentId") DO UPDATE SET "paymentId"=EXCLUDED."paymentId",
      "sourceVersion"=EXCLUDED."sourceVersion",status=EXCLUDED.status,"paidAt"=EXCLUDED."paidAt","observedAt"=NOW()
      WHERE appointment_payment_projections."sourceVersion"<EXCLUDED."sourceVersion"`,
    [appointment.id, payment.id, payment.version, payment.status, payment.paidAt]);
    if (payment.status !== "paid" || !["approved", "pending_payment_verification"].includes(appointment.status)) return;
    const confirmed = await tx.query<{ version: number }>(`UPDATE appointments SET status='confirmed',version=version+1,"updatedAt"=NOW()
      WHERE id=$1 AND version=$2 AND status=$3 RETURNING version`, [appointment.id, appointment.version, appointment.status]);
    if (!confirmed.rows[0]) throw new Error("APPOINTMENT_VERSION_CHANGED");
    await tx.query(`INSERT INTO appointment_logs (id,"appointmentId","fromStatus","toStatus","changedByRole",note,"changedAt")
      VALUES ($1,$2,$3,'confirmed','system','Sandbox payment outcome verified.',NOW())`, [randomUUID(), appointment.id, appointment.status]);
    await appendSqlOutbox(tx, { eventType: "vital.appointment.confirmed", producer: "appointment", aggregateId: appointment.id,
      aggregateVersion: confirmed.rows[0].version, correlationId: event.correlationId, causationId: event.eventId,
      data: { appointmentId: appointment.id, actorAuthId: null, operationId: event.eventId } });
    await appendSqlOutbox(tx, { eventType: "vital.audit.requested", producer: "appointment", aggregateId: appointment.id,
      aggregateVersion: confirmed.rows[0].version, correlationId: event.correlationId, causationId: event.eventId,
      data: { auditType: "vital.appointment.confirmed", actorAuthId: null, resourceId: appointment.id, resourceType: "appointment" } });
  });
}

export async function consumeProfile(core: Pool, integrations: Pool, event: EventEnvelope) {
  if (event.eventType !== "vital.profile.changed" || event.producer !== "profile") throw new Error("PROFILE_SUBSCRIPTION_MISMATCH");
  const source = await core.query<{ authId: string; version: number }>(`SELECT "authId",version FROM vital_users WHERE id=$1`, [event.aggregateId]);
  const profile = source.rows[0];
  if (!profile || profile.authId !== event.data.authId || profile.version < event.aggregateVersion) throw new Error("PROFILE_SOURCE_UNVERIFIED");
  await processWithInbox(integrations, "profile-projection", event, async (tx) => {
    await saveDelivery(tx, event, "audit", event.eventId, { event_id: event.eventId, event_type: event.eventType,
      correlation_id: event.correlationId, user_id: event.data.actorAuthId ?? event.data.authId,
      system: "vital", timestamp: event.occurredAt,
      details: { resource_id: event.aggregateId, resource_type: "profile", source_event_id: event.eventId } });
  });
}
