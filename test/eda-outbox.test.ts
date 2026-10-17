import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { dispatchOutbox, makeEvent, processWithInbox, retryDelay, type OutboxRow } from "../src/eda/infrastructure/outbox.js";
import { validateDatabaseBoundary } from "../src/eda/infrastructure/databases.js";

const event = () => makeEvent({ producer: "profile", eventType: "vital.profile.changed", aggregateId: randomUUID(),
  aggregateVersion: 1, correlationId: randomUUID(), data: { authId: randomUUID(), role: "patient", operation: "materialized" } });

test("EDA inbox commits effects before success and rolls back failed effects before releasing", async () => {
  for (const outcome of ["new", "duplicate", "failure"] as const) {
    const calls: string[] = [];
    const pool = { async connect() { return {
      async query(sql: string) { calls.push(sql.startsWith("INSERT") ? "inbox" : sql); return { rowCount: outcome === "duplicate" ? 0 : 1 }; },
      release() { calls.push("release"); },
    }; } } as unknown as Pool;
    const apply = async () => { calls.push("effects"); if (outcome === "failure") throw new Error("fault"); };
    if (outcome === "failure") await assert.rejects(processWithInbox(pool, "consumer", event(), apply));
    else assert.equal(await processWithInbox(pool, "consumer", event(), apply), outcome === "new");
    assert.deepEqual(calls, outcome === "duplicate" ? ["BEGIN", "inbox", "COMMIT", "release"] :
      ["BEGIN", "inbox", "effects", outcome === "failure" ? "ROLLBACK" : "COMMIT", "release"]);
  }
});

test("EDA outbox marks published only after confirm and retains failed or malformed rows", async () => {
  const fact = event();
  const row: OutboxRow = { ...fact, id: fact.eventId, occurredAt: new Date(fact.occurredAt), payload: fact.data, attempts: 0 };
  for (const outcome of ["success", "failure", "malformed"] as const) {
    const calls: string[] = [];
    const pool = { async query(sql: string, args?: unknown[]) {
      if (sql.startsWith("WITH")) { calls.push("claim"); return { rows: [{ ...row, ...(outcome === "malformed" ? { payload: { clinicalText: "forbidden" } } : {}) }] }; }
      calls.push(sql.includes("status='published'") ? "mark" : `retain:${args?.[2]}`);
      return { rows: [], rowCount: 1 };
    } } as unknown as Pool;
    const result = await dispatchOutbox(pool, async (published) => { calls.push("confirm"); assert.equal(published.eventId, fact.eventId);
      if (outcome === "failure") throw new Error("broker unavailable"); }, "test-owner");
    assert.equal(result.published, outcome === "success" ? 1 : 0);
    assert.deepEqual(calls, outcome === "success" ? ["claim", "confirm", "mark"] :
      outcome === "failure" ? ["claim", "confirm", "retain:pending"] : ["claim", "retain:blocked"]);
  }
  assert.equal(retryDelay(0), 60_000);
  assert.equal(retryDelay(100), 21_600_000);
});

test("EDA database configuration preserves two databases and rejects superuser or TLS overrides", () => {
  const core = "postgresql://core_api:example@db:5432/vital_core";
  const integrations = "postgresql://integration_api:example@db:5432/vital_integrations";
  validateDatabaseBoundary(core, integrations);
  for (const changed of [core.replace("core_api", "postgres"), core.replace("core_api", "%70ostgres"),
    core.replace("vital_core", "vital_integrations"), `${core}?sslmode=no-verify`, core.replace("@db", "@other-db")]) {
    assert.throws(() => validateDatabaseBoundary(changed, integrations));
  }
  assert.throws(() => validateDatabaseBoundary(core, integrations.replace("integration_api", "core_api")));
});
