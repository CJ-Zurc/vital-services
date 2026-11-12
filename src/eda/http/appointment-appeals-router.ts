import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { DomainError } from "../contracts/actor.js";
import { appendSqlOutbox } from "../infrastructure/outbox.js";

const receiptInput = z.object({
  appeal_reference: z.string().min(5).max(64),
  case_id: z.string().uuid(),
  form_id: z.string().uuid().nullable().optional(),
  response_id: z.string().nullable().optional(),
  submitted_at: z.string().datetime({ offset: true })
}).strict();

const dispositionInput = z.object({
  event_id: z.string().uuid().optional(),
  case_id: z.string().uuid(),
  appeal_reference: z.string().min(5).max(64),
  appointment_id: z.string().uuid(),
  decision_id: z.string().uuid(),
  supersedes_decision_id: z.string().uuid().nullable().optional(),
  disposition: z.enum(["appointment_invalidated", "appeal_dismissed", "reschedule_agreed"]),
  refund_approved: z.boolean().default(false),
  decided_by_role: z.string().optional(),
  decided_at: z.string().datetime({ offset: true }).optional()
}).strict();

const refundConfirmedInput = z.object({
  event_id: z.string().uuid().optional(),
  case_id: z.string().uuid(),
  appeal_reference: z.string().min(5).max(64),
  appointment_id: z.string().uuid(),
  reconciliation_reference: z.string().min(1).max(255),
  issuance_date: z.string().datetime({ offset: true }).optional(),
  refund_amount: z.number().nullable().optional()
}).strict();

const redirectInput = z.object({
  event_id: z.string().uuid().optional(),
  case_id: z.string().uuid(),
  appeal_reference: z.string().min(5).max(64),
  appointment_id: z.string().uuid().nullable().optional(),
  notes: z.string().optional(),
  redirected_at: z.string().datetime({ offset: true }).optional()
}).strict();

const acknowledgmentInput = z.object({
  event_id: z.string().uuid(),
  case_id: z.string().uuid(),
  appeal_reference: z.string().min(5).max(64),
  appointment_id: z.string().uuid(),
  acknowledged_at: z.string().datetime({ offset: true }),
}).strict();

