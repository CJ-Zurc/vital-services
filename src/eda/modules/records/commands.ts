import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import { requireScope,type Actor } from "../../contracts/actor.js";
import { requestHash } from "../../infrastructure/security.js";
import { membership } from "../appointment/appointment.js";
import type { AppointmentCommand } from "../appointment/appointment-contracts.js";
import { recordsDenied } from "./authorization.js";

export async function recordsCommand<T>(pool:Pool,actor:Actor,action:string,resource:string,meta:AppointmentCommand,input:unknown,run:(tx:PoolClient)=>Promise<T>,replay?:(tx:PoolClient,result:T)=>Promise<T>) {
  requireScope(actor,"records."+action,resource);z.uuid().parse(meta.operationId);z.string().regex(/^[a-f0-9]{64}$/).parse(meta.requestHash);
  const hash=requestHash("RECORDS-COMMAND",action,{resource,role:actor.role,input,transportHash:meta.requestHash});
  const tx=await pool.connect();
  try{
    await tx.query("BEGIN");await membership(tx,actor);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["records-command:"+actor.authId+":"+meta.operationId]);
    const old=(await tx.query<{action:string;resourceId:string;requestHash:string;status:string;result:T}>(
      'SELECT * FROM command_operations WHERE "actorId"=$1 AND "operationId"=$2',[actor.authId,meta.operationId])).rows[0];
    if(old){if(old.action!==action||old.resourceId!==resource||old.requestHash!==hash)recordsDenied(409,"COMMAND_REPLAY_CONFLICT");
      if(old.status!=="completed")recordsDenied(409,"COMMAND_PENDING");const result=replay?await replay(tx,old.result):old.result;await tx.query("COMMIT");return result;}
    const result=await run(tx);
    await tx.query(`INSERT INTO command_operations (id,"actorId","operationId",action,"resourceId","requestHash",status,result,"createdAt","updatedAt")
      VALUES($1,$2,$3,$4,$5,$6,'completed',$7::jsonb,NOW(),NOW())`,[randomUUID(),actor.authId,meta.operationId,action,resource,hash,JSON.stringify(result)]);
    await tx.query("COMMIT");return result;
  }catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}
}
