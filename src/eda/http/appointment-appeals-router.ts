import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { DomainError } from "../contracts/actor.js";
import { appendSqlOutbox } from "../infrastructure/outbox.js";
import { effectiveCompletionDeadline } from "../modules/appointment/appointment-contracts.js";

const receiptInput = z.object({
  appeal_reference: z.string().min(5).max(64),
  case_id: z.string().uuid(),
  form_id: z.string().uuid().nullable().optional(),
  response_id: z.string().nullable().optional(),
  submitted_at: z.string().datetime().optional()
}).strict();

const dispositionInput = z.object({
  event_id: z.string().uuid().optional(),
  case_id: z.string().uuid(),
  appeal_reference: z.string().min(5).max(64),
  appointment_id: z.string().uuid(),
  decision_id: z.string().uuid(),
  supersedes_decision_id: z.string().uuid().nullable().optional(),
  disposition: z.enum(["appointment_invalidated", "appeal_dismissed", "reschedule_agreed"]),
  decided_by_role: z.string().optional(),
  decided_at: z.string().datetime().optional()
}).strict();

const refundConfirmedInput = z.object({
  event_id: z.string().uuid().optional(),
  case_id: z.string().uuid(),
  appeal_reference: z.string().min(5).max(64),
  appointment_id: z.string().uuid(),
  reconciliation_reference: z.string().min(1).max(255),
  issuance_date: z.string().datetime().optional(),
  refund_amount: z.number().nullable().optional()
}).strict();

const redirectInput = z.object({
  event_id: z.string().uuid().optional(),
  case_id: z.string().uuid(),
  appeal_reference: z.string().min(5).max(64),
  appointment_id: z.string().uuid().nullable().optional(),
  notes: z.string().optional(),
  redirected_at: z.string().datetime().optional()
}).strict();

