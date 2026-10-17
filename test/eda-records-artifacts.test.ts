import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Duplex, Readable } from "node:stream";
import { existsSync } from "node:fs";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import sharp from "sharp";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { ArtifactError, MAX_UPLOAD_BYTES, MAX_MULTIPART_BYTES, detectRecordsMime, sha256, validateUpload } from "../src/eda/modules/records/upload-validation.js";
import { S3RecordsStorage, type RecordsStorage, type StoredContent } from "../src/eda/modules/records/storage.js";
import { ClamAvScanner, verifyClamAvPolicy, type ClamAvIo, type ScanEvidence, type RecordsScanner } from "../src/eda/modules/records/scanner.js";
import { createPrescriptionPdfBuffer, createCertificatePdfBuffer, philippineDate, type PrescriptionPdf } from "../src/eda/modules/records/pdf.js";
import { RecordsArtifactWorker, type ArtifactJob, type ArtifactPrepared, type ArtifactRepository, type ArtifactPublication } from "../src/eda/modules/records/artifacts.js";

const now = Date.parse("2026-10-13T09:00:00Z");
const base: PrescriptionPdf = { accessCode: "RX-12345678", patientName: "Patient Example", doctorName: "Doctor Example", doctorLicense: "12345", issuedAt: new Date("2026-10-12T17:00:00Z"), lines: [{ medicineName: "Amoxicillin", dosageAmount: "500", dosageUnit: "mg", frequency: "Twice daily", duration: "7 days", route: "Oral", quantity: "14", instructions: "After meals" }] };
async function png(): Promise<Buffer> { return sharp({ create: { width: 8, height: 8, channels: 3, background: "#ff0000" } }).png().toBuffer(); }
const clamConfig = { socketPath: "/run/clamav/clamd.sock", daemonConfigPath: "/etc/clamav/clamd.conf", deadlineMs: 1000, maxDatabaseAgeMs: 86400000 };
const policy = "LocalSocket /run/clamav/clamd.sock\nAlertExceedsMax yes\nAlertEncrypted yes\nScanPDF yes\nScanArchive yes\nStreamMaxLength 11M\nMaxFileSize 11M\nMaxScanSize 50M\n";
function protocolFixture(verdict = "stream: OK", version = "ClamAV 1.4.3/28000/Tue Oct 13 08:00:00 2026") {
  const requests: Buffer[] = [];
  const io: ClamAvIo = {
    policy: async config => verifyClamAvPolicy(policy, config),
    connect: async () => new Duplex({ read() {}, write(chunk: Buffer, _encoding, callback) {
      requests.push(Buffer.from(chunk)); callback();
      const response = Buffer.from(`${chunk.subarray(0, 9).toString() === "zVERSION\0" ? version : verdict}\0`);
      queueMicrotask(() => { this.push(response.subarray(0, 4)); this.push(response.subarray(4)); });
    } }),
  };
  return { scanner: new ClamAvScanner(clamConfig, io, () => now), requests, io };
}
function scanBytes(request: Buffer): Buffer {
  assert.equal(request.subarray(0, 10).toString(), "zINSTREAM\0");
  let offset = 10; const parts: Buffer[] = [];
  while (true) { const size = request.readUInt32BE(offset); offset += 4; if (size === 0) break; assert.ok(size <= 65536); parts.push(request.subarray(offset, offset + size)); offset += size; }
  assert.equal(offset, request.length); return Buffer.concat(parts);
}

