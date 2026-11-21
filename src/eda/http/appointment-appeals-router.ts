import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { DomainError } from "../contracts/actor.js";
import { appendSqlOutbox } from "../infrastructure/outbox.js";

const decisionInput = z.object({
  event_id: z.string().uuid().optional(),
  case_id: z.string().uuid(),
  appeal_reference: z.string().optional(),
  appointment_id: z.string().uuid().nullable().optional(),
  decision: z.enum(["approved", "rejected"]),
  ticket_id: z.string().uuid().nullable().optional(),
  ticket_number: z.string().nullable().optional(),
  rejection_reason: z.string().nullable().optional(),
  decided_at: z.string().datetime().optional()
}).passthrough();

const completionInput = z.object({
  event_id: z.string().uuid().optional(),
  case_id: z.string().uuid(),
  appeal_reference: z.string().optional(),
  appointment_id: z.string().uuid().nullable().optional(),
  outcome_tag: z.enum(["reschedule", "invalidate", "complete"]),
  outcome_explanation: z.string(),
  acknowledgment_deadline_at: z.string().datetime(),
  completed_at: z.string().datetime().optional()
}).passthrough();

const autoResolvedInput = z.object({
  event_id: z.string().uuid().optional(),
  case_id: z.string().uuid(),
  appeal_reference: z.string().optional(),
  appointment_id: z.string().uuid().nullable().optional(),
  action: z.literal("auto_resolved"),
  resolved_at: z.string().datetime().optional()
}).passthrough();

const receiptInput = z.object({
  appeal_reference: z.string().min(5).max(64).optional(),
  case_id: z.string().uuid(),
  form_id: z.string().uuid().nullable().optional(),
  response_id: z.string().nullable().optional(),
  submitted_at: z.string().datetime().optional()
}).passthrough();

const dispositionInput = z.object({
  event_id: z.string().uuid().optional(),
  case_id: z.string().uuid(),
  appeal_reference: z.string().min(5).max(64).optional(),
  appointment_id: z.string().uuid().optional(),
  decision_id: z.string().uuid().optional(),
  supersedes_decision_id: z.string().uuid().nullable().optional(),
  disposition: z.enum(["appointment_invalidated", "appeal_dismissed", "reschedule_agreed"]),
  decided_by_role: z.string().optional(),
  decided_at: z.string().datetime().optional()
}).passthrough();

const refundConfirmedInput = z.object({
  event_id: z.string().uuid().optional(),
  case_id: z.string().uuid(),
  appeal_reference: z.string().min(5).max(64).optional(),
  appointment_id: z.string().uuid().optional(),
  reconciliation_reference: z.string().min(1).max(255),
  issuance_date: z.string().datetime().optional(),
  refund_amount: z.number().optional()
}).passthrough();

const redirectToAdminInput = z.object({
  event_id: z.string().uuid().optional(),
  case_id: z.string().uuid(),
  appeal_reference: z.string().min(5).max(64).optional(),
  appointment_id: z.string().uuid().optional(),
  notes: z.string().optional(),
  redirected_at: z.string().datetime().optional()
}).passthrough();

