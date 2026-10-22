import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import sharp from "sharp";
import { DomainError, type Actor } from "../src/eda/contracts/actor.js";
import { ArtifactError, sha256 } from "../src/eda/modules/records/upload-validation.js";
import { createFileInspector, type FileInspector } from "../src/eda/modules/records/inspection.js";
import type { RecordsScanner } from "../src/eda/modules/records/scanner.js";
import { createProfileQrModule, type ProfileQrStorage } from "../src/eda/modules/profile/profile-qr.js";
import { createProfileQrRepository, type ProfileQrRepository } from "../src/eda/modules/profile/profile-qr-repository.js";
import { PROFILE_QR_LIMIT, profileQrDescriptor, qrFilePath, type QrAsset, type QrJob, type QrRow } from "../src/eda/modules/profile/profile-qr-contracts.js";
import { profileQrRuntime } from "../src/eda/modules/profile/profile-qr-runtime.js";

const now = Date.now();
const authId = randomUUID(), doctorId = randomUUID();
const actor = (write = false): Actor => ({ authId, role: "doctor", serviceId: "vital-web", resource: authId,
  scopes: [write ? "profile.qr.write" : "profile.qr.read"], correlationId: randomUUID(), isSuperAdmin: false });
const image = (format: "png" | "jpeg" | "webp" = "png") => sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).toFormat(format).toBuffer();
const denied = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
function fixture(inspector?: FileInspector) {
  const assets = new Map<string, QrAsset>(), rows = new Map<string, QrRow>(), leases = new Set<string>(), hashes = new Map<string, string>();
  const objects = new Map<string, Buffer>(), events: string[] = [];
  let failStorage = "", failScanner = false, forged = false, stale = false, lostCommit = false, published = 0;
  const authorized = (a: Actor, write = false) => { if (a.authId !== authId || a.role !== "doctor" || a.resource !== authId || !a.scopes.includes(write ? "profile.qr.write" : "profile.qr.read")) throw new DomainError(403, "PROFILE_QR_OWNER_DENIED", "Denied"); };
  const repository: ProfileQrRepository = {
    async reserve(a, meta, descriptor) {
      authorized(a, true); events.push("reserve.commit");
      const hash = JSON.stringify(descriptor), old = assets.get(meta.operationId);
      if (old) { if (hashes.get(meta.operationId) !== hash) throw new DomainError(409, "PROFILE_QR_REPLAY_CONFLICT", "Conflict"); return old; }
      const asset: QrAsset = { schema: "profile-qr.v1", id: randomUUID(), doctorId, state: "pending", descriptor };
      assets.set(meta.operationId, asset); hashes.set(meta.operationId, hash); return asset;
    },
    async claim(a, id) {
      const asset = assets.get(id); if (a !== authId || !asset || asset.state !== "pending" || leases.has(id)) return null;
      leases.add(id); return { actorId: a, operationId: id, asset, leaseOwner: randomUUID() };
    },
    async finish(job, content) {
      events.push("publish.commit");
      if (lostCommit) { lostCommit = false; throw new Error("COMMIT_OUTCOME_UNKNOWN"); }
      const asset: QrAsset = { ...job.asset, state: "ready", content };
      assets.set(job.operationId, asset); leases.delete(job.operationId); published++;
      rows.set(asset.id, { id: asset.id, doctorId, paymentProvider: asset.descriptor.paymentProvider, filePath: qrFilePath(asset.id), isActive: true, createdAt: new Date(now) });
    },
    async release(job, code) { leases.delete(job.operationId); if (code) assets.set(job.operationId, { ...job.asset, state: "rejected", errorCode: code }); },
    async pending() { return [...assets].filter(([, a]) => a.state === "pending").map(([operationId]) => ({ actorId: authId, operationId })); },
    async status(a, id, write) { authorized(a, write); const result = assets.get(id); if (!result) throw new Error("NOT_FOUND"); return result; },
    async list(a) { authorized(a); return [...rows.values()]; },
    async ready(a, id, write) {
      authorized(a, write); const row = rows.get(id), asset = [...assets.values()].find(value => value.id === id);
      if (!row || !asset || asset.state !== "ready") throw new Error("NOT_READY"); return { row, asset };
    },
    async activate(a, id, _meta, isActive) { authorized(a, true); const row = rows.get(id); if (!row) throw new Error("NOT_FOUND"); row.isActive = isActive; return row; },
  };
  const storage: ProfileQrStorage = {
    key: (area, id, hash, mime) => `${area}/${id}/${hash}.${mime.split("/")[1]}`,
    async putQuarantine(key, bytes) { events.push("quarantine.put"); if (failStorage === "quarantine") throw new Error("S3_DOWN"); objects.set(key, Buffer.from(bytes)); },
    async readQuarantine(key, expected) { const bytes = objects.get(key); if (!bytes) throw new ArtifactError("STORAGE_OBJECT_MISSING", true); if (sha256(bytes) !== expected.contentHash) throw new ArtifactError("STORAGE_OBJECT_CONFLICT"); return Buffer.from(bytes); },
    async ensureFinal(key, bytes) { events.push("final.put"); objects.set(key, Buffer.from(bytes)); if (failStorage === "final") throw new ArtifactError("STORAGE_UNAVAILABLE", true); },
    async inspectFinal(key) { events.push("final.verify"); if (failStorage === "inspect") return false; return objects.has(key); },
  };
  const scanner: RecordsScanner = { async scan(bytes) {
    events.push("scan"); if (failScanner) throw new ArtifactError("SCANNER_UNAVAILABLE", true);
    return { engine: "clamav", engineVersion: "1.4.3", databaseVersion: 28000, databaseDate: new Date(now - (stale ? 172800000 : 1000)).toISOString(),
      scannedAt: new Date(now).toISOString(), contentHash: forged ? "0".repeat(64) : sha256(bytes), byteLength: bytes.length, verdict: "clean" };
  } };
  const module = () => createProfileQrModule(repository, storage, inspector??scanner, () => now);
  const upload = async (bytes: Buffer, mimeType = "image/png", paymentProvider = "gcash", operationId = randomUUID()) => {
    const descriptor = profileQrDescriptor.parse({ operationId, byteLength: bytes.length, sha256: sha256(bytes), mimeType, paymentProvider });
    return { operationId, result: await module().upload(actor(true), { operationId, requestHash: "a".repeat(64) }, descriptor, bytes), descriptor };
  };
  return { repository, storage, scanner, module, upload, assets, rows, objects, events, leases,
    setStorage: (value: string) => { failStorage = value; }, scannerDown: () => { failScanner = true; }, scannerUp: () => { failScanner = false; },
    forge: () => { forged = true; }, stale: () => { stale = true; }, loseCommit: () => { lostCommit = true; }, published: () => published };
}

