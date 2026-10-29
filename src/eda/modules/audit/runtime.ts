import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool,PoolClient } from 'pg';
import { DomainError,requireScope,type Actor } from '../../contracts/actor.js';
import { appendSqlOutbox } from '../../infrastructure/outbox.js';
import type { AuditMetadata } from '../../contracts/audit.js';

export const adminAuditInput=z.object({event:z.enum(['viewed','export_requested','export_completed','export_failed']),
 resultCount:z.number().int().min(0).max(10000).optional()}).strict();

export async function securityIntent(tx:PoolClient,actor:Actor,type:'code_incorrect'|'code_locked'|'access_denied'|'throttled',
 resourceId:string|null=null,route?:string,method?:AuditMetadata['method'],entity:AuditMetadata['entity_type']='appointment'){
 await appendSqlOutbox(tx,{producer:'appointment',eventType:'vital.audit.requested',aggregateId:resourceId??actor.authId,aggregateVersion:0,
  correlationId:actor.correlationId,data:{auditType:'vital.security.'+type,actorAuthId:actor.authId,resourceId,resourceType:entity,
   auditMetadata:{actor_id:actor.authId,actor_type:'user',entity_type:entity,...(resourceId?{entity_id:resourceId}:{}),
    action:'verify',outcome:type==='code_incorrect'||type==='code_locked'?'failed':'denied',reason_category:'verification_failed',
    ...(route?{route}:{}),...(method?{method}:{})}}});
}

export function auditRuntime(pool:Pool){return{
 async boundary(actor:Actor,raw:unknown){
  requireScope(actor,'audit.security.write',actor.authId);
  if(!['admin','doctor','patient'].includes(actor.role))throw new DomainError(403,'AUDIT_ACTOR_REQUIRED','Verified VITAL actor required.');
  const input=z.object({route:z.enum(['/api/admin/audit-logs','/api/admin/audit-logs/export']),method:z.enum(['GET','POST'])}).strict().parse(raw);
  if(input.method!==(input.route.endsWith('/export')?'POST':'GET'))throw new DomainError(400,'AUDIT_ROUTE_INVALID','Invalid audit boundary.');
  const tx=await pool.connect();try{await tx.query('BEGIN');await securityIntent(tx,actor,'access_denied',null,input.route,input.method,'audit_history');await tx.query('COMMIT');}catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
  return{recorded:true};
 },
 async intent(actor:Actor,operationId:string,hash:string,raw:unknown){
  requireScope(actor,'audit.admin.write',actor.authId);
  if(actor.role!=='admin')throw new DomainError(403,'AUDIT_ADMIN_REQUIRED','VITAL administrator required.');
  z.uuid().parse(operationId);z.string().regex(/^[a-f0-9]{64}$/).parse(hash);
  const body=adminAuditInput.parse(raw),tx=await pool.connect();
  try{await tx.query('BEGIN');
   const member=await tx.query(`SELECT a."userId" FROM vital_admins a JOIN vital_users u ON u.id=a."userId" AND u."authId"=a."authId" WHERE a."authId"=$1`,[actor.authId]);
   if(!member.rows.length)throw new DomainError(403,'AUDIT_ADMIN_REVOKED','VITAL administrator required.');
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['audit:'+actor.authId+':'+operationId]);
   const old=(await tx.query('SELECT action,"resourceId","requestHash",result FROM command_operations WHERE "actorId"=$1 AND "operationId"=$2',[actor.authId,operationId])).rows[0];
   if(old){if(old.action!=='audit.intent'||old.resourceId!==actor.authId||old.requestHash!==hash)throw new DomainError(409,'COMMAND_REPLAY_CONFLICT','Audit request changed.');await tx.query('COMMIT');return old.result;}
   const result={recorded:true};
   await appendSqlOutbox(tx,{producer:'profile',eventType:'vital.audit.requested',aggregateId:actor.authId,aggregateVersion:0,
    correlationId:actor.correlationId,causationId:operationId,data:{auditType:'vital.audit.'+body.event,actorAuthId:actor.authId,resourceId:null,resourceType:'audit_history',
     auditMetadata:{actor_id:actor.authId,actor_type:'user',entity_type:'audit_history',action:body.event==='viewed'?'read':'export',
      outcome:body.event==='export_failed'?'failed':body.event==='export_requested'?'attempted':'success',
      ...(body.resultCount===undefined?{}:{result_count:body.resultCount})}}});
   await tx.query(`INSERT INTO command_operations(id,"actorId","operationId",action,"resourceId","requestHash",status,result,"createdAt","updatedAt") VALUES($1,$2,$3,'audit.intent',$2,$4,'completed',$5::jsonb,NOW(),NOW())`,[randomUUID(),actor.authId,operationId,hash,JSON.stringify(result)]);
   await tx.query('COMMIT');return result;
  }catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
 },
 async denied(actor:Actor,route:string,method:string,status:number){
  if((![401,403,423,429].includes(status)&&!([400,409].includes(status)&&/\/access(?:\/|$)/.test(route)))||!['GET','POST','PATCH','PUT','DELETE'].includes(method))return;
  const entity:AuditMetadata['entity_type']=route.includes('/records')?'document':route.includes('/messaging')?'message':route.includes('/profile')?'profile':route.includes('/video')?'video':route.includes('/payments')?'payment':route.includes('/audit')?'audit_history':'appointment';
  const tx=await pool.connect();try{await tx.query('BEGIN');await securityIntent(tx,actor,status===429?'throttled':status===423&&route.includes('/access')?'code_locked':'access_denied',null,route,method as AuditMetadata['method'],entity);await tx.query('COMMIT');}catch(e){await tx.query('ROLLBACK');throw e;}finally{tx.release();}
 }
};}
export type AuditRuntime=ReturnType<typeof auditRuntime>;
