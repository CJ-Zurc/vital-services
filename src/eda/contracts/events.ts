import { z } from "zod";

const uuid = z.uuid();
const appointmentData = z.object({
  appointmentId: uuid,
  actorAuthId: uuid.nullable(),
  operationId: uuid,
}).strict();

export const eventDataSchemas = {
  "vital.profile.changed": z.object({
    authId: uuid,
    role: z.enum(["patient", "doctor", "admin"]),
    operation: z.enum(["materialized", "profile_updated", "onboarded", "doctor_provisioned"]),
    actorAuthId: uuid.optional(),
  }).strict(),
  "vital.payment.completed": z.object({
    appointmentId: uuid,
    paymentId: uuid,
    paymentVersion: z.number().int().nonnegative(),
    paidAt: z.iso.datetime(),
  }).strict(),
  "vital.payment.changed": z.object({
    appointmentId: uuid,
    paymentId: uuid,
    paymentVersion: z.number().int().nonnegative(),
    status: z.enum(["pending", "paid", "failed", "refund_pending", "refunded", "refund_failed", "non_refundable"]),
  }).strict(),
  "vital.appointment.approved": appointmentData,
  "vital.appointment.confirmed": appointmentData,
  "vital.appointment.rescheduled": appointmentData,
  "vital.appointment.cancelled": appointmentData,
  "vital.appointment.completed": appointmentData,
  "vital.messaging.changed": z.object({
    appointmentId: uuid,
    conversationId: uuid,
    actorAuthId: uuid,
    kind: z.enum(["message", "read", "eligibility"]),
  }).strict(),
  "vital.video.changed": z.object({
    appointmentId: uuid,
    resourceId: uuid,
    doctorAuthId: uuid,
    status: z.enum(["prepared", "ready", "claimed", "released", "uncertain"]),
  }).strict(),
  "vital.audit.requested": z.object({
    auditType: z.string().regex(/^vital\.[a-z_.]{1,96}$/),
    actorAuthId: uuid.nullable(),
    resourceId: uuid,
    resourceType: z.enum(["profile", "appointment", "payment", "document", "message", "video"]),
  }).strict(),
  "vital.notification.requested": z.object({
    requestId: uuid,
    recipientAuthId: uuid,
    appointmentId: uuid,
    template: z.enum(["appointment.cancelled", "appointment.follow_up"]),
    parameters: z.object({ scheduledAt: z.iso.datetime().optional() }).strict(),
  }).strict(),
} as const;

export type EventType = keyof typeof eventDataSchemas;
export type Producer = "profile" | "appointment" | "payment" | "records" | "messaging" | "video";

const producers: Record<EventType, readonly Producer[]> = {
  "vital.profile.changed": ["profile"],
  "vital.payment.completed": ["payment"],
  "vital.payment.changed": ["payment"],
  "vital.appointment.approved": ["appointment"],
  "vital.appointment.confirmed": ["appointment"],
  "vital.appointment.rescheduled": ["appointment"],
  "vital.appointment.cancelled": ["appointment"],
  "vital.appointment.completed": ["appointment"],
  "vital.messaging.changed": ["messaging"],
  "vital.video.changed": ["video"],
  "vital.audit.requested": ["profile", "appointment", "payment", "records", "messaging", "video"],
  "vital.notification.requested": ["appointment"],
};

const envelopeSchema = z.object({
  eventId: uuid,
  eventType: z.enum(Object.keys(eventDataSchemas) as [EventType, ...EventType[]]),
  schemaVersion: z.literal(1),
  producer: z.enum(["profile", "appointment", "payment", "records", "messaging", "video"]),
  occurredAt: z.iso.datetime(),
  aggregateId: uuid,
  aggregateVersion: z.number().int().nonnegative(),
  correlationId: uuid,
  causationId: uuid.nullable(),
  data: z.unknown(),
}).strict();

export type EventEnvelope = Omit<z.infer<typeof envelopeSchema>, "data"> & { data: Record<string, unknown> };

export function parseEvent(input: unknown): EventEnvelope {
  const envelope = envelopeSchema.parse(input);
  if (!producers[envelope.eventType].includes(envelope.producer)) throw new Error("Event producer does not own this fact.");
  const data = eventDataSchemas[envelope.eventType].parse(envelope.data);
  if ("paymentId" in data && (data.paymentId !== envelope.aggregateId || data.paymentVersion !== envelope.aggregateVersion)) {
    throw new Error("Payment fact must bind its aggregate identity and source version.");
  }
  if (envelope.eventType.startsWith("vital.appointment.") && "appointmentId" in data && data.appointmentId !== envelope.aggregateId) {
    throw new Error("Appointment fact must bind its aggregate identity.");
  }
  const event = { ...envelope, data };
  if (Buffer.byteLength(JSON.stringify(event), "utf8") > 16_384) throw new Error("Event exceeds 16 KiB.");
  return event;
}

export function exchangeFor(producer: Producer) {
  return `vital.${producer}.events`;
}
