import { createHash } from "node:crypto";
import { PDFDocument, PDFDict, PDFName, PDFArray, PDFRawStream } from "pdf-lib";
import sharp from "sharp";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_MULTIPART_BYTES = 11 * 1024 * 1024;
export type RecordsMime = "application/pdf" | "image/png" | "image/jpeg" | "image/webp";
export class ArtifactError extends Error {
  constructor(readonly code: string, readonly retryable = false) { super(code); }
}
export function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
export function assertUploadSize(bytes: Buffer): void {
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new ArtifactError("UPLOAD_SIZE_INVALID");
}
export function detectRecordsMime(bytes: Buffer): RecordsMime {
  if (bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) return "application/pdf";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new ArtifactError("UPLOAD_FORMAT_UNSUPPORTED");
}

async function validatePdf(bytes: Buffer): Promise<void> {
  // Reject truncated/polyglot envelopes before the parser's recovery behavior.
  const tail = bytes.subarray(Math.max(0, bytes.length - 1024)).toString("latin1");
  const end = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  if (!end) throw new ArtifactError("PDF_MALFORMED");
  const offset = Number(end[1]);
  if (!Number.isSafeInteger(offset) || offset < 8 || offset >= bytes.length) throw new ArtifactError("PDF_MALFORMED");
  const xref = bytes.toString("latin1", offset, Math.min(offset + 256, bytes.length));
  if (!/^xref\s/.test(xref) && !(/^\d+\s+\d+\s+obj\b/.test(xref) && /\/Type\s*\/XRef\b/.test(xref))) throw new ArtifactError("PDF_MALFORMED");
  try {
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false });
    if (pdf.isEncrypted) throw new ArtifactError("PDF_ENCRYPTED");
    if (pdf.getPageCount() < 1 || pdf.getPageCount() > 100) throw new ArtifactError("PDF_LIMIT_EXCEEDED");
    const objects = pdf.context.enumerateIndirectObjects();
    if (objects.length > 50000) throw new ArtifactError("PDF_LIMIT_EXCEEDED");
    const forbiddenKeys = new Set(["JS", "JavaScript", "OpenAction", "AA", "EmbeddedFiles", "EF", "XFA", "RichMediaContent"]);
    const forbiddenActions = new Set(["JavaScript", "Launch", "SubmitForm", "ImportData", "GoToR", "GoToE", "Rendition", "URI"]);
    const visited = new Set<unknown>(); let nodes = 0;
    const visit = (value: unknown, depth: number): void => {
      if (!value || typeof value !== "object" || visited.has(value)) return;
      if (++nodes > 200000 || depth > 50) throw new ArtifactError("PDF_LIMIT_EXCEEDED");
      visited.add(value);
      if (value instanceof PDFRawStream) { visit(value.dict, depth + 1); return; }
      if (value instanceof PDFArray) { for (let index = 0; index < value.size(); index++) visit(value.get(index), depth + 1); return; }
      if (!(value instanceof PDFDict)) return;
      for (const [key, item] of value.entries()) {
        if (forbiddenKeys.has(key.decodeText())) throw new ArtifactError("PDF_ACTIVE_CONTENT");
        if (item instanceof PDFName && ((key.decodeText() === "S" && forbiddenActions.has(item.decodeText())) || (key.decodeText() === "Type" && ["Filespec", "EmbeddedFile"].includes(item.decodeText())) || (key.decodeText() === "Subtype" && ["RichMedia", "3D"].includes(item.decodeText())))) throw new ArtifactError("PDF_ACTIVE_CONTENT");
        visit(item, depth + 1);
      }
    };
    for (const [, value] of objects) visit(value, 0);
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError("PDF_MALFORMED_OR_ENCRYPTED");
  }
}

if (!isMainThread && workerData?.recordsPdfValidation === true) {
  void validatePdf(Buffer.from(workerData.bytes as Uint8Array)).then(
    () => parentPort?.postMessage({ ok: true }),
    error => parentPort?.postMessage({ ok: false, code: error instanceof ArtifactError ? error.code : "PDF_MALFORMED" }),
  );
}
function validatePdfBounded(bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { recordsPdfValidation: true, bytes }, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
    let complete = false;
    const finish = (error?: ArtifactError) => {
      if (complete) return; complete = true; clearTimeout(timer); void worker.terminate();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new ArtifactError("PDF_VALIDATION_LIMIT_EXCEEDED")), 10000);
    worker.once("error", () => finish(new ArtifactError("PDF_VALIDATION_UNAVAILABLE", true)));
    worker.once("exit", () => finish(new ArtifactError("PDF_VALIDATION_LIMIT_EXCEEDED")));
    worker.once("message", (result: { ok?: boolean; code?: string }) => {
      if (result.ok === true) finish();
      else finish(new ArtifactError(typeof result.code === "string" && /^PDF_[A-Z_]+$/.test(result.code) ? result.code : "PDF_MALFORMED"));
    });
  });
}

export type ValidatedUpload = { bytes: Buffer; mimeType: RecordsMime; inputHash: string; contentHash: string; byteLength: number };
export async function validateUpload(input: Buffer, declaredMime?: string): Promise<ValidatedUpload> {
  assertUploadSize(input);
  const mimeType = detectRecordsMime(input);
  if (declaredMime !== undefined && declaredMime !== mimeType) throw new ArtifactError("UPLOAD_MIME_MISMATCH");
  let bytes: Buffer;
  if (mimeType === "application/pdf") {
    await validatePdfBounded(input);
    bytes = Buffer.from(input);
  } else {
    try {
      const pipeline = sharp(input, { failOn: "warning", limitInputPixels: 40000000, sequentialRead: true, animated: false });
      const metadata = await pipeline.metadata();
      const format = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" }[mimeType];
      if (metadata.format !== format || !metadata.width || !metadata.height || metadata.width > 12000 || metadata.height > 12000 || (metadata.pages ?? 1) !== 1) throw new ArtifactError("IMAGE_UNSAFE");
      // Decode/re-encode instead of copying EXIF, embedded payloads or trailing bytes.
      const rotated = pipeline.rotate().timeout({ seconds: 10 });
      bytes = await (mimeType === "image/png" ? rotated.png() : mimeType === "image/jpeg" ? rotated.jpeg({ quality: 95 }) : rotated.webp({ quality: 95 })).toBuffer();
    } catch (error) {
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactError("IMAGE_MALFORMED_OR_LIMIT_EXCEEDED");
    }
  }
  assertUploadSize(bytes);
  return { bytes, mimeType, inputHash: sha256(input), contentHash: sha256(bytes), byteLength: bytes.length };
}
