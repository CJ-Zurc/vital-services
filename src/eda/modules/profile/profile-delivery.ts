import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { parseEvent, type EventEnvelope } from "../../contracts/events.js";
import { processWithInbox } from "../../infrastructure/outbox.js";
import { requestHash as canonicalHash } from "../../infrastructure/security.js";
import { latestProfileSyncIntents, readProfileSyncIntent, syncRequest, type ProfileSyncIntent } from "./profile-sync.js";
import { saveDelivery, type DeliveryTarget } from "../platform-delivery/delivery.js";
import { boundedJsonReceipt } from "../../infrastructure/http-receipt.js";

export type SyncStatus = "pending" | "failed" | "synced";
export async function consumeProfileSync(core: Pool, integrations: Pool, raw: EventEnvelope) {
  const event = parseEvent(raw);
  if (event.eventType !== "vital.profile.sync.requested" || event.producer !== "profile") throw new Error("PROFILE_SYNC_SUBSCRIPTION_MISMATCH");
  const intent = await readProfileSyncIntent(core, event);
  await processWithInbox(integrations, "profile-sync", event, async tx => {
    await saveDelivery(tx, event, intent.destination, intent.requestId,
      { authId: intent.authId, body: intent.payload }, intent.requestHash);
  });
}

export async function getProfileSyncStatuses(core: Pool, integrations: Pool, authIds: string[]): Promise<Map<string, SyncStatus>> {
  const intents = await latestProfileSyncIntents(core, authIds);
  const requestIds = intents.map(intent => intent.requestId);
  const result = requestIds.length ? await integrations.query<{ requestId: string; requestHash: string; status: string }>(
    `SELECT "requestId","requestHash",status FROM integration_deliveries WHERE "requestId"=ANY($1::text[])
      AND destination IN ('auth-stale','ehr-mirror')`, [requestIds]) : { rows: [] };
  const states = new Map(result.rows.map(row => [row.requestId, row]));
  const statuses = new Map<string, SyncStatus>(authIds.map(id => [id, "pending"]));
  for (const id of authIds) {
    const required = intents.filter(intent => intent.authId === id);
    if (!required.length) continue;
    const observed = required.map(intent => {
      const delivery = states.get(intent.requestId);
      return delivery?.requestHash !== undefined && delivery.requestHash !== intent.requestHash
        || delivery?.status === "blocked" ? "failed" : delivery?.status === "accepted" ? "synced" : "pending";
    });
    statuses.set(id, observed.includes("failed") ? "failed" : observed.every(state => state === "synced") ? "synced" : "pending");
  }
  return statuses;
}

type SyncRow = { id: string; eventId: string; destination: ProfileSyncIntent["destination"]; requestId: string; requestHash: string;
  aggregateId: string; sourceVersion: number; correlationId: string; payload: { authId: string; body: Record<string, unknown> }; attempts: number };
const receiptSchema = z.object({ operationId: z.uuid(), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["completed", "superseded"]), sourceVersion: z.number().int().positive().optional() });