export function createAppointmentAppealsRouter(pool: Pool) {
  const router = Router();

  // Ingests TRACE Admin triage decision (approved or rejected)
  router.post("/decision", (async (req, res, next) => {
    const tx = await pool.connect();
    try {
      const input = decisionInput.parse(req.body);
      await tx.query("BEGIN");

      // Find appointment by ID or case_id
      const query = input.appointment_id
        ? `SELECT a.*, ad.id AS "disputeId"
           FROM appointments a
           LEFT JOIN appointment_disputes ad ON ad."appointmentId" = a.id
           WHERE a.id = $1 FOR UPDATE OF a`
        : `SELECT a.*, ad.id AS "disputeId"
           FROM appointments a
           JOIN appointment_disputes ad ON ad."appointmentId" = a.id
           WHERE ad."traceCaseId" = $1 FOR UPDATE OF a`;
      const param = input.appointment_id || input.case_id;

      const appt = (await tx.query(query, [param])).rows[0];
      if (!appt) {
        await tx.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Appointment not found for dispute case." });
      }

      const now = new Date();
      if (input.decision === "approved") {
        await tx.query(
          `UPDATE appointment_disputes SET
            "traceTicketId" = COALESCE($2, "traceTicketId"),
            "traceTicketNumber" = COALESCE($3, "traceTicketNumber"),
            "traceCaseId" = COALESCE("traceCaseId", $4),
            stage = 3,
            "updatedAt" = NOW()
          WHERE "appointmentId" = $1`,
          [appt.id, input.ticket_id || null, input.ticket_number || null, input.case_id]
        );
        await tx.query(
          `UPDATE appointments SET
            status = 'in_review',
            "reviewHold" = true,
            version = version + 1,
            "updatedAt" = NOW()
          WHERE id = $1`,
          [appt.id]
        );
        await tx.query(
          `INSERT INTO appointment_logs (id, "appointmentId", "fromStatus", "toStatus", "changedByRole", note, "changedAt")
          VALUES ($1, $2, 'in_review', 'in_review', 'trace_admin', $3, $4)`,
          [randomUUID(), appt.id, `dispute_approved: ticket ${input.ticket_number || input.ticket_id}`, now]
        );
      } else {
        // Rejected
        await tx.query(
          `UPDATE appointment_disputes SET
            stage = 2,
            "rejectionReason" = $2,
            "updatedAt" = NOW()
          WHERE "appointmentId" = $1`,
          [appt.id, input.rejection_reason || null]
        );
        await tx.query(
          `UPDATE appointments SET
            "reviewHold" = false,
            status = CASE WHEN "doctorConfirmedAt" IS NOT NULL AND status = 'in_review' THEN 'confirmed' ELSE status END,
            version = version + 1,
            "updatedAt" = NOW()
          WHERE id = $1`,
          [appt.id]
        );
        await tx.query(
          `INSERT INTO appointment_logs (id, "appointmentId", "fromStatus", "toStatus", "changedByRole", note, "changedAt")
          VALUES ($1, $2, 'in_review', 'confirmed', 'trace_admin', $3, $4)`,
          [randomUUID(), appt.id, `dispute_rejected: ${input.rejection_reason || 'Rejected by Admin'}`, now]
        );
      }

      await tx.query("COMMIT");
      res.json({ success: true, contractVersion: 1, data: { case_id: input.case_id, appointment_id: appt.id, applied: true } });
    } catch (err) {
      await tx.query("ROLLBACK");
      next(err);
    } finally {
      tx.release();
    }
  }) as RequestHandler);

  // Ingests TRACE Staff completion + final Admin review resolution proposal
  router.post("/completion", (async (req, res, next) => {
    const tx = await pool.connect();
    try {
      const input = completionInput.parse(req.body);
      await tx.query("BEGIN");

      const query = input.appointment_id
        ? `SELECT a.*, ad.id AS "disputeId"
           FROM appointments a
           LEFT JOIN appointment_disputes ad ON ad."appointmentId" = a.id
           WHERE a.id = $1 FOR UPDATE OF a`
        : `SELECT a.*, ad.id AS "disputeId"
           FROM appointments a
           JOIN appointment_disputes ad ON ad."appointmentId" = a.id
           WHERE ad."traceCaseId" = $1 FOR UPDATE OF a`;
      const param = input.appointment_id || input.case_id;

      const appt = (await tx.query(query, [param])).rows[0];
      if (!appt) {
        await tx.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Appointment not found for dispute case." });
      }

      const now = new Date();
      await tx.query(
        `UPDATE appointment_disputes SET
          stage = 4,
          "proposedOutcomeTag" = $2,
          "proposedExplanation" = $3,
          "acknowledgmentDeadlineAt" = $4,
          "updatedAt" = NOW()
        WHERE "appointmentId" = $1`,
        [appt.id, input.outcome_tag, input.outcome_explanation, new Date(input.acknowledgment_deadline_at)]
      );
      await tx.query(
        `UPDATE appointments SET
          version = version + 1,
          "updatedAt" = NOW()
        WHERE id = $1`,
        [appt.id]
      );

      await tx.query(
        `INSERT INTO appointment_logs (id, "appointmentId", "fromStatus", "toStatus", "changedByRole", note, "changedAt")
        VALUES ($1, $2, 'in_review', 'in_review', 'trace_admin', $3, $4)`,
        [randomUUID(), appt.id, `dispute_completed_proposed: ${input.outcome_tag} - ${input.outcome_explanation}`, now]
      );

      await tx.query("COMMIT");
      res.json({ success: true, contractVersion: 1, data: { case_id: input.case_id, appointment_id: appt.id, applied: true } });
    } catch (err) {
      await tx.query("ROLLBACK");
      next(err);
    } finally {
      tx.release();
    }
  }) as RequestHandler);

  // Ingests TRACE 72h auto-resolution
  router.post("/auto-resolved", (async (req, res, next) => {
    const tx = await pool.connect();
    try {
      const input = autoResolvedInput.parse(req.body);
      await tx.query("BEGIN");

      const query = input.appointment_id
        ? `SELECT a.*, ad.id AS "disputeId", ad."proposedOutcomeTag"
           FROM appointments a
           LEFT JOIN appointment_disputes ad ON ad."appointmentId" = a.id
           WHERE a.id = $1 FOR UPDATE OF a`
        : `SELECT a.*, ad.id AS "disputeId", ad."proposedOutcomeTag"
           FROM appointments a
           JOIN appointment_disputes ad ON ad."appointmentId" = a.id
           WHERE ad."traceCaseId" = $1 FOR UPDATE OF a`;
      const param = input.appointment_id || input.case_id;

      const appt = (await tx.query(query, [param])).rows[0];
      if (!appt) {
        await tx.query("ROLLBACK");
        return res.status(404).json({ success: false, message: "Appointment not found for dispute case." });
      }

      const now = new Date();
      let terminalStatus = appt.status;
      let reviewHold = false;
      if (appt.proposedOutcomeTag === "invalidate") {
        terminalStatus = "invalid";
      } else if (appt.proposedOutcomeTag === "complete") {
        terminalStatus = "completed";
      }

      await tx.query(
        `UPDATE appointment_disputes SET
          stage = 5,
          "resolutionMethod" = 'auto_resolved_72h',
          "resolvedAt" = NOW(),
          "updatedAt" = NOW()
        WHERE "appointmentId" = $1`,
        [appt.id]
      );

      await tx.query(
        `UPDATE appointments SET
          "reviewHold" = $2,
          status = $3::"AppointmentStatus",
          version = version + 1,
          "updatedAt" = NOW()
        WHERE id = $1`,
        [appt.id, reviewHold, terminalStatus]
      );

      await tx.query(
        `INSERT INTO appointment_logs (id, "appointmentId", "fromStatus", "toStatus", "changedByRole", note, "changedAt")
        VALUES ($1, $2, 'in_review', $3, 'system_auto_resolution', 'dispute_auto_resolved_72h', $4)`,
        [randomUUID(), appt.id, terminalStatus, now]
      );

      await tx.query("COMMIT");
      res.json({ success: true, contractVersion: 1, data: { case_id: input.case_id, appointment_id: appt.id, applied: true } });
    } catch (err) {
      await tx.query("ROLLBACK");
      next(err);
    } finally {
      tx.release();
    }
  }) as RequestHandler);

  // Backward compatibility: receipt
  router.post("/receipt", (async (req, res, next) => {
    const tx = await pool.connect();
    try {
      const input = receiptInput.parse(req.body);
      await tx.query("BEGIN");
      const appt = (await tx.query(
        `SELECT a.* FROM appointments a
         LEFT JOIN appointment_disputes ad ON ad."appointmentId" = a.id
         WHERE ad."traceCaseId" = $1 OR a.id = $1`,
        [input.case_id]
      )).rows[0];
      if (appt) {
        await tx.query(
          `UPDATE appointment_disputes SET "traceCaseId" = $2, "updatedAt" = NOW() WHERE "appointmentId" = $1`,
          [appt.id, input.case_id]
        );
        await tx.query(
          `UPDATE appointments SET "reviewHold" = true, version = version + 1, "updatedAt" = NOW() WHERE id = $1`,
          [appt.id]
        );
      }
      await tx.query("COMMIT");
      res.json({ success: true, contractVersion: 1, data: { case_id: input.case_id, appointment_id: appt?.id ?? null, applied: true } });
    } catch (err) {
      await tx.query("ROLLBACK");
      next(err);
    } finally {
      tx.release();
    }
  }) as RequestHandler);

  // Backward compatibility: disposition
  router.post("/disposition", (async (req, res, next) => {
    const tx = await pool.connect();
    try {
      const input = dispositionInput.parse(req.body);
      await tx.query("BEGIN");
      const appt = (await tx.query(
        `SELECT a.* FROM appointments a
         LEFT JOIN appointment_disputes ad ON ad."appointmentId" = a.id
         WHERE ad."traceCaseId" = $1 OR a.id = $1`,
        [input.case_id]
      )).rows[0];
      if (appt) {
        const terminal = input.disposition === "appointment_invalidated" ? "invalid" : "completed";
        await tx.query(
          `UPDATE appointment_disputes SET stage = 5, "resolutionMethod" = $2, "resolvedAt" = NOW(), "updatedAt" = NOW() WHERE "appointmentId" = $1`,
          [appt.id, input.disposition]
        );
        await tx.query(
          `UPDATE appointments SET status = $2::"AppointmentStatus", "reviewHold" = false, version = version + 1, "updatedAt" = NOW() WHERE id = $1`,
          [appt.id, terminal]
        );
      }
      await tx.query("COMMIT");
      res.json({ success: true, contractVersion: 1, data: { case_id: input.case_id, applied: true } });
    } catch (err) {
      await tx.query("ROLLBACK");
      next(err);
    } finally {
      tx.release();
    }
  }) as RequestHandler);

  // Backward compatibility: refund-confirmed
  router.post("/refund-confirmed", (async (req, res, next) => {
    const tx = await pool.connect();
    try {
      const input = refundConfirmedInput.parse(req.body);
      await tx.query("BEGIN");
      const appt = (await tx.query('SELECT * FROM appointments WHERE "traceCaseId" = $1 OR id = $1', [input.case_id])).rows[0];
      if (appt) {
        await tx.query('UPDATE appointments SET "accountingRef" = $2, "accountingRefundIssuedAt" = NOW() WHERE id = $1', [appt.id, input.reconciliation_reference]);
      }
      await tx.query("COMMIT");
      res.json({ success: true, contractVersion: 1, data: { case_id: input.case_id, applied: true } });
    } catch (err) {
      await tx.query("ROLLBACK");
      next(err);
    } finally {
      tx.release();
    }
  }) as RequestHandler);

  // Backward compatibility: redirect-to-admin
  router.post("/redirect-to-admin", (async (req, res, next) => {
    res.json({ success: true, contractVersion: 1, data: { case_id: req.body?.case_id, applied: true } });
  }) as RequestHandler);

  return router;
}
