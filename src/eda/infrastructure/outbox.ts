import { auditMetadata } from '../contracts/audit.js';
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { parseEvent, type EventEnvelope, type EventType, type Producer } from "../contracts/events.js";
import type { Prisma as CorePrisma } from "../generated/core/client.js";
import type { Prisma as IntegrationsPrisma } from "../generated/integrations/client.js";

export interface OutboxInput {
  eventType: EventType;
  producer: Producer;
  aggregateId: string;
  aggregateVersion: number;
  correlationId: string;
  causationId?: string | null;
  data: Record<string, unknown>;
  eventId?: string;
  occurredAt?: string;
}

type Writer = Pick<CorePrisma.TransactionClient, "outboxEvent"> | Pick<IntegrationsPrisma.TransactionClient, "outboxEvent">;

export function makeEvent(input: OutboxInput): EventEnvelope {
  if(input.eventType==='vital.audit.requested'&&!input.data.auditMetadata){
    const data=input.data as {auditType:string;actorAuthId:string|null;resourceId:string|null;resourceType:string};
    input={...input,data:{...input.data,auditMetadata:auditMetadata(data)}};
  }
  return parseEvent({ ...input, eventId: input.eventId ?? randomUUID(), schemaVersion: 1,
    occurredAt: input.occurredAt ?? new Date().toISOString(), causationId: input.causationId ?? null });
}

export async function appendOutbox(tx: Writer, input: OutboxInput) {
  const event = makeEvent(input);
  const data = {
    id: event.eventId, eventType: event.eventType, schemaVersion: 1, producer: event.producer,
    aggregateId: event.aggregateId, aggregateVersion: event.aggregateVersion,
    correlationId: event.correlationId, causationId: event.causationId,
    occurredAt: new Date(event.occurredAt), payload: event.data as CorePrisma.InputJsonObject,
  };
  await tx.outboxEvent.create({ data });
  return event;
}

export async function appendSqlOutbox(tx: PoolClient, input: OutboxInput) {
  const event = makeEvent(input);
  await tx.query(`INSERT INTO outbox_events
    (id,"eventType","schemaVersion",producer,"aggregateId","aggregateVersion","correlationId","causationId","occurredAt",payload,status,attempts,"nextAttemptAt")
    VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9::jsonb,'pending',0,NOW())`,
  [event.eventId, event.eventType, event.producer, event.aggregateId, event.aggregateVersion, event.correlationId, event.causationId, event.occurredAt, JSON.stringify(event.data)]);
  if (event.producer === 'appointment' && event.eventType.startsWith('vital.appointment.')) {
    // Delivered after commit; this hint contains no clinical or financial state.
    await tx.query('SELECT pg_notify($1,$2)::text', ['vital_appointment_events', JSON.stringify({ appointmentId: event.aggregateId, kind: 'eligibility' })]);
  }
  return event;
}

export interface OutboxRow {
  id: string;
  eventType: EventType;
  schemaVersion: 1;
  producer: Producer;
  aggregateId: string;
  aggregateVersion: number;
  correlationId: string;
  causationId: string | null;
  occurredAt: Date;
  payload: Record<string, unknown>;
  attempts: number;
}

export function envelopeFromRow(row: OutboxRow) {
  return parseEvent({ eventId: row.id, eventType: row.eventType, schemaVersion: row.schemaVersion,
    producer: row.producer, aggregateId: row.aggregateId, aggregateVersion: row.aggregateVersion,
    correlationId: row.correlationId, causationId: row.causationId,
    occurredAt: row.occurredAt.toISOString(), data: row.payload });
}

export async function claimOutbox(pool: Pool, owner: string, limit = 5): Promise<OutboxRow[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Outbox batch must be 1-100.");
  const result = await pool.query<OutboxRow>(`WITH due AS (
    SELECT id FROM outbox_events WHERE
      (status = 'pending' AND "nextAttemptAt" <= NOW()) OR
      (status = 'processing' AND "leaseUntil" <= NOW())
    ORDER BY "occurredAt",id LIMIT $1 FOR UPDATE SKIP LOCKED
  ) UPDATE outbox_events AS event SET status='processing',"leaseOwner"=$2,"leaseUntil"=NOW()+INTERVAL '30 seconds'
    FROM due WHERE event.id=due.id RETURNING event.*`, [limit, owner]);
  return result.rows;
}

export async function markPublished(pool: Pool, id: string, owner: string) {
  const result = await pool.query(`UPDATE outbox_events SET status='published',"publishedAt"=NOW(),
    "leaseOwner"=NULL,"leaseUntil"=NULL,"lastErrorCode"=NULL
    WHERE id=$1 AND status='processing' AND "leaseOwner"=$2 AND "leaseUntil">NOW()`, [id, owner]);
  if (result.rowCount !== 1) throw new Error("OUTBOX_LEASE_LOST");
}

export function retryDelay(attempts: number) {
  return Math.min(60_000 * 2 ** Math.min(attempts, 10), 21_600_000);
}

export async function releaseOutbox(pool: Pool, row: OutboxRow, owner: string, code: "PUBLISH_FAILED" | "INVALID_EVENT") {
  const blocked = code === "INVALID_EVENT" || row.attempts + 1 >= 20;
  await pool.query(`UPDATE outbox_events SET status=$3,attempts=attempts+1,"nextAttemptAt"=NOW()+($4 * INTERVAL '1 millisecond'),
    "leaseOwner"=NULL,"leaseUntil"=NULL,"lastErrorCode"=$5 WHERE id=$1 AND "leaseOwner"=$2 AND status='processing'`,
  [row.id, owner, blocked ? "blocked" : "pending", retryDelay(row.attempts), code]);
}

export async function dispatchOutbox(pool: Pool, publish: (event: EventEnvelope) => Promise<void>, owner = randomUUID()) {
  const rows = await claimOutbox(pool, owner);
  let published = 0;
  for (const row of rows) {
    let event: EventEnvelope;
    try { event = envelopeFromRow(row); }
    catch { await releaseOutbox(pool, row, owner, "INVALID_EVENT"); continue; }
    try { await publish(event); await markPublished(pool, row.id, owner); published += 1; }
    catch { await releaseOutbox(pool, row, owner, "PUBLISH_FAILED"); }
  }
  return { claimed: rows.length, published };
}

export async function processWithInbox(pool: Pool, consumerId: string, event: EventEnvelope,
  apply: (tx: PoolClient, event: EventEnvelope) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(`INSERT INTO inbox_events ("consumerId","eventId","processedAt")
      VALUES ($1,$2,NOW()) ON CONFLICT ("consumerId","eventId") DO NOTHING RETURNING "eventId"`, [consumerId, event.eventId]);
    if (inserted.rowCount === 1) await apply(client, event);
    await client.query("COMMIT");
    return inserted.rowCount === 1;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
