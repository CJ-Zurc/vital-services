import { bghPrescription,bghCertificate,type SigningFields } from './bgh-pdf.js';
import PDFDocument from "pdfkit";
import { lstat } from "node:fs/promises";
import { ArtifactError, MAX_UPLOAD_BYTES } from "./upload-validation.js";

export type PrescriptionLine = {
  medicineId?: string | null; medicineName: string; dosageAmount: string; dosageUnit: string; frequency: string;
  duration?: string | null; route?: string | null; quantity?: string | null; instructions?: string | null;
};
export type DocumentBase = SigningFields & { accessCode: string; patientName: string; doctorName: string; doctorLicense: string; issuedAt: Date };
export type PrescriptionPdf = DocumentBase & { lines: PrescriptionLine[] };
export type CertificatePdf = DocumentBase & {
  purpose: string; diagnosis: string; consultationDate?: Date | null; restStartDate?: Date | null; restEndDate?: Date | null;
  recommendation?: string | null; remarks?: string | null;
};
export type RecordsFontConfig = { regularPath: string; boldPath: string };
type Fonts = { regular: string; bold: string };
function text(value: unknown, required = true, maximum = 2000): asserts value is string {
  if (typeof value !== "string" || value.length > maximum || (required && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new ArtifactError("DOCUMENT_FIELD_INVALID");
}
function date(value: Date): void { if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new ArtifactError("DOCUMENT_DATE_INVALID"); }
export function philippineDate(value: Date, withTime = false): string {
  date(value);
  return withTime ? value.toLocaleString("en-US", { timeZone: "Asia/Manila" }) : value.toLocaleDateString("en-US", { timeZone: "Asia/Manila" });
}
export function validatePrescriptionLines(lines: PrescriptionLine[]): void {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 50) throw new ArtifactError("PRESCRIPTION_LINES_INVALID");
  for (const line of lines) {
    if (!line || typeof line !== "object") throw new ArtifactError("PRESCRIPTION_LINES_INVALID");
    for (const name of ["medicineName", "dosageAmount", "dosageUnit", "frequency"] as const) text(line[name], true, 500);
    for (const name of ["duration", "route", "quantity", "instructions"] as const) if (line[name] !== undefined && line[name] !== null) text(line[name], false);
  }
}
function validateBase(base: DocumentBase): void {
  text(base.accessCode, true, 100); text(base.patientName, true, 1000); text(base.doctorName, true, 1000); text(base.doctorLicense, false, 100); date(base.issuedAt);
}
function printableValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(printableValues);
  if (value && typeof value === "object" && !(value instanceof Date)) return Object.values(value).flatMap(printableValues);
  return [];
}
async function fonts(doc: PDFKit.PDFDocument, values: string[], config?: RecordsFontConfig): Promise<Fonts> {
  if (values.reduce((total, value) => total + value.length, 0) > 64000) throw new ArtifactError("DOCUMENT_RENDER_LIMIT");
  if (!config) {
    if (values.some(value => /[^\x20-\x7e\r\n\t]/.test(value))) throw new ArtifactError("DOCUMENT_UNICODE_FONT_REQUIRED", true);
    return { regular: "Helvetica", bold: "Helvetica-Bold" };
  }
  try {
    for (const path of [config.regularPath, config.boldPath]) {
      if (!path) throw new ArtifactError("DOCUMENT_FONT_UNAVAILABLE", true);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 20 * 1024 * 1024) throw new ArtifactError("DOCUMENT_FONT_UNAVAILABLE", true);
    }
    doc.registerFont("records-regular", config.regularPath); doc.registerFont("records-bold", config.boldPath);
    for (const font of ["records-regular", "records-bold"]) {
      doc.font(font);
      const embedded = (doc as unknown as { _font?: { font?: { hasGlyphForCodePoint?: (code: number) => boolean } } })._font?.font;
      if (!embedded?.hasGlyphForCodePoint) throw new ArtifactError("DOCUMENT_FONT_UNAVAILABLE", true);
      for (const value of [...values, "VITAL Hospital Network", "Official clinical document generated from Vital consultation records", "Prescription Medical Certificate Patient Issued Document Code Medication Instructions PRC License Purpose Diagnosis / Impression Recommended Rest / Excuse Consultation Date Recommendation Remarks N/A Not provided Dose Frequency Route Duration Quantity Instructions", "0123456789.,:/-|"])
        for (const char of value) if (!/[\r\n\t]/.test(char) && !embedded.hasGlyphForCodePoint(char.codePointAt(0)!)) throw new ArtifactError("DOCUMENT_UNICODE_UNSUPPORTED");
    }
    return { regular: "records-regular", bold: "records-bold" };
  } catch (error) { if (error instanceof ArtifactError) throw error; throw new ArtifactError("DOCUMENT_FONT_UNAVAILABLE", true); }
}
function header(doc: PDFKit.PDFDocument, title: string, font: Fonts): void {
  doc.fontSize(18).font(font.bold).text("VITAL Hospital Network", { align: "center" });
  doc.moveDown(0.25);
  doc.fontSize(10).font(font.regular).text("Official clinical document generated from Vital consultation records", { align: "center" });
  doc.moveDown(1); doc.fontSize(15).font(font.bold).text(title, { align: "center" }); doc.moveDown(1);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor("#d7ded0").stroke(); doc.moveDown(1);
}
function meta(doc: PDFKit.PDFDocument, base: DocumentBase, font: Fonts): void {
  doc.fontSize(10).font(font.bold).text("Patient: ", { continued: true }).font(font.regular).text(base.patientName);
  doc.font(font.bold).text("Issued: ", { continued: true }).font(font.regular).text(philippineDate(base.issuedAt, true));
  doc.font(font.bold).text("Document Code: ", { continued: true }).font(font.regular).text(base.accessCode); doc.moveDown(0.75);
}
function signature(doc: PDFKit.PDFDocument, base: DocumentBase, font: Fonts): void {
  if (doc.y > 730) doc.addPage();
  doc.moveDown(2); doc.moveTo(350, doc.y).lineTo(545, doc.y).strokeColor("#111827").stroke();
  doc.fontSize(10).font(font.bold).text(base.doctorName, 350, doc.y + 6, { width: 195, align: "center" });
  doc.font(font.regular).text(`PRC License: ${base.doctorLicense || "Not provided"}`, { width: 195, align: "center" });
}
function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let length = 0;
    doc.on("data", (chunk: Buffer) => { length += chunk.length; if (length > MAX_UPLOAD_BYTES) doc.destroy(new ArtifactError("DOCUMENT_RENDER_LIMIT")); else chunks.push(Buffer.from(chunk)); });
    doc.once("error", () => reject(new ArtifactError("DOCUMENT_RENDER_FAILED", true)));
    doc.once("end", () => resolve(Buffer.concat(chunks)));
  });
}
function document(base: DocumentBase): PDFKit.PDFDocument {
  // Fixed metadata makes retries of committed canonical input byte-stable.
  return new PDFDocument({ size: "A4", margin: 50, compress: false, info: { CreationDate: base.issuedAt, ModDate: base.issuedAt, Producer: "VITAL Records", Creator: "VITAL Records" } });
}
export async function createPrescriptionPdfBuffer(args: PrescriptionPdf, config?: RecordsFontConfig): Promise<Buffer> {
  if(args.templateVersion)return bghPrescription(args,config);
  validateBase(args); validatePrescriptionLines(args.lines);
  const doc = document(args); const result = collect(doc);
  try {
    const font = await fonts(doc, printableValues(args), config); header(doc, "Prescription", font); meta(doc, args, font);
    doc.fontSize(11).font(font.bold).text("Medication Instructions"); doc.moveDown(0.5);
    for (const [index, line] of args.lines.entries()) {
      doc.fontSize(10).font(font.bold).text(`${index + 1}. ${line.medicineName}`);
      doc.font(font.regular).text(`Dose: ${line.dosageAmount} ${line.dosageUnit} | Frequency: ${line.frequency}`);
      if (line.route || line.duration || line.quantity) doc.text(`Route: ${line.route || "N/A"} | Duration: ${line.duration || "N/A"} | Quantity: ${line.quantity || "N/A"}`);
      if (line.instructions) doc.text(`Instructions: ${line.instructions}`); doc.moveDown(0.6);
    }
    signature(doc, args, font); doc.end(); return await result;
  } catch (error) { doc.destroy(); void result.catch(() => {}); throw error; }
}
export async function createCertificatePdfBuffer(args: CertificatePdf, config?: RecordsFontConfig): Promise<Buffer> {
  if(args.templateVersion)return bghCertificate(args,config);
  validateBase(args); text(args.purpose); text(args.diagnosis,true,4000);
  for (const value of [args.consultationDate, args.restStartDate, args.restEndDate]) if (value != null) date(value);
  for (const value of [args.recommendation, args.remarks]) if (value != null) text(value, false);
  const doc = document(args); const result = collect(doc);
  try {
    const font = await fonts(doc, printableValues(args), config); header(doc, "Medical Certificate", font); meta(doc, args, font);
    doc.fontSize(11).font(font.regular).text("This is to certify that the above-named patient was evaluated through Vital consultation services."); doc.moveDown(0.75);
    const field = (label: string, value: string) => doc.font(font.bold).text(`${label}: `, { continued: true }).font(font.regular).text(value);
    field("Purpose", args.purpose); field("Diagnosis / Impression", args.diagnosis);
    if (args.consultationDate) field("Consultation Date", philippineDate(args.consultationDate));
    if (args.restStartDate || args.restEndDate) field("Recommended Rest / Excuse", `${args.restStartDate ? philippineDate(args.restStartDate) : "N/A"} to ${args.restEndDate ? philippineDate(args.restEndDate) : "N/A"}`);
    if (args.recommendation) field("Recommendation", args.recommendation); if (args.remarks) field("Remarks", args.remarks);
    signature(doc, args, font); doc.end(); return await result;
  } catch (error) { doc.destroy(); void result.catch(() => {}); throw error; }
}
