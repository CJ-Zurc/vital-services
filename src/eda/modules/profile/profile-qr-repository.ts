import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { requireScope, type Actor } from "../../contracts/actor.js";
import { requestHash } from "../../infrastructure/security.js";
import { appendProfileSqlEffects } from './profile-sql-effects.js';
import { qrDenied, qrFilePath, type QrAsset, type QrCommand, type QrDescriptor, type QrJob, type QrRow } from "./profile-qr-contracts.js";

export interface ProfileQrRepository {
  reserve(actor: Actor, meta: QrCommand, descriptor: QrDescriptor): Promise<QrAsset>;
  claim(actorId: string, operationId: string): Promise<QrJob | null>;
  finish(job: QrJob, content: NonNullable<QrAsset["content"]>): Promise<void>;
  release(job: QrJob, rejectedCode?: string): Promise<void>;
  pending(): Promise<{ actorId: string; operationId: string }[]>;
  status(actor: Actor, operationId: string, write?: boolean): Promise<QrAsset>;
  list(actor: Actor): Promise<QrRow[]>;
  ready(actor: Actor, id: string, write?: boolean): Promise<{ row: QrRow; asset: QrAsset }>;
  activate(actor: Actor, id: string, meta: QrCommand, isActive: boolean): Promise<QrRow>;
}
type CommandRow = { actorId: string; operationId: string; action: string; resourceId: string; requestHash: string; status: string; result: QrAsset; leaseUntil: Date | null };
export function createProfileQrRepository(pool: Pool): ProfileQrRepository {
  async function transaction<T>(run: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tx = await pool.connect();
    try { await tx.query("BEGIN"); const result = await run(tx); await tx.query("COMMIT"); return result; }
    catch (error) { await tx.query("ROLLBACK"); throw error; } finally { tx.release(); }
  }
  async function membership(db: Pick<PoolClient, "query">, authId: string) {
    const row = (await db.query<{ userId: string }>(`SELECT d."userId" FROM vital_doctors d JOIN vital_users u
      ON u.id=d."userId" AND u."authId"=d."authId" AND u.role='doctor' WHERE d."authId"=$1`, [authId])).rows[0];
    if (!row) qrDenied(404, "PROFILE_QR_DOCTOR_NOT_FOUND");
    return row.userId;
  }
  async function doctor(db: Pick<PoolClient, "query">, actor: Actor, scope: string) {
    requireScope(actor, scope, actor.authId);
    if (actor.role !== "doctor") qrDenied(403, "PROFILE_QR_DOCTOR_REQUIRED");
    return membership(db, actor.authId);
  }
  const lock = (tx: PoolClient, actorId: string, operationId: string) => tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`profile-qr:${actorId}:${operationId}`]);
  async function command(db: Pick<PoolClient, "query">, actorId: string, operationId: string) {
    return (await db.query<CommandRow>('SELECT * FROM command_operations WHERE "actorId"=$1 AND "operationId"=$2', [actorId, operationId])).rows[0];
  }
  async function ownedReady(db: Pick<PoolClient, "query">, actor: Actor, id: string, scope: string) {
    z.uuid().parse(id); const doctorId = await doctor(db, actor, scope);
    const row = (await db.query<QrRow>('SELECT * FROM doctor_qr_codes WHERE id=$1 AND "doctorId"=$2', [id, doctorId])).rows[0];
    if (!row) qrDenied(404, "PROFILE_QR_NOT_FOUND");
    const owner = (await db.query<CommandRow>(`SELECT * FROM command_operations WHERE "actorId"=$1 AND action='profile.qr.upload'
      AND status='completed' AND result->>'id'=$2 AND result->>'state'='ready' LIMIT 1`, [actor.authId, id])).rows[0];
    if (!owner || owner.result.doctorId !== doctorId || !owner.result.content) qrDenied(409, "PROFILE_QR_NOT_READY");
    return { row, asset: owner.result };
  }
  return {
    async reserve(actor, meta, descriptor) {
      z.uuid().parse(meta.operationId); z.string().regex(/^[a-f0-9]{64}$/).parse(meta.requestHash);
      const hash = requestHash("PROFILE-QR", "upload", { descriptor });
      return transaction(async tx => {
        await lock(tx, actor.authId, meta.operationId);
        const doctorId = await doctor(tx, actor, "profile.qr.write");
        const old = await command(tx, actor.authId, meta.operationId);
        if (old) {
          if (old.action !== "profile.qr.upload" || old.requestHash !== hash || old.resourceId !== actor.authId || old.result.doctorId !== doctorId) qrDenied(409, "PROFILE_QR_REPLAY_CONFLICT");
          return old.result;
        }
        const asset: QrAsset = { schema: "profile-qr.v1", id: randomUUID(), doctorId, descriptor, state: "pending", correlationId: actor.correlationId };
        await tx.query(`INSERT INTO command_operations (id,"actorId",action,"resourceId","operationId","requestHash",status,result,"createdAt","updatedAt")
          VALUES($1,$2,'profile.qr.upload',$2,$3,$4,'pending',$5::jsonb,NOW(),NOW())`, [randomUUID(), actor.authId, meta.operationId, hash, JSON.stringify(asset)]);
        return asset;
      });
    },
    async claim(actorId, operationId) {
      const leaseOwner = randomUUID();
      const row = (await pool.query<CommandRow>(`UPDATE command_operations SET "leaseOwner"=$3,"leaseUntil"=NOW()+INTERVAL '120 seconds',"updatedAt"=NOW()
        WHERE "actorId"=$1 AND "operationId"=$2 AND action='profile.qr.upload' AND status='pending'
        AND ("leaseUntil" IS NULL OR "leaseUntil"<NOW()) RETURNING *`, [actorId, operationId, leaseOwner])).rows[0];
      return row ? { actorId, operationId, leaseOwner, asset: row.result } : null;
    },
    async finish(job, content) {
      await transaction(async tx => {
        await lock(tx, job.actorId, job.operationId);
        const leased = (await tx.query(`SELECT id FROM command_operations WHERE "actorId"=$1 AND "operationId"=$2
          AND action='profile.qr.upload' AND status='pending' AND "leaseOwner"=$3 AND "leaseUntil">NOW() FOR UPDATE`, [job.actorId, job.operationId, job.leaseOwner])).rows[0];
        if (!leased) qrDenied(409, "PROFILE_QR_LEASE_LOST");
        await membership(tx, job.actorId).then(id => {
          if (id !== job.asset.doctorId) qrDenied(403, "PROFILE_QR_OWNER_CHANGED");
        });
        const asset: QrAsset = { ...job.asset, state: "ready", content };
        await tx.query(`INSERT INTO doctor_qr_codes (id,"doctorId","paymentProvider","filePath","isActive","createdAt")
          VALUES($1,$2,$3::"PaymentProvider",$4,true,NOW())`, [asset.id, asset.doctorId, asset.descriptor.paymentProvider, qrFilePath(asset.id)]);
        await tx.query(`UPDATE command_operations SET status='completed',result=$3::jsonb,"leaseOwner"=NULL,"leaseUntil"=NULL,"updatedAt"=NOW()
          WHERE "actorId"=$1 AND "operationId"=$2`, [job.actorId, job.operationId, JSON.stringify(asset)]);
        await appendProfileSqlEffects(tx, { userId: asset.doctorId, authId: job.actorId, role: 'doctor', correlationId: asset.correlationId ?? job.operationId });
      });
    },
    async release(job, rejectedCode) {
      await pool.query(`UPDATE command_operations SET status=$4,result=$5::jsonb,"errorCode"=$6,"leaseOwner"=NULL,"leaseUntil"=NOW()+INTERVAL '30 seconds',"updatedAt"=NOW()
        WHERE "actorId"=$1 AND "operationId"=$2 AND "leaseOwner"=$3 AND status='pending'`,
      [job.actorId, job.operationId, job.leaseOwner, rejectedCode ? "rejected" : "pending",
        JSON.stringify(rejectedCode ? { ...job.asset, state: "rejected", errorCode: rejectedCode } : job.asset), rejectedCode ?? null]);
    },
    async pending() {
      return (await pool.query<{ actorId: string; operationId: string }>(`SELECT "actorId","operationId" FROM command_operations
        WHERE action='profile.qr.upload' AND status='pending' AND ("leaseUntil" IS NULL OR "leaseUntil"<NOW()) ORDER BY "updatedAt",id LIMIT 2`)).rows;
    },
    async status(actor, operationId, write = false) {
      z.uuid().parse(operationId); const doctorId = await doctor(pool, actor, write ? "profile.qr.write" : "profile.qr.read");
      const row = await command(pool, actor.authId, operationId);
      if (!row || row.action !== "profile.qr.upload" || row.result.doctorId !== doctorId) qrDenied(404, "PROFILE_QR_OPERATION_NOT_FOUND");
      return row.result;
    },
    async list(actor) {
      const id = await doctor(pool, actor, "profile.qr.read");
      return (await pool.query<QrRow>(`SELECT q.* FROM doctor_qr_codes q WHERE q."doctorId"=$1 AND EXISTS
        (SELECT 1 FROM command_operations c WHERE c."actorId"=$2 AND c.action='profile.qr.upload' AND c.status='completed'
        AND c.result->>'id'=q.id AND c.result->>'state'='ready') ORDER BY q."isActive" DESC,q."createdAt" DESC,q.id LIMIT 1000`, [id, actor.authId])).rows;
    },
    ready: (actor, id, write = false) => ownedReady(pool, actor, id, write ? "profile.qr.write" : "profile.qr.read"),
    async activate(actor, id, meta, isActive) {
      z.uuid().parse(meta.operationId); z.string().regex(/^[a-f0-9]{64}$/).parse(meta.requestHash);
      const hash = requestHash("PROFILE-QR", "activate", { id, isActive });
      return transaction(async tx => {
        await lock(tx, actor.authId, meta.operationId);
        await ownedReady(tx, actor, id, "profile.qr.write");
        const old = await command(tx, actor.authId, meta.operationId);
        if (old) {
          if (old.action !== "profile.qr.activate" || old.requestHash !== hash || old.resourceId !== actor.authId) qrDenied(409, "PROFILE_QR_REPLAY_CONFLICT");
          const saved = old.result as unknown as QrRow;
          return { ...saved, createdAt: new Date(saved.createdAt) };
        }
        const row = (await tx.query<QrRow>('UPDATE doctor_qr_codes SET "isActive"=$2 WHERE id=$1 RETURNING *', [id, isActive])).rows[0]!;
        await appendProfileSqlEffects(tx, { userId: row.doctorId, authId: actor.authId, role: 'doctor', correlationId: actor.correlationId });
        await tx.query(`INSERT INTO command_operations (id,"actorId",action,"resourceId","operationId","requestHash",status,result,"createdAt","updatedAt")
          VALUES($1,$2,'profile.qr.activate',$2,$3,$4,'completed',$5::jsonb,NOW(),NOW())`, [randomUUID(), actor.authId, meta.operationId, hash, JSON.stringify(row)]);
        return row;
      });
    },
  };
}