test("Records uploads use actual format and preserve 10 MiB file / 11 MiB envelope boundaries", async () => {
  assert.equal(MAX_UPLOAD_BYTES, 10485760); assert.equal(MAX_MULTIPART_BYTES, 11534336);
  assert.throws(() => detectRecordsMime(Buffer.from("not a PDF")), /UPLOAD_FORMAT_UNSUPPORTED/);
  await assert.rejects(validateUpload(Buffer.alloc(MAX_UPLOAD_BYTES + 1)), /UPLOAD_SIZE_INVALID/);
  await assert.rejects(validateUpload(Buffer.alloc(0)), /UPLOAD_SIZE_INVALID/);
  await assert.rejects(validateUpload(await png(), "application/pdf"), /UPLOAD_MIME_MISMATCH/);
});
test("Records image pipeline strips metadata and trailing payloads and hashes exact output", async () => {
  for (const format of ["png", "jpeg", "webp"] as const) {
    const source = await sharp(await png()).withMetadata({ orientation: 6 }).toFormat(format).toBuffer();
    const input = Buffer.concat([source, Buffer.from("trailing-secret-payload")]);
    const result = await validateUpload(input);
    const metadata = await sharp(result.bytes).metadata();
    assert.equal(metadata.exif, undefined); assert.equal(metadata.icc, undefined);
    assert.equal(result.contentHash, sha256(result.bytes)); assert.equal(result.inputHash, sha256(input));
    assert.equal(result.bytes.includes(Buffer.from("trailing-secret-payload")), false);
  }
});
test("Records image validation rejects malformed files and oversized dimensions", async () => {
  await assert.rejects(validateUpload(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])), /IMAGE_MALFORMED/);
  const wide = await sharp({ create: { width: 12001, height: 1, channels: 3, background: "red" } }).png().toBuffer();
  await assert.rejects(validateUpload(wide), /IMAGE_UNSAFE/);
});
test("Records PDF parser rejects malformed, truncated and active documents", async () => {
  await assert.rejects(validateUpload(Buffer.from("%PDF-1.7\nnot a PDF\n%%EOF")), /PDF_MALFORMED/);
  const bytes = await createPrescriptionPdfBuffer(base);
  assert.equal((await validateUpload(bytes)).contentHash, sha256(bytes));
  await assert.rejects(validateUpload(bytes.subarray(0, bytes.length - 20)), /PDF_MALFORMED/);
  const pdf = await PDFDocument.create(); pdf.addPage();
  pdf.catalog.set(PDFName.of("OpenAction"), pdf.context.obj({ S: PDFName.of("JavaScript"), JS: PDFString.of("alert(1)") }));
  await assert.rejects(validateUpload(Buffer.from(await pdf.save())), /PDF_ACTIVE_CONTENT/);
});
test("Records PDF parser rejects an encrypted document instead of ignoring encryption", async () => {
  const pdf = await PDFDocument.create(); pdf.addPage();
  pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({ Filter: PDFName.of("Standard"), V: 4, R: 4 }));
  await assert.rejects(validateUpload(Buffer.from(await pdf.save())), /PDF_MALFORMED_OR_ENCRYPTED|PDF_ENCRYPTED/);
});
test("Records PDF templates are deterministic A4 documents with Philippine dates", async () => {
  const first = await createPrescriptionPdfBuffer(base); const second = await createPrescriptionPdfBuffer(base);
  assert.equal(sha256(first), sha256(second)); assert.equal(philippineDate(base.issuedAt), "10/13/2026");
  assert.match(philippineDate(base.issuedAt, true), /^10\/13\/2026, 1:00:00 AM$/);
  for (const bytes of [first, await createCertificatePdfBuffer({ ...base, purpose: "Medical leave", diagnosis: "Recorded impression", consultationDate: base.issuedAt, restStartDate: base.issuedAt, restEndDate: new Date("2026-10-14T00:00:00Z"), recommendation: "Rest", remarks: "Follow up" })]) {
    const pdf = await PDFDocument.load(bytes); assert.ok(pdf.getPageCount() >= 1);
    assert.equal(Math.round(pdf.getPages()[0]!.getWidth()), 595); assert.equal(Math.round(pdf.getPages()[0]!.getHeight()), 842);
    assert.equal(pdf.getCreationDate()?.toISOString(), base.issuedAt.toISOString());
  }
});
test("Records PDFs reject the entire malformed prescription and unsupported Unicode", async () => {
  await assert.rejects(createPrescriptionPdfBuffer({ ...base, lines: [...base.lines, { ...base.lines[0]!, medicineName: "" }] }), /DOCUMENT_FIELD_INVALID/);
  await assert.rejects(createPrescriptionPdfBuffer({ ...base, patientName: "Jos\u00e9" }), /DOCUMENT_UNICODE_FONT_REQUIRED/);
  await assert.rejects(createPrescriptionPdfBuffer({ ...base, patientName: "bad\u0000name" }), /DOCUMENT_FIELD_INVALID/);
  await assert.rejects(createPrescriptionPdfBuffer(base, { regularPath: "/does-not-exist.ttf", boldPath: "/does-not-exist.ttf" }), /DOCUMENT_FONT_UNAVAILABLE/);
});
const regularFont = ["C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].find(existsSync);
const boldFont = ["C:/Windows/Fonts/arialbd.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"].find(existsSync);
test("Records Unicode fonts render supported names and reject missing glyphs", { skip: !regularFont || !boldFont ? "No configured test font; font deployment remains an activation gate" : false }, async () => {
  const fonts = { regularPath: regularFont!, boldPath: boldFont! };
  const bytes = await createPrescriptionPdfBuffer({ ...base, patientName: "Jos\u00e9 Mu\u00f1oz" }, fonts);
  assert.ok(bytes.length > 1000);
  await assert.rejects(createPrescriptionPdfBuffer({ ...base, patientName: "unsupported \u{10ffff}" }, fonts), /DOCUMENT_UNICODE_UNSUPPORTED/);
});
test("Records ClamAV adapter sends exact binary INSTREAM frames and binds evidence", async () => {
  const f = protocolFixture(); const bytes = Buffer.alloc(200000, 23); const evidence = await f.scanner.scan(bytes);
  assert.equal(f.requests.length, 3); assert.deepEqual(scanBytes(f.requests[1]!), bytes);
  assert.equal(evidence.contentHash, sha256(bytes)); assert.equal(evidence.byteLength, bytes.length); assert.equal(evidence.databaseVersion, 28000);
});
test("Records ClamAV fails closed for malware, skips, limits, errors and malformed verdicts", async () => {
  for (const verdict of ["stream: Eicar-Test-Signature FOUND", "stream: Heuristics.Limits.Exceeded FOUND", "INSTREAM size limit exceeded. ERROR", "stream: skipped", "OK", "stream: OK\0trailing", "stream: UNKNOWN"]) {
    await assert.rejects(protocolFixture(verdict).scanner.scan(Buffer.from("test")), /UPLOAD_MALWARE_OR_SCAN_LIMIT|SCANNER_VERDICT_INVALID/);
  }
});
test("Records scanner rejects stale/future/malformed databases and unsafe daemon policies", async () => {
  for (const version of ["ClamAV 1.4.3/28000/Sun Oct 11 08:00:00 2026", "ClamAV 1.4.3/28000/Wed Oct 14 08:00:00 2026", "malformed"]) await assert.rejects(protocolFixture("stream: OK", version).scanner.scan(Buffer.from("test")), /SCANNER_DATABASE_STALE|SCANNER_VERSION_INVALID/);
  for (const unsafe of [policy + "TCPSocket 3310\n", policy.replace("AlertExceedsMax yes", "AlertExceedsMax no"), policy.replace("AlertEncrypted yes", "AlertEncrypted no"), policy.replace("StreamMaxLength 11M", "StreamMaxLength 1M"), policy.replace("MaxScanSize 50M", "MaxScanSize 1M")]) assert.throws(() => verifyClamAvPolicy(unsafe, clamConfig), /SCANNER_POLICY_UNVERIFIED/);
  assert.throws(() => new ClamAvScanner({ ...clamConfig, socketPath: "tcp://localhost:3310" }), /SCANNER_CONFIG_INVALID/);
});
test("Records scanner rejects database reload mid-scan and unavailable sockets", async () => {
  const f = protocolFixture(); let requests = 0;
  const connect = f.io.connect;
  f.io.connect = async (...args) => { requests++; if (requests === 3) return protocolFixture("stream: OK", "ClamAV 1.4.3/28001/Tue Oct 13 08:00:00 2026").io.connect(...args); return connect(...args); };
  await assert.rejects(f.scanner.scan(Buffer.from("test")), /SCANNER_DATABASE_CHANGED/);
  f.io.connect = async () => { throw new Error("private socket details"); };
  await assert.rejects(f.scanner.scan(Buffer.from("test")), /SCANNER_UNAVAILABLE/);
});
test("Records scanner timeout is indeterminate and closes the stream", async () => {
  let destroyed = false;
  const keepAlive = setTimeout(() => {}, 500);
  const io: ClamAvIo = { policy: async () => {}, connect: async () => new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); }, destroy(error, callback) { destroyed = true; callback(error); } }) };
  try { await assert.rejects(new ClamAvScanner({ ...clamConfig, deadlineMs: 100 }, io).scan(Buffer.from("test")), /SCANNER_TIMEOUT/); assert.equal(destroyed, true); }
  finally { clearTimeout(keepAlive); }
});