export async function deliverProfileSync(core: Pool, integrations: Pool,
  config: { auth: DeliveryTarget; ehr: DeliveryTarget }, fetcher: typeof fetch = fetch) {
  const owner = randomUUID();
  const rows = await integrations.query<SyncRow>(`WITH due AS (
    SELECT id FROM integration_deliveries WHERE destination IN ('auth-stale','ehr-mirror') AND
      ((status='pending' AND "nextAttemptAt"<=NOW()) OR (status='processing' AND "leaseUntil"<=NOW()))
    ORDER BY "createdAt",id LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE integration_deliveries d SET status='processing',"leaseOwner"=$1,"leaseUntil"=NOW()+INTERVAL '30 seconds',"updatedAt"=NOW()
    FROM due WHERE d.id=due.id RETURNING d.*`, [owner]);
  for (const row of rows.rows) {
    let terminal = false;
    try {
      const intent: ProfileSyncIntent = { id: row.id, profileId: row.aggregateId, authId: row.payload.authId,
        sourceVersion: row.sourceVersion, destination: row.destination, requestId: row.requestId, requestHash: row.requestHash, payload: row.payload.body };
      const request = syncRequest(intent);
      const latest = (await latestProfileSyncIntents(core, [intent.authId])).find(item => item.destination === row.destination);
      if (!latest || latest.profileId !== row.aggregateId || latest.sourceVersion < row.sourceVersion) {
        terminal = true; throw new Error("PROFILE_SYNC_SOURCE_INVALID");
      }
      if (latest.sourceVersion > row.sourceVersion) {
        await integrations.query(`UPDATE integration_deliveries SET status='superseded',"leaseOwner"=NULL,"leaseUntil"=NULL,"updatedAt"=NOW()
          WHERE id=$1 AND "leaseOwner"=$2 AND "leaseUntil">NOW()`, [row.id, owner]);
        continue;
      }
      if (latest.requestId !== row.requestId || latest.requestHash !== row.requestHash) {
        terminal = true; throw new Error("PROFILE_SYNC_SOURCE_CONFLICT");
      }
      const target = row.destination === "auth-stale" ? config.auth : config.ehr;
      if (!target.baseUrl || !target.key) throw new Error("PROFILE_SYNC_UNCONFIGURED");
      const base = new URL(target.baseUrl);
      if (base.username || base.password || base.search || base.hash || base.pathname !== "/"
        || !["http:", "https:"].includes(base.protocol) || process.env.NODE_ENV === "production" && base.protocol !== "https:") {
        terminal = true; throw new Error("PROFILE_SYNC_TARGET_INVALID");
      }
      const response = await fetcher(new URL(request.path, base), { method: request.method, redirect: "error",
        signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/json", "X-Internal-Service": "vital-services",
          "X-Internal-Service-Key": target.key, "X-Correlation-ID": row.correlationId,
          "X-Vital-Operation-ID": row.requestId, "X-Vital-Request-Hash": row.requestHash }, body: JSON.stringify(request.body) });
      if (!response.ok) {
        terminal = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status);
        throw new Error("PROFILE_SYNC_REJECTED");
      }
      const body = z.object({ success: z.literal(true), vitalOperation: receiptSchema.optional(), data: z.unknown() }).parse(await boundedJsonReceipt(response));
      const nested = body.data && typeof body.data === "object" && "vitalOperation" in body.data ? body.data.vitalOperation : undefined;
      if (body.vitalOperation && nested !== undefined
        && canonicalHash("RECEIPT", "profile", body.vitalOperation) !== canonicalHash("RECEIPT", "profile", nested)) {
        terminal = true; throw new Error("PROFILE_SYNC_AMBIGUOUS_RECEIPT");
      }
      const receipt = receiptSchema.parse(body.vitalOperation ?? nested);
      if (receipt.operationId !== row.requestId || receipt.requestHash !== row.requestHash
        || row.destination === "ehr-mirror" && receipt.sourceVersion !== row.sourceVersion
        || receipt.status !== "completed") {
        terminal = true; throw new Error("PROFILE_SYNC_RECEIPT_CONFLICT");
      }
      if (row.destination === "ehr-mirror") {
        const mirror = z.object({ auth_id: z.uuid(), role: z.literal("doctor"),
          department_external_id: z.string().nullable(), department_name: z.string().nullable() }).parse(body.data);
        if (mirror.auth_id !== intent.authId || mirror.department_external_id !== request.body.department_external_id
          || mirror.department_name !== request.body.department_name) { terminal = true; throw new Error("PROFILE_SYNC_MIRROR_CONFLICT"); }
      }
      const accepted = await integrations.query(`UPDATE integration_deliveries SET status='accepted',"receiptId"=$3,
        "leaseOwner"=NULL,"leaseUntil"=NULL,"lastErrorCode"=NULL,"updatedAt"=NOW()
        WHERE id=$1 AND "leaseOwner"=$2 AND status='processing' AND "leaseUntil">NOW()`, [row.id, owner, row.requestId]);
      if (accepted.rowCount !== 1) throw new Error("PROFILE_SYNC_LEASE_LOST");
    } catch {
      await integrations.query(`UPDATE integration_deliveries SET status=$3,attempts=attempts+1,
        "nextAttemptAt"=NOW()+($4 * INTERVAL '1 second'),"lastErrorCode"='PROFILE_SYNC_FAILED',
        "leaseOwner"=NULL,"leaseUntil"=NULL,"updatedAt"=NOW() WHERE id=$1 AND "leaseOwner"=$2 AND status='processing'`,
      [row.id, owner, terminal || row.attempts >= 9 ? "blocked" : "pending", [60, 300, 900, 3600, 21600][Math.min(row.attempts, 4)]]);
    }
  }
  return rows.rows.length;
}
