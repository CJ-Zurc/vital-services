import { auditMetadataSchema } from './audit.js';
import { z } from "zod";

const uuid = z.uuid();
const appointmentData = z.object({
  appointmentId: uuid,
  appointmentVersion: z.number().int().nonnegative(),
  billingLineageId: uuid,
  associationVersion: z.number().int().min(1),
  actorAuthId: uuid.nullable(),
  operationId: uuid,
}).strict();

export const eventDataSchemas = {
  "vital.video.workflow.finalization.requested": z.object({workflowId:uuid,appointmentId:uuid,appointmentVersion:z.number().int().nonnegative(),operationId:uuid}).strict(),
  "vital.video.resource.changed": z.object({appointmentId:uuid,resourceId:uuid,billingLineageId:uuid,associationVersion:z.number().int().min(1),operationId:uuid}).strict(),
  "vital.video.generation.changed": z.object({appointmentId:uuid,generationId:uuid,doctorAuthId:uuid.nullable(),status:z.enum(['creating','ready','failed','uncertain','expired','claimed']),operationId:uuid}).strict(),
  "vital.records.snapshot.captured": z.object({snapshotId:uuid,appointmentId:uuid,patientId:uuid,operationId:uuid}).strict(),
  "vital.records.artifact.requested": z.object({assetId:uuid,operationId:uuid}).strict(),
  "vital.records.artifact.ready": z.object({assetId:uuid,operationId:uuid}).strict(),
  "vital.profile.changed": z.object({
    authId: uuid,
    role: z.enum(["patient", "doctor", "admin"]),
    operation: z.enum(["materialized", "profile_updated", "onboarded", "doctor_provisioned"]),
    actorAuthId: uuid.optional(),
  }).strict(),
  "vital.profile.sync.requested": z.object({
    intentId: uuid,
    authId: uuid,
    destination: z.enum(["auth-stale", "ehr-mirror"]),
  }).strict(),
  "vital.payment.completed": z.object({
    appointmentId: uuid,
    paymentId: uuid,
    paymentVersion: z.number().int().nonnegative(),
    billingLineageId: uuid,
    associationVersion: z.number().int().min(1),
    reviewRequired: z.boolean(),
    paidAt: z.iso.datetime(),
  }).strict(),
  "vital.payment.changed": z.object({
    appointmentId: uuid,
    paymentId: uuid,
    paymentVersion: z.number().int().nonnegative(),
    billingLineageId: uuid,
    associationVersion: z.number().int().min(1),
    reviewRequired: z.boolean(),
    status: z.enum(["pending", "paid", "failed", "refund_pending", "refunded", "refund_failed", "non_refundable"]),
  }).strict(),
  "vital.appointment.approved": appointmentData,
  "vital.appointment.requested": appointmentData,
  "vital.appointment.rejected": appointmentData,
  "vital.appointment.expired": appointmentData,
  "vital.appointment.confirmed": appointmentData,
  "vital.appointment.rescheduled": appointmentData.extend({ replacementAppointmentId: uuid, replacementVersion: z.number().int().nonnegative() }),
  "vital.appointment.cancelled": appointmentData,
  "vital.appointment.completed": appointmentData,
  "vital.appointment.completion_acknowledged": appointmentData,
  "vital.appointment.participant.requested": appointmentData.extend({phase:z.enum(["prepare","abort","finalize"]),participants:z.array(z.enum(["payment","video"])).min(1).max(2)}),
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
    resourceId: uuid.nullable(),
    resourceType: z.enum(["profile", "appointment", "payment", "document", "message", "video", "audit_history"]),
    auditMetadata: auditMetadataSchema.optional(),
  }).strict(),
  "vital.notification.requested": z.object({
    requestId: uuid,
    recipientAuthId: uuid,
    appointmentId: uuid,
    template: z.enum(["appointment.cancelled", "appointment.follow_up", "appointment.reschedule_proposed", "appointment.rescheduled", "appointment.reschedule_declined"]),
    parameters: z.object({ scheduledAt: z.iso.datetime().optional() }).strict(),
  }).strict(),
} as const;

export type EventType = keyof typeof eventDataSchemas;
export type Producer = "profile" | "appointment" | "payment" | "records" | "messaging" | "video";

const producers: Record<EventType, readonly Producer[]> = {
  "vital.video.workflow.finalization.requested": ["appointment"],
  "vital.video.resource.changed": ["video"],
  "vital.video.generation.changed": ["video"],
  "vital.records.snapshot.captured": ["records"],
  "vital.records.artifact.requested": ["records"],
  "vital.records.artifact.ready": ["records"],
  "vital.appointment.requested": ["appointment"],
  "vital.appointment.rejected": ["appointment"],
  "vital.appointment.expired": ["appointment"],
  "vital.profile.changed": ["profile"],
  "vital.profile.sync.requested": ["profile"],
  "vital.payment.completed": ["payment"],
  "vital.payment.changed": ["payment"],
  "vital.appointment.approved": ["appointment"],
  "vital.appointment.confirmed": ["appointment"],
  "vital.appointment.rescheduled": ["appointment"],
  "vital.appointment.cancelled": ["appointment"],
  "vital.appointment.completed": ["appointment"],
  "vital.appointment.completion_acknowledged": ["appointment"],
  "vital.appointment.participant.requested": ["appointment"],
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
  if (envelope.eventType.startsWith("vital.appointment.") && "appointmentId" in data && "appointmentVersion" in data &&
      (data.appointmentId !== envelope.aggregateId || data.appointmentVersion !== envelope.aggregateVersion)) {
    throw new Error("Appointment fact must bind its aggregate identity.");
  }
  if (envelope.eventType === 'vital.messaging.changed' && 'conversationId' in data && data.conversationId !== envelope.aggregateId) {
    throw new Error('Messaging fact must bind its conversation aggregate identity.');
  }
  const event = { ...envelope, data };
  if (Buffer.byteLength(JSON.stringify(event), "utf8") > 16_384) throw new Error("Event exceeds 16 KiB.");
  return event;
}

export function exchangeFor(producer: Producer) {
  return `vital.${producer}.events`;
}
