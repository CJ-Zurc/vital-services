import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { appendSqlOutbox } from "../../infrastructure/outbox.js";
import { createMessageCrypto } from "./crypto.js";
import { lockMessagingConversation, messagingDenied } from "./holds.js";
import { messagingTransaction } from "./transactions.js";
import { patientRetentionLock } from '../appointment/appointment.js';

export interface MessageRetentionInput {
  status: string; completedAt: Date | null; updatedAt: Date; lastCompletedVisitAt: Date | null;
  lastMessageAt: Date | null; legalHoldAt: Date | null;
}
export function messageExpiryDate(input: MessageRetentionInput): Date | null {
  if (input.legalHoldAt || !["completed", "cancelled", "rescheduled"].includes(input.status)) return null;
  const closure = input.status === "completed" ? input.completedAt : input.updatedAt;
  if (!closure) return null;
  const reference = [closure, input.lastCompletedVisitAt, input.lastMessageAt]
    .filter((value): value is Date => !!value)
    .reduce((latest, value) => value > latest ? value : latest, closure);
  if (!Number.isFinite(reference.getTime())) return null;
  const expiry = new Date(reference);
  expiry.setUTCFullYear(expiry.getUTCFullYear() + 10);
  return expiry;
}

export interface MessagingRetentionResult {
  enabled: boolean; mode: "dry-run" | "execute"; scanned: number; eligible: number; purged: number;
  completed: boolean; aborted: boolean; busy: boolean;
}
interface Scan { id: string; afterId: string | null; upperId: string | null; scanStartedAt: Date | null }
const scanId = "messaging-retention";
const leaseMs = 60_000;
const dailyMs = 86_400_000;
const tickBudgetMs = 10_000;

