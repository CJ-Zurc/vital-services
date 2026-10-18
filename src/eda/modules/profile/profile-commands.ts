import { randomUUID } from "node:crypto";
import type { Prisma } from "../../generated/core/client.js";
import { DomainError } from "../../contracts/actor.js";
import { requestHash as canonicalHash } from "../../infrastructure/security.js";
import type { ProfileCommandGuard, ProfileVerification } from "./profile.js";

export function createProfileCommandGuard(): ProfileCommandGuard {
  return async <T>(tx: Prisma.TransactionClient, command: Parameters<ProfileCommandGuard>[1], execute: (verification?: ProfileVerification) => Promise<T>) => {
    const metadata = command.metadata;
    if (!metadata) throw new DomainError(401, "COMMAND_METADATA_REQUIRED", "A signed mutation ID is required.");
    const resourceId = command.targetAuthId ?? command.actor.authId;
    if (command.actor.resource !== resourceId) throw new DomainError(403, "ACTOR_SCOPE_DENIED", "Wrong command resource.");
    const hash = canonicalHash("PROFILE-COMMAND", command.operation,
      { role: command.actor.role, targetAuthId: resourceId, input: command.input ?? null, transportHash: metadata.requestHash });
    const key = { actorId: command.actor.authId, operationId: metadata.operationId };
    const existing = await tx.commandOperation.findUnique({ where: { actorId_operationId: key } });
    if (existing) {
      if (existing.action !== command.operation || existing.requestHash !== hash || existing.resourceId !== resourceId) {
        throw new DomainError(409, "COMMAND_REPLAY_CONFLICT", "Mutation ID was already used for another request.");
      }
      if (existing.status !== "completed") throw new DomainError(409, "COMMAND_PENDING", "This mutation needs reconciliation.");
      return existing.result as T;
    }
    const claim = await tx.commandOperation.create({ data: { id: randomUUID(), ...key, action: command.operation,
      resourceId, requestHash: hash, status: "pending" } });
    const result = await execute();
    await tx.commandOperation.update({ where: { id: claim.id }, data: { status: "completed",
      result: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue } });
    return result;
  };
}
