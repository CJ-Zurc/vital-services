import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { DomainError, requireScope, type Actor } from "../../contracts/actor.js";
import { appendSqlOutbox } from "../../infrastructure/outbox.js";
import { requestHash } from "../../infrastructure/security.js";
import type { AppointmentCommand } from "./appointment-contracts.js";

export async function resumeAppointmentSaga(pool:Pool,actor:Actor,operationId:string,metadata:AppointmentCommand,body:unknown){
  requireScope(actor,"appointments.operation.resume",operationId);
  if(actor.role!=="admin")throw new DomainError(403,"SAGA_ADMIN_REQUIRED","Independent administrator authority required.");
  z.uuid().parse(operationId);z.uuid().parse(metadata.operationId);z.string().regex(/^[a-f0-9]{64}$/).parse(metadata.requestHash);
  const input=z.object({expectedFence:z.number().int().nonnegative()}).strict().parse(body);
  const hash=requestHash("SAGA-REVIEW",operationId,{...input,transportHash:metadata.requestHash});const tx=await pool.connect();
  try{
    await tx.query("BEGIN");const admin=await tx.query('SELECT a."userId" FROM vital_admins a JOIN vital_users u ON u.id=a."userId" AND u."authId"=a."authId" WHERE a."authId"=$1',[actor.authId]);
    if(!admin.rows.length)throw new DomainError(403,"SAGA_ADMIN_REVOKED","Administrator membership is unavailable.");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["appointment-command:"+actor.authId+":"+metadata.operationId]);
    const old=(await tx.query('SELECT * FROM command_operations WHERE "actorId"=$1 AND "operationId"=$2',[actor.authId,metadata.operationId])).rows[0];
    if(old){if(old.action!=="saga.resume"||old.resourceId!==operationId||old.requestHash!==hash)throw new DomainError(409,"COMMAND_REPLAY_CONFLICT","Recovery command conflict.");await tx.query("COMMIT");return old.result;}
    const saga=(await tx.query('SELECT * FROM saga_operations WHERE id=$1 FOR UPDATE',[operationId])).rows[0];
    if(!saga||saga.status!=="review_required"||saga.fence!==input.expectedFence)throw new DomainError(409,"SAGA_REVIEW_STALE","Expected review fence is required.");
    const status=saga.pivotCommittedAt?"finalizing":"compensating";
    await tx.query('UPDATE saga_operations SET status=$2,attempts=0,"nextAttemptAt"=NOW(),"leaseOwner"=NULL,"leaseUntil"=NULL,"lastErrorCode"=NULL WHERE id=$1',[operationId,status]);
    const result={operationId,operationStatus:"processing",status};
    await tx.query('INSERT INTO command_operations (id,"actorId","operationId",action,"resourceId","requestHash",status,result,"createdAt","updatedAt") VALUES($1,$2,$3,\'saga.resume\',$4,$5,\'completed\',$6::jsonb,NOW(),NOW())',[randomUUID(),actor.authId,metadata.operationId,operationId,hash,JSON.stringify(result)]);
    await appendSqlOutbox(tx,{producer:"appointment",eventType:"vital.audit.requested",aggregateId:saga.sourceAppointmentId,aggregateVersion:saga.expectedSourceVersion,correlationId:actor.correlationId,causationId:metadata.operationId,
      data:{auditType:"vital.appointment.recovery_requested",actorAuthId:actor.authId,resourceId:saga.sourceAppointmentId,resourceType:"appointment"}});
    await tx.query("COMMIT");return result;
  }catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}
}