export function createMessagingRetention(pool: Pool, environment: NodeJS.ProcessEnv, clock: () => number = Date.now) {
  const crypto = createMessageCrypto(environment);
  let running = false;
  return {
    async tick(signal?: AbortSignal): Promise<MessagingRetentionResult> {
      const enabled = environment.VITAL_EDA_MESSAGING_ENABLED === "true" && environment.VITAL_EDA_MESSAGING_RETENTION_SCAN_ENABLED === "true";
      const approvedPolicy = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,95}$/.test(environment.MESSAGE_RETENTION_POLICY_APPROVAL_ID ?? "");
      const mode = environment.VITAL_EDA_MESSAGING_RETENTION_ENABLED === "true" && environment.MESSAGE_RETENTION_APPROVED === "true" && approvedPolicy ? "execute" : "dry-run";
      const result: MessagingRetentionResult = { enabled, mode, scanned: 0, eligible: 0, purged: 0,
        completed: false, aborted: signal?.aborted ?? false, busy: false };
      if (!enabled || result.aborted) return result;
      if (running) return { ...result, busy: true };
      crypto.assertConfigured();
      running = true;
      const owner = randomUUID();
      let claimed = false;
      try {
        const startedAt = clock();
        const now = new Date(clock());
        const scan = (await pool.query<Scan>(`UPDATE message_retention_scans SET "leaseOwner"=$1,"leaseUntil"=$3,
          "scanStartedAt"=COALESCE("scanStartedAt",$2),
          "upperId"=CASE WHEN "scanStartedAt" IS NULL THEN (SELECT MAX(id) FROM message_conversations) ELSE "upperId" END
          WHERE id=$4 AND "nextRunAt"<=$2 AND ("leaseUntil" IS NULL OR "leaseUntil"<=$2) RETURNING *`,
        [owner, now, new Date(now.getTime() + leaseMs), scanId])).rows[0];
        if (!scan) return { ...result, busy: true };
        claimed = true;
        const rows = (await pool.query<{ id: string }>(`SELECT id FROM message_conversations
          WHERE "purgedAt" IS NULL AND ($1::text IS NULL OR id>$1) AND id<=$2 ORDER BY id LIMIT 100`,
        [scan.afterId, scan.upperId])).rows;
        for (const row of rows) {
          if (signal?.aborted) { result.aborted = true; break; }
          if (clock() - startedAt >= tickBudgetMs) break;
          const counts = await messagingTransaction(pool, async tx => {
            await tx.query("SET LOCAL lock_timeout = '5s'");
            await tx.query("SET LOCAL statement_timeout = '10s'");
            const instant = new Date(clock());
            const lease = await tx.query(`SELECT id FROM message_retention_scans
              WHERE id=$1 AND "leaseOwner"=$2 AND "leaseUntil">$3 FOR UPDATE`, [scanId, owner, instant]);
            if (lease.rowCount !== 1) messagingDenied(409, "MESSAGE_RETENTION_LEASE_LOST");
            const { appointment, conversation } = await lockMessagingConversation(tx, row.id);
            await patientRetentionLock(tx, appointment.patientId);
            const times = (await tx.query<{ updatedAt: Date; lastCompletedVisitAt: Date | null; lastMessageAt: Date | null }>(
              `SELECT a."updatedAt",(SELECT MAX(v."completedAt") FROM appointments v
                WHERE v."patientId"=a."patientId" AND v.status='completed') AS "lastCompletedVisitAt",
                (SELECT MAX(m."createdAt") FROM appointment_messages m WHERE m."conversationId"=$2) AS "lastMessageAt"
                FROM appointments a WHERE a.id=$1`, [appointment.id, row.id])).rows[0];
            if (!times) messagingDenied(409, "MESSAGE_RETENTION_APPOINTMENT_CHANGED");
            const expiry = messageExpiryDate({ status: appointment.status, completedAt: appointment.completedAt,
              ...times, legalHoldAt: conversation.legalHoldAt });
            const eligible = !conversation.purgedAt && !!expiry && expiry <= instant;
            let purged = 0;
            if (eligible && mode === "execute") {
              // Retain the conversation identity: command replays must never resurrect purged messages.
              const deleted = await tx.query('DELETE FROM appointment_messages WHERE "conversationId"=$1', [row.id]);
              const version = conversation.version + 1;
              const tombstone = await tx.query(`UPDATE message_conversations SET "purgedAt"=$2,"patientLastReadAt"=NULL,
                "doctorLastReadAt"=NULL,version=$3 WHERE id=$1 AND "legalHoldAt" IS NULL AND "purgedAt" IS NULL`,
              [row.id, instant, version]);
              if (tombstone.rowCount !== 1) messagingDenied(409, "MESSAGE_RETENTION_CONVERSATION_CHANGED");
              await tx.query(`INSERT INTO message_purges ("conversationId","purgedAt","expiredAt","removedMessages",version)
                VALUES($1,$2,$3,$4,$5)`, [row.id, instant, expiry, deleted.rowCount ?? 0, version]);
              await appendSqlOutbox(tx, { eventType: "vital.audit.requested", producer: "messaging", aggregateId: row.id,
                aggregateVersion: version, correlationId: owner,
                data: { auditType: "vital.message.purged", actorAuthId: null, resourceId: row.id, resourceType: "message" } });
              purged = 1;
            }
            if (signal?.aborted) messagingDenied(409, "MESSAGE_RETENTION_ABORTED");
            const renewal = new Date(clock());
            const progress = await tx.query(`UPDATE message_retention_scans SET "afterId"=$3,"leaseUntil"=$4,
              scanned=scanned+1,eligible=eligible+$5,purged=purged+$6
              WHERE id=$1 AND "leaseOwner"=$2 AND "leaseUntil">$7`,
            [scanId, owner, row.id, new Date(renewal.getTime() + leaseMs), eligible ? 1 : 0, purged, renewal]);
            if (progress.rowCount !== 1) messagingDenied(409, "MESSAGE_RETENTION_LEASE_LOST");
            return { eligible: eligible ? 1 : 0, purged };
          });
          result.scanned++; result.eligible += counts.eligible; result.purged += counts.purged;
        }
        if (!result.aborted && result.scanned === rows.length && rows.length < 100) {
          const finished = new Date(clock());
          const updated = await pool.query(`UPDATE message_retention_scans SET "afterId"=NULL,"upperId"=NULL,"scanStartedAt"=NULL,
            "lastCompletedAt"=$3,"nextRunAt"=$4,"leaseOwner"=NULL,"leaseUntil"=NULL,scanned=0,eligible=0,purged=0
            WHERE id=$1 AND "leaseOwner"=$2 AND "leaseUntil">$3`, [scanId, owner, finished, new Date(finished.getTime() + dailyMs)]);
          if (updated.rowCount !== 1) messagingDenied(409, "MESSAGE_RETENTION_LEASE_LOST");
          result.completed = true;
        }
        return result;
      } catch (error) {
        if (signal?.aborted && (error as { code?: string }).code === "MESSAGE_RETENTION_ABORTED") return { ...result, aborted: true };
        throw error;
      } finally {
        try {
          if (claimed) await pool.query('UPDATE message_retention_scans SET "leaseOwner"=NULL,"leaseUntil"=NULL WHERE id=$1 AND "leaseOwner"=$2', [scanId, owner]);
        } finally { running = false; }
      }
    },
  };
}

export type MessagingRetention = ReturnType<typeof createMessagingRetention>;
