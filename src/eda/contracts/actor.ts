import { z } from "zod";

export const actorSchema = z.object({
  authId: z.uuid(),
  role: z.enum(["patient", "doctor", "admin", "service"]),
  serviceId: z.literal("vital-web"),
  scopes: z.array(z.string().min(1).max(96)).min(1).max(16),
  resource: z.string().min(1).max(256),
  correlationId: z.uuid(),
  isSuperAdmin: z.boolean(),
}).strict();

export type Actor = z.infer<typeof actorSchema>;
export type VitalActor = Actor;

export class DomainError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export class AppointmentPendingConflictsError extends DomainError {
  constructor(public readonly conflictIds: string[]) {
    super(409, 'APPOINTMENT_SLOT_PENDING_CONFLICTS', 'Review competing pending requests before approval.');
  }
}

export function requireScope(actor: Actor, scope: string, resource: string) {
  if (!actor.scopes.includes(scope) || actor.resource !== resource) {
    throw new DomainError(403, "ACTOR_SCOPE_DENIED", "The delegated action is not permitted.");
  }
}