const storageConfig = { endpoint: "http://minio.internal:9000", publicEndpoint: "https://gateway.example/media/vital-web", bucket: "vital-records", region: "us-east-1", accessKeyId: "scoped-key", secretAccessKey: "scoped-secret", quarantinePrefix: "records/quarantine/", finalPrefix: "records/final/" };
function s3Fixture() {
  const objects = new Map<string, { bytes: Buffer; mimeType: string; metadata: Record<string, string> }>(); const commands: string[] = []; let loseAck = false;
  const client = { send: async (command: PutObjectCommand | GetObjectCommand | HeadObjectCommand) => {
    commands.push(command.constructor.name); const key = command.input.Key!;
    if (command instanceof PutObjectCommand) {
      assert.equal(command.input.IfNoneMatch, "*");
      if (objects.has(key)) throw { $metadata: { httpStatusCode: 412 } };
      objects.set(key, { bytes: Buffer.from(command.input.Body as Buffer), mimeType: command.input.ContentType!, metadata: command.input.Metadata! });
      if (loseAck) { loseAck = false; throw new Error("lost acknowledgement"); } return {};
    }
    const value = objects.get(key); if (!value) throw { $metadata: { httpStatusCode: 404 } };
    if (command instanceof HeadObjectCommand) return { ContentLength: value.bytes.length, ContentType: value.mimeType, Metadata: value.metadata };
    if (command instanceof GetObjectCommand) return { Body: Readable.from([value.bytes]), ContentLength: value.bytes.length };
    throw new Error("Unexpected storage command");
  } } as unknown as S3Client;
  return { storage: new S3RecordsStorage(storageConfig, client), objects, commands, loseAcknowledgement: () => { loseAck = true; } };
}
test("Records S3 adapter has stable immutable keys and exact-byte recovery without bucket creation", async () => {
  const f = s3Fixture(); const bytes = await png(); const key = f.storage.key("quarantine", randomUUID(), sha256(bytes), "image/png");
  await f.storage.putQuarantine(key, bytes, "image/png"); await f.storage.putQuarantine(key, bytes, "image/png");
  assert.equal(f.commands.filter(value => value === "PutObjectCommand").length, 1);
  assert.equal(f.commands.some(value => /Bucket/.test(value)), false);
  assert.deepEqual(await f.storage.readQuarantine(key, { contentHash: sha256(bytes), byteLength: bytes.length, mimeType: "image/png" }), bytes);
});
test("Records S3 lost acknowledgement recovers same key and rejects hash/metadata substitution", async () => {
  const f = s3Fixture(); const bytes = await png(); const key = f.storage.key("final", randomUUID(), sha256(bytes), "image/png");
  f.loseAcknowledgement(); await assert.rejects(f.storage.ensureFinal(key, bytes, "image/png"), /STORAGE_UNAVAILABLE/);
  await f.storage.ensureFinal(key, bytes, "image/png"); assert.equal(f.objects.size, 1);
  const expected: StoredContent = { contentHash: sha256(bytes), byteLength: bytes.length, mimeType: "image/png" };
  assert.equal(await f.storage.inspectFinal(key, expected), true);
  const objectBytes = f.objects.get(key)!.bytes; objectBytes[10] = objectBytes[10]! ^ 1;
  await assert.rejects(f.storage.inspectFinal(key, expected), /STORAGE_OBJECT_CONFLICT/);
  f.objects.get(key)!.metadata.sha256 = "a".repeat(64);
  await assert.rejects(f.storage.inspectFinal(key, expected), /STORAGE_OBJECT_CONFLICT/);
});
test("Records S3 denies URLs, arbitrary object keys, quarantine signing and missing config", async () => {
  const storage = s3Fixture().storage;
  for (const key of ["https://evil.test/file.pdf", "/uploads/file.pdf", "records/final/../secret", "records/quarantine/id/hash.pdf", "unscoped/file.pdf"]) await assert.rejects(storage.signedLink(key), /STORAGE_KEY_INVALID/);
  assert.throws(() => new S3RecordsStorage({ ...storageConfig, accessKeyId: "" }), /STORAGE_CONFIG_INVALID/);
  assert.throws(() => new S3RecordsStorage({ ...storageConfig, finalPrefix: "records/" }), /STORAGE_CONFIG_INVALID/);
});
test("Records signed links retain MinIO signing host and rewrite Gateway prefix with five-minute lifetime", async () => {
  const storage = new S3RecordsStorage(storageConfig); const key = storage.key("final", randomUUID(), "a".repeat(64), "application/pdf");
  const url = new URL(await storage.signedLink(key)); assert.equal(url.origin, "https://gateway.example");
  assert.equal(url.pathname, `/media/vital-web/vital-records/${key}`);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "300"); assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.equal(url.searchParams.get("response-cache-control"), "private, no-store");
});

