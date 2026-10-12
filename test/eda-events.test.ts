import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { parseEvent, exchangeFor } from "../src/eda/contracts/events.js";

function paymentEvent() {
  const paymentId = randomUUID();
  return { eventId: randomUUID(), eventType: "vital.payment.completed", schemaVersion: 1,
    producer: "payment", occurredAt: new Date().toISOString(), aggregateId: paymentId,
    aggregateVersion: 1, correlationId: randomUUID(), causationId: null,
    data: { appointmentId: randomUUID(), paymentId, paymentVersion: 1, paidAt: new Date().toISOString() } };
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
