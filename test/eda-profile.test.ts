import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { DomainError, type Actor } from "../src/eda/contracts/actor.js";
import { parseEvent } from "../src/eda/contracts/events.js";
import type { CorePrismaClient } from "../src/eda/infrastructure/databases.js";
import { createProfileModule, ProfileError, type ProfileCommandGuard } from "../src/eda/modules/profile/profile.js";
import { createProfileRouter } from "../src/eda/http/profile-router.js";
import { createProfileCommandGuard } from "../src/eda/modules/profile/profile-commands.js";
import { requestHash as canonicalHash } from "../src/eda/infrastructure/security.js";

const authId = "11111111-1111-4111-8111-111111111111";
const otherAuthId = "22222222-2222-4222-8222-222222222222";
const actor = (role: Actor["role"] = "patient", id = authId): Actor => ({
  authId: id, role, serviceId: "vital-web", scopes: ["profile.read", "profile.write", "profile.materialize"],
  resource: id, correlationId: "33333333-3333-4333-8333-333333333333", isSuperAdmin: false,
});
const permit: ProfileCommandGuard = async (_tx, _command, execute) => execute();
type Row = Record<string, unknown>;
type Select = { [key: string]: boolean | { select: Select } };
type Query = { where?: Row; data?: Row; create?: Row; update?: Row; select?: Select };
type Table = "vitalUser" | "vitalPatient" | "vitalDoctor" | "vitalAdmin" | "profileWorkflow" | "consentRecord";

// The only structural Prisma cast lives in this test fixture. It honors select and transaction rollback.
function databaseStub() {
  let state: Record<Table, Row[]> & { events: Row[]; commands: Row[]; intents: Row[] } = {
    vitalUser: [], vitalPatient: [], vitalDoctor: [], vitalAdmin: [], profileWorkflow: [], consentRecord: [], events: [], commands: [], intents: [],
  };
  const reads: Array<{ table: Table; query: Query }> = [];
  const transactionOptions: unknown[] = [];
  let failOutbox = false;
  let transactionDepth = 0;
  function project(row: Row | undefined, select?: Select): Row | null {
    if (!row) return null;
    if (!select) return { ...row };
    return Object.fromEntries(Object.entries(select).filter(([, value]) => Boolean(value)).map(([key, value]) => {
      if (typeof value === "boolean") return [key, row[key]];
      const table: Table | undefined = key === "patient" ? "vitalPatient" : key === "doctor" ? "vitalDoctor" : key === "admin" ? "vitalAdmin" : key === "user" ? "vitalUser" : undefined;
      return [key, table ? project(state[table].find((marker) => key === "user" ? marker.id === row.userId : marker.userId === row.id), value.select) : null];
    }));
  }
  function find(table: Table, query: Query) {
    return state[table].find((row) => Object.entries(query.where ?? {}).every(([key, value]) => row[key] === value));
  }
  function defaults(table: Table): Row {
    if (table === "vitalUser") return { id: randomUUID(), version: 0 };
    if (table === "consentRecord") return { id: randomUUID(), appointmentId: null };
    if (table === "vitalPatient") return { profilePic: null, isRecordAvailable: false, ehrPatientId: null,
      ehrRecordOrigin: "none", existingEhrRecordNoticeDismissedAt: null, isOnboardingComplete: false,
      emergencyContactName: null, emergencyContactRelationship: null, emergencyContactPhone: null };
    if (table === "vitalDoctor") return { role: "doctor", s2License:null,s2ValidFrom:null,s2ValidUntil:null,signatureAssetId:"11111111-1111-4111-8111-111111111111", specialty: null, departmentExternalId: null,
      departmentName: null, prcLicense: null, availabilityType: null, virtualFee: null, inPersonFee: null,
      starRating: 0, changedAt: null, bio: null, education: null, isDoctorOnboardingComplete: false, termsAgreedAt: null };
    return {};
  }
  function update(table: Table, query: Query) {
    const row = find(table, query);
    if (!row) throw new Error("Mock row not found");
    for (const [key, value] of Object.entries(query.data ?? {})) {
      if (key === "version" && typeof value === "object" && value !== null && "increment" in value) {
        row.version = Number(row.version) + Number(value.increment);
      } else row[key] = value;
    }
    return project(row, query.select);
  }
  const delegates = Object.fromEntries((["vitalUser", "vitalPatient", "vitalDoctor", "vitalAdmin", "profileWorkflow", "consentRecord"] as const).map((table) => [table, {
    async findFirst(query: Query) { return project(find(table, query), query.select); },
    async findMany(query: Query) { return state[table].map((row) => project(row, query.select)); },
    async findUnique(query: Query) { reads.push({ table, query }); return project(find(table, query), query.select); },
    async findUniqueOrThrow(query: Query) {
      const row = project(find(table, query), query.select);
      if (!row) throw new Error("Mock row not found");
      return row;
    },
    async create(query: Query) {
      const row = { ...defaults(table), ...query.data };
      state[table].push(row);
      return project(row, query.select);
    },
    async update(query: Query) { return update(table, query); },
    async upsert(query: Query) {
      if (find(table, query)) return update(table, { ...query, data: query.update });
      const row = { ...defaults(table), ...query.create };
      state[table].push(row);
      return project(row, query.select);
    },
  }]));
  const tx = {
    ...delegates,
    commandOperation: {
      async findUnique(query: Query) {
        const key = query.where?.actorId_operationId as Row;
        return state.commands.find((row) => row.actorId === key.actorId && row.operationId === key.operationId) ?? null;
      },
      async update(query: Query) {
        const row = state.commands.find((row) => row.id === query.where?.id);
        if (!row) throw new Error("Mock command not found");
        Object.assign(row, query.data);
        return row;
      },
      async create(query: Query) {
      assert.equal(transactionDepth, 1, "command result must be inside the Core transaction");
      const row = { id: randomUUID(), ...query.data };
      state.commands.push(row);
      return row;
    } },
    profileSyncIntent: { async create(query: Query) {
      assert.equal(transactionDepth, 1);
      const row = { id: randomUUID(), ...query.data };
      state.intents.push(row);
      return row;
    } },
    outboxEvent: { async create(query: Query) {
      assert.equal(transactionDepth, 1, "outbox must be inside the Core transaction");
      if (failOutbox) throw new Error("outbox unavailable: secret connection details");
      const row = { id: randomUUID(), ...query.data };
      state.events.push(row);
      return row;
    } },
  };
  const db = { ...tx, async $transaction<T>(run: (client: typeof tx) => Promise<T>, options: unknown) {
    transactionOptions.push(options);
    const before = structuredClone(state);
    transactionDepth += 1;
    try { return await run(tx); }
    catch (error) { state = before; throw error; }
    finally { transactionDepth -= 1; }
  } } as unknown as CorePrismaClient;
  return { db, reads, transactionOptions, rows: () => ({ ...state,
    allEvents: state.events, events: state.events.filter((row) => row.eventType === "vital.profile.changed") }),
    failOutbox: () => { failOutbox = true; } };
}

