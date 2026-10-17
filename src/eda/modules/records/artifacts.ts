import { randomUUID } from "node:crypto";
import { ArtifactError, MAX_UPLOAD_BYTES, sha256, validateUpload, type RecordsMime } from "./upload-validation.js";
import { createPrescriptionPdfBuffer, createCertificatePdfBuffer, type PrescriptionPdf, type CertificatePdf, type RecordsFontConfig } from "./pdf.js";
import type { RecordsStorage, StoredContent } from "./storage.js";
import type { RecordsScanner, ScanEvidence } from "./scanner.js";

export type ArtifactPrepared = StoredContent & { objectKey: string };
export type ArtifactJob = {
  operationId: string; assetId: string; documentId?: string; patientId: string;
  kind: "upload" | "prescription" | "medical-certificate";
  attempts: number; fence: number;
  input?: StoredContent & { objectKey: string };
  prepared?: ArtifactPrepared;
};
export type ArtifactClaim = { operationId: string; leaseOwner: string; fence: number };
export type ArtifactScanEvidence = { input?: ScanEvidence; final: ScanEvidence };
export type ArtifactPublication = ArtifactPrepared & { scanEvidence: ArtifactScanEvidence };

// The owner implements each method as one fenced Core transaction. No callback is a provider transaction.
export interface ArtifactRepository {
  claimDue(options: { leaseOwner: string; leaseMs: number; now: Date }): Promise<ArtifactJob | null>;
  renew(claim: ArtifactClaim, options: { leaseMs: number; now: Date }): Promise<boolean>;
  savePrepared(claim: ArtifactClaim, prepared: ArtifactPrepared): Promise<boolean>;
  recordScan(claim: ArtifactClaim, evidence: ArtifactScanEvidence): Promise<boolean>;
  publish(claim: ArtifactClaim, publication: ArtifactPublication): Promise<boolean>;
  retry(claim: ArtifactClaim, options: { errorCode: string; nextAttemptAt: Date; blocked: boolean }): Promise<void>;
  reject(claim: ArtifactClaim, errorCode: string): Promise<void>;
}
export type CanonicalDocument = { kind: "prescription"; data: PrescriptionPdf } | { kind: "medical-certificate"; data: CertificatePdf };
export type RecordsArtifactDependencies = {
  repository: ArtifactRepository; storage: RecordsStorage; scanner: RecordsScanner;
  decryptCanonicalData(job: ArtifactJob): Promise<CanonicalDocument>;
  fonts?: RecordsFontConfig;
};
function evidenceMatches(evidence: ScanEvidence, bytes: Buffer, now: number): void {
  const scannedAt = Date.parse(evidence.scannedAt);
  if (evidence.verdict !== "clean" || evidence.engine !== "clamav" || evidence.contentHash !== sha256(bytes) || evidence.byteLength !== bytes.length || !Number.isFinite(scannedAt) || scannedAt > now + 5000 || now - scannedAt > 60000) throw new ArtifactError("SCAN_EVIDENCE_MISMATCH");
}
function samePrepared(a: ArtifactPrepared, b: ArtifactPrepared): boolean { return a.objectKey === b.objectKey && a.contentHash === b.contentHash && a.byteLength === b.byteLength && a.mimeType === b.mimeType; }

