import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { DomainError, requireScope, type Actor } from "../../contracts/actor.js";
import { appendSqlOutbox } from "../../infrastructure/outbox.js";
import { requestHash } from "../../infrastructure/security.js";
import { lockAppointment } from "../appointment/appointment.js";
import type { AppointmentCommand } from "../appointment/appointment-contracts.js";
import { createMessageCrypto } from "./crypto.js";
import { messagingTransaction } from "./transactions.js";

export type MessageHoldCommand = AppointmentCommand;
export const holdReasonCodes = ["legal_request", "investigation", "records_review"] as const;
export const messageHoldPlaceInput = z.object({ expectedVersion: z.number().int().nonnegative(),
  reasonCode: z.enum(holdReasonCodes), reference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,95}$/) }).strict();
export const messageHoldReleaseInput = z.object({ expectedVersion: z.number().int().nonnegative() }).strict();
export const messageHoldListQuery = z.object({ limit: z.number().int().min(1).max(50).default(50),
  appointmentId: z.uuid().optional(), conversationId: z.uuid().optional(),
  holdState: z.enum(["all", "held", "unheld"]).default("all"),
  before: z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).strict().optional() }).strict();
export type MessageHoldPlaceInput = z.infer<typeof messageHoldPlaceInput>;
export type MessageHoldReleaseInput = z.infer<typeof messageHoldReleaseInput>;
export type MessageHoldListQuery = z.input<typeof messageHoldListQuery>;
export interface MessageHoldResult { conversationId: string; version: number; holdId: string | null; legalHoldAt: string | null }
export interface MessageHoldMetadata {
  id: string; appointmentId: string; patientId: string; doctorId: string; status: string;
  scheduledAt: string; createdAt: string; lastMessageAt: string | null; legalHoldAt: string | null;
  reasonCode: typeof holdReasonCodes[number] | null; reference: string | null; version: number;
}
export interface MessageHoldPage { conversations: MessageHoldMetadata[]; nextCursor: { createdAt: string; id: string } | null }
export interface MessagingConversation {
  id: string; appointmentId: string; version: number; legalHoldAt: Date | null; purgedAt: Date | null;
}
export function messagingDenied(status: number, code: string): never {
  throw new DomainError(status, code, "Messaging operation is unavailable.");
}

