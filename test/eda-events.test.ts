import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { parseEvent, exchangeFor } from "../src/eda/contracts/events.js";

function paymentEvent() {
  const paymentId = randomUUID();
  return { eventId: randomUUID(), eventType: "vital.payment.completed", schemaVersion: 1,
    producer: "payment", occurredAt: new Date().toISOString(), aggregateId: paymentId,
    aggregateVersion: 1, correlationId: randomUUID(), causationId: null,
    data: { appointmentId: randomUUID(), paymentId, paymentVersion: 1, billingLineageId: randomUUID(),
      associationVersion: 1, reviewRequired: false, paidAt: new Date().toISOString() } };
}

test("EDA events validate owned committed facts and module exchange selection", () => {
  const event = parseEvent(paymentEvent());
  assert.equal(event.producer, "payment");
  assert.equal(exchangeFor(event.producer), "vital.payment.events");
});

test("EDA event payloads reject clinical content, credentials, unknown fields and producer spoofing", () => {
  const event = paymentEvent();
  for (const field of ["chiefComplaint", "content", "accessToken", "refreshToken", "meetingUrl"]) {
    assert.throws(() => parseEvent({ ...event, data: { ...event.data, [field]: "forbidden" } }));
  }
  assert.throws(() => parseEvent({ ...event, producer: "appointment" }));
  assert.throws(() => parseEvent({ ...event, schemaVersion: 2 }));
  assert.throws(() => parseEvent({ ...event, aggregateVersion: -1 }));
  assert.throws(() => parseEvent({ ...event, password: "forbidden" }));
  assert.throws(() => parseEvent({ ...event, aggregateId: randomUUID() }));
  assert.throws(() => parseEvent({ ...event, aggregateVersion: 2 }));
});

test("EDA notification intents permit only first-rollout in-app template metadata", () => {
  const event = { ...paymentEvent(), eventType: "vital.notification.requested", producer: "appointment",
    data: { requestId: randomUUID(), recipientAuthId: randomUUID(), appointmentId: randomUUID(),
      template: "appointment.cancelled", parameters: {} } };
  assert.equal(parseEvent(event).eventType, "vital.notification.requested");
  assert.throws(() => parseEvent({ ...event, data: { ...event.data, parameters: { reason: "private content" } } }));
  assert.throws(() => parseEvent({ ...event, data: { ...event.data, channel: "sms" } }));
});

test("EDA payment events require lineage association and review fencing", () => {
  const event = paymentEvent();
  for (const field of ["billingLineageId", "associationVersion", "reviewRequired"]) {
    const data: Record<string, unknown> = { ...event.data };
    delete data[field];
    assert.throws(() => parseEvent({ ...event, data }));
  }
  for (const patch of [{ billingLineageId: "invalid" }, { associationVersion: 0 },
    { associationVersion: 1.5 }, { reviewRequired: "true" }, { checkoutUrl: "https://provider.test" }]) {
    assert.throws(() => parseEvent({ ...event, data: { ...event.data, ...patch } }));
  }
});

test("EDA payment changed events accept only current financial statuses", () => {
  const event = paymentEvent();
  const { paidAt: _paidAt, ...data } = event.data;
  for (const status of ["pending", "paid", "failed", "refund_pending", "refunded", "refund_failed", "non_refundable"]) {
    assert.equal(parseEvent({ ...event, eventType: "vital.payment.changed", data: { ...data, status } }).data.status, status);
  }
  for (const status of ["confirmed", "unpaid", "not_needed", "processing"]) {
    assert.throws(() => parseEvent({ ...event, eventType: "vital.payment.changed", data: { ...data, status } }));
  }
});
