import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError, requireScope, type Actor } from '../../contracts/actor.js';
import { requestHash } from '../../infrastructure/security.js';
import { appendSqlOutbox } from '../../infrastructure/outbox.js';
import { appointmentMessagingProcessing, calculateMessageAccess, listMessagingAppointments, loadMessagingChain, messagingAppointment } from '../appointment/appointment-messaging.js';
import type { AppointmentCommand } from '../appointment/appointment-contracts.js';
import { membership } from '../appointment/appointment.js';
import { createMessageCrypto, type EncryptedMessage } from './crypto.js';
import { messagingTransaction } from './transactions.js';

export const messageInput = z.object({ content: z.string().trim().min(1).max(2000), clientMessageId: z.uuid() }).strict();
export const messageReadInput = z.object({ messageId: z.uuid() }).strict();
type Message = EncryptedMessage & { senderUserId: string; senderRole: 'patient' | 'doctor'; createdAt: Date };
type Conversation = { id: string; version: number; purgedAt: Date | null; patientLastReadAt: Date | null; doctorLastReadAt: Date | null };
function denied(status: number, code: string, message: string): never { throw new DomainError(status, code, message); }
export function messageCursor(value?: string) {
  if (!value) return null;
  try {
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const parsed = z.object({ at: z.iso.datetime(), id: z.uuid() }).strict().parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return { at: new Date(parsed.at), id: parsed.id };
  } catch { return denied(400, 'MESSAGE_CURSOR_INVALID', 'Invalid message cursor.'); }
}
async function conversation(tx: PoolClient, appointmentId: string, lock = false) {
  return (await tx.query<Conversation>('SELECT * FROM message_conversations WHERE "appointmentId"=$1' + (lock ? ' FOR UPDATE' : ''), [appointmentId])).rows[0];
}
async function signal(tx: PoolClient, actor: Actor, appointmentId: string, row: Conversation, kind: 'message' | 'read', operationId: string) {
  const event = await appendSqlOutbox(tx, { eventType: 'vital.messaging.changed', producer: 'messaging', aggregateId: row.id,
    aggregateVersion: row.version, correlationId: actor.correlationId, causationId: operationId,
    data: { appointmentId, conversationId: row.id, actorAuthId: actor.authId, kind } });
  await appendSqlOutbox(tx, { eventType: 'vital.audit.requested', producer: 'messaging', aggregateId: row.id,
    aggregateVersion: row.version, correlationId: actor.correlationId, causationId: event.eventId,
    data: { auditType: kind === 'message' ? 'vital.message.sent' : 'vital.message.read', actorAuthId: actor.authId, resourceId: row.id, resourceType: 'message' } });
  await tx.query('SELECT pg_notify($1,$2)::text', ['vital_message_events', JSON.stringify({ appointmentId, kind })]);
}
export function createMessagingModule(pool: Pool, environment: NodeJS.ProcessEnv = process.env, clock = Date.now) {
  const crypto = createMessageCrypto(environment);
  function publicMessage(row: Message, appointmentId: string) {
    return { id: row.id, senderUserId: row.senderUserId, senderRole: row.senderRole, content: crypto.decrypt(row, appointmentId), createdAt: row.createdAt.toISOString() };
  }
  async function command<T>(actor: Actor, action: string, resource: string, meta: AppointmentCommand, input: unknown,
    run: (tx: PoolClient, old: { result: unknown } | undefined) => Promise<{ result: T; journal: unknown }>) {
    crypto.assertConfigured(); requireScope(actor, 'messaging.' + action, resource);
    z.uuid().parse(meta.operationId); z.string().regex(/^[a-f0-9]{64}$/).parse(meta.requestHash);
    const hash = requestHash('MESSAGING-COMMAND', action, { resource, role: actor.role, input, transportHash: meta.requestHash });
    return messagingTransaction(pool, async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['messaging-command:' + actor.authId + ':' + meta.operationId]);
      await membership(tx, actor);
      const old = (await tx.query<{ action: string; resourceId: string; requestHash: string; result: unknown; status: string }>(
        'SELECT * FROM command_operations WHERE "actorId"=$1 AND "operationId"=$2', [actor.authId, meta.operationId])).rows[0];
      if (old && (old.action !== 'messaging.' + action || old.resourceId !== resource || old.requestHash !== hash || old.status !== 'completed')) denied(409, 'COMMAND_REPLAY_CONFLICT', 'This retry ID was already used.');
      const result = await run(tx, old);
      if (!old) await tx.query(`INSERT INTO command_operations (id,"actorId","operationId",action,"resourceId","requestHash",status,result,"createdAt","updatedAt")
        VALUES($1,$2,$3,$4,$5,$6,'completed',$7::jsonb,NOW(),NOW())`, [randomUUID(), actor.authId, meta.operationId, 'messaging.' + action, resource, hash, JSON.stringify(result.journal)]);
      return result.result;
    });
  }
  return {
    async authorizeStream(actor: Actor, id: string) {
      crypto.assertConfigured(); requireScope(actor, 'messaging.stream', id); z.uuid().parse(id);
      await messagingTransaction(pool, async tx => { await messagingAppointment(tx, actor, id); });
    },
    async history(actor: Actor, id: string, query: unknown = {}) {
      crypto.assertConfigured(); requireScope(actor, 'messaging.history', id); z.uuid().parse(id);
      const input = z.object({ before: z.string().optional() }).strict().parse(query), boundary = messageCursor(input.before);
      return messagingTransaction(pool, async tx => {
        const context = await messagingAppointment(tx, actor, id);
        const access = calculateMessageAccess(context.seed, context.chain, new Date(clock()));
        if (context.processing) Object.assign(access, { canSend: false, sendUntil: null, nextOpenAt: null, availabilityReason: 'processing' });
        const found = await conversation(tx, id);
        if (!found || found.purgedAt) return { messages: [], nextCursor: null, ...access, ...(found?.purgedAt ? { canSend: false, sendUntil: null, nextOpenAt: null, availabilityReason: 'purged' as const } : {}) };
        const page = (await tx.query<Message>(`SELECT * FROM appointment_messages WHERE "conversationId"=$1
          AND ($2::timestamp IS NULL OR ("createdAt",id)<($2,$3)) ORDER BY "createdAt" DESC,id DESC LIMIT 31`, [found.id, boundary?.at ?? null, boundary?.id ?? null])).rows;
        const visible = page.slice(0, 30), oldest = visible.at(-1);
        return { messages: visible.reverse().map(row => publicMessage(row, id)), nextCursor: page.length > 30 && oldest
          ? Buffer.from(JSON.stringify({ at: oldest.createdAt.toISOString(), id: oldest.id })).toString('base64url') : null, ...access };
      });
    },
    async conversations(actor: Actor, query: unknown = {}) {
      crypto.assertConfigured(); requireScope(actor, 'messaging.conversations', actor.authId);
      const input = z.object({ before: z.string().optional(), appointmentId: z.uuid().optional() }).strict().parse(query);
      return messagingTransaction(pool, async tx => {
        const { page, nextCursor } = await listMessagingAppointments(tx, actor, messageCursor(input.before), input.appointmentId);
        const chains = new Map<string, Awaited<ReturnType<typeof loadMessagingChain>>>();
        const conversations = [];
        for (const row of page) {
          const key = `${row.patientId}:${row.doctorId}`;
          if (!chains.has(key)) chains.set(key, await loadMessagingChain(tx, row));
          const chain = chains.get(key)!, seed = chain.find(item => item.id === row.id)!;
          const access = calculateMessageAccess(seed, chain, new Date(clock()));
          const found = await conversation(tx, row.id);
          const lastReadAt = actor.role === 'patient' ? found?.patientLastReadAt : found?.doctorLastReadAt;
          const state = found ? (await tx.query<{ lastMessageAt: Date | null; unreadCount: number }>(`SELECT MAX("createdAt") AS "lastMessageAt",
            COUNT(*) FILTER(WHERE "senderRole"=$2::"MessageSenderRole" AND ($3::timestamp IS NULL OR "createdAt">$3))::integer AS "unreadCount"
            FROM appointment_messages WHERE "conversationId"=$1`, [found.id, actor.role === 'patient' ? 'doctor' : 'patient', lastReadAt ?? null])).rows[0] : undefined;
          const processing = await appointmentMessagingProcessing(tx, row);
          if (processing || found?.purgedAt) Object.assign(access, { canSend: false, sendUntil: null, nextOpenAt: null, availabilityReason: found?.purgedAt ? 'purged' : 'processing' });
          conversations.push({ appointmentId: row.id, counterpartAuthId: row.counterpartAuthId, specialty: row.specialty, status: row.status,
            scheduledAt: row.scheduledAt.toISOString(), lastMessageAt: state?.lastMessageAt?.toISOString() ?? null, unreadCount: state?.unreadCount ?? 0, ...access });
        }
        return { conversations, nextCursor };
      });
    },
    async send(actor: Actor, id: string, meta: AppointmentCommand, body: unknown) {
      const input = messageInput.parse(body); z.uuid().parse(id);
      return command(actor, 'send', id, meta, input, async (tx, old) => {
        const member = await membership(tx, actor);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['message-send:' + member.userId]);
        const context = await messagingAppointment(tx, actor, id, true);
        let found = await conversation(tx, id, true);
        if (found?.purgedAt) denied(409, 'MESSAGE_PURGED', 'This conversation is read-only.');
        const previous = found ? (await tx.query<Message>('SELECT * FROM appointment_messages WHERE "conversationId"=$1 AND "senderUserId"=$2 AND "clientMessageId"=$3', [found.id, member.userId, input.clientMessageId])).rows[0] : undefined;
        if (previous) {
          if (crypto.decrypt(previous, id) !== input.content) denied(409, 'MESSAGE_REPLAY_CONFLICT', 'This message retry ID was already used.');
          return { result: { message: publicMessage(previous, id), created: false }, journal: { messageId: previous.id } };
        }
        if (old) denied(409, 'MESSAGE_REPLAY_UNAVAILABLE', 'The original message is no longer available.');
        if (context.processing) denied(409, 'APPOINTMENT_TRANSITION_PENDING', 'This conversation is temporarily read-only.');
        if (!calculateMessageAccess(context.seed, context.chain, new Date(clock())).canSend) denied(409, 'MESSAGE_READ_ONLY', 'This conversation is read-only.');
        const count = (await tx.query<{ count: number }>('SELECT COUNT(*)::integer AS count FROM appointment_messages WHERE "senderUserId"=$1 AND "createdAt">=$2', [member.userId, new Date(clock() - 60_000)])).rows[0]?.count ?? 0;
        if (count >= 10) denied(429, 'MESSAGE_RATE_LIMIT', 'Please wait before sending another message.');
        if (!found) found = (await tx.query<Conversation>('INSERT INTO message_conversations (id,"appointmentId","createdAt",version) VALUES($1,$2,$3,0) RETURNING *', [randomUUID(), id, new Date(clock())])).rows[0]!;
        const messageId = randomUUID(), encrypted = crypto.encrypt(input.content, id, messageId);
        const message = (await tx.query<Message>(`INSERT INTO appointment_messages (id,"conversationId","senderUserId","senderRole","clientMessageId",ciphertext,nonce,"authTag","keyVersion","createdAt")
          VALUES($1,$2,$3,$4::"MessageSenderRole",$5,$6,$7,$8,$9,$10) RETURNING *`, [messageId, found.id, member.userId, actor.role, input.clientMessageId,
          encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyVersion, new Date(clock())])).rows[0]!;
        found = (await tx.query<Conversation>('UPDATE message_conversations SET version=version+1 WHERE id=$1 RETURNING *', [found.id])).rows[0]!;
        await signal(tx, actor, id, found, 'message', meta.operationId);
        return { result: { message: publicMessage(message, id), created: true }, journal: { messageId } };
      });
    },
    async read(actor: Actor, id: string, meta: AppointmentCommand, body: unknown) {
      const input = messageReadInput.parse(body); z.uuid().parse(id);
      return command(actor, 'read', id, meta, input, async tx => {
        await messagingAppointment(tx, actor, id, true);
        const found = await conversation(tx, id, true);
        if (!found || found.purgedAt) denied(400, 'MESSAGE_REQUIRED', 'A valid message is required.');
        const message = (await tx.query<{ createdAt: Date }>('SELECT "createdAt" FROM appointment_messages WHERE id=$1 AND "conversationId"=$2', [input.messageId, found.id])).rows[0];
        if (!message) denied(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
        const field = actor.role === 'patient' ? 'patientLastReadAt' : 'doctorLastReadAt';
        const updated = (await tx.query<Conversation>(`UPDATE message_conversations SET "${field}"=$2,version=version+1
          WHERE id=$1 AND ("${field}" IS NULL OR "${field}"<$2) RETURNING *`, [found.id, message.createdAt])).rows[0];
        if (updated) await signal(tx, actor, id, updated, 'read', meta.operationId);
        return { result: { success: true }, journal: { messageId: input.messageId } };
      });
    },
  };
}
export type MessagingModule = ReturnType<typeof createMessagingModule>;
