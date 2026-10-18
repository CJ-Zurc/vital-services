import { z } from "zod";

export const profileWorkflowKindSchema = z.enum([
  "patient.onboarding", "doctor.onboarding", "doctor.provision", "doctor.specialty", "doctor.update",
]);
export type ProfileWorkflowKind = z.infer<typeof profileWorkflowKindSchema>;

export const prepareProfileWorkflowSchema = z.object({
  workflowId: z.uuid(),
  kind: profileWorkflowKindSchema,
  targetAuthId: z.uuid().optional(),
  input: z.unknown().refine((value) => value !== undefined, "Input is required."),
}).strict();
export const commitProfileWorkflowSchema = z.object({
  input: z.unknown().refine((value) => value !== undefined, "Input is required."),
  receipt: z.unknown(),
}).strict();
const binding = { operationId: z.uuid(), inputHash: z.string().regex(/^[a-f0-9]{64}$/) };
export const patientProfileReceiptSchema = z.object({
  ...binding,
  ehrPatientId: z.string().trim().min(1).max(128),
  ehrRecordOrigin: z.enum(["preexisting", "created_by_vital"]),
}).strict();
export const doctorProfileReceiptSchema = z.object({
  ...binding,
  department: z.object({ id: z.string().trim().min(1).max(160), name: z.string().trim().min(1).max(160) }).strict(),
  authId: z.uuid().optional(),
}).strict();
export type ProfileReceipt = z.infer<typeof patientProfileReceiptSchema> | z.infer<typeof doctorProfileReceiptSchema>;
export type ProfileSyncStatus = "pending" | "failed" | "synced";
export type ProfileSyncStatuses = (authIds: string[]) => Promise<Map<string, ProfileSyncStatus>>;
export interface ProfileWorkflowStatus {
  workflowId: string;
  kind: ProfileWorkflowKind;
  targetAuthId: string;
  inputHash: string;
  expectedVersion: number;
  state: "prepared" | "committed";
}
