import { z } from "zod";
import { DomainError } from "../../contracts/actor.js";
import type { ScanEvidence } from "../records/scanner.js";

export const PROFILE_QR_LIMIT = 5 * 1024 * 1024;
export const profileQrDescriptor = z.object({
  operationId: z.uuid(), paymentProvider: z.enum(["gcash", "maya"]),
  byteLength: z.number().int().positive().max(PROFILE_QR_LIMIT),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
}).strict();
export type QrDescriptor = z.infer<typeof profileQrDescriptor>;
export type QrCommand = { operationId: string; requestHash: string };
export type QrRow = { id: string; doctorId: string; paymentProvider: "gcash" | "maya"; filePath: string; isActive: boolean; createdAt: Date };
export type QrAsset = {
  schema: "profile-qr.v1"; id: string; doctorId: string; descriptor: QrDescriptor;
  state: "pending" | "ready" | "rejected"; errorCode?: string;
  correlationId?: string;
  content?: { contentHash: string; byteLength: number; mimeType: QrDescriptor["mimeType"]; evidence: ScanEvidence };
};
export type QrJob = { actorId: string; operationId: string; asset: QrAsset; leaseOwner: string };
export const qrFilePath = (id: string) => `/api/doctor/payment-qr/${z.uuid().parse(id)}/file`;
export function qrDenied(status: number, code: string): never {
  throw new DomainError(status, code, "Payment QR operation could not be completed.");
}
export function qrDto(row: QrRow) {
  return { id: row.id, doctorId: row.doctorId, paymentProvider: row.paymentProvider,
    filePath: qrFilePath(row.id), isActive: row.isActive, createdAt: row.createdAt.toISOString() };
}