export function createAppointmentAppealsRouter(pool: Pool) {
  const router = Router();

  // Ingests verified submission receipt from TRACE
  router.post("/receipt", async (req, res, next) => {
    try {
      const input = receiptInput.parse(req.body);
      const correlationId = (req.get("X-Correlation-ID") as string) || randomUUID();
      const submittedAt = input.submitted_at ? new Date(input.submitted_at) : new Date();

      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        const rows = (await tx.query(
          `SELECT id, status, version, "reviewHold", "appealDeadlineAt"
           FROM appointments WHERE "appealReference" = $1 FOR UPDATE`,
          [input.appeal_reference]
        )).rows;

        if (!rows.length) {
          await tx.query("ROLLBACK");
          throw new DomainError(404, "APPEAL_REFERENCE_NOT_FOUND", "No appointment found for appeal reference.");
        }

        const appt = rows[0];
        const timely = !appt.appealDeadlineAt || submittedAt.getTime() <= (appt.appealDeadlineAt.getTime() + 60000); // 1m grace

        await tx.query(
          `UPDATE appointments SET
            "traceCaseId" = $2,
            "reviewHold" = true,
            status = 'in_review',
            version = version + 1,
            "updatedAt" = NOW()
          WHERE id = $1`,
          [appt.id, input.case_id]
        );

        await tx.query(
          `INSERT INTO appointment_logs (id, "appointmentId", "fromStatus", "toStatus", "changedByRole", note, "changedAt")
           VALUES ($1, $2, $3, 'in_review', 'trace', $4, NOW())`,
          [randomUUID(), appt.id, appt.status, timely ? "trace_receipt_confirmed" : "trace_receipt_late"]
        );

        await appendSqlOutbox(tx, {
          producer: "appointment",
          eventType: "vital.appointment.appeal_receipt_locked",
          aggregateId: appt.id,
          aggregateVersion: appt.version + 1,
          correlationId,
          causationId: correlationId,
          data: { appointmentId: appt.id, appealReference: input.appeal_reference, traceCaseId: input.case_id, timely }
        });

        await tx.query("COMMIT");
        res.status(200).json({
          success: true,
          contractVersion: 1,
          data: { appeal_reference: input.appeal_reference, case_id: input.case_id, status: "locked", timely }
        });
      } catch (err) {
        await tx.query("ROLLBACK");
        throw err;
      } finally {
        tx.release();
      }
    } catch (err) {
      next(err);
    }
  });

  // Ingests authenticated final disposition from TRACE HR/Medical Affairs
  router.post("/disposition", async (req, res, next) => {
    try {
      const input = dispositionInput.parse(req.body);
      const correlationId = (req.get("X-Correlation-ID") as string) || input.event_id || randomUUID();

      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        const rows = (await tx.query(
          `SELECT id, status, version, "reviewHold", "activeDecisionId", "doctorConfirmedAt", "patientConfirmedAt",
                  "completionDeadlineAt", "scheduledAt", "proposedEndAt"
           FROM appointments WHERE id = $1 OR "appealReference" = $2 FOR UPDATE`,
          [input.appointment_id, input.appeal_reference]
        )).rows;

        if (!rows.length) {
          await tx.query("ROLLBACK");
          throw new DomainError(404, "APPOINTMENT_NOT_FOUND", "Appointment not found for disposition.");
        }

        const appt = rows[0];

        // Decision revision / conflict check
        if (appt.activeDecisionId && input.supersedes_decision_id && appt.activeDecisionId !== input.supersedes_decision_id) {
          // Conflicting or stale decision; route to VITAL Admin review
          await tx.query(
            `UPDATE appointments SET
              "recordsBlockCode" = 'DISPUTE_DECISION_CONFLICT',
              version = version + 1,
              "updatedAt" = NOW()
            WHERE id = $1`,
            [appt.id]
          );

          await tx.query(
            `INSERT INTO appointment_logs (id, "appointmentId", "fromStatus", "toStatus", "changedByRole", note, "changedAt")
             VALUES ($1, $2, $3, $3, 'trace', 'disposition_conflict_routed_to_admin', NOW())`,
            [randomUUID(), appt.id, appt.status]
          );

          await tx.query("COMMIT");
          return res.status(200).json({
            success: true,
            contractVersion: 1,
            data: { appointment_id: appt.id, disposition: input.disposition, applied: false, status: "conflict_routed_to_admin" }
          });
        }

        let nextStatus = appt.status;
        let note = `disposition_${input.disposition}`;

        if (input.disposition === "appointment_invalidated") {
          nextStatus = "invalid";
        } else if (input.disposition === "appeal_dismissed") {
          // Clear hold and evaluate whether completion deadline has already passed
          const deadline = effectiveCompletionDeadline(appt);
          if (appt.doctorConfirmedAt && Date.now() >= deadline.getTime()) {
            nextStatus = "completed";
            note = "disposition_dismissed_autocompleted";
          } else {
            nextStatus = "confirmed";
          }
        } else if (input.disposition === "reschedule_agreed") {
          nextStatus = "confirmed";
          note = "disposition_reschedule_offered";
        }

        await tx.query(
          `UPDATE appointments SET
            status = $2::"AppointmentStatus",
            "reviewHold" = false,
            "activeDecisionId" = $3,
            version = version + 1,
            "updatedAt" = NOW()
          WHERE id = $1`,
          [appt.id, nextStatus, input.decision_id]
        );

        await tx.query(
          `INSERT INTO appointment_logs (id, "appointmentId", "fromStatus", "toStatus", "changedByRole", note, "changedAt")
           VALUES ($1, $2, $3, $4, 'trace', $5, NOW())`,
          [randomUUID(), appt.id, appt.status, nextStatus, note]
        );

        await appendSqlOutbox(tx, {
          producer: "appointment",
          eventType: `vital.appointment.disposition_${input.disposition}`,
          aggregateId: appt.id,
          aggregateVersion: appt.version + 1,
          correlationId,
          causationId: correlationId,
          data: { appointmentId: appt.id, disposition: input.disposition, decisionId: input.decision_id, nextStatus }
        });

        await tx.query("COMMIT");
        res.status(200).json({
          success: true,
          contractVersion: 1,
          data: { appointment_id: appt.id, disposition: input.disposition, applied: true, nextStatus }
        });
      } catch (err) {
        await tx.query("ROLLBACK");
        throw err;
      } finally {
        tx.release();
      }
    } catch (err) {
      next(err);
    }
  });

  // Ingests external refund confirmation from Accounting
  router.post("/refund-confirmed", async (req, res, next) => {
    try {
      const input = refundConfirmedInput.parse(req.body);
      const correlationId = (req.get("X-Correlation-ID") as string) || input.event_id || randomUUID();
      const issuanceDate = input.issuance_date ? new Date(input.issuance_date) : new Date();

      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        const rows = (await tx.query(
          `SELECT id, status, version, "accountingRef" FROM appointments
           WHERE id = $1 OR "appealReference" = $2 FOR UPDATE`,
          [input.appointment_id, input.appeal_reference]
        )).rows;

        if (!rows.length) {
          await tx.query("ROLLBACK");
          throw new DomainError(404, "APPOINTMENT_NOT_FOUND", "Appointment not found for refund confirmation.");
        }

        const appt = rows[0];

        // Idempotently record refund confirmation
        await tx.query(
          `UPDATE appointments SET
            "accountingRef" = $2,
            "accountingRefundIssuedAt" = $3,
            version = version + 1,
            "updatedAt" = NOW()
          WHERE id = $1`,
          [appt.id, input.reconciliation_reference, issuanceDate]
        );

        // Update payment projections / intents to refunded if exists
        await tx.query(
          `UPDATE appointment_payment_projections SET
            status = 'refunded',
            "updatedAt" = NOW()
          WHERE "appointmentId" = $1`,
          [appt.id]
        );

        await tx.query(
          `INSERT INTO appointment_logs (id, "appointmentId", "fromStatus", "toStatus", "changedByRole", note, "changedAt")
           VALUES ($1, $2, $3, $3, 'accounting', 'refund_confirmed_reconciled', NOW())`,
          [randomUUID(), appt.id, appt.status]
        );

        await appendSqlOutbox(tx, {
          producer: "appointment",
          eventType: "vital.appointment.refund_confirmed",
          aggregateId: appt.id,
          aggregateVersion: appt.version + 1,
          correlationId,
          causationId: correlationId,
          data: {
            appointmentId: appt.id,
            reconciliationReference: input.reconciliation_reference,
            issuanceDate: issuanceDate.toISOString(),
            refundAmount: input.refund_amount
          }
        });

        await tx.query("COMMIT");
        res.status(200).json({
          success: true,
          contractVersion: 1,
          data: {
            appointment_id: appt.id,
            reconciliation_reference: input.reconciliation_reference,
            status: "refund_recorded"
          }
        });
      } catch (err) {
        await tx.query("ROLLBACK");
        throw err;
      } finally {
        tx.release();
      }
    } catch (err) {
      next(err);
    }
  });

  // Ingests redirection to VITAL Admin (e.g. for patient-only disputes)
  router.post("/redirect-to-admin", async (req, res, next) => {
    try {
      const input = redirectInput.parse(req.body);
      const correlationId = (req.get("X-Correlation-ID") as string) || input.event_id || randomUUID();

      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        const rows = (await tx.query(
          `SELECT id, status, version FROM appointments
           WHERE "appealReference" = $1 ${input.appointment_id ? 'OR id = $2' : ''} FOR UPDATE`,
          input.appointment_id ? [input.appeal_reference, input.appointment_id] : [input.appeal_reference]
        )).rows;

        if (!rows.length) {
          await tx.query("ROLLBACK");
          throw new DomainError(404, "APPEAL_REFERENCE_NOT_FOUND", "Appointment not found for redirection.");
        }

        const appt = rows[0];

        await tx.query(
          `UPDATE appointments SET
            "recordsBlockCode" = 'REDIRECTED_VITAL_ADMIN',
            "reviewHold" = true,
            status = 'in_review',
            version = version + 1,
            "updatedAt" = NOW()
          WHERE id = $1`,
          [appt.id]
        );

        await tx.query(
          `INSERT INTO appointment_logs (id, "appointmentId", "fromStatus", "toStatus", "changedByRole", note, "changedAt")
           VALUES ($1, $2, $3, 'in_review', 'trace', 'redirected_to_vital_admin', NOW())`,
          [randomUUID(), appt.id, appt.status]
        );

        await tx.query("COMMIT");
        res.status(200).json({
          success: true,
          contractVersion: 1,
          data: { appeal_reference: input.appeal_reference, status: "redirected_vital_admin" }
        });
      } catch (err) {
        await tx.query("ROLLBACK");
        throw err;
      } finally {
        tx.release();
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