function storedEvent(row: Row | undefined) {
  assert.ok(row);
  assert.ok(row.occurredAt instanceof Date);
  return parseEvent({ eventId: row.id, eventType: row.eventType, schemaVersion: row.schemaVersion,
    producer: row.producer, aggregateId: row.aggregateId, aggregateVersion: row.aggregateVersion,
    correlationId: row.correlationId, causationId: row.causationId,
    occurredAt: row.occurredAt.toISOString(), data: row.payload });
}

async function withRouter(db: CorePrismaClient, identity: Actor | undefined, guard: ProfileCommandGuard | undefined,
  run: (base: string) => Promise<void>) {
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  app.use((_req, res, next) => { res.locals.actor = identity; next(); });
  app.use("/profile", createProfileRouter(db, { commandGuard: guard }));
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}/profile`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const patch = (body: unknown) => ({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const emergencyContact = { emergencyContactName: "  Jane Doe  ", emergencyContactRelationship: " Sister ", emergencyContactPhone: "0912 345 6789" };
const onboarding = {
  consent_accepted: true, date_of_birth: "2000-01-01", sex: "female", contact_number: "09123456789",
  address_island_group: "Luzon", address_province_region: "NCR", address_province: "",
  address_city_municipality: "Manila", address_barangay: "Barangay 1", address_street: "123 Main St",
  address_postal_code: "1000", address_country: "Philippines", philhealth_identification_number: "",
};
const metadata = (operationId = randomUUID()) => ({ operationId, requestHash: "a".repeat(64) });

test('notice dismissal commits once and rechecks patient ownership on replay', async () => {
  const stub = databaseStub(), profile = createProfileModule(stub.db, createProfileCommandGuard());
  await profile.materialize(actor(), {}, metadata());
  const command = metadata();
  assert.deepEqual(await profile.dismissPatientNotice(actor(), {}, command), { dismissed: true });
  const first = stub.rows().vitalPatient[0]!.existingEhrRecordNoticeDismissedAt;
  const events = stub.rows().allEvents.length;
  await profile.dismissPatientNotice(actor(), {}, command);
  await profile.dismissPatientNotice(actor(), {}, metadata());
  assert.equal(stub.rows().vitalPatient[0]!.existingEhrRecordNoticeDismissedAt, first);
  assert.equal(stub.rows().allEvents.length, events);
  stub.rows().vitalPatient[0]!.authId = otherAuthId;
  await assert.rejects(profile.dismissPatientNotice(actor(), {}, command), error => error instanceof ProfileError && error.status === 403);
  await assert.rejects(profile.dismissPatientNotice(actor('doctor'), {}, metadata()), error => error instanceof ProfileError && error.status === 403);
});
const doctorOnboarding = { s2License:"DEMO-S2",s2ValidFrom:"2026-01-01",s2ValidUntil:"2027-01-01",specialty: "Cardiology", prcLicense: "123456", bio: "Clinical biography",
  availabilityType: "both", isDoctorOnboardingComplete: true, terms_accepted: true };
function receipt(kind: string, workflowId: string, input: unknown, targetAuthId?: string) {
  const binding = { operationId: workflowId, inputHash: canonicalHash("PROFILE", kind, input) };
  return kind === "patient.onboarding" ? { ...binding, ehrPatientId: "ehr-owned-patient-id", ehrRecordOrigin: "preexisting" }
    : { ...binding, department: { id: "trace-cardio", name: "Cardiology" }, ...(targetAuthId ? { authId: targetAuthId } : {}) };
}

test("profile: missing validated actor ignores spoofed headers and performs no query", async () => {
  const stub = databaseStub();
  await withRouter(stub.db, undefined, permit, async (base) => {
    const response = await fetch(`${base}/me`, { headers: { "X-User-Id": authId, "X-User-System-Roles": "admin" } });
    assert.equal(response.status, 401);
    assert.equal(stub.reads.length, 0);
  });
});

test("profile: default-off guard prevents materialization and PATCH writes", async () => {
  const stub = databaseStub();
  await withRouter(stub.db, actor(), undefined, async (base) => {
    assert.equal((await fetch(`${base}/materialize`, { method: "POST" })).status, 503);
    assert.equal((await fetch(`${base}/patient/me`, patch(emergencyContact))).status, 503);
    assert.equal((await fetch(`${base}/me`)).status, 200);
  });
  assert.equal(stub.transactionOptions.length, 0);
  assert.equal(stub.rows().events.length, 0);
});

test("profile: verified roles bootstrap their own markers, distinguish local IDs, and are idempotent", async () => {
  for (const role of ["patient", "doctor", "admin"] as const) {
    const stub = databaseStub();
    const profile = createProfileModule(stub.db, permit);
    const user = await profile.materialize(actor(role));
    assert.equal(user.authId, authId);
    assert.notEqual(user.id, authId);
    assert.equal(user[role]?.userId, user.id);
    assert.equal(user.version, 1);
    assert.deepEqual(await profile.materialize(actor(role)), user);
    assert.equal(stub.rows().events.length, 1);
    const event = storedEvent(stub.rows().events[0]);
    assert.equal(event.aggregateId, user.id);
    assert.equal(event.aggregateVersion, 1);
    assert.equal(event.producer, "profile");
    assert.equal(event.data.operation, "materialized");
    assert.equal(event.data.actorAuthId, authId);
    assert.deepEqual(stub.transactionOptions[0], { isolationLevel: "Serializable" });
  }
});

test("profile: materialization never accepts identity or authority from the request", async () => {
  const stub = databaseStub();
  const profile = createProfileModule(stub.db, permit);
  for (const body of [{ authId: otherAuthId }, { role: "admin" }, { isSuperAdmin: true }, { userId: otherAuthId }]) {
    await assert.rejects(profile.materialize(actor(), body));
  }
  await assert.rejects(profile.materialize(actor("service")), (error: unknown) => error instanceof ProfileError && error.status === 403);
  assert.equal(stub.transactionOptions.length, 0);
});

test("profile: roles lookup requires service, scope, and exact resource, with no SuperAdmin bypass", async () => {
  const stub = databaseStub();
  const profile = createProfileModule(stub.db, permit);
  const service = { ...actor("service"), scopes: ["profile.roles.read"] };
  for (const denied of [actor("admin"), { ...service, scopes: [] }, { ...service, resource: "*" },
    { ...service, resource: otherAuthId, isSuperAdmin: true }]) {
    await assert.rejects(profile.roles(denied, authId), (error: unknown) => (error instanceof ProfileError || error instanceof DomainError) && error.status === 403);
  }
  assert.equal(stub.reads.length, 0);
  assert.deepEqual(await profile.roles(service, authId), { system: "vital", user_id: authId, roles: [] });
  await profile.materialize(actor("patient"));
  await profile.materialize(actor("doctor"));
  await profile.materialize(actor("admin"));
  assert.deepEqual((await profile.roles(service, authId)).roles, ["admin", "doctor", "patient"]);
  await withRouter(stub.db, service, undefined, async (base) => {
    const response = await fetch(`${base}/roles/${authId}`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.roles, result.data.roles);
    assert.equal(result.user_id, authId);
  });
});

test("profile: self reads and writes cannot cross actors or roles", async () => {
  const stub = databaseStub();
  const profile = createProfileModule(stub.db, permit);
  await profile.materialize(actor());
  await profile.materialize(actor("patient", otherAuthId));
  await profile.patchPatient(actor("patient", otherAuthId), { ...emergencyContact, emergencyContactName: "Other Person" });
  await withRouter(stub.db, actor(), permit, async (base) => {
    const response = await fetch(`${base}/patient/me?authId=${otherAuthId}&include=user`, patch(emergencyContact));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.data.vitalPatient.authId, authId);
    assert.equal(result.data.vitalPatient.emergencyContactName, "Jane Doe");
    assert.equal((await fetch(`${base}/doctor/me`)).status, 403);
  });
  assert.equal((await profile.patientMe(actor("patient", otherAuthId)))?.emergencyContactName, "Other Person");
  await assert.rejects(profile.patchPatient(actor("doctor"), emergencyContact));
  await assert.rejects(profile.patchDoctor(actor(), { bio: "No" }));
});

test("profile: emergency contact validation matches booking constraints and validates the merged contact", async () => {
  const stub = databaseStub();
  const profile = createProfileModule(stub.db, permit);
  await profile.materialize(actor());
  await assert.rejects(profile.patchPatient(actor(), { emergencyContactName: "Jane" }));
  const patient = await profile.patchPatient(actor(), emergencyContact);
  assert.equal(patient.emergencyContactPhone, "+639123456789");
  assert.equal(patient.emergencyContactRelationship, "Sister");
  const updated = await profile.patchPatient(actor(), { emergencyContactName: "New Name" });
  assert.equal(updated.emergencyContactPhone, patient.emergencyContactPhone);
  for (const body of [{ ...emergencyContact, emergencyContactName: " " },
    { ...emergencyContact, emergencyContactName: "x".repeat(161) },
    { ...emergencyContact, emergencyContactRelationship: "x".repeat(81) },
    { ...emergencyContact, emergencyContactPhone: "+12025550123" }]) {
    await assert.rejects(profile.patchPatient(actor(), body));
  }
});

test("profile: strict field allowlists reject credentials, ORM arguments, authority, and integration-owned fields", async () => {
  const stub = databaseStub();
  const profile = createProfileModule(stub.db, permit);
  for (const key of ["authId", "userId", "role", "version", "where", "include", "data", "password", "accessToken",
    "ehrPatientId", "isRecordAvailable", "profilePic"]) {
    await assert.rejects(profile.patchPatient(actor(), { ...emergencyContact, [key]: otherAuthId }));
  }
  for (const key of ["authId", "userId", "role", "starRating", "termsAgreedAt", "departmentExternalId",
    "hospitalAffiliations", "paymentQrCodes", "password", "where", "data"]) {
    await assert.rejects(profile.patchDoctor(actor("doctor"), { bio: "Valid bio", [key]: "forbidden" }));
  }
  assert.equal(stub.transactionOptions.length, 0);
});

test("profile: patient onboarding validates completion and requires prepared EHR receipt, never guard verification", async () => {
  const stub = databaseStub();
  const profile = createProfileModule(stub.db, permit);
  await profile.materialize(actor());
  for (const invalid of [{ ...onboarding, consent_accepted: false }, { ...onboarding, date_of_birth: "2999-01-01" },
    { ...onboarding, date_of_birth: "2000-02-30" }, { ...onboarding, contact_number: "123" },
    { ...onboarding, address_province_region: "CAR", address_province: "" }, { ...onboarding, address_street: "x" }]) {
    await assert.rejects(profile.patchPatient(actor(), { isOnboardingComplete: true, onboarding: invalid }));
  }
  await assert.rejects(profile.patchPatient(actor(), { isOnboardingComplete: true, onboarding }),
    (error: unknown) => error instanceof ProfileError && error.status === 409);
  const verified = createProfileModule(stub.db, async (_tx, command, execute) => {
    assert.equal(command.operation, "patient.onboarding");
    return execute({ patientRecord: { ehrPatientId: "ehr-owned-patient-id", ehrRecordOrigin: "preexisting" } });
  });
  await assert.rejects(verified.patchPatient(actor(), { isOnboardingComplete: true, onboarding }),
    (error: unknown) => error instanceof ProfileError && error.status === 409);
  const durable = createProfileModule(stub.db, createProfileCommandGuard());
  const input = { isOnboardingComplete: true, onboarding };
  const workflowId = randomUUID();
  await durable.workflows.prepare(actor(), { workflowId, kind: "patient.onboarding", input }, metadata());
  const result = await durable.workflows.commit(actor(), workflowId,
    { input, receipt: receipt("patient.onboarding", workflowId, input) }, metadata());
  const patient = result.data as Row;
  assert.equal(patient.isOnboardingComplete, true);
  assert.equal(patient.ehrPatientId, "ehr-owned-patient-id");
  assert.equal(patient.ehrRecordOrigin, "preexisting");
  await assert.rejects(verified.patchPatient(actor(), { isOnboardingComplete: true, onboarding }),
    (error: unknown) => error instanceof ProfileError && error.status === 409);
  assert.equal(storedEvent(stub.rows().events.at(-1)).data.operation, "onboarded");
});

test("profile: doctor fees and onboarding prerequisites are validated, specialty requires workflow", async () => {
  const stub = databaseStub();
  const profile = createProfileModule(stub.db, permit);
  await profile.materialize(actor("doctor"));
  for (const virtualFee of [-1, Infinity, 1.001, "12junk", "100000000", "1.234"]) {
    await assert.rejects(profile.patchDoctor(actor("doctor"), { virtualFee }));
  }
  const doctor = await profile.patchDoctor(actor("doctor"), { virtualFee: "123.45", inPersonFee: null });
  assert.equal(String(doctor.virtualFee), "123.45");
  assert.equal(doctor.inPersonFee, null);
  await assert.rejects(profile.patchDoctor(actor("doctor"), { isDoctorOnboardingComplete: true }));
  await assert.rejects(profile.patchDoctor(actor("doctor"), { isDoctorOnboardingComplete: true, terms_accepted: true }));
  const input = doctorOnboarding;
  await assert.rejects(profile.patchDoctor(actor("doctor"), input),
    (error: unknown) => error instanceof ProfileError && error.status === 409);
  const verified = createProfileModule(stub.db, async (_tx, _command, execute) => execute({ specialty: "Cardiology" }));
  await assert.rejects(verified.patchDoctor(actor("doctor"), input));
  const durable = createProfileModule(stub.db, createProfileCommandGuard());
  const workflowId = randomUUID();
  await durable.workflows.prepare(actor("doctor"), { workflowId, kind: "doctor.onboarding", input }, metadata());
  const result = await durable.workflows.commit(actor("doctor"), workflowId,
    { input, receipt: receipt("doctor.onboarding", workflowId, input) }, metadata());
  const completed = result.data as Row;
  assert.equal(completed.isDoctorOnboardingComplete, true);
  assert.ok(completed.termsAgreedAt instanceof Date);
  await assert.rejects(verified.patchDoctor(actor("doctor"), { specialty: "Neurology" }),
    (error: unknown) => error instanceof ProfileError && error.status === 409);
  await assert.rejects(verified.patchDoctor(actor("doctor"), input),
    (error: unknown) => error instanceof ProfileError && error.status === 409);
});

test("profile: workflow input remains transient; canonical hashes, stable receipt ID and distinct steps are enforced", async () => {
  const stub = databaseStub();
  await createProfileModule(stub.db, permit).materialize(actor());
  const profile = createProfileModule(stub.db, createProfileCommandGuard());
  const workflowId = randomUUID();
  const input = { isOnboardingComplete: true, onboarding };
  const prepareId = metadata();
  await assert.rejects(profile.workflows.prepare(actor(), { workflowId, kind: "patient.onboarding", input }, metadata(workflowId)));
  const prepared = await profile.workflows.prepare(actor(), { workflowId, kind: "patient.onboarding", input }, prepareId);
  assert.equal(prepared.expectedVersion, 1);
  assert.equal(prepared.inputHash, canonicalHash("PROFILE", "patient.onboarding", input));
  assert.deepEqual(await profile.workflows.prepare(actor(), { workflowId, kind: "patient.onboarding", input }, prepareId), prepared);
  assert.equal(stub.rows().profileWorkflow.length, 1);
  const stored = JSON.stringify(stub.rows().profileWorkflow);
  assert.ok(!stored.includes("date_of_birth") && !stored.includes("Main St"));
  assert.deepEqual(await profile.workflows.status(actor(), workflowId), prepared);
  await assert.rejects(profile.workflows.status({ ...actor(), authId: otherAuthId, resource: otherAuthId }, workflowId));
  const valid = receipt("patient.onboarding", workflowId, input);
  for (const bad of [{ ...valid, operationId: randomUUID() }, { ...valid, inputHash: "b".repeat(64) },
    { ...valid, accessToken: "forged" }, { ...valid, ehrRecordOrigin: "none" }]) {
    await assert.rejects(profile.workflows.commit(actor(), workflowId, { input, receipt: bad }, metadata()),
      (error: unknown) => error instanceof ProfileError && error.status === 409);
  }
  await assert.rejects(profile.workflows.commit(actor(), workflowId, { input, receipt: valid }, prepareId));
  await assert.rejects(profile.workflows.commit(actor(), workflowId, { input, receipt: valid }, metadata(workflowId)));
  await assert.rejects(profile.workflows.commit(actor(), workflowId,
    { input: { ...input, onboarding: { ...onboarding, address_street: "456 Changed Street" } }, receipt: valid }, metadata()));
  const commitId = metadata();
  const result = await profile.workflows.commit(actor(), workflowId, { input, receipt: valid }, commitId);
  assert.equal(result.state, "committed");
  assert.deepEqual(await profile.workflows.commit(actor(), workflowId, { input, receipt: valid }, commitId), JSON.parse(JSON.stringify(result)));
  await assert.rejects(profile.workflows.commit(actor(), workflowId, { input, receipt: valid }, metadata()));
  assert.equal(stub.rows().events.length, 2);
  assert.equal(stub.rows().commands.length, 2);
  const persisted = JSON.stringify(stub.rows());
  assert.ok(!persisted.includes("date_of_birth") && !persisted.includes("Main St"));
});

test("profile: command action, input, resource, role and signed transport hashes cannot reuse an ID", async () => {
  const stub = databaseStub();
  const profile = createProfileModule(stub.db, createProfileCommandGuard());
  const operation = metadata();
  await profile.materialize(actor(), {}, operation);
  await assert.rejects(profile.patchPatient(actor(), emergencyContact, operation));
  await assert.rejects(profile.materialize(actor("doctor"), {}, operation));
  await assert.rejects(profile.materialize(actor(), {}, { ...operation, requestHash: "b".repeat(64) }));
  const update = metadata();
  await profile.patchPatient(actor(), emergencyContact, update);
  await assert.rejects(profile.patchPatient(actor(), { ...emergencyContact, emergencyContactName: "Changed" }, update));
  assert.equal(stub.rows().commands.length, 2);
  assert.equal(stub.rows().events.length, 2);
});

test("profile: stale workflows reject version races and outbox failure rolls back receipt, profile and command", async () => {
  for (const stale of [true, false]) {
    const stub = databaseStub();
    await createProfileModule(stub.db, permit).materialize(actor());
    const profile = createProfileModule(stub.db, createProfileCommandGuard());
    const workflowId = randomUUID();
    const input = { isOnboardingComplete: true, onboarding };
    await profile.workflows.prepare(actor(), { workflowId, kind: "patient.onboarding", input }, metadata());
    if (stale) await profile.patchPatient(actor(), emergencyContact, metadata());
    else stub.failOutbox();
    const before = JSON.stringify(stub.rows());
    await assert.rejects(profile.workflows.commit(actor(), workflowId,
      { input, receipt: receipt("patient.onboarding", workflowId, input) }, metadata()));
    assert.equal(JSON.stringify(stub.rows()), before);
    assert.equal(stub.rows().profileWorkflow[0]?.state, "prepared");
  }
});

const adminActor = (resource = authId): Actor => ({ ...actor("admin"), resource, scopes: ["profile.admin.read", "profile.admin.write", "profile.materialize"] });

test("profile: admin DB marker is mandatory independently of role, scope and SuperAdmin", async () => {
  const stub = databaseStub();
  const profile = createProfileModule(stub.db, createProfileCommandGuard());
  const input = { specialty: "Cardiology" };
  for (const admin of [adminActor(), { ...adminActor(), isSuperAdmin: true }]) {
    await assert.rejects(profile.adminDoctors(admin));
    await assert.rejects(profile.adminMembership(admin));
    await assert.rejects(profile.workflows.prepare({ ...admin, resource: otherAuthId },
      { workflowId: randomUUID(), kind: "doctor.provision", targetAuthId: otherAuthId, input }, metadata()));
  }
  await createProfileModule(stub.db, permit).materialize(actor("patient"));
  stub.rows().vitalUser[0]!.role = "admin";
  await assert.rejects(profile.adminDoctors(adminActor()));
  assert.equal(stub.rows().profileWorkflow.length, 0);
  assert.equal(stub.rows().commands.length, 0);
});

test("profile: admin provision and specialty bind Auth identity, target resource and verified department", async () => {
  const stub = databaseStub();
  await createProfileModule(stub.db, permit).materialize(actor("admin"));
  const profile = createProfileModule(stub.db, createProfileCommandGuard());
  const admin = adminActor(otherAuthId);
  const input = { specialty: "Cardiology" };
  const workflowId = randomUUID();
  await assert.rejects(profile.workflows.prepare(adminActor(),
    { workflowId, kind: "doctor.provision", targetAuthId: otherAuthId, input }, metadata()));
  await assert.rejects(profile.workflows.prepare(admin,
    { workflowId, kind: "doctor.provision", targetAuthId: otherAuthId, input: { ...input, email: "invented@example.test" } }, metadata()));
  await profile.workflows.prepare(admin, { workflowId, kind: "doctor.provision", targetAuthId: otherAuthId, input }, metadata());
  const valid = receipt("doctor.provision", workflowId, input, otherAuthId);
  const { authId: _id, ...unverifiedIdentity } = valid as Row;
  for (const invalid of [unverifiedIdentity, { ...valid, authId }, { ...valid, department: { id: "trace-other", name: "Neurology" } }]) {
    await assert.rejects(profile.workflows.commit(admin, workflowId, { input, receipt: invalid }, metadata()));
  }
  await profile.workflows.commit(admin, workflowId, { input, receipt: valid }, metadata());
  const doctor = await profile.doctorMe(actor("doctor", otherAuthId));
  assert.equal(doctor?.departmentExternalId, "trace-cardio");
  assert.equal(doctor?.specialty, "Cardiology");
  const source = storedEvent(stub.rows().events.at(-1));
  assert.equal(source.data.authId, otherAuthId);
  assert.equal(source.data.actorAuthId, authId);
  assert.equal(source.data.role, "doctor");
  assert.equal(source.data.operation, "doctor_provisioned");
  const second = randomUUID();
  await profile.workflows.prepare(admin, { workflowId: second, kind: "doctor.specialty", targetAuthId: otherAuthId, input }, metadata());
  await profile.workflows.commit(admin, second, { input, receipt: receipt("doctor.specialty", second, input) }, metadata());
  const all = stub.rows().allEvents;
  assert.equal(all.filter((row) => row.eventType === "vital.audit.requested").length, 3);
  assert.equal(stub.rows().intents.filter((row) => row.authId === otherAuthId && row.destination === "ehr-mirror").length, 2);
  const membership = await profile.adminMembership(adminActor());
  assert.deepEqual(membership.memberships, { patient: [], doctor: [otherAuthId], admin: [authId] });
  assert.deepEqual(membership.counts, { patients: 0, doctors: 1, admins: 1, accounts: 1 });
});

test("profile: revoked admin marker denies prepare replay, commit replay, workflow status and directory reads", async () => {
  const stub = databaseStub();
  await createProfileModule(stub.db, permit).materialize(actor("admin"));
  const profile = createProfileModule(stub.db, createProfileCommandGuard());
  const admin = adminActor(otherAuthId);
  const workflowId = randomUUID();
  const input = { specialty: "Cardiology" };
  const body = { workflowId, kind: "doctor.provision", targetAuthId: otherAuthId, input };
  const preparedId = metadata();
  const commitId = metadata();
  const commit = { input, receipt: receipt("doctor.provision", workflowId, input, otherAuthId) };
  await profile.workflows.prepare(admin, body, preparedId);
  await profile.workflows.commit(admin, workflowId, commit, commitId);
  stub.rows().vitalAdmin.length = 0;
  const before = JSON.stringify(stub.rows());
  for (const run of [() => profile.workflows.prepare(admin, body, preparedId),
    () => profile.workflows.commit(admin, workflowId, commit, commitId),
    () => profile.workflows.status(admin, workflowId), () => profile.adminDoctors(adminActor()),
    () => profile.adminMembership(adminActor())]) {
    await assert.rejects(run(), (error: unknown) => error instanceof ProfileError && error.status === 403);
  }
  assert.equal(JSON.stringify(stub.rows()), before);
});

test("profile: admin lists fail closed to pending sync and workflow routes remain disabled by default", async () => {
  const stub = databaseStub();
  const bootstrap = createProfileModule(stub.db, permit);
  await bootstrap.materialize(actor("admin"));
  await bootstrap.materialize(actor("doctor", otherAuthId));
  await withRouter(stub.db, adminActor(), undefined, async (base) => {
    const response = await fetch(`${base}/admin/doctors`);
    assert.equal(response.status, 200);
    const data = await response.json() as { data: { items: Row[] } };
    assert.equal(data.data.items[0]?.syncStatus, "pending");
    assert.equal((await fetch(`${base}/admin/membership`)).status, 200);
    const prepare = await fetch(`${base}/workflows`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId: randomUUID(), kind: "doctor.provision", targetAuthId: otherAuthId, input: { specialty: "Cardiology" } }) });
    // A self resource is not permission to act on the doctor even while writes are disabled.
    assert.equal(prepare.status, 403);
  });
  await withRouter(stub.db, adminActor(otherAuthId), undefined, async (base) => {
    const response = await fetch(`${base}/workflows`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId: randomUUID(), kind: "doctor.provision", targetAuthId: otherAuthId, input: { specialty: "Cardiology" } }) });
    assert.equal(response.status, 503);
  });
});

test("profile: every committed mutation increments the local aggregate revision and appends its source fact", async () => {
  const stub = databaseStub();
  const profile = createProfileModule(stub.db, permit);
  const user = await profile.materialize(actor());
  await profile.patchPatient(actor(), emergencyContact);
  await profile.patchPatient(actor(), { emergencyContactName: "Updated Name" });
  const events = stub.rows().events.map(storedEvent);
  assert.deepEqual(events.map((event) => event.aggregateVersion), [1, 2, 3]);
  assert.equal(new Set(events.map((event) => event.eventId)).size, 3);
  for (const event of events) {
    assert.equal(event.aggregateId, user.id);
    assert.equal(event.correlationId, actor().correlationId);
    assert.equal(event.eventType, "vital.profile.changed");
    assert.deepEqual(Object.keys(event.data).sort(), ["actorAuthId", "authId", "operation", "role"]);
    assert.equal(event.data.role, "patient");
  }
  assert.equal((await profile.me(actor()))?.version, 3);
});

test("profile: failed outbox append rolls back bootstrap and profile/version changes and sanitizes errors", async () => {
  const bootstrap = databaseStub();
  bootstrap.failOutbox();
  await assert.rejects(createProfileModule(bootstrap.db, permit).materialize(actor()));
  assert.equal(bootstrap.rows().vitalUser.length, 0);
  assert.equal(bootstrap.rows().vitalPatient.length, 0);
  const stub = databaseStub();
  const profile = createProfileModule(stub.db, permit);
  const user = await profile.materialize(actor());
  stub.failOutbox();
  await withRouter(stub.db, actor(), permit, async (base) => {
    const response = await fetch(`${base}/patient/me`, patch(emergencyContact));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { success: false, message: "Profile request failed." });
  });
  assert.equal((await profile.me(actor()))?.version, user.version);
  assert.equal((await profile.patientMe(actor()))?.emergencyContactName, null);
  assert.equal(stub.rows().events.length, 1);
});

test("profile: parent command guard can deny a write before any profile change", async () => {
  const stub = databaseStub();
  const profile = createProfileModule(stub.db, async () => { throw new ProfileError(409, "Command already claimed."); });
  await assert.rejects(profile.materialize(actor()), (error: unknown) => error instanceof ProfileError && error.status === 409);
  assert.equal(stub.rows().vitalUser.length, 0);
  assert.equal(stub.rows().events.length, 0);
  assert.equal(stub.reads.length, 0);
});

test("profile: self actions require the named scope and exact Auth UUID resource before database access", async () => {
  const stub = databaseStub();
  const profile = createProfileModule(stub.db, permit);
  for (const denied of [{ ...actor(), scopes: [] }, { ...actor(), resource: "*", isSuperAdmin: true },
    { ...actor(), resource: otherAuthId }]) {
    for (const run of [() => profile.me(denied), () => profile.patientMe(denied),
      () => profile.materialize(denied), () => profile.patchPatient(denied, emergencyContact)]) {
      await assert.rejects(run(), (error: unknown) => error instanceof DomainError && error.status === 403);
    }
  }
  const readOnly = { ...actor(), scopes: ["profile.read"] };
  assert.equal(await profile.me(readOnly), null);
  await assert.rejects(profile.materialize(readOnly));
  await assert.rejects(profile.patchPatient(readOnly, emergencyContact));
  await withRouter(stub.db, { ...actor(), resource: otherAuthId }, permit, async (base) => {
    assert.equal((await fetch(`${base}/me`)).status, 403);
  });
  assert.equal(stub.transactionOptions.length, 0);
});

test("profile: parent command result and domain mutation commit or roll back in the same transaction", async () => {
  const stub = databaseStub();
  const metadata = { operationId: randomUUID(), requestHash: "a".repeat(64) };
  const guard: ProfileCommandGuard = async (tx, command, execute) => {
    assert.deepEqual(command.metadata, metadata);
    const result = await execute();
    await tx.commandOperation.create({ data: {
      actorId: command.actor.authId, action: command.operation, resourceId: command.actor.authId,
      operationId: metadata.operationId, requestHash: metadata.requestHash, status: "completed",
      result: JSON.stringify(result),
    } });
    return result;
  };
  const profile = createProfileModule(stub.db, guard);
  const user = await profile.materialize(actor(), {}, metadata);
  assert.equal(stub.rows().commands.length, 1);
  assert.equal(stub.rows().commands[0]?.result, JSON.stringify(user));
  const failFinalization = createProfileModule(stub.db, async (tx, command, execute) => {
    await guard(tx, command, execute);
    throw new ProfileError(409, "Command finalization failed.");
  });
  await assert.rejects(failFinalization.patchPatient(actor(), emergencyContact, metadata));
  assert.equal(stub.rows().commands.length, 1);
  assert.equal(stub.rows().events.length, 1);
  assert.equal((await profile.me(actor()))?.version, 1);
  assert.equal((await profile.patientMe(actor()))?.emergencyContactName, null);
});

const registrationActor = (): Actor => ({ ...actor(), scopes: ["profile.registration", "profile.read"] });

test('profile registration receipt: online authority rechecked on replay and atomic bootstrap', async () => {
  const stub = databaseStub();
  let allowed = true;
  let resolutions = 0;
  const profile = createProfileModule(stub.db, createProfileCommandGuard(), async (id, reference) => {
    resolutions++;
    assert.equal(id, authId); assert.equal(reference, otherAuthId);
    if (!allowed) throw new ProfileError(409, 'Registration denied.');
  });
  const delegated: Actor = { ...actor('service'), scopes: ['profile.registration.receipt'] };
  const body = { consent_accepted: true, registrationId: otherAuthId };
  const metadata = { operationId: randomUUID(), requestHash: 'a'.repeat(64) };
  const created = await profile.bootstrapRegistration(delegated, body, metadata);
  assert.equal(created.role, 'patient'); assert.equal(created.patient?.isOnboardingComplete, false);
  await profile.bootstrapRegistration(delegated, body, metadata);
  assert.equal(stub.rows().consentRecord.length, 1); assert.equal(stub.rows().events.length, 1);
  assert.equal(resolutions, 2);
  allowed = false;
  await assert.rejects(profile.bootstrapRegistration(delegated, body, metadata));
  assert.equal(stub.rows().commands.length, 1);
});

test('profile registration receipt: absent authority and wrong scopes fail before persistence', async () => {
  const stub = databaseStub();
  const delegated: Actor = { ...actor('service'), scopes: ['profile.registration.receipt'] };
  const body = { consent_accepted: true, registrationId: otherAuthId };
  await assert.rejects(createProfileModule(stub.db, permit).bootstrapRegistration(delegated, body));
  const profile = createProfileModule(stub.db, permit, async () => { throw new Error('must not resolve'); });
  for (const denied of [{ ...delegated, isSuperAdmin: true }, { ...delegated, scopes: ['profile.registration'] },
    { ...delegated, resource: otherAuthId }, { ...delegated, scopes: ['profile.registration.receipt', 'profile.write'] }]) {
    await assert.rejects(profile.bootstrapRegistration(denied, body));
  }
  assert.equal(stub.rows().vitalUser.length, 0);
});

test("profile registration: bootstrap and consent commit once with signed replay", async () => {
  const stub = databaseStub();
  const profile = createProfileModule(stub.db, createProfileCommandGuard());
  const metadata = { operationId: randomUUID(), requestHash: "a".repeat(64) };
  const user = await profile.bootstrapRegistration(registrationActor(), { consent_accepted: true }, metadata);
  assert.equal(user.role, "patient");
  assert.equal(user.patient?.isOnboardingComplete, false);
  assert.equal(user.patient?.isRecordAvailable, false);
  assert.equal(user.version, 1);
  assert.equal(stub.rows().consentRecord.length, 1);
  assert.equal(stub.rows().consentRecord[0]?.accepted, true);
  assert.ok(stub.rows().consentRecord[0]?.consentedAt instanceof Date);
  assert.equal(stub.rows().events.length, 1);
  assert.equal(stub.rows().intents.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(await profile.bootstrapRegistration(registrationActor(), { consent_accepted: true }, metadata))),
    JSON.parse(JSON.stringify(user)));
  await profile.bootstrapRegistration(registrationActor(), { consent_accepted: true }, { ...metadata, operationId: randomUUID() });
  assert.equal(stub.rows().consentRecord.length, 1);
  assert.equal(stub.rows().events.length, 1);
  assert.equal((await profile.me(registrationActor()))?.version, 1);
  assert.equal(stub.rows().commands.length, 2);
  await assert.rejects(profile.bootstrapRegistration(registrationActor(), { consent_accepted: true }, { ...metadata, requestHash: "b".repeat(64) }),
    (error: unknown) => error instanceof DomainError && error.code === "COMMAND_REPLAY_CONFLICT");
});

test("profile registration: authorization and strict consent input precede database access", async () => {
  const stub = databaseStub();
  const profile = createProfileModule(stub.db, permit);
  for (const denied of [actor(), { ...registrationActor(), resource: otherAuthId },
    { ...registrationActor(), role: "admin" as const, isSuperAdmin: true },
    { ...registrationActor(), role: "doctor" as const }, { ...registrationActor(), role: "service" as const }]) {
    await assert.rejects(profile.bootstrapRegistration(denied, { consent_accepted: true }));
  }
  for (const body of [{}, { consent_accepted: false }, { consent_accepted: true, authId: otherAuthId },
    { consent_accepted: true, role: "admin" }, { consent_accepted: true, password: "secret" }]) {
    await assert.rejects(profile.bootstrapRegistration(registrationActor(), body));
  }
  assert.equal(stub.reads.length, 0);
  assert.equal(stub.transactionOptions.length, 0);
  await assert.rejects(createProfileModule(stub.db).bootstrapRegistration(registrationActor(), { consent_accepted: true }),
    (error: unknown) => error instanceof ProfileError && error.status === 503);
});

test("profile registration: existing doctor and admin markers cannot be replaced", async () => {
  for (const role of ["doctor", "admin"] as const) {
    const stub = databaseStub();
    const profile = createProfileModule(stub.db, permit);
    await profile.materialize(actor(role));
    const before = structuredClone(stub.rows());
    await assert.rejects(profile.bootstrapRegistration(registrationActor(), { consent_accepted: true }),
      (error: unknown) => error instanceof ProfileError && error.status === 409);
    assert.deepEqual(stub.rows(), before);
    // Even after canonical materialization to patient, retained privilege markers deny registration.
    await profile.materialize(actor());
    await assert.rejects(profile.bootstrapRegistration(registrationActor(), { consent_accepted: true }));
    assert.equal(stub.rows().consentRecord.length, 0);
  }
});

test("profile registration: declined consent is not silently overwritten", async () => {
  const stub = databaseStub();
  const profile = createProfileModule(stub.db, permit);
  const user = await profile.materialize(actor());
  await stub.db.consentRecord.create({ data: { patientId: user.id, consentType: "registration", accepted: false } });
  await assert.rejects(profile.bootstrapRegistration(registrationActor(), { consent_accepted: true }),
    (error: unknown) => error instanceof ProfileError && error.status === 409);
  assert.equal(stub.rows().consentRecord.length, 1);
  assert.equal(stub.rows().consentRecord[0]?.accepted, false);
});

test("profile registration: outbox failure rolls back marker consent and command", async () => {
  const stub = databaseStub();
  stub.failOutbox();
  const profile = createProfileModule(stub.db, createProfileCommandGuard());
  await assert.rejects(profile.bootstrapRegistration(registrationActor(), { consent_accepted: true },
    { operationId: randomUUID(), requestHash: "a".repeat(64) }));
  assert.equal(stub.rows().vitalUser.length, 0);
  assert.equal(stub.rows().vitalPatient.length, 0);
  assert.equal(stub.rows().consentRecord.length, 0);
  assert.equal(stub.rows().commands.length, 0);
  assert.equal(stub.rows().allEvents.length, 0);
});


test('S6 onboarding denies missing signature, missing S2, reversed dates and removed honorific',async()=>{
 const stub=databaseStub();await createProfileModule(stub.db,permit).materialize(actor('doctor'));
 const profile=createProfileModule(stub.db,createProfileCommandGuard());
 const prepare=(input:unknown)=>profile.workflows.prepare(actor('doctor'),{workflowId:randomUUID(),kind:'doctor.onboarding',input},metadata());
 stub.rows().vitalDoctor[0]!.signatureAssetId=null;
 await assert.rejects(prepare(doctorOnboarding));
 stub.rows().vitalDoctor[0]!.signatureAssetId=randomUUID();
 const{s2License,...missing}=doctorOnboarding;assert.ok(s2License);await assert.rejects(prepare(missing));
 await assert.rejects(prepare({...doctorOnboarding,s2ValidFrom:'2027-01-01',s2ValidUntil:'2026-01-01'}));
 await assert.rejects(prepare({...doctorOnboarding,title:'Dr.'}));
 assert.equal(stub.rows().vitalDoctor[0]!.isDoctorOnboardingComplete,false);
});