test("Profile QR runtime defaults off without constructing storage or a database client", () => {
  assert.equal(profileQrRuntime({ corePool: {} as Pool }, {}), undefined);
  assert.throws(() => profileQrRuntime({ corePool: {} as Pool }, { VITAL_EDA_PROFILE_QR_ENABLED: "true" }), /RUNTIME_DISABLED/);
  assert.throws(() => profileQrRuntime({ corePool: {} as Pool }, { VITAL_EDA_ENABLED: "true", VITAL_EDA_PROFILE_QR_ENABLED: "true" }), /RUNTIME_DISABLED/);
  assert.throws(() => profileQrRuntime({ corePool: {} as Pool }, { VITAL_EDA_ENABLED: "true", VITAL_EDA_PROFILE_WRITES_ENABLED: 'true', VITAL_EDA_PROFILE_QR_ENABLED: "true" }), /CONFIGURATION_MISSING/);
});
test("Profile QR descriptors preserve providers, image types and the exact 5 MiB boundary", () => {
  const input = { operationId: randomUUID(), byteLength: PROFILE_QR_LIMIT, sha256: "a".repeat(64), mimeType: "image/png", paymentProvider: "maya" };
  assert.equal(profileQrDescriptor.parse(input).byteLength, 5242880);
  for (const extra of [{ byteLength: PROFILE_QR_LIMIT + 1 }, { byteLength: 0 }, { mimeType: "application/pdf" }, { paymentProvider: "paymongo" }, { clinicalRecordId: randomUUID() }]) assert.equal(profileQrDescriptor.safeParse({ ...input, ...extra }).success, false);
});
test("Profile QR stages only; one existing worker validates scans and publishes real ready bytes", async () => {
  for (const format of ["png", "jpeg", "webp"] as const) {
    const f = fixture(), bytes = await image(format), uploaded = await f.upload(bytes, `image/${format}`, format === "webp" ? "maya" : "gcash");
    assert.equal(uploaded.result.operationStatus, "pending"); assert.equal(uploaded.result.qrCode, null); assert.equal(f.rows.size, 0);
    assert.deepEqual(f.events, ["reserve.commit", "quarantine.put"]);
    await f.module().recoverOnce();
    const status = await f.module().status(actor(), uploaded.operationId);
    assert.equal(status.operationStatus, "completed"); assert.equal(status.qrCode?.isActive, true);
    assert.equal(f.events.filter(e => e === "scan").length, 2);
    assert.ok(f.events.indexOf("final.verify") < f.events.indexOf("publish.commit"));
    const file = await f.module().file(actor(), status.qrCode!.id);
    assert.equal(file.sha256, sha256(Buffer.from(file.base64, "base64"))); assert.equal(file.mimeType, `image/${format}`);
    assert.equal(status.qrCode!.filePath, `/api/doctor/payment-qr/${status.qrCode!.id}/file`);
  }
});
test("Profile QR rejects MIME spoofing and oversized input before any storage side effect", async () => {
  const f = fixture(); await assert.rejects(f.upload(await image(), "image/jpeg"), denied('PROFILE_QR_BYTES_MISMATCH'));
  const descriptor = { operationId: randomUUID(), byteLength: 1, sha256: "a".repeat(64), mimeType: "image/png", paymentProvider: "gcash" };
  await assert.rejects(f.module().upload(actor(true), { operationId: descriptor.operationId, requestHash: "a".repeat(64) }, descriptor, Buffer.alloc(PROFILE_QR_LIMIT + 1)), denied('PROFILE_QR_SIZE_INVALID'));
  assert.equal(f.events.length, 0);
});
test("Profile QR malformed images are durably rejected and never get public rows", async () => {
  const f = fixture(); const value = await f.upload(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  await f.module().recoverOnce(); assert.equal((await f.module().status(actor(), value.operationId)).operationStatus, "rejected");
  assert.equal(f.rows.size, 0); assert.equal(f.events.includes("final.put"), false);
});
test("Profile QR scanner outage, forged evidence and stale signatures fail closed", async () => {
  for (const fault of ["scannerDown", "forge", "stale"] as const) {
    const f = fixture(); f[fault](); const value = await f.upload(await image());
    await f.module().recoverOnce(); assert.equal((await f.module().status(actor(), value.operationId)).operationStatus, "pending");
    assert.equal(f.rows.size, 0); assert.equal(f.events.includes("final.put"), false);
  }
});
test("Profile QR missing staged bytes recover by exact replay after a storage outage", async () => {
  const f = fixture(), bytes = await image(); f.setStorage("quarantine"); const value = await f.upload(bytes);
  await f.module().recoverOnce(); assert.equal(f.rows.size, 0);
  f.setStorage(""); await f.upload(bytes, "image/png", "gcash", value.operationId); await f.module().recoverOnce();
  assert.equal(f.rows.size, 1); assert.equal(f.assets.size, 1);
});
test("Profile QR lost storage acknowledgements and process restart do not duplicate publication", async () => {
  const f = fixture(), bytes = await image(), value = await f.upload(bytes); f.setStorage("final");
  await f.module().recoverOnce(); assert.equal(f.rows.size, 0);
  f.setStorage(""); f.loseCommit(); await f.module().recoverOnce(); assert.equal(f.rows.size, 0);
  await f.module().recoverOnce(); await f.upload(bytes, "image/png", "gcash", value.operationId); await f.module().recoverOnce();
  assert.equal(f.rows.size, 1); assert.equal(f.published(), 1);
});
test("Profile QR immutable operation IDs reject changed provider or bytes", async () => {
  const f = fixture(), bytes = await image(), value = await f.upload(bytes);
  await assert.rejects(f.upload(bytes, "image/png", "maya", value.operationId), denied('PROFILE_QR_REPLAY_CONFLICT'));
  await assert.rejects(f.upload(await image("jpeg"), "image/jpeg", "gcash", value.operationId), denied('PROFILE_QR_REPLAY_CONFLICT'));
});
test("Profile QR concurrent recovery is fenced by durable leases", async () => {
  const f = fixture(); await f.upload(await image()); await Promise.all([f.module().recoverOnce(), f.module().recoverOnce()]);
  assert.equal(f.published(), 1); assert.equal(f.rows.size, 1);
});
test("Profile QR file reads reject changed bytes and missing final storage", async () => {
  const f = fixture(); const value = await f.upload(await image()); await f.module().recoverOnce();
  const id = (await f.module().status(actor(), value.operationId)).qrCode!.id;
  f.setStorage("inspect"); await assert.rejects(f.module().file(actor(), id), denied('PROFILE_QR_STORAGE_UNAVAILABLE'));
  f.setStorage(""); for (const key of f.objects.keys()) if (key.startsWith("quarantine/")) f.objects.set(key, Buffer.from("changed"));
  await assert.rejects(f.module().file(actor(), id), /STORAGE_OBJECT_CONFLICT/);
});
test("Profile QR preserves activation fields and denies foreign owners and non-doctor claims", async () => {
  const f = fixture(), value = await f.upload(await image()); await f.module().recoverOnce();
  const row = (await f.module().status(actor(), value.operationId)).qrCode!;
  const result = await f.module().activate(actor(true), row.id, { operationId: randomUUID(), requestHash: "a".repeat(64) }, false);
  assert.equal(result.qrCode.isActive, false); assert.equal(result.qrCode.doctorId, doctorId); assert.equal(result.qrCode.filePath, row.filePath);
  await assert.rejects(f.module().list({ ...actor(), role: "admin", isSuperAdmin: true }), denied('PROFILE_QR_DOCTOR_REQUIRED'));
  await assert.rejects(f.module().file({ ...actor(), authId: randomUUID() }, row.id));
  await assert.rejects(f.module().list({ ...actor(), resource: randomUUID() }), /not permitted/);
});
test("Profile QR SQL repository fences stale publication before inserting a QR row", async () => {
  const statements: string[] = [];
  const tx = { query: async (sql: string) => { statements.push(sql); return { rows: [] }; }, release() {} };
  const pool = { connect: async () => tx } as unknown as Pool;
  const job = { actorId: authId, operationId: randomUUID(), leaseOwner: randomUUID(), asset: {} } as QrJob;
  await assert.rejects(createProfileQrRepository(pool).finish(job, {} as NonNullable<QrAsset["content"]>), denied('PROFILE_QR_LEASE_LOST'));
  assert.ok(statements.some(sql => sql.includes('"leaseUntil">NOW() FOR UPDATE')));
  assert.ok(statements.includes("ROLLBACK")); assert.equal(statements.some(sql => sql.includes("INSERT INTO doctor_qr_codes")), false);
});
test("Profile QR SQL reserve commits the durable descriptor before returning to storage", async () => {
  const statements: string[] = [];
  const tx = { query: async (sql: string) => { statements.push(sql); return { rows: sql.includes("SELECT d.") ? [{ userId: doctorId }] : [] }; }, release() { statements.push("release"); } };
  const repository = createProfileQrRepository({ connect: async () => tx } as unknown as Pool);
  const descriptor = profileQrDescriptor.parse({ operationId: randomUUID(), byteLength: 1, sha256: "a".repeat(64), mimeType: "image/png", paymentProvider: "gcash" });
  const result = await repository.reserve(actor(true), { operationId: descriptor.operationId, requestHash: "a".repeat(64) }, descriptor);
  assert.equal(result.state, "pending"); assert.deepEqual(statements.slice(-2), ["COMMIT", "release"]);
  assert.ok(statements.some(sql => sql.includes("INSERT INTO command_operations")));
  assert.equal(statements.some(sql => /clinical|record_operations|records_file_assets/.test(sql)), false);
});

test('Capstone payment QR processing records unscanned evidence and supports historical private reads',async()=>{
  const inspector=createFileInspector(()=>{throw new Error('No scanner config');},'capstone-validation-only',()=>now),f=fixture(inspector),value=await f.upload(await image());
  f.scannerDown();await f.module().recoverOnce();const status=await f.module().status(actor(),value.operationId);assert.equal(status.operationStatus,'completed');assert.equal(f.rows.size,1);assert.ok(!f.events.includes('scan'));
  const stored=f.assets.get(value.operationId)!;assert.equal(stored.content?.evidence.verdict,'not_scanned');assert.equal('engine' in stored.content!.evidence,false);
  const restored=createProfileQrModule(f.repository,f.storage,f.scanner,()=>now+86400000);
  assert.ok((await restored.file(actor(),status.qrCode!.id)).base64);
});

test('Capstone payment QR runtime does not require ClamAV environment paths',()=>{
  assert.ok(profileQrRuntime({corePool:{} as Pool},{VITAL_EDA_ENABLED:'true',VITAL_EDA_PROFILE_WRITES_ENABLED:'true',VITAL_EDA_PROFILE_QR_ENABLED:'true',VITAL_PROFILE_QR_STORAGE_ENDPOINT:'https://storage.example.test',VITAL_PROFILE_QR_STORAGE_BUCKET:'demo-qr',VITAL_PROFILE_QR_STORAGE_REGION:'local',VITAL_PROFILE_QR_STORAGE_ACCESS_KEY:'fictional-access',VITAL_PROFILE_QR_STORAGE_SECRET_KEY:'fictional-secret'}));
});
