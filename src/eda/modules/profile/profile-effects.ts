import { randomUUID } from "node:crypto";
import type { Prisma } from "../../generated/core/client.js";
import type { Actor } from "../../contracts/actor.js";
import { appendOutbox } from "../../infrastructure/outbox.js";
import { requestHash } from "../../infrastructure/security.js";

type Subject = { id: string; authId: string; role: string; version: number };
type Metadata = { departmentExternalId?: string | null; departmentName?: string | null; doctorMirror?: boolean };
const auditTypes: Record<string, string> = {
  materialize: "vital.profile.materialized", "registration.bootstrap": "vital.profile.materialized", "patient.update": "vital.profile.updated",
  "patient.notice.dismiss": "vital.profile.updated",
  "doctor.update": "vital.profile.updated", "patient.onboarding": "vital.patient.onboarded",
  "doctor.onboarding": "vital.doctor.onboarded", "doctor.provision": "vital.doctor.provisioned",
  "doctor.specialty": "vital.doctor.specialty_updated",
};

export async function recordProfileEffects(tx: Prisma.TransactionClient, actor: Actor, user: Subject,
  operation: string, metadata: Metadata = {}) {
  const role = user.role as "patient" | "doctor" | "admin";
  const auditType = auditTypes[operation];
  if (!auditType || !["patient", "doctor", "admin"].includes(role)) throw new Error("PROFILE_EFFECT_OPERATION_INVALID");
  const source = await appendOutbox(tx, { eventType: "vital.profile.changed", producer: "profile",
    aggregateId: user.id, aggregateVersion: user.version, correlationId: actor.correlationId,
    data: { authId: user.authId, role, actorAuthId: actor.authId,
      operation: operation === "materialize" || operation === "registration.bootstrap" ? "materialized" : operation === "doctor.provision" ? "doctor_provisioned"
        : operation.endsWith(".onboarding") ? "onboarded" : "profile_updated" } });
  await appendOutbox(tx, { eventType: "vital.audit.requested", producer: "profile", aggregateId: user.id,
    aggregateVersion: user.version, correlationId: actor.correlationId, causationId: source.eventId,
    data: { auditType, actorAuthId: actor.authId, resourceId: user.id, resourceType: "profile" } });
  for (const destination of metadata.doctorMirror ? ["auth-stale", "ehr-mirror"] as const : ["auth-stale"] as const) {
    const requestId = randomUUID();
    const path = `/internal/users/${user.authId}/${destination === "auth-stale" ? "stale" : "doctor-mirror"}`;
    const method = destination === "auth-stale" ? "POST" : "PUT";
    const payload = destination === "auth-stale" ? {} : { source: "vital-services", request_id: requestId,
      source_version: user.version, department_external_id: metadata.departmentExternalId ?? null,
      department_name: metadata.departmentName ?? null };
    const intent = await tx.profileSyncIntent.create({ data: { id: randomUUID(), profileId: user.id, authId: user.authId,
      sourceVersion: user.version, destination, requestId, requestHash: requestHash(method, path, payload), payload } });
    await appendOutbox(tx, { eventType: "vital.profile.sync.requested", producer: "profile", aggregateId: user.id,
      aggregateVersion: user.version, correlationId: actor.correlationId, causationId: source.eventId,
      data: { intentId: intent.id, authId: user.authId, destination } });
  }
}