export class RecordsArtifactWorker {
  private busy = false;
  private readonly leaseOwner: string;
  constructor(private readonly dependencies: RecordsArtifactDependencies, private readonly options: { enabled?: boolean; leaseOwner?: string; now?: () => number } = {}) {
    this.leaseOwner = options.leaseOwner ?? randomUUID();
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  async runOnce(parent?: AbortSignal): Promise<number> {
    if (this.options.enabled !== true || this.busy || parent?.aborted) return 0;
    this.busy = true;
    try {
      const job = await this.dependencies.repository.claimDue({ leaseOwner: this.leaseOwner, leaseMs: 60000, now: new Date(this.now()) });
      if (!job) return 0;
      await this.process(job, parent); return 1;
    } finally { this.busy = false; }
  }
  private async process(job: ArtifactJob, parent?: AbortSignal): Promise<void> {
    const { repository, storage, scanner } = this.dependencies;
    const claim: ArtifactClaim = { operationId: job.operationId, leaseOwner: this.leaseOwner, fence: job.fence };
    const controller = new AbortController();
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    let renewing: Promise<void> | undefined;
    const lease = setInterval(() => {
      if (renewing) return;
      renewing = repository.renew(claim, { leaseMs: 60000, now: new Date(this.now()) }).then(ok => { if (!ok) controller.abort(); }, () => controller.abort()).finally(() => { renewing = undefined; });
    }, 15000);
    const requireLease = (ok = true) => { if (!ok || signal.aborted) throw new ArtifactError("ARTIFACT_LEASE_LOST", true); };
    try {
      requireLease();
      let bytes: Buffer; let mimeType: RecordsMime; let inputEvidence: ScanEvidence | undefined;
      if (job.kind === "upload") {
        if (!job.input) throw new ArtifactError("ARTIFACT_INPUT_MISSING", true);
        const raw = await storage.readQuarantine(job.input.objectKey, job.input, signal);
        inputEvidence = await scanner.scan(raw, signal); evidenceMatches(inputEvidence, raw, this.now()); requireLease();
        const output = await validateUpload(raw, job.input.mimeType); bytes = output.bytes; mimeType = output.mimeType;
      } else {
        const canonical = await this.dependencies.decryptCanonicalData(job);
        if (canonical.kind !== job.kind) throw new ArtifactError("ARTIFACT_DOCUMENT_KIND_MISMATCH");
        bytes = canonical.kind === "prescription" ? await createPrescriptionPdfBuffer(canonical.data, this.dependencies.fonts) : await createCertificatePdfBuffer(canonical.data, this.dependencies.fonts);
        mimeType = "application/pdf";
      }
      if (bytes.length > MAX_UPLOAD_BYTES) throw new ArtifactError("ARTIFACT_SIZE_INVALID");
      const prepared: ArtifactPrepared = { contentHash: sha256(bytes), byteLength: bytes.length, mimeType, objectKey: storage.key("final", job.assetId, sha256(bytes), mimeType) };
      if (job.prepared && !samePrepared(job.prepared, prepared)) throw new ArtifactError("ARTIFACT_CANONICAL_OUTPUT_CONFLICT");
      requireLease(await repository.savePrepared(claim, prepared));
      const finalEvidence = await scanner.scan(bytes, signal); evidenceMatches(finalEvidence, bytes, this.now()); requireLease();
      const scanEvidence: ArtifactScanEvidence = { ...(inputEvidence ? { input: inputEvidence } : {}), final: finalEvidence };
      requireLease(await repository.recordScan(claim, scanEvidence));
      await storage.ensureFinal(prepared.objectKey, bytes, mimeType, signal); requireLease();
      // Inspect exact bytes on crash recovery, not ETag or an upload acknowledgement alone.
      if (!await storage.inspectFinal(prepared.objectKey, prepared, signal)) throw new ArtifactError("ARTIFACT_OBJECT_MISSING", true);
      evidenceMatches(finalEvidence, bytes, this.now());
      requireLease(await repository.publish(claim, { ...prepared, scanEvidence }));
    } catch (error) {
      const safe = error instanceof ArtifactError ? error : new ArtifactError("ARTIFACT_DEPENDENCY_UNAVAILABLE", true);
      // A lost lease or shutdown cannot mutate the state claimed by a newer process.
      if (!signal.aborted) {
        if (!safe.retryable) await repository.reject(claim, safe.code);
        else {
          const attempts = Math.max(1, job.attempts);
          const seconds = [60, 300, 900, 3600][Math.min(attempts - 1, 3)]!;
          await repository.retry(claim, { errorCode: safe.code, nextAttemptAt: new Date(this.now() + seconds * 1000), blocked: attempts >= 10 });
        }
      }
    } finally { clearInterval(lease); if (renewing) await renewing; }
  }
}
