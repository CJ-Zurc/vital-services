import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const web = resolve(root, process.argv[2] ?? "../vital-web");
const require = createRequire(resolve(root, "package.json"));
const { getDMMF } = require("@prisma/internals");
const source = await readFile(resolve(web, "prisma/schema.prisma"), "utf8");
const { datamodel } = await getDMMF({ datamodel: source });
const integrations = new Set(["Payment", "PaymentOperation", "Invoice", "GoogleMeetConnection", "GoogleMeetOAuthState", "GoogleMeetGeneration"]);
const retired = new Set(["Notification", "AuditLog", "GoogleMeetAudit", "MessageAuditEvent", "Message", "AppointmentConcern", "IntegrationSyncJob"]);
const videoFields = new Set(["meetingProvider", "meetingUrl", "normalizedMeetingUrl", "meetingUrlHash", "meetingValidationStatus", "videoApiSessionId", "videoCallLink", "linkGeneratedAt", "linkSavedAt", "googleSpaceName"]);
const owner = (name) => retired.has(name) ? "replaced" : integrations.has(name) ? "integrations" : "core";

function sourceBlock(kind, name) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${kind} ${name} {`);
  if (start < 0) throw new Error(`Missing parsed ${kind} ${name}`);
  const end = lines.findIndex((line, index) => index > start && line.trim() === "}");
  if (end < 0) throw new Error(`Unclosed ${kind} ${name}`);
  return lines.slice(start, end + 1);
}

const report = [];
for (const database of ["core", "integrations"]) {
  const destination = resolve(root, "prisma", database, "schema.prisma");
  let exists = false;
  try { await access(destination); exists = true; } catch { /* Initial generation only. */ }
  if (exists) throw new Error(`${destination} exists; refusing to overwrite maintained schema.`);
  const enums = new Set();
  const blocks = [];
  for (const model of datamodel.models.filter((item) => owner(item.name) === database)) {
    const removed = new Set(model.fields.filter((field) =>
      (field.kind === "object" && owner(field.type) !== database) ||
      (model.name === "Consultation" && videoFields.has(field.name)),
    ).map((field) => field.name));
    for (const field of model.fields) if (!removed.has(field.name) && field.kind === "enum") enums.add(field.type);
    const lines = sourceBlock("model", model.name).filter((line) => !removed.has(line.trim().split(/\s+/)[0]));
    const additions = [];
    if (["VitalUser", "Appointment", "Payment", "GoogleMeetGeneration", "MessageConversation"].includes(model.name)) additions.push("  version Int @default(0)");
    if (model.name === "Appointment") additions.push("  billingLineageId String @default(uuid())", "  paymentProjection AppointmentPaymentProjection?");
    if (model.name === "Consultation") additions.push("  videoResourceId String? @unique");
    if (model.name === "GoogleMeetGeneration") additions.push("  billingLineageId String", "  providerAttemptStartedAt DateTime?");
    lines.splice(lines.length - 1, 0, ...additions);
    blocks.push(lines.join("\n"));
    report.push({ model: model.name, database, removedRelationsOrFields: [...removed] });
  }
  const header = `// Initial extraction from development schema SHA256 ${createHash("sha256").update(source).digest("hex")}\n` +
    `generator client {\n  provider = "prisma-client"\n  moduleFormat = "cjs"\n  output = "../../src/eda/generated/${database}"\n}\n\ndatasource db {\n  provider = "postgresql"\n}\n`;
  const common = await readFile(resolve(root, "prisma/common.fragment.prisma"), "utf8");
  const extra = await readFile(resolve(root, `prisma/${database}.fragment.prisma`), "utf8");
  const output = [header, ...[...enums].map((name) => sourceBlock("enum", name).join("\n")), ...blocks, common, extra].join("\n\n");
  await getDMMF({ datamodel: output });
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, output);
}
for (const name of retired) report.push({ model: name, database: "replaced", replacement: ["Notification"].includes(name) ? "Central BGH inbox" : ["IntegrationSyncJob"].includes(name) ? "Core outbox + Integrations delivery ledger" : ["Message", "AppointmentConcern"].includes(name) ? "Retired persistence; existing endpoint behavior retained" : "Content-free audit intent + BGH_AUDIT_LOGS" });
await mkdir(resolve(root, "docs/eda"), { recursive: true });
await writeFile(resolve(root, "docs/eda/schema-ownership.json"), JSON.stringify({ sourceSchemaSha256: createHash("sha256").update(source).digest("hex"), models: report }, null, 2) + "\n");
console.log(`Extracted and validated ${report.length} source models into two owned schemas; no database was contacted.`);
