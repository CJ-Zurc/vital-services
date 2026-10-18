import type { Pool } from "pg";
import { z } from "zod";
import { requestHash } from "../../infrastructure/security.js";
import type { EventEnvelope } from "../../contracts/events.js";

export const syncDestination = z.enum(["auth-stale", "ehr-mirror"]);
export type SyncDestination = z.infer<typeof syncDestination>;
const mirror = z.object({ source: z.literal("vital-services"), request_id: z.uuid(),
  source_version: z.number().int().positive(), department_external_id: z.string().min(1).max(128).nullable(),
  department_name: z.string().min(1).max(160).nullable() }).strict();
export type ProfileSyncIntent = { id: string; profileId: string; authId: string; sourceVersion: number;
  destination: SyncDestination; requestId: string; requestHash: string; payload: Record<string, unknown> };

export function syncRequest(intent: ProfileSyncIntent) {
  z.uuid().parse(intent.authId); z.uuid().parse(intent.requestId);
  const destination = syncDestination.parse(intent.destination);
  const method = destination === "auth-stale" ? "POST" : "PUT";
  const path = `/internal/users/${intent.authId}/${destination === "auth-stale" ? "stale" : "doctor-mirror"}`;
  const body = destination === "auth-stale" ? z.object({}).strict().parse(intent.payload) : mirror.parse(intent.payload);
  if ("request_id" in body && (body.request_id !== intent.requestId || body.source_version !== intent.sourceVersion)) {
    throw new Error("PROFILE_SYNC_BINDING_MISMATCH");
  }
  if (requestHash(method, path, body) !== intent.requestHash) throw new Error("PROFILE_SYNC_HASH_MISMATCH");
  return { method, path, body };
}

// Owning-module reads expose committed identifiers/transport intent, never patient clinical data.
export async function readProfileSyncIntent(core: Pool, event: EventEnvelope): Promise<ProfileSyncIntent> {
  const result = await core.query<ProfileSyncIntent>(`SELECT i.id,i."profileId",i."authId",i."sourceVersion",i.destination,
    i."requestId",i."requestHash",i.payload FROM profile_sync_intents i JOIN vital_users u ON u.id=i."profileId"
    WHERE i.id=$1 AND u."authId"=i."authId" AND u.version>=i."sourceVersion"`, [event.data.intentId]);
  const intent = result.rows[0];
  if (!intent || intent.profileId !== event.aggregateId || intent.sourceVersion !== event.aggregateVersion
    || intent.authId !== event.data.authId || intent.destination !== event.data.destination) throw new Error("PROFILE_SYNC_SOURCE_UNVERIFIED");
  syncRequest(intent);
  return intent;
}

export async function latestProfileSyncIntents(core: Pool, authIds: string[]) {
  for (const id of authIds) z.uuid().parse(id);
  if (!authIds.length) return [];
  const result = await core.query<ProfileSyncIntent>(`SELECT DISTINCT ON ("authId",destination)
    id,"profileId","authId","sourceVersion",destination,"requestId","requestHash",payload
    FROM profile_sync_intents WHERE "authId"=ANY($1::text[])
    ORDER BY "authId",destination,"sourceVersion" DESC`, [authIds]);
  return result.rows;
}
