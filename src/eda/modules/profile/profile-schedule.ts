import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { DomainError, requireScope, type Actor } from "../../contracts/actor.js";
import { appendSqlOutbox } from "../../infrastructure/outbox.js";
import { requestHash } from "../../infrastructure/security.js";

export type ProfileAvailability = "virtual" | "in_person" | "both";
export interface ScheduleAvailabilityInput {
  doctorId: string;
  consultationType: ProfileAvailability;
  // Own Auth UUID on create; the already-authorized schedule UUID on update.
  resource: string;
}
export interface ScheduleAvailabilityResult {
  doctorId: string;
  availabilityType: ProfileAvailability;
  changed: boolean;
}
export type ScheduleAvailabilityUpgrade = (tx: PoolClient, actor: Actor,
  input: ScheduleAvailabilityInput) => Promise<ScheduleAvailabilityResult>;

// Called only inside Appointment's command/calendar transaction. No separate commit or network I/O.
export const upgradeScheduleAvailability: ScheduleAvailabilityUpgrade = async (tx, actor, input) => {
  const fields = z.object({ doctorId: z.uuid(), consultationType: z.enum(["virtual", "in_person", "both"]),
    resource: z.uuid() }).strict().parse(input);
  if (actor.role !== "doctor") throw new DomainError(403, "PROFILE_SCHEDULE_DENIED", "Doctor membership required.");
  requireScope(actor, "appointments.schedule.write", fields.resource);
  const doctor = (await tx.query<{ userId: string; availabilityType: ProfileAvailability | null }>(
    `SELECT d."userId",d."availabilityType" FROM vital_doctors d
     JOIN vital_users u ON u.id=d."userId" AND u."authId"=d."authId"
     WHERE d."userId"=$1 AND d."authId"=$2 AND u.role='doctor' AND d.role='doctor'
     FOR UPDATE OF u,d`, [fields.doctorId, actor.authId])).rows[0];
  if (!doctor) throw new DomainError(403, "PROFILE_SCHEDULE_DENIED", "Doctor membership required.");
  if (!doctor.availabilityType || !["virtual", "in_person", "both"].includes(doctor.availabilityType)) {
    throw new DomainError(409, "PROFILE_AVAILABILITY_REQUIRED", "Configure doctor availability first.");
  }
  if (doctor.availabilityType === "both" || doctor.availabilityType === fields.consultationType) {
    return { doctorId: fields.doctorId, availabilityType: doctor.availabilityType, changed: false };
  }
  await tx.query('UPDATE vital_doctors SET "availabilityType"=\'both\',"changedAt"=NOW() WHERE "userId"=$1', [fields.doctorId]);
  const user = (await tx.query<{ version: number }>(
    'UPDATE vital_users SET version=version+1 WHERE id=$1 RETURNING version', [fields.doctorId])).rows[0];
  if (!user) throw new DomainError(409, "PROFILE_SCHEDULE_DENIED", "Doctor membership changed.");
  const source = await appendSqlOutbox(tx, { producer: "profile", eventType: "vital.profile.changed",
    aggregateId: fields.doctorId, aggregateVersion: user.version, correlationId: actor.correlationId,
    data: { authId: actor.authId, role: "doctor", actorAuthId: actor.authId, operation: "profile_updated" } });
  await appendSqlOutbox(tx, { producer: "profile", eventType: "vital.audit.requested",
    aggregateId: fields.doctorId, aggregateVersion: user.version, correlationId: actor.correlationId, causationId: source.eventId,
    data: { auditType: "vital.profile.updated", actorAuthId: actor.authId, resourceId: fields.doctorId, resourceType: "profile" } });
  const intentId = randomUUID();
  await tx.query(`INSERT INTO profile_sync_intents
    (id,"profileId","authId","sourceVersion",destination,"requestId","requestHash",payload,"createdAt")
    VALUES($1,$2,$3,$4,'auth-stale',$5,$6,'{}'::jsonb,NOW())`,
  [intentId, fields.doctorId, actor.authId, user.version, randomUUID(), requestHash("POST", `/internal/users/${actor.authId}/stale`, {})]);
  await appendSqlOutbox(tx, { producer: "profile", eventType: "vital.profile.sync.requested",
    aggregateId: fields.doctorId, aggregateVersion: user.version, correlationId: actor.correlationId, causationId: source.eventId,
    data: { intentId, authId: actor.authId, destination: "auth-stale" } });
  return { doctorId: fields.doctorId, availabilityType: "both", changed: true };
};
