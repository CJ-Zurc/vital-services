import { requireScope, type Actor } from "../../contracts/actor.js";
import { ArtifactError, detectRecordsMime, sha256, validateUpload } from "../records/upload-validation.js";
import { verifyFileInspection, type FileInspector, type FileInspectionPolicy, type FileInspectionEvidence } from "../records/inspection.js";
import type { RecordsStorage } from "../records/storage.js";
import { PROFILE_QR_LIMIT, profileQrDescriptor, qrDenied, qrDto, type QrAsset, type QrCommand } from "./profile-qr-contracts.js";
import type { ProfileQrRepository } from "./profile-qr-repository.js";

// Reuse byte-safety adapters, not Records authorization, tables, events or runtime flags.
export type ProfileQrStorage = Pick<RecordsStorage, "key" | "readQuarantine" | "putQuarantine" | "ensureFinal" | "inspectFinal">;
function assertBytes(bytes: Buffer) {
  if (!bytes.length || bytes.length > PROFILE_QR_LIMIT) qrDenied(413, "PROFILE_QR_SIZE_INVALID");
}
function own(actor: Actor, write = false) {
  if (actor.role !== "doctor") qrDenied(403, "PROFILE_QR_DOCTOR_REQUIRED");
  requireScope(actor, write ? "profile.qr.write" : "profile.qr.read", actor.authId);
}
export function verifyQrScan(evidence: FileInspectionEvidence, bytes: Buffer, now: number, historical = false, policy: FileInspectionPolicy = 'clamav') {
  try { verifyFileInspection(evidence, { contentHash:sha256(bytes), byteLength:bytes.length }, now, policy, historical, 300000); }
  catch { throw new ArtifactError('SCANNER_EVIDENCE_INVALID', true); }
}
export function createProfileQrModule(repository: ProfileQrRepository, storage: ProfileQrStorage, scanner: FileInspector, clock = Date.now) {
  let active = 0;
  const originalKey = (asset: QrAsset) => storage.key("quarantine", asset.id, asset.descriptor.sha256, asset.descriptor.mimeType);
  const contentKey = (asset: QrAsset, area: "quarantine" | "final") => {
    if (!asset.content) qrDenied(409, "PROFILE_QR_NOT_READY");
    return storage.key(area, asset.id, asset.content.contentHash, asset.content.mimeType);
  };
  async function process(actorId: string, operationId: string, signal?: AbortSignal) {
    if (active >= 2) return;
    active++;
    let job: Awaited<ReturnType<ProfileQrRepository["claim"]>> = null;
    try {
      job = await repository.claim(actorId, operationId);
      if (!job) return;
      const descriptor = profileQrDescriptor.parse(job.asset.descriptor);
      const input = await storage.readQuarantine(originalKey(job.asset), { contentHash: descriptor.sha256, byteLength: descriptor.byteLength, mimeType: descriptor.mimeType }, signal);
      assertBytes(input);
      if (sha256(input) !== descriptor.sha256 || input.length !== descriptor.byteLength || detectRecordsMime(input) !== descriptor.mimeType) qrDenied(400, "PROFILE_QR_BYTES_MISMATCH");
      verifyQrScan(await scanner.scan(input, signal), input, clock(), false, scanner.policy);
      const validated = await validateUpload(input, descriptor.mimeType);
      assertBytes(validated.bytes);
      const evidence = await scanner.scan(validated.bytes, signal);
      verifyQrScan(evidence, validated.bytes, clock(), false, scanner.policy);
      const content: NonNullable<QrAsset["content"]> = { contentHash: validated.contentHash, byteLength: validated.byteLength, mimeType: descriptor.mimeType, evidence };
      const ready = { ...job.asset, content };
      // The private normalized mirror permits verified byte reads using the existing storage adapter.
      // Neither quarantine namespace is ever directly browser-readable or signed for clients.
      await storage.putQuarantine(contentKey(ready, "quarantine"), validated.bytes, descriptor.mimeType, signal);
      await storage.ensureFinal(contentKey(ready, "final"), validated.bytes, descriptor.mimeType, signal);
      if (!await storage.inspectFinal(contentKey(ready, "final"), content, signal)) throw new ArtifactError("STORAGE_OBJECT_MISSING", true);
      verifyQrScan(evidence, validated.bytes, clock(), false, scanner.policy);
      await repository.finish(job, content);
    } catch (error) {
      if (!job) throw error;
      const rejected = error instanceof ArtifactError && !error.retryable && /^(IMAGE_|UPLOAD_)/.test(error.code);
      await repository.release(job, rejected ? "PROFILE_QR_IMAGE_REJECTED" : undefined);
    } finally { active--; }
  }
  async function receipt(actor: Actor, asset: QrAsset, write = false) {
    const base = { operationId: asset.descriptor.operationId, operationStatus: asset.state === "ready" ? "completed" : asset.state };
    if (asset.state !== "ready") return { ...base, qrCode: null, ...(asset.errorCode ? { errorCode: asset.errorCode } : {}) };
    return { ...base, qrCode: qrDto((await repository.ready(actor, asset.id, write)).row) };
  }
  return {
    async upload(actor: Actor, meta: QrCommand, raw: unknown, input: Buffer) {
      own(actor, true); const descriptor = profileQrDescriptor.parse(raw);
      if (descriptor.operationId !== meta.operationId) qrDenied(409, "PROFILE_QR_OPERATION_MISMATCH");
      const bytes = Buffer.from(input); assertBytes(bytes);
      if (bytes.length !== descriptor.byteLength || sha256(bytes) !== descriptor.sha256 || detectRecordsMime(bytes) !== descriptor.mimeType) qrDenied(400, "PROFILE_QR_BYTES_MISMATCH");
      const asset = await repository.reserve(actor, meta, descriptor);
      if (asset.state === "pending") {
        try { await storage.putQuarantine(originalKey(asset), bytes, descriptor.mimeType); }
        catch { return receipt(actor, asset, true); }
      }
      return receipt(actor, await repository.status(actor, meta.operationId, true), true);
    },
    async status(actor: Actor, id: string) { own(actor); return receipt(actor, await repository.status(actor, id)); },
    async list(actor: Actor) { own(actor); return { qrCodes: (await repository.list(actor)).map(qrDto) }; },
    async activate(actor: Actor, id: string, meta: QrCommand, isActive: boolean) {
      own(actor, true); return { qrCode: qrDto(await repository.activate(actor, id, meta, isActive)) };
    },
    async file(actor: Actor, id: string) {
      own(actor); const { asset } = await repository.ready(actor, id);
      const content = asset.content!;
      if (!await storage.inspectFinal(contentKey(asset, "final"), content)) qrDenied(503, "PROFILE_QR_STORAGE_UNAVAILABLE");
      const bytes = await storage.readQuarantine(contentKey(asset, "quarantine"), content);
      assertBytes(bytes);
      verifyQrScan(content.evidence, bytes, clock(), true, scanner.policy);
      if (sha256(bytes) !== content.contentHash || bytes.length !== content.byteLength || detectRecordsMime(bytes) !== content.mimeType) qrDenied(503, "PROFILE_QR_STORAGE_UNAVAILABLE");
      return { id, mimeType: content.mimeType, byteLength: bytes.length, sha256: content.contentHash, base64: bytes.toString("base64") };
    },
    async recoverOnce(signal?: AbortSignal) {
      const jobs = await repository.pending();
      for (const job of jobs) { if (signal?.aborted) break; await process(job.actorId, job.operationId, signal); }
      return jobs.length;
    },
  };
}
export type ProfileQrModule = ReturnType<typeof createProfileQrModule>;
