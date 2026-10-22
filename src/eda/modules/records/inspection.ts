import { z } from 'zod';
import { ClamAvScanner, type ClamAvConfig, type ScanEvidence } from './scanner.js';
import { ArtifactError, sha256, validateUpload } from './upload-validation.js';

export type FileInspectionPolicy = 'clamav' | 'capstone-validation-only';
// Explicit temporary capstone build setting. Restore 'clamav' to require
// antivirus for new writes; NODE_ENV and browser input never select this policy.
export const FILE_INSPECTION_POLICY: FileInspectionPolicy = 'capstone-validation-only';

const binding = { contentHash: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().positive() };
const antivirusEvidence = z.object({ ...binding, engine: z.literal('clamav'), engineVersion: z.string().min(1),
  databaseVersion: z.number().int().positive(), databaseDate: z.iso.datetime(), scannedAt: z.iso.datetime(), verdict: z.literal('clean') }).strict();
const validationEvidence = z.object({ ...binding, policy: z.literal('capstone-validation-only'),
  verdict: z.literal('not_scanned'), validationVersion: z.literal(1), validatedAt: z.iso.datetime() }).strict();
export type ValidationOnlyEvidence = z.infer<typeof validationEvidence>;
export type FileInspectionEvidence = ScanEvidence | ValidationOnlyEvidence;
export interface FileInspector {
  // Older antivirus adapters/test doubles have no explicit policy property.
  readonly policy?: FileInspectionPolicy;
  scan(bytes: Buffer, signal?: AbortSignal): Promise<FileInspectionEvidence>;
}

export function verifyFileInspection(evidence: unknown, expected: { contentHash: string; byteLength: number },
  now: number, policy: FileInspectionPolicy = 'clamav', historical = false, futureTolerance = 5000): void {
  const parsed = z.union([antivirusEvidence, validationEvidence]).safeParse(evidence);
  if (!parsed.success) throw new ArtifactError('SCAN_EVIDENCE_MISMATCH');
  const value = parsed.data, antivirus = 'engine' in value;
  const inspectedAt = Date.parse(antivirus ? value.scannedAt : value.validatedAt);
  if (value.contentHash !== expected.contentHash || value.byteLength !== expected.byteLength ||
    inspectedAt > now + futureTolerance || (!historical && now - inspectedAt > 60000) ||
    (!historical && (antivirus ? 'clamav' : value.policy) !== policy)) throw new ArtifactError('SCAN_EVIDENCE_MISMATCH');
  if (antivirus) {
    const databaseAt = Date.parse(value.databaseDate);
    if (databaseAt > inspectedAt + 300000 || inspectedAt - databaseAt > 86400000) throw new ArtifactError('SCAN_EVIDENCE_MISMATCH');
  }
}

export function createFileInspector(clamav: () => ClamAvConfig, policy: FileInspectionPolicy = FILE_INSPECTION_POLICY,
  now: () => number = Date.now): FileInspector {
  if (policy === 'clamav') {
    const scanner = new ClamAvScanner(clamav());
    return { policy, scan: (bytes, signal) => scanner.scan(bytes, signal) };
  }
  if (policy !== 'capstone-validation-only') throw new ArtifactError('FILE_INSPECTION_POLICY_INVALID');
  return { policy, async scan(input, signal) {
    if (signal?.aborted) throw new ArtifactError('ARTIFACT_LEASE_LOST', true);
    const bytes = Buffer.from(input);
    // Real decoding/PDF validation, never a fabricated antivirus verdict. The
    // calling pipeline remains responsible for storing its normalized bytes.
    await validateUpload(bytes);
    if (signal?.aborted) throw new ArtifactError('ARTIFACT_LEASE_LOST', true);
    return { policy, verdict: 'not_scanned', validationVersion: 1, validatedAt: new Date(now()).toISOString(),
      contentHash: sha256(bytes), byteLength: bytes.length };
  } };
}