export function createAppointmentAppealsRouter(pool: Pool) {
  const router = Router();

  // Ingests verified submission receipt from TRACE
  router.post("/receipt", async (req, res, next) => {
    try {
      const input = receiptInput.parse(req.body);
      const correlationId = (req.get("X-Correlation-ID") as string) || randomUUID();
      const submittedAt = new Date(input.submitted_at);

      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        const rows = (await tx.query(
          `SELECT id, status, version, "reviewHold", "appealDeadlineAt", "disputedAt", "traceCaseId"
           FROM appointments WHERE "appealReference" = $1 FOR UPDATE`,
          [input.appeal_reference]
        )).rows;

        if (!rows.length) {
          await tx.query("ROLLBACK");
          throw new DomainError(404, "APPEAL_REFERENCE_NOT_FOUND", "No appointment found for appeal reference.");
        }

        const appt = rows[0];
        const timely = appt.appealDeadlineAt && appt.disputedAt &&
          submittedAt >= appt.disputedAt && submittedAt <= appt.appealDeadlineAt;
        if (!timely || appt.status !== "in_review" || !appt.reviewHold ||
            (appt.traceCaseId && appt.traceCaseId !== input.case_id)) {
          throw new DomainError(409, "APPEAL_RECEIPT_INELIGIBLE", "Receipt does not match a timely active appeal.");
        }
        if (appt.traceCaseId === input.case_id) {
          await tx.query("COMMIT");
          return res.json({ success: true, contractVersion: 1,
            data: { appointment_id: appt.id, appeal_reference: input.appeal_reference, case_id: input.case_id, status: "locked", timely: true } });
        }

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
          data: { appointmentId: appt.id, traceCaseId: input.case_id }
        });

        await tx.query("COMMIT");
        res.status(200).json({
          success: true,
          contractVersion: 1,
          data: { appointment_id: appt.id, appeal_reference: input.appeal_reference, case_id: input.case_id, status: "locked", timely }
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

  router.post("/acknowledged", async (req, res, next) => {
    try {
      const input = acknowledgmentInput.parse(req.body);
      const result = await pool.query(
        `UPDATE appointments SET
           "appealAcknowledgedAt" = COALESCE("appealAcknowledgedAt", $4),
           version = version + CASE WHEN "appealAcknowledgedAt" IS NULL THEN 1 ELSE 0 END
         WHERE id = $1 AND "appealReference" = $2 AND "traceCaseId" = $3 RETURNING id`,
        [input.appointment_id, input.appeal_reference, input.case_id, new Date(input.acknowledged_at)],
      );
      if (!result.rowCount) throw new DomainError(404, "APPEAL_CASE_NOT_FOUND", "No linked appeal case.");
      res.json({ success: true, contractVersion: 1, data: { status: "acknowledged" } });
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
          `SELECT id, status, version, "reviewHold", "activeDecisionId"
           FROM appointments WHERE id = $1 AND "appealReference" = $2 AND "traceCaseId" = $3 FOR UPDATE`,
          [input.appointment_id, input.appeal_reference, input.case_id]
        )).rows;

        if (!rows.length) {
          await tx.query("ROLLBACK");
          throw new DomainError(404, "APPOINTMENT_NOT_FOUND", "Appointment not found for disposition.");
        }

        const appt = rows[0];

        if (appt.activeDecisionId === input.decision_id) {
          await tx.query("COMMIT");
          return res.json({ success: true, contractVersion: 1,
            data: { appointment_id: appt.id, applied: true, status: "already_applied" } });
        }

        const predecessorMatches = (appt.activeDecisionId ?? null) === (input.supersedes_decision_id ?? null);
        const activeReview = appt.status === "in_review" && appt.reviewHold;
        if (!predecessorMatches || !activeReview || input.disposition === "reschedule_agreed") {
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

        if (input.refund_approved && input.disposition !== "appointment_invalidated") {
          throw new DomainError(422, "TRACE_REFUND_APPROVAL_INELIGIBLE", "Invalidation is required for refund approval.");
        }
        const nextStatus = input.disposition === "appointment_invalidated" ? "invalid" : "confirmed";
        const note = "disposition_" + input.disposition;

        await tx.query(
          `UPDATE appointments SET
            status = $2::"AppointmentStatus",
            "reviewHold" = false,
            "activeDecisionId" = $3,
            "traceRefundApproved" = $4,
            version = version + 1,
            "updatedAt" = NOW()
          WHERE id = $1`,
          [appt.id, nextStatus, input.decision_id, input.refund_approved]
        );

        await tx.query(
          `INSERT INTO appointment_logs (id, "appointmentId", "fromStatus", "toStatus", "changedByRole", note, "changedAt")
           VALUES ($1, $2, $3, $4, 'trace', $5, NOW())`,
          [randomUUID(), appt.id, appt.status, nextStatus, note]
        );

        await appendSqlOutbox(tx, {
          producer: "appointment",
          eventType: "vital.appointment.disposition_applied",
          aggregateId: appt.id,
          aggregateVersion: appt.version + 1,
          correlationId,
          causationId: correlationId,
          data: { appointmentId: appt.id, disposition: input.disposition, decisionId: input.decision_id }
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
          `SELECT id, status, version, "accountingRef", "traceRefundApproved" FROM appointments
           WHERE id = $1 AND "appealReference" = $2 AND "traceCaseId" = $3 FOR UPDATE`,
          [input.appointment_id, input.appeal_reference, input.case_id]
        )).rows;

        if (!rows.length) {
          await tx.query("ROLLBACK");
          throw new DomainError(404, "APPOINTMENT_NOT_FOUND", "Appointment not found for refund confirmation.");
        }

        const appt = rows[0];

        if (appt.accountingRef === input.reconciliation_reference) {
          await tx.query("COMMIT");
          return res.json({ success: true, contractVersion: 1,
            data: { appointment_id: appt.id, status: "refund_recorded" } });
        }
        if (appt.status !== "invalid" || !appt.traceRefundApproved || appt.accountingRef) {
          throw new DomainError(409, "TRACE_REFUND_CONFIRMATION_INELIGIBLE", "Refund approval or reconciliation reference does not match.");
        }

        // Record Accounting's confirmation independently of the appointment disposition.
        await tx.query(
          `UPDATE appointments SET
            "accountingRef" = $2,
            "accountingRefundIssuedAt" = $3,
            version = version + 1,
            "updatedAt" = NOW()
          WHERE id = $1`,
          [appt.id, input.reconciliation_reference, issuanceDate]
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
          data: { appointmentId: appt.id }
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
           WHERE "appealReference" = $1 AND "traceCaseId" = $2
             AND ($3::text IS NULL OR id::text = $3) AND status = 'in_review' AND "reviewHold" FOR UPDATE`,
          [input.appeal_reference, input.case_id, input.appointment_id ?? null]
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
