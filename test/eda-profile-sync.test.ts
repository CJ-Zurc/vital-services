import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Prisma } from "../src/eda/generated/core/client.js";
import { recordProfileEffects } from "../src/eda/modules/profile/profile-effects.js";
import { syncRequest, type ProfileSyncIntent } from "../src/eda/modules/profile/profile-sync.js";
import { consumeProfileSync, deliverProfileSync, getProfileSyncStatuses } from "../src/eda/modules/profile/profile-delivery.js";
import { requestHash } from "../src/eda/infrastructure/security.js";
import { makeEvent } from "../src/eda/infrastructure/outbox.js";

type Query = (sql: string, values: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
const pool = (query: Query) => ({ query, async connect() { return { query, release() {} }; } }) as unknown as Pool;
const result = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount });
function intent(destination: "auth-stale" | "ehr-mirror" = "auth-stale", version = 1): ProfileSyncIntent {
  const authId = randomUUID(); const requestId = randomUUID();
  const payload = destination === "auth-stale" ? {} : { source: "vital-services", request_id: requestId,
    source_version: version, department_external_id: "department-123", department_name: "Cardiology" };
  return { id: randomUUID(), profileId: randomUUID(), authId, sourceVersion: version, destination, requestId,
    requestHash: requestHash(destination === "auth-stale" ? "POST" : "PUT",
      `/internal/users/${authId}/${destination === "auth-stale" ? "stale" : "doctor-mirror"}`, payload), payload };
}
function sourceEvent(source: ProfileSyncIntent) {
  return makeEvent({ eventType: "vital.profile.sync.requested", producer: "profile", aggregateId: source.profileId,
    aggregateVersion: source.sourceVersion, correlationId: randomUUID(), data: { intentId: source.id,
      authId: source.authId, destination: source.destination } });
}

test("EDA Profile effects commit minimal fact, one audit intent and owned sync intents", async () => {
  const events: Array<Record<string, unknown>> = []; const intents: Array<Record<string, unknown>> = [];
  const tx = { outboxEvent: { async create({ data }: { data: Record<string, unknown> }) { events.push(data); return data; } },
    profileSyncIntent: { async create({ data }: { data: Record<string, unknown> }) { intents.push(data); return data; } } } as unknown as Prisma.TransactionClient;
  const actorId = randomUUID(); const subjectId = randomUUID();
  await recordProfileEffects(tx, { authId: actorId, role: "admin", scopes: [], resource: subjectId,
    serviceId: "vital-web", correlationId: randomUUID(), isSuperAdmin: false },
  { id: randomUUID(), authId: subjectId, role: "doctor", version: 7 }, "doctor.provision",
  { doctorMirror: true, departmentExternalId: "dep-123", departmentName: "Cardiology" });
  assert.equal(events.length, 4); assert.equal(intents.length, 2);
  const fact = events.find(event => event.eventType === "vital.profile.changed")!;
  assert.equal((fact.payload as Record<string, unknown>).authId, subjectId);
  assert.equal((fact.payload as Record<string, unknown>).actorAuthId, actorId);
  assert.equal(events.filter(event => event.eventType === "vital.audit.requested").length, 1);
  assert.ok(events.filter(event => event.eventType !== "vital.profile.changed").every(event => event.causationId === fact.id));
  for (const event of events) assert.ok(!JSON.stringify(event.payload).includes("Cardiology"));
  for (const row of intents) syncRequest(row as unknown as ProfileSyncIntent);
});

test("EDA Profile sync validates committed identity, version and request hash before inbox effects", async () => {
  const source = intent("ehr-mirror"); const event = sourceEvent(source);
  const core = pool(async () => result([source]));
  const sql: string[] = []; let writes = 0;
  const integrations = pool(async (query, values) => {
    sql.push(query);
    if (query.includes("INSERT INTO inbox_events")) return result([{}]);
    if (query.includes("INSERT INTO integration_deliveries")) { writes++; return result([], 1); }
    if (query.includes('SELECT "requestHash"')) return result([{ requestHash: values[0] ? source.requestHash : "invalid" }]);
    return result();
  });
  await consumeProfileSync(core, integrations, event);
  assert.equal(writes, 1); assert.ok(sql.includes("COMMIT"));
  assert.throws(() => syncRequest({ ...source, requestHash: "0".repeat(64) }), /HASH_MISMATCH/);
  await assert.rejects(consumeProfileSync(core, integrations, { ...event, aggregateVersion: 2 }), /SOURCE_UNVERIFIED/);
  assert.equal(writes, 1);
});

test("EDA Profile sync duplicate inbox skips delivery and hash conflicts roll back", async () => {
  const source = intent(); const event = sourceEvent(source); const core = pool(async () => result([source]));
  const queries: string[] = [];
  await consumeProfileSync(core, pool(async sql => {
    queries.push(sql); return result([], 0);
  }), event);
  assert.ok(queries.includes("COMMIT")); assert.ok(!queries.some(sql => sql.includes("INSERT INTO integration_deliveries")));
  queries.length = 0;
  await assert.rejects(consumeProfileSync(core, pool(async sql => {
    queries.push(sql);
    if (sql.includes("INSERT INTO inbox_events")) return result([{}]);
    if (sql.includes('SELECT "requestHash"')) return result([{ requestHash: "different" }]);
    return result();
  }), event), /DELIVERY_REQUEST_CONFLICT/);
  assert.ok(queries.includes("ROLLBACK")); assert.ok(!queries.includes("COMMIT"));
});