export async function lockMessagingConversation(tx: PoolClient, id: string) {
  const prior = (await tx.query<{ appointmentId: string }>(
    'SELECT "appointmentId" FROM message_conversations WHERE id=$1', [id])).rows[0];
  if (!prior) messagingDenied(404, "MESSAGE_CONVERSATION_NOT_FOUND");
  // The owner helper takes calendar then appointment locks; never invert this order.
  const appointment = await lockAppointment(tx, prior.appointmentId);
  const conversation = (await tx.query<MessagingConversation>(
    'SELECT * FROM message_conversations WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!conversation || conversation.appointmentId !== appointment.id) messagingDenied(409, "MESSAGE_CONVERSATION_CHANGED");
  return { appointment, conversation };
}

async function currentAdmin(tx: PoolClient, actor: Actor) {
  await tx.query("SET LOCAL lock_timeout = '5s'");
  await tx.query("SET LOCAL statement_timeout = '10s'");
  if (actor.role !== "admin") messagingDenied(403, "MESSAGING_ADMIN_REQUIRED");
  const result = await tx.query(`SELECT u.id FROM vital_admins a JOIN vital_users u
    ON u.id=a."userId" AND u."authId"=a."authId"
    WHERE u."authId"=$1 FOR SHARE OF a,u`, [actor.authId]);
  if (!result.rows.length) messagingDenied(403, "MESSAGING_ADMIN_REVOKED");
}

export function createMessageHolds(pool: Pool, environment: NodeJS.ProcessEnv = process.env) {
  const crypto = createMessageCrypto(environment);
  async function mutate(actor: Actor, id: string, meta: MessageHoldCommand, input: MessageHoldPlaceInput | MessageHoldReleaseInput,
    action: "place" | "release"): Promise<MessageHoldResult> {
    z.uuid().parse(id); requireScope(actor, "messaging.hold." + action, id);
    z.uuid().parse(meta.operationId); z.string().regex(/^[a-f0-9]{64}$/).parse(meta.requestHash);
    crypto.assertConfigured();
    const hash = requestHash("MESSAGING-HOLD-COMMAND", action, { role: actor.role, resource: id, input, transportHash: meta.requestHash });
    return messagingTransaction(pool, async tx => {
      await currentAdmin(tx, actor);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["messaging-command:" + actor.authId + ":" + meta.operationId]);
      const { conversation } = await lockMessagingConversation(tx, id);
      const old = (await tx.query<{ action: string; resourceId: string; requestHash: string; status: string; result: MessageHoldResult }>(
        'SELECT action,"resourceId","requestHash",status,result FROM command_operations WHERE "actorId"=$1 AND "operationId"=$2',
        [actor.authId, meta.operationId])).rows[0];
      if (old) {
        if (old.action !== "messaging.hold." + action || old.resourceId !== id || old.requestHash !== hash) messagingDenied(409, "COMMAND_REPLAY_CONFLICT");
        if (old.status !== "completed") messagingDenied(409, "COMMAND_PENDING");
        return old.result;
      }
      if (conversation.version !== input.expectedVersion) messagingDenied(409, "MESSAGE_CONVERSATION_VERSION_CHANGED");
      if (conversation.purgedAt) messagingDenied(410, "MESSAGE_CONVERSATION_PURGED");
      let holdId: string | null = null;
      let legalHoldAt: Date | null = null;
      if (action === "place") {
        if (conversation.legalHoldAt) messagingDenied(409, "MESSAGE_HOLD_ALREADY_ACTIVE");
        const placement = input as MessageHoldPlaceInput;
        holdId = randomUUID();
        const encrypted = crypto.encrypt(placement.reference, "messaging-hold:" + id, holdId);
        const inserted = await tx.query<{ placedAt: Date }>(`INSERT INTO message_legal_holds
          (id,"conversationId","reasonCode","protectedReference","placedByAuthId","placedAt")
          VALUES($1,$2,$3,$4::jsonb,$5,NOW()) RETURNING "placedAt"`,
        [holdId, id, placement.reasonCode, JSON.stringify(encrypted), actor.authId]);
        legalHoldAt = inserted.rows[0]!.placedAt;
      } else {
        if (!conversation.legalHoldAt) messagingDenied(409, "MESSAGE_HOLD_NOT_ACTIVE");
        const updated = await tx.query<{ id: string }>(`UPDATE message_legal_holds SET "releasedAt"=NOW(),"releasedByAuthId"=$2
          WHERE "conversationId"=$1 AND "releasedAt" IS NULL RETURNING id`, [id, actor.authId]);
        if (updated.rowCount !== 1) messagingDenied(409, "MESSAGE_HOLD_HISTORY_REQUIRED");
        holdId = updated.rows[0]!.id;
      }
      const version = conversation.version + 1;
      await tx.query('UPDATE message_conversations SET "legalHoldAt"=$2,version=$3 WHERE id=$1', [id, legalHoldAt, version]);
      const result: MessageHoldResult = { conversationId: id, version, holdId, legalHoldAt: legalHoldAt?.toISOString() ?? null };
      await tx.query(`INSERT INTO command_operations (id,"actorId",action,"resourceId","operationId","requestHash",status,result,"createdAt","updatedAt")
        VALUES($1,$2,$3,$4,$5,$6,'completed',$7::jsonb,NOW(),NOW())`,
      [randomUUID(), actor.authId, "messaging.hold." + action, id, meta.operationId, hash, JSON.stringify(result)]);
      await appendSqlOutbox(tx, { eventType: "vital.audit.requested", producer: "messaging", aggregateId: id,
        aggregateVersion: version, correlationId: actor.correlationId,
        data: { auditType: action === "place" ? "vital.message.hold_placed" : "vital.message.hold_released",
          actorAuthId: actor.authId, resourceId: id, resourceType: "message" } });
      return result;
    });
  }
  return {
    async list(actor: Actor, query: MessageHoldListQuery = {}): Promise<MessageHoldPage> {
      requireScope(actor, "messaging.admin.list", actor.authId); crypto.assertConfigured();
      const input = messageHoldListQuery.parse(query);
      return messagingTransaction(pool, async tx => {
        await currentAdmin(tx, actor);
        type Row = Omit<MessageHoldMetadata, "scheduledAt" | "createdAt" | "lastMessageAt" | "legalHoldAt" | "reference"> & {
          scheduledAt: Date; createdAt: Date; lastMessageAt: Date | null; legalHoldAt: Date | null;
          holdId: string | null; protectedReference: Parameters<typeof crypto.decrypt>[0] | null;
        };
        const rows = (await tx.query<Row>(`SELECT c.id,c."appointmentId",a."patientId",a."doctorId",a.status,a."scheduledAt",
          c."createdAt",c."legalHoldAt",c.version,h.id AS "holdId",h."reasonCode",h."protectedReference",
          (SELECT MAX(m."createdAt") FROM appointment_messages m WHERE m."conversationId"=c.id) AS "lastMessageAt"
          FROM message_conversations c JOIN appointments a ON a.id=c."appointmentId"
          LEFT JOIN message_legal_holds h ON h."conversationId"=c.id AND h."releasedAt" IS NULL
          WHERE ($1::text IS NULL OR c."appointmentId"=$1) AND ($2::text IS NULL OR c.id=$2)
          AND ($3='all' OR ($3='held' AND c."legalHoldAt" IS NOT NULL) OR ($3='unheld' AND c."legalHoldAt" IS NULL))
          AND ($4::timestamp IS NULL OR (c."createdAt",c.id)<($4::timestamp,$5::text))
          ORDER BY c."createdAt" DESC,c.id DESC LIMIT $6`,
        [input.appointmentId ?? null, input.conversationId ?? null, input.holdState,
          input.before?.createdAt ?? null, input.before?.id ?? null, input.limit + 1])).rows;
        const page = rows.slice(0, input.limit);
        const conversations = page.map(row => ({ id: row.id, appointmentId: row.appointmentId, patientId: row.patientId,
          doctorId: row.doctorId, status: row.status, scheduledAt: row.scheduledAt.toISOString(), createdAt: row.createdAt.toISOString(),
          lastMessageAt: row.lastMessageAt?.toISOString() ?? null, legalHoldAt: row.legalHoldAt?.toISOString() ?? null,
          reasonCode: row.reasonCode ?? null, reference: row.protectedReference && row.holdId
            ? crypto.decrypt({ ...row.protectedReference, id: row.holdId }, "messaging-hold:" + row.id) : null, version: row.version }));
        const last = page.at(-1);
        return { conversations, nextCursor: rows.length > input.limit && last ? { createdAt: last.createdAt.toISOString(), id: last.id } : null };
      });
    },
    place: (actor: Actor, id: string, meta: MessageHoldCommand, input: MessageHoldPlaceInput) => mutate(actor, id, meta, messageHoldPlaceInput.parse(input), "place"),
    release: (actor: Actor, id: string, meta: MessageHoldCommand, input: MessageHoldReleaseInput) => mutate(actor, id, meta, messageHoldReleaseInput.parse(input), "release"),
  };
}

export type MessageHolds = ReturnType<typeof createMessageHolds>;
