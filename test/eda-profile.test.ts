import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { DomainError, type Actor } from "../src/eda/contracts/actor.js";
import { parseEvent } from "../src/eda/contracts/events.js";
import type { CorePrismaClient } from "../src/eda/infrastructure/databases.js";
import { createProfileModule, ProfileError, type ProfileCommandGuard } from "../src/eda/modules/core/profile.js";
import { createProfileRouter } from "../src/eda/http/profile-router.js";

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
type Table = "vitalUser" | "vitalPatient" | "vitalDoctor" | "vitalAdmin";

// The only structural Prisma cast lives in this test fixture. It honors select and transaction rollback.
function databaseStub() {
  let state: Record<Table, Row[]> & { events: Row[]; commands: Row[] } = { vitalUser: [], vitalPatient: [], vitalDoctor: [], vitalAdmin: [], events: [], commands: [] };
  const reads: Array<{ table: Table; query: Query }> = [];
  const transactionOptions: unknown[] = [];
  let failOutbox = false;
  let transactionDepth = 0;
  function project(row: Row | undefined, select?: Select): Row | null {
    if (!row) return null;
    if (!select) return { ...row };
    return Object.fromEntries(Object.entries(select).filter(([, value]) => Boolean(value)).map(([key, value]) => {
      if (typeof value === "boolean") return [key, row[key]];
      const table: Table | undefined = key === "patient" ? "vitalPatient" : key === "doctor" ? "vitalDoctor" : key === "admin" ? "vitalAdmin" : undefined;
      return [key, table ? project(state[table].find((marker) => marker.userId === row.id), value.select) : null];
    }));
  }
  function find(table: Table, query: Query) {
    return state[table].find((row) => Object.entries(query.where ?? {}).every(([key, value]) => row[key] === value));
  }
  function defaults(table: Table): Row {
    if (table === "vitalUser") return { id: randomUUID(), version: 0 };
    if (table === "vitalPatient") return { profilePic: null, isRecordAvailable: false, ehrPatientId: null,
      ehrRecordOrigin: "none", existingEhrRecordNoticeDismissedAt: null, isOnboardingComplete: false,
      emergencyContactName: null, emergencyContactRelationship: null, emergencyContactPhone: null };
    if (table === "vitalDoctor") return { role: "doctor", title: null, specialty: null, departmentExternalId: null,
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
  const delegates = Object.fromEntries((["vitalUser", "vitalPatient", "vitalDoctor", "vitalAdmin"] as const).map((table) => [table, {
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
    commandOperation: { async create(query: Query) {
      assert.equal(transactionDepth, 1, "command result must be inside the Core transaction");
      const row = { id: randomUUID(), ...query.data };
      state.commands.push(row);
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
  return { db, reads, transactionOptions, rows: () => state, failOutbox: () => { failOutbox = true; } };
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

test("profile: patient onboarding validates consent, personal/address details, and trusted EHR confirmation", async () => {
  const stub = databaseStub();
  const profile = createProfileModule(stub.db, permit);
  await profile.materialize(actor());
  for (const invalid of [{ ...onboarding, consent_accepted: false }, { ...onboarding, date_of_birth: "2999-01-01" },
    { ...onboarding, date_of_birth: "2000-02-30" }, { ...onboarding, contact_number: "123" },
    { ...onboarding, address_province_region: "CAR", address_province: "" }, { ...onboarding, address_street: "x" }]) {
    await assert.rejects(profile.patchPatient(actor(), { isOnboardingComplete: true, onboarding: invalid }));
  }
  await assert.rejects(profile.patchPatient(actor(), { isOnboardingComplete: true, onboarding }),
    (error: unknown) => error instanceof ProfileError && error.status === 503);
  const verified = createProfileModule(stub.db, async (_tx, command, execute) => {
    assert.equal(command.operation, "patient.onboarding");
    return execute({ patientRecord: { ehrPatientId: "ehr-owned-patient-id", ehrRecordOrigin: "preexisting" } });
  });
  const patient = await verified.patchPatient(actor(), { isOnboardingComplete: true, onboarding });
  assert.equal(patient.isOnboardingComplete, true);
  assert.equal(patient.ehrPatientId, "ehr-owned-patient-id");
  assert.equal(patient.ehrRecordOrigin, "preexisting");
  await assert.rejects(verified.patchPatient(actor(), { isOnboardingComplete: true, onboarding }),
    (error: unknown) => error instanceof ProfileError && error.status === 409);
  assert.equal(storedEvent(stub.rows().events.at(-1)).data.operation, "onboarded");
});

test("profile: doctor fees are bounded and onboarding requires fields, terms, and verified specialty", async () => {
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
  const input = { title: "MD", specialty: "Cardiology", prcLicense: "123456", bio: "Clinical biography",
    availabilityType: "both", isDoctorOnboardingComplete: true, terms_accepted: true };
  await assert.rejects(profile.patchDoctor(actor("doctor"), input),
    (error: unknown) => error instanceof ProfileError && error.status === 503);
  const verified = createProfileModule(stub.db, async (_tx, _command, execute) => execute({ specialty: "Cardiology" }));
  const completed = await verified.patchDoctor(actor("doctor"), input);
  assert.equal(completed.isDoctorOnboardingComplete, true);
  assert.ok(completed.termsAgreedAt instanceof Date);
  await assert.rejects(verified.patchDoctor(actor("doctor"), { specialty: "Neurology" }),
    (error: unknown) => error instanceof ProfileError && error.status === 403);
  await assert.rejects(verified.patchDoctor(actor("doctor"), input),
    (error: unknown) => error instanceof ProfileError && error.status === 409);
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
