import { randomUUID } from "node:crypto";
import { observeDeliveryOutcome } from '../../infrastructure/observation.js';
import type { Pool, PoolClient } from "pg";
import { processWithInbox } from "../../infrastructure/outbox.js";
import { parseEvent, type EventEnvelope } from "../../contracts/events.js";
import { requestHash as canonicalHash } from "../../infrastructure/security.js";
import { boundedJsonReceipt } from "../../infrastructure/http-receipt.js";
import { trustedInternalOrigin } from "../../infrastructure/private-transport.js";

export type Destination = "audit" | "notification" | "auth-stale" | "ehr-mirror";
function hash(value: unknown) { return canonicalHash("POST", "delivery", value); }

export async function saveDelivery(tx: PoolClient, event: EventEnvelope, destination: Destination,
  requestId: string, payload: Record<string, unknown>, verifiedRequestHash?: string) {
  const requestHash = verifiedRequestHash ?? hash(payload);
  await tx.query(`INSERT INTO integration_deliveries
    (id,"eventId",destination,"requestId","requestHash","aggregateId","sourceVersion",payload,"correlationId",status,attempts,"nextAttemptAt","createdAt","updatedAt")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'pending',0,NOW(),NOW(),NOW())
    ON CONFLICT (destination,"requestId") DO NOTHING`,
  [randomUUID(), event.eventId, destination, requestId, requestHash, event.aggregateId, event.aggregateVersion, JSON.stringify(payload), event.correlationId]);
  const existing = await tx.query<{ requestHash: string }>(`SELECT "requestHash" FROM integration_deliveries WHERE destination=$1 AND "requestId"=$2`, [destination, requestId]);
  if (existing.rows[0]?.requestHash !== requestHash) throw new Error("DELIVERY_REQUEST_CONFLICT");
}

export async function enqueueAudit(pool: Pool, raw: EventEnvelope) {
  const event = parseEvent(raw);
  await processWithInbox(pool, "platform-audit", event, async (tx) => {
    if (event.eventType !== "vital.audit.requested") throw new Error("AUDIT_SUBSCRIPTION_MISMATCH");
    await saveDelivery(tx, event, "audit", event.eventId, {
      event_id: event.eventId, event_type: event.data.auditType,
      correlation_id: event.correlationId, user_id: event.data.actorAuthId,
      system: "vital", timestamp: event.occurredAt,
      details: { resource_id: event.data.resourceId, resource_type: event.data.resourceType, source_event_id: event.eventId },
    });
  });
}

export async function enqueueNotification(pool: Pool, raw: EventEnvelope) {
  const event = parseEvent(raw);
  await processWithInbox(pool, "platform-notification", event, async (tx) => {
    if (event.eventType !== "vital.notification.requested") throw new Error("NOTIFICATION_SUBSCRIPTION_MISMATCH");
    await saveDelivery(tx, event, "notification", String(event.data.requestId), {
      ...event.data, sourceEventId: event.eventId, sourceVersion: event.aggregateVersion,
    });
  });
}

export interface DeliveryTarget { baseUrl: string; key: string; }
export interface DeliveryConfig { audit: DeliveryTarget; notification: DeliveryTarget; }

export async function deliverPending(pool: Pool, config: DeliveryConfig, fetcher: typeof fetch = fetch) {
  const owner = randomUUID();
  const result = await pool.query<{ id: string; destination: "audit" | "notification"; requestId: string; correlationId: string; payload: Record<string, unknown>; attempts: number }>(`WITH due AS (
    SELECT id FROM integration_deliveries WHERE destination IN ('audit','notification') AND
      ((status='pending' AND "nextAttemptAt"<=NOW()) OR (status='processing' AND "leaseUntil"<=NOW()))
      ORDER BY "createdAt",id LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE integration_deliveries AS delivery SET status='processing',"leaseOwner"=$1,"leaseUntil"=NOW()+INTERVAL '30 seconds',"updatedAt"=NOW()
    FROM due WHERE delivery.id=due.id RETURNING delivery.*`, [owner]);
  for (const row of result.rows) {
    const target = config[row.destination];
    try {
      if (!target?.baseUrl || !target.key) throw new Error("DELIVERY_NOT_CONFIGURED");
      const path = row.destination === "audit" ? "/ingest/business" : "/internal/v1/vital/notifications";
      const url = new URL(path, target.baseUrl);
      if (url.username || url.password || !trustedInternalOrigin(url)) throw new Error("INVALID_DELIVERY_TARGET");
      const headers: Record<string, string> = { "Content-Type": "application/json", "X-Correlation-ID": row.correlationId };
      if (row.destination === "audit") headers["X-Audit-Ingest-Key"] = target.key;
      else { headers["X-Internal-Service"] = "vital-services"; headers["X-Internal-Service-Key"] = target.key; }
      const response = await fetcher(url, { method: "POST", redirect: "error", headers,
        body: JSON.stringify(row.payload), signal: AbortSignal.timeout(10_000) });
      if (response.status !== 202) throw new Error("DELIVERY_NOT_ACCEPTED");
      let receiptId: string | null = null;
      if (row.destination === "notification") {
        const receipt = await boundedJsonReceipt(response) as { requestId?: string; notificationId?: string; status?: string };
        if (receipt.requestId !== row.requestId || typeof receipt.notificationId !== "string") throw new Error("DELIVERY_RECEIPT_MISMATCH");
        receiptId = receipt.notificationId;
      }
      const accepted = await pool.query(`UPDATE integration_deliveries SET status='accepted',"receiptId"=$3,"leaseOwner"=NULL,"leaseUntil"=NULL,"updatedAt"=NOW()
        WHERE id=$1 AND "leaseOwner"=$2 AND status='processing' AND "leaseUntil">NOW()`, [row.id, owner, receiptId]);
      if (accepted.rowCount !== 1) throw new Error("DELIVERY_LEASE_LOST");
      observeDeliveryOutcome(row.destination, 'accepted');
    } catch {
      await pool.query(`UPDATE integration_deliveries SET status=$3,attempts=attempts+1,"nextAttemptAt"=NOW()+($4 * INTERVAL '1 second'),
        "lastErrorCode"='DELIVERY_FAILED',"leaseOwner"=NULL,"leaseUntil"=NULL,"updatedAt"=NOW() WHERE id=$1 AND "leaseOwner"=$2`,
      [row.id, owner, row.attempts >= 19 ? "blocked" : "pending", Math.min(60 * 2 ** Math.min(row.attempts, 10), 21600)]);
      observeDeliveryOutcome(row.destination, row.attempts >= 19 ? 'blocked' : 'retry_pending');
    }
  }
  return result.rows.length;
}