function artifactFixture(input: Buffer) {
  const storageFixture = s3Fixture(); const assetId = randomUUID();
  const job: ArtifactJob = { operationId: randomUUID(), assetId, patientId: "local-patient", kind: "upload", attempts: 1, fence: 1, input: { objectKey: storageFixture.storage.key("quarantine", assetId, sha256(input), "image/png"), contentHash: sha256(input), byteLength: input.length, mimeType: "image/png" } };
  let available = true; let published: ArtifactPublication | undefined; let failPublish = false; let retry: { errorCode: string; nextAttemptAt: Date; blocked: boolean } | undefined; let rejected: string | undefined; const scans: Buffer[] = [];
  const repository: ArtifactRepository = {
    claimDue: async options => { assert.equal(options.leaseMs, 60000); if (!available) return null; available = false; return { ...job }; },
    renew: async () => true,
    savePrepared: async (_claim, prepared) => { job.prepared = prepared; return true; },
    recordScan: async () => true,
    publish: async (_claim, value) => { if (failPublish) { failPublish = false; throw new Error("Core commit failed"); } published = value; return true; },
    retry: async (_claim, value) => { retry = value; available = !value.blocked; job.attempts++; job.fence++; },
    reject: async (_claim, code) => { rejected = code; },
  };
  const scanner: RecordsScanner = { scan: async bytes => { scans.push(Buffer.from(bytes)); return { engine: "clamav", engineVersion: "1.4.3", databaseVersion: 28000, databaseDate: new Date(now).toISOString(), scannedAt: new Date(now).toISOString(), contentHash: sha256(bytes), byteLength: bytes.length, verdict: "clean" }; } };
  const dependencies = { repository, storage: storageFixture.storage as RecordsStorage, scanner, decryptCanonicalData: async () => ({ kind: "prescription" as const, data: base }) };
  const worker = new RecordsArtifactWorker(dependencies, { enabled: true, now: () => now });
  return { ...storageFixture, worker, job, dependencies, scans, upload: () => storageFixture.storage.putQuarantine(job.input!.objectKey, input, "image/png"), published: () => published, retry: () => retry, rejected: () => rejected, failPublication: () => { failPublish = true; }, requeue: () => { available = true; } };
}
test("Records artifact worker is default-off and processes at most one operation concurrently", async () => {
  const f = artifactFixture(await png()); await f.upload();
  assert.equal(await new RecordsArtifactWorker(f.dependencies).runOnce(), 0);
  const outcomes = await Promise.all([f.worker.runOnce(), f.worker.runOnce()]); assert.deepEqual(outcomes.sort(), [0, 1]);
  assert.ok(f.published()); assert.equal(f.scans.length, 2);
});
test("Records artifact worker scans input and transformed final bytes before publication", async () => {
  const source = await sharp(await png()).withMetadata().png().toBuffer(); const f = artifactFixture(source); await f.upload(); await f.worker.runOnce();
  const publication = f.published()!; assert.ok(publication); assert.equal(publication.scanEvidence.input?.contentHash, sha256(source));
  assert.equal(publication.scanEvidence.final.contentHash, publication.contentHash); assert.notEqual(publication.contentHash, sha256(source));
  assert.ok(f.objects.has(publication.objectKey));
});
test("Records artifact storage success then Core failure recovers without duplicate asset or issuance", async () => {
  const f = artifactFixture(await png()); await f.upload(); f.failPublication(); await f.worker.runOnce();
  assert.equal(f.published(), undefined); assert.equal(f.retry()?.errorCode, "ARTIFACT_DEPENDENCY_UNAVAILABLE");
  const before = f.commands.filter(value => value === "PutObjectCommand").length;
  await f.worker.runOnce(); assert.ok(f.published()); assert.equal(f.commands.filter(value => value === "PutObjectCommand").length, before); assert.equal(f.objects.size, 2);
});
test("Records artifact scanner outages retry durably while malware remains unpublished", async () => {
  for (const retryable of [true, false]) {
    const f = artifactFixture(await png()); await f.upload(); f.dependencies.scanner.scan = async () => { throw new ArtifactError(retryable ? "SCANNER_UNAVAILABLE" : "UPLOAD_MALWARE_OR_SCAN_LIMIT", retryable); };
    await f.worker.runOnce(); assert.equal(f.published(), undefined); assert.equal(f.objects.size, 1);
    if (retryable) assert.equal(f.retry()?.nextAttemptAt.toISOString(), new Date(now + 60000).toISOString()); else assert.equal(f.rejected(), "UPLOAD_MALWARE_OR_SCAN_LIMIT");
  }
});
test("Records artifact fencing, conflicting outputs and checksum substitution cannot publish", async () => {
  for (const kind of ["lease", "hash", "prepared"] as const) {
    const f = artifactFixture(await png()); await f.upload();
    if (kind === "lease") f.dependencies.repository.savePrepared = async () => false;
    if (kind === "hash") { const scan = f.dependencies.scanner.scan; f.dependencies.scanner.scan = async bytes => ({ ...await scan(bytes), contentHash: "b".repeat(64) }); }
    if (kind === "prepared") f.job.prepared = { objectKey: "conflict", contentHash: "c".repeat(64), byteLength: 1, mimeType: "image/png" };
    await f.worker.runOnce(); assert.equal(f.published(), undefined); assert.equal(f.objects.size, 1);
  }
});
test("Records artifact retries stop after ten failures and never reopen clinical issuance", async () => {
  const f = artifactFixture(await png()); await f.upload(); f.job.attempts = 10;
  f.dependencies.scanner.scan = async () => { throw new ArtifactError("SCANNER_UNAVAILABLE", true); };
  await f.worker.runOnce(); assert.equal(f.retry()?.blocked, true); assert.equal(await f.worker.runOnce(), 0);
});
test("Records artifact document rendering consumes only committed canonical data", async () => {
  const f = artifactFixture(await png()); f.job.kind = "prescription"; f.job.input = undefined;
  await f.worker.runOnce(); const publication = f.published()!;
  assert.ok(publication); assert.equal(publication.mimeType, "application/pdf"); assert.equal(publication.scanEvidence.input, undefined);
  assert.equal(publication.contentHash, sha256(await createPrescriptionPdfBuffer(base))); assert.equal(f.objects.size, 1);
});
test("Records artifact prepared output survives unavailable storage without duplicate rendering identity", async () => {
  const f = artifactFixture(await png()); await f.upload();
  const ensure = f.dependencies.storage.ensureFinal.bind(f.dependencies.storage);
  f.dependencies.storage.ensureFinal = async () => { throw new ArtifactError("STORAGE_UNAVAILABLE", true); };
  await f.worker.runOnce(); assert.ok(f.job.prepared); assert.equal(f.published(), undefined);
  const original = { ...f.job.prepared! }; f.dependencies.storage.ensureFinal = ensure;
  await f.worker.runOnce(); assert.equal(f.published()?.objectKey, original.objectKey); assert.equal(f.published()?.contentHash, original.contentHash);
});
test("Records artifact scan evidence cannot be reused from expired processing", async () => {
  const f = artifactFixture(await png()); await f.upload();
  const scan = f.dependencies.scanner.scan; f.dependencies.scanner.scan = async bytes => ({ ...await scan(bytes), scannedAt: new Date(now - 61000).toISOString() });
  await f.worker.runOnce(); assert.equal(f.published(), undefined); assert.equal(f.rejected(), "SCAN_EVIDENCE_MISMATCH");
});
