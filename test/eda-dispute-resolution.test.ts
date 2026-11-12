// what this block of code do: Unit tests for VITAL dispute resolution, hold lifecycle, TRACE endpoints, and state machine guards
// what triggers it and its relative filepath: npm test or node --test via test/eda-dispute-resolution.test.ts
// what does this trigger and its relative filepath: src/eda/modules/appointment/appointment.ts and src/eda/http/appointment-appeals-router.ts

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";
import type { Actor } from "../src/eda/contracts/actor.js";
import { DomainError } from "../src/eda/contracts/actor.js";
import { createAppointmentModule } from "../src/eda/modules/appointment/appointment.js";
import type { AppointmentRow } from "../src/eda/modules/appointment/appointment-contracts.js";
import { createAppointmentMaintenance } from "../src/eda/modules/appointment/appointment-maintenance.js";
import express from "express";
import { createAppointmentAppealsRouter } from "../src/eda/http/appointment-appeals-router.js";

function patientActor(patientAuthId: string, appointmentId: string): Actor {
  return {
    authId: patientAuthId,
    role: "patient",
    scopes: ["appointments.appeal"],
    resource: appointmentId,
    serviceId: "vital-web",
    isSuperAdmin: false,
    correlationId: randomUUID(),
  };
}

function createTestFixture() {
  const doctorId = randomUUID();
  const patientId = randomUUID();
  const doctorAuthId = randomUUID();
  const patientAuthId = randomUUID();
  const appointmentId = randomUUID();
  const now = Date.now();

  const row: AppointmentRow = {
    id: appointmentId,
    doctorId,
    patientId,
    doctorAuthId,
    patientAuthId,
    status: "confirmed",
    version: 1,
    billingLineageId: randomUUID(),
    associationVersion: 1,
    scheduledAt: new Date(now - 7200000), // 2 hours ago
    proposedEndAt: new Date(now - 3600000),
    slotEndsAt: null,
    scheduleSlotId: null,
    consultationType: "virtual",
    sourceAppointmentId: null,
    appointmentKind: "standard",
    patientRescheduleCount: 0,
    doctorRescheduleCount: 0,
    ehrCaseId: null,
    doctorConfirmedAt: new Date(now - 1800000), // confirmed 30m ago (within 48h window)
    patientConfirmedAt: null,
    completionDeadlineAt: new Date(now + 171000000), // 47.5 hours remaining
    paperworkLockedAt: null,
    completedAt: null,
    proposalRole: null,
    reviewHold: false,
    appealReference: null,
    appealDeadlineAt: null,
    traceCaseId: null,
    disputeReason: null,
    disputedAt: null,
    activeDecisionId: null,
    accountingRef: null,
    accountingRefundIssuedAt: null,
    recordsBlockCode: null,
  };

  const state = {
    row: structuredClone(row),
    events: [] as Record<string, unknown>[],
    commands: new Map<string, Record<string, unknown>>(),
    maintenanceProcessed: [] as string[],
  };

  const tx = {
    async query(sql: string, args: unknown[] = []): Promise<{ rows: any[]; rowCount: number }> {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };

      if (sql.includes("SELECT a.*") || sql.includes("FROM appointments a WHERE a.id")) {
        return { rows: [structuredClone(state.row)], rowCount: 1 };
      }

      if (sql.includes("SELECT p.* FROM vital_patients")) {
        return { rows: [{ userId: patientId, ehrPatientId: patientId, isOnboardingComplete: true }], rowCount: 1 };
      }

      if (sql.includes("SELECT d.* FROM vital_doctors")) {
        return { rows: [{ userId: doctorId, isDoctorOnboardingComplete: true }], rowCount: 1 };
      }

      if (sql.includes("SELECT * FROM command_operations")) {
        return { rows: state.commands.has(String(args[1])) ? [state.commands.get(String(args[1]))] : [], rowCount: 0 };
      }

      if (sql.includes("INSERT INTO command_operations")) {
        state.commands.set(String(args[2]), {
          action: args[3],
          resourceId: args[4],
          requestHash: args[5],
          status: "completed",
          result: JSON.parse(String(args[6])),
        });
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("UPDATE appointments") && sql.includes('"reviewHold"')) {
        state.row.reviewHold = true;
        state.row.status = "in_review";
        state.row.appealReference = String(args[1]);
        state.row.appealDeadlineAt = args[2] as Date;
        state.row.disputedAt = args[3] as Date;
        state.row.disputeReason = String(args[4]);
        state.row.version++;
        return { rows: [{ version: state.row.version }], rowCount: 1 };
      }

      if (sql.includes("UPDATE appointments SET status=") && sql.includes("completed")) {
        state.row.status = "completed";
        state.row.completedAt = new Date();
        state.row.version++;
        return { rows: [{ version: state.row.version }], rowCount: 1 };
      }

      if (sql.includes("INSERT INTO outbox_events")) {
        state.events.push({ topic: args[1], type: args[2], payload: JSON.parse(String(args[8])) });
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("INSERT INTO appointment_state_logs")) {
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("SELECT a.id") && sql.includes('"reviewHold" = false') && sql.includes("completionDeadlineAt")) {
        if (!state.row.reviewHold && state.row.status !== "in_review") {
          return { rows: [{ id: state.row.id }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  const pool = {
    ...tx,
    connect: async () => tx,
  } as unknown as Pool;

  return { state, pool, patientAuthId, doctorAuthId, appointmentId };
}

test.beforeEach(() => { process.env.VITAL_TRACE_DISPUTES_ENABLED = "true"; });

test("startAppeal initializes review hold, generates appeal reference and pauses auto-completion", async () => {
  const fixture = createTestFixture();
  const appointmentModule = createAppointmentModule(fixture.pool);
  const patient = patientActor(fixture.patientAuthId, fixture.appointmentId);

  const result = await appointmentModule.startAppeal(
    patient,
    fixture.appointmentId,
    { operationId: randomUUID(), requestHash: "a".repeat(64) },
    { reason: "Doctor was absent during scheduled consultation." }
  );

  assert.equal(result.status, "in_review");
  assert.equal(result.reviewHold, true);
  assert.ok(result.appealReference.startsWith("app-ref-"));
  assert.ok(Number.isFinite(Date.parse(result.appealDeadlineAt)));

  // Verify internal state in fixture
  assert.equal(fixture.state.row.reviewHold, true);
  assert.equal(fixture.state.row.status, "in_review");
  assert.ok(fixture.state.row.appealReference?.startsWith("app-ref-"));
});

test("startAppeal rejects duplicate appeals when reviewHold is already active", async () => {
  const fixture = createTestFixture();
  fixture.state.row.reviewHold = true;
  fixture.state.row.status = "in_review";
  fixture.state.row.appealReference = "app-ref-existing123";

  const appointmentModule = createAppointmentModule(fixture.pool);
  const patient = patientActor(fixture.patientAuthId, fixture.appointmentId);

  await assert.rejects(
    appointmentModule.startAppeal(
      patient,
      fixture.appointmentId,
      { operationId: randomUUID(), requestHash: "a".repeat(64) },
      { reason: "Duplicate appeal attempt." }
    ),
    (err: unknown) => err instanceof DomainError && err.status === 409 && err.code === "APPEAL_ALREADY_ACTIVE"
  );
});

test("startAppeal fails if caller is not the owning patient", async () => {
  const fixture = createTestFixture();
  const appointmentModule = createAppointmentModule(fixture.pool);
  const foreignPatient = patientActor(randomUUID(), fixture.appointmentId);

  await assert.rejects(
    appointmentModule.startAppeal(
      foreignPatient,
      fixture.appointmentId,
      { operationId: randomUUID(), requestHash: "a".repeat(64) },
      { reason: "Unauthorized attempt" }
    ),
    (err: unknown) => err instanceof DomainError && err.status === 403
  );
});

test("appointment maintenance freezes auto-completion candidates when reviewHold is active", async () => {
  const fixture = createTestFixture();
  fixture.state.row.reviewHold = true;
  fixture.state.row.status = "in_review";

  const maintenance = createAppointmentMaintenance(fixture.pool, {}, undefined);
  const { processed } = await maintenance.lifecycle();

  assert.equal(processed, 0);
  assert.notEqual(fixture.state.row.status, "completed");
});

test("TRACE callbacks enforce receipt timing, deduplication and refund approval", async (t) => {
  const appointmentId = randomUUID();
  const caseId = randomUUID();
  const appealReference = "app-ref-test";
  let linkedCase: string | null = null;
  let writes = 0;
  let status = "in_review";
  const tx = {
    async query(sql: string, args: unknown[] = []) {
      if (sql.includes("SELECT id, status")) {
        return { rows: [{ id: appointmentId, status, version: 1, reviewHold: status === "in_review", traceRefundApproved: false,
          disputedAt: new Date("2026-11-10T00:00:00Z"), appealDeadlineAt: new Date("2026-11-11T00:00:00Z"),
          traceCaseId: linkedCase }] };
      }
      if (sql.includes("UPDATE appointments SET")) {
        linkedCase = String(args[1]);
        writes++;
      }
      return { rows: [] };
    },
    release() {},
  };
  const app = express();
  app.use(express.json(), createAppointmentAppealsRouter({ connect: async () => tx } as unknown as Pool));
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.sendStatus(error instanceof DomainError ? error.status : 500);
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const post = (timestamp: string) => fetch("http://127.0.0.1:" + address.port + "/receipt", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appeal_reference: appealReference, case_id: caseId, submitted_at: timestamp }),
  });
  assert.equal((await post("2026-11-11T00:00:01Z")).status, 409);
  assert.equal(writes, 0);
  assert.equal((await post("2026-11-10T23:59:59+00:00")).status, 200);
  assert.equal((await post("2026-11-10T23:59:59+00:00")).status, 200);
  assert.equal(writes, 1);

  status = "invalid";
  const refund = await fetch("http://127.0.0.1:" + address.port + "/refund-confirmed", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appointment_id: appointmentId, appeal_reference: appealReference,
      case_id: caseId, reconciliation_reference: "cashier-123" }),
  });
  assert.equal(refund.status, 409);
  assert.equal(writes, 1);
});