test("EDA Profile sync status uses latest required destination revisions and fails closed on conflicts", async () => {
  const a = intent(); const b = { ...intent("ehr-mirror", 3), authId: a.authId };
  const c = intent(); const d = intent();
  const core = pool(async () => result([a, b, c, d]));
  const integrations = pool(async () => result([
    { requestId: a.requestId, requestHash: a.requestHash, status: "accepted" },
    { requestId: b.requestId, requestHash: b.requestHash, status: "blocked" },
    { requestId: c.requestId, requestHash: c.requestHash, status: "accepted" },
  ]));
  const missing = randomUUID();
  const states = await getProfileSyncStatuses(core, integrations, [a.authId, c.authId, d.authId, missing]);
  assert.equal(states.get(a.authId), "failed"); assert.equal(states.get(c.authId), "synced"); assert.equal(states.get(d.authId), "pending");
  assert.equal(states.get(missing), "pending");
});

function deliveryFixture(source: ProfileSyncIntent, latest = source) {
  const updates: unknown[][] = [];
  const core = pool(async () => result([latest]));
  const integrations = pool(async (sql, values) => {
    if (sql.startsWith("WITH due")) return result([{ ...source, aggregateId: source.profileId, eventId: randomUUID(),
      correlationId: randomUUID(), attempts: 0, payload: { authId: source.authId, body: source.payload } }]);
    updates.push(values); return result([], 1);
  });
  return { core, integrations, updates };
}
const config = { auth: { baseUrl: "https://auth.internal", key: "auth-test" }, ehr: { baseUrl: "https://ehr.internal", key: "ehr-test" } };

test("EDA Profile sync delivery suppresses superseded mirrors before external calls", async () => {
  const source = intent("ehr-mirror"); const fixture = deliveryFixture(source, { ...source, sourceVersion: 2 });
  let calls = 0;
  await deliverProfileSync(fixture.core, fixture.integrations, config, (async () => { calls++; throw new Error(); }) as typeof fetch);
  assert.equal(calls, 0); assert.equal(fixture.updates.length, 1);
});

test("EDA Profile sync delivery binds stable operation headers and accepts only matching persisted receipts", async () => {
  const source = intent(); const fixture = deliveryFixture(source); let calls = 0;
  await deliverProfileSync(fixture.core, fixture.integrations, config, (async (url, init) => {
    calls++; assert.equal(new URL(String(url)).pathname, `/internal/users/${source.authId}/stale`);
    assert.equal(new Headers(init?.headers).get("X-Vital-Operation-ID"), source.requestId);
    assert.equal(new Headers(init?.headers).get("X-Vital-Request-Hash"), source.requestHash);
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    return Response.json({ success: true, data: { stale_since: 1, vitalOperation: {
      operationId: source.requestId, requestHash: source.requestHash, status: "completed" } } });
  }) as typeof fetch);
  assert.equal(calls, 1); assert.equal(fixture.updates[0]?.[2], source.requestId);
});

test("EDA Profile sync unknown outcomes retry the same durable intent and receipt mismatches block", async () => {
  const source = intent(); const fixture = deliveryFixture(source);
  await deliverProfileSync(fixture.core, fixture.integrations, config, (async () => { throw new Error("timeout"); }) as typeof fetch);
  assert.equal(fixture.updates[0]?.[2], "pending");
  const rejected = deliveryFixture(source);
  await deliverProfileSync(rejected.core, rejected.integrations, config, (async () => Response.json({ success: true, data: {},
    vitalOperation: { operationId: randomUUID(), requestHash: source.requestHash, status: "completed" } })) as typeof fetch);
  assert.equal(rejected.updates[0]?.[2], "blocked");
});

test("EDA Profile sync terminal credentials and exhausted retries never loop immediately", async () => {
  const source = intent(); const fixture = deliveryFixture(source);
  await deliverProfileSync(fixture.core, fixture.integrations, config, (async () => new Response("", { status: 403 })) as typeof fetch);
  assert.equal(fixture.updates[0]?.[2], "blocked"); assert.equal(fixture.updates[0]?.[3], 60);
});

test("EDA Profile mirror receipts bind doctor and department without accepting superseded success", async () => {
  const source = intent("ehr-mirror"); const fixture = deliveryFixture(source);
  const receipt = { operationId: source.requestId, requestHash: source.requestHash, sourceVersion: 1, status: "completed" };
  const response = { success: true, data: { auth_id: source.authId, role: "doctor", department_external_id: "department-123", department_name: "Cardiology" }, vitalOperation: receipt };
  await deliverProfileSync(fixture.core, fixture.integrations, config, (async () => Response.json(response)) as typeof fetch);
  assert.equal(fixture.updates[0]?.[2], source.requestId);
  for (const invalid of [{ ...response, data: { ...response.data, auth_id: randomUUID() } },
    { ...response, data: { ...response.data, department_name: "Different" } },
    { ...response, vitalOperation: { ...receipt, status: "superseded" } }]) {
    const failed = deliveryFixture(source);
    await deliverProfileSync(failed.core, failed.integrations, config, (async () => Response.json(invalid)) as typeof fetch);
    assert.equal(failed.updates[0]?.[2], "blocked");
  }
});

test("EDA Profile delivery bounds receipt size and validates configured targets before transport", async () => {
  const source = intent(); const fixture = deliveryFixture(source);
  await deliverProfileSync(fixture.core, fixture.integrations, config, (async () => new Response("x".repeat(70_000))) as typeof fetch);
  assert.equal(fixture.updates[0]?.[2], "pending");
  const invalid = deliveryFixture(source); let calls = 0;
  await deliverProfileSync(invalid.core, invalid.integrations, { ...config, auth: { baseUrl: "https://user:password@auth.internal", key: "test" } },
    (async () => { calls++; throw new Error(); }) as typeof fetch);
  assert.equal(calls, 0); assert.equal(invalid.updates[0]?.[2], "blocked");
});
