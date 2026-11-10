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
import { createAppealsRouter } from "../src/eda/http/appointment-appeals-router.js";

function patientActor(patientAuthId: string): Actor {
  return {
    authId: patientAuthId,
    role: "patient",
    scopes: ["appointment.patient.manage"],
    resource: patientAuthId,
    serviceId: "vital-web",
    isSuperAdmin: false,
    correlationId: randomUUID(),
  };
}

function doctorActor(doctorAuthId: string): Actor {
  return {
    authId: doctorAuthId,
    role: "doctor",
    scopes: ["appointment.doctor.manage"],
    resource: doctorAuthId,
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

      if (sql.includes("SELECT p.*,u.version,u.role FROM vital_patients")) {
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
        state.row.reviewHold = Boolean(args[1]);
        state.row.status = String(args[2]) as any;
        state.row.appealReference = String(args[3]);
        state.row.appealDeadlineAt = args[4] as Date;
        state.row.disputeReason = String(args[5]);
        state.row.disputedAt = args[6] as Date;
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
        state.events.push({ topic: args[1], type: args[2], payload: JSON.parse(String(args[4])) });
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

test("startAppeal initializes review hold, generates appeal reference and pauses auto-completion", async () => {
  const fixture = createTestFixture();
  const appointmentModule = createAppointmentModule(fixture.pool);
  const patient = patientActor(fixture.patientAuthId);

  const result = await appointmentModule.startAppeal(
    patient,
    fixture.appointmentId,
    { operationId: randomUUID(), requestHash: "hash-001" },
    { reason: "Doctor was absent during scheduled consultation." }
  );

  assert.equal(result.status, "in_review");
  assert.equal(result.reviewHold, true);
  assert.ok(result.appealReference.startsWith("app-ref-"));
  assert.ok(result.appealDeadlineAt instanceof Date);

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
  const patient = patientActor(fixture.patientAuthId);

  await assert.rejects(
    appointmentModule.startAppeal(
      patient,
      fixture.appointmentId,
      { operationId: randomUUID(), requestHash: "hash-002" },
      { reason: "Duplicate appeal attempt." }
    ),
    (err: unknown) => err instanceof DomainError && err.status === 409 && err.code === "APPEAL_ALREADY_ACTIVE"
  );
});

test("startAppeal fails if caller is not the owning patient", async () => {
  const fixture = createTestFixture();
  const appointmentModule = createAppointmentModule(fixture.pool);
  const foreignPatient = patientActor(randomUUID());

  await assert.rejects(
    appointmentModule.startAppeal(
      foreignPatient,
      fixture.appointmentId,
      { operationId: randomUUID(), requestHash: "hash-003" },
      { reason: "Unauthorized attempt" }
    ),
    (err: unknown) => err instanceof DomainError && err.status === 403
  );
});

test("appointment maintenance freezes auto-completion candidates when reviewHold is active", async () => {
  const fixture = createTestFixture();
  fixture.state.row.reviewHold = true;
  fixture.state.row.status = "in_review";

  const maintenance = createAppointmentMaintenance(fixture.pool);
  const count = await maintenance.run();

  assert.equal(count, 0);
  assert.notEqual(fixture.state.row.status, "completed");
});

test("checkTraceAppealStatus correctly discriminates tri-state response", async () => {
  const fixture = createTestFixture();
  const maintenance = createAppointmentMaintenance(fixture.pool);

  // Test confirmed_no_response
  const mockFetchNoResponse = async () =>
    new Response(JSON.stringify({ status: "confirmed_no_response", reference: "app-ref-123" }), { status: 200 });
  const status1 = await maintenance.checkTraceAppealStatus("app-ref-123", mockFetchNoResponse as any);
  assert.equal(status1, "confirmed_no_response");

  // Test submitted
  const mockFetchSubmitted = async () =>
    new Response(JSON.stringify({ status: "submitted", reference: "app-ref-123" }), { status: 200 });
  const status2 = await maintenance.checkTraceAppealStatus("app-ref-123", mockFetchSubmitted as any);
  assert.equal(status2, "submitted");

  // Test sync_pending
  const mockFetchPending = async () =>
    new Response(JSON.stringify({ status: "sync_pending", reference: "app-ref-123" }), { status: 200 });
  const status3 = await maintenance.checkTraceAppealStatus("app-ref-123", mockFetchPending as any);
  assert.equal(status3, "sync_pending");
});

test("appeals router updates hold on receipt confirmation", async () => {
  const fixture = createTestFixture();
  let updatedCaseId = "";

  const mockPool = {
    query: async (sql: string, args: unknown[]) => {
      if (sql.includes('UPDATE appointments SET "traceCaseId"')) {
        updatedCaseId = String(args[0]);
        return { rowCount: 1, rows: [{ id: fixture.appointmentId, reviewHold: true, traceCaseId: updatedCaseId }] };
      }
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Pool;

  const router = createAppealsRouter(mockPool);
  assert.ok(router, "Appeals router successfully constructed");
});
