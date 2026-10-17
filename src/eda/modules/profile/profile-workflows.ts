import { z } from "zod";
import type { Prisma } from "../../generated/core/client.js";
import type { Actor } from "../../contracts/actor.js";
import { requireScope } from "../../contracts/actor.js";
import type { CorePrismaClient } from "../../infrastructure/databases.js";
import { requestHash as canonicalHash } from "../../infrastructure/security.js";
import { ProfileError, type ProfileCommand, type ProfileCommandMetadata } from "./profile.js";
import {
  prepareProfileWorkflowSchema, commitProfileWorkflowSchema, patientProfileReceiptSchema,
  doctorProfileReceiptSchema, type ProfileWorkflowKind, type ProfileReceipt, type ProfileWorkflowStatus,
} from "./profile-contracts.js";

type Workflow = Prisma.ProfileWorkflowGetPayload<Record<string, never>>;
export interface ProfileWorkflowDependencies {
  mutate<T>(command: ProfileCommand, run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  validate(kind: ProfileWorkflowKind, input: unknown): unknown;
  inspect(tx: Prisma.TransactionClient, actor: Actor, kind: ProfileWorkflowKind, targetAuthId: string, input: unknown): Promise<number>;
  apply(tx: Prisma.TransactionClient, actor: Actor, kind: ProfileWorkflowKind, targetAuthId: string, input: unknown, receipt: ProfileReceipt): Promise<unknown>;
}

function authorize(actor: Actor, kind: ProfileWorkflowKind, targetAuthId: string) {
  z.uuid().parse(targetAuthId);
  const admin = kind === "doctor.provision" || kind === "doctor.specialty";
  if (admin ? actor.role !== "admin" : actor.authId !== targetAuthId || actor.role !== (kind === "patient.onboarding" ? "patient" : "doctor")) {
    throw new ProfileError(403, "Forbidden.");
  }
  requireScope(actor, admin ? "profile.admin.write" : "profile.write", targetAuthId);
}
function status(row: Workflow): ProfileWorkflowStatus {
  return { workflowId: row.id, kind: row.kind as ProfileWorkflowKind, targetAuthId: row.targetAuthId,
    inputHash: row.inputHash, expectedVersion: row.expectedVersion, state: row.state as "prepared" | "committed" };
}
function conflict(): never { throw new ProfileError(409, "Profile workflow binding or version mismatch."); }

// Inputs and integration calls stay in the BFF. Core stores only binding facts and a minimal receipt.
export function createProfileWorkflows(db: CorePrismaClient, deps: ProfileWorkflowDependencies) {
  return {
    async prepare(actor: Actor, body: unknown, metadata?: ProfileCommandMetadata) {
      const request = prepareProfileWorkflowSchema.parse(body);
      const admin = request.kind === "doctor.provision" || request.kind === "doctor.specialty";
      if (admin && !request.targetAuthId) throw new ProfileError(400, "Target Auth UUID required.");
      const targetAuthId = request.targetAuthId ?? actor.authId;
      authorize(actor, request.kind, targetAuthId);
      deps.validate(request.kind, request.input);
      const inputHash = canonicalHash("PROFILE", request.kind, request.input);
      if (metadata?.operationId === request.workflowId) conflict();
      return deps.mutate({ actor, operation: "workflow.prepare", metadata, input: request, targetAuthId }, async (tx) => {
        if (!metadata) throw new ProfileError(401, "A signed mutation ID is required.");
        const existing = await tx.profileWorkflow.findUnique({ where: { id: request.workflowId } });
        if (existing) {
          if (existing.actorAuthId !== actor.authId || existing.actorRole !== actor.role || existing.targetAuthId !== targetAuthId
            || existing.kind !== request.kind || existing.inputHash !== inputHash) conflict();
          return status(existing);
        }
        const expectedVersion = await deps.inspect(tx, actor, request.kind, targetAuthId, request.input);
        return status(await tx.profileWorkflow.create({ data: { id: request.workflowId, actorAuthId: actor.authId,
          actorRole: actor.role, targetAuthId, kind: request.kind, inputHash, expectedVersion,
          prepareOperationId: metadata!.operationId, state: "prepared" } }));
      });
    },
    async status(actor: Actor, id: string) {
      z.uuid().parse(id);
      return db.$transaction(async (tx) => {
        const row = await tx.profileWorkflow.findUnique({ where: { id } });
        if (!row) throw new ProfileError(404, "Profile workflow not found.");
        authorize(actor, row.kind as ProfileWorkflowKind, row.targetAuthId);
        if (row.actorAuthId !== actor.authId || row.actorRole !== actor.role) throw new ProfileError(403, "Forbidden.");
        // Recheck the independent DB admin marker, even for an already committed workflow.
        if (actor.role === "admin") await deps.inspect(tx, actor, row.kind as ProfileWorkflowKind, row.targetAuthId, undefined);
        return status(row);
      }, { isolationLevel: "Serializable" });
    },
    async commit(actor: Actor, id: string, body: unknown, metadata?: ProfileCommandMetadata, expectedKind?: "doctor.provision" | "doctor.specialty") {
      z.uuid().parse(id);
      const request = commitProfileWorkflowSchema.parse(body);
      // Signed transport binds this entire body, including the receipt, before this module is invoked.
      if (actor.role === "service") throw new ProfileError(403, "Forbidden.");
      requireScope(actor, actor.role === "admin" ? "profile.admin.write" : "profile.write", actor.resource);
      return deps.mutate({ actor, operation: expectedKind ?? "workflow.commit", metadata, input: { workflowId: id, ...request }, targetAuthId: actor.resource }, async (tx) => {
        if (!metadata) throw new ProfileError(401, "A signed mutation ID is required.");
        const row = await tx.profileWorkflow.findUnique({ where: { id } });
        if (!row) throw new ProfileError(404, "Profile workflow not found.");
        const kind = row.kind as ProfileWorkflowKind;
        if (expectedKind && kind !== expectedKind) conflict();
        authorize(actor, kind, row.targetAuthId);
        if (row.actorAuthId !== actor.authId || row.actorRole !== actor.role
          || canonicalHash("PROFILE", kind, request.input) !== row.inputHash
          || metadata?.operationId === row.prepareOperationId || metadata?.operationId === id) conflict();
        deps.validate(kind, request.input);
        const parsed = (kind === "patient.onboarding" ? patientProfileReceiptSchema : doctorProfileReceiptSchema).safeParse(request.receipt);
        if (!parsed.success) conflict();
        const receipt = parsed.data;
        if (receipt.operationId !== id || receipt.inputHash !== row.inputHash) conflict();
        if ("department" in receipt) {
          if (receipt.authId !== undefined && receipt.authId !== row.targetAuthId) conflict();
          if (kind === "doctor.provision" && receipt.authId !== row.targetAuthId) conflict();
          const input = deps.validate(kind, request.input) as { specialty?: string | null };
          if (input.specialty !== receipt.department.name) conflict();
        }
        const currentVersion = await deps.inspect(tx, actor, kind, row.targetAuthId, request.input);
        if (row.state !== "prepared" || currentVersion !== row.expectedVersion) conflict();
        const result = await deps.apply(tx, actor, kind, row.targetAuthId, request.input, receipt);
        await tx.profileWorkflow.update({ where: { id }, data: { state: "committed",
          receipt: receipt as Prisma.InputJsonValue, commitOperationId: metadata!.operationId } });
        return { ...status({ ...row, state: "committed" }), data: result };
      });
    },
  };
}
