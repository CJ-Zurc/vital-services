import { randomUUID } from "node:crypto";
import type { Prisma } from "../../generated/core/client.js";
import { DomainError } from "../../contracts/actor.js";
import type { ProfileCommandGuard, ProfileVerification } from "./profile.js";

export function createProfileCommandGuard(): ProfileCommandGuard {
  return async <T>(tx: Prisma.TransactionClient, command: Parameters<ProfileCommandGuard>[1], execute: (verification?: ProfileVerification) => Promise<T>) => {
    const metadata = command.metadata;
    if (!metadata) throw new DomainError(401, "COMMAND_METADATA_REQUIRED", "A signed mutation ID is required.");
    // These workflows need a typed, verified BFF EHR/TRACE receipt before activation.
    if (command.operation.endsWith(".onboarding") || (command.input && "specialty" in command.input)) {
      throw new DomainError(503, "PROFILE_INTEGRATION_GATE", "This profile workflow has not passed integration acceptance.");
    }
    const key = { actorId: command.actor.authId, operationId: metadata.operationId };
    const existing = await tx.commandOperation.findUnique({ where: { actorId_operationId: key } });
    if (existing) {
      if (existing.action !== command.operation || existing.requestHash !== metadata.requestHash || existing.resourceId !== command.actor.resource) {
        throw new DomainError(409, "COMMAND_REPLAY_CONFLICT", "Mutation ID was already used for another request.");
      }
      if (existing.status !== "completed") throw new DomainError(409, "COMMAND_PENDING", "This mutation needs reconciliation.");
      return existing.result as T;
    }
    const claim = await tx.commandOperation.create({ data: { id: randomUUID(), ...key, action: command.operation,
      resourceId: command.actor.resource, requestHash: metadata.requestHash, status: "pending" } });
    const result = await execute();
    await tx.commandOperation.update({ where: { id: claim.id }, data: { status: "completed",
      result: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue } });
    return result;
  };
}
