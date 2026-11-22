import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { disputesEnabled, nativeEvent, receiveNativeEvent } from './native-dispute.js';
import { verifiedDisputeEvidence } from './dispute-evidence.js';
import { reconcileExternalDisputeRefund } from '../payment/dispute-refund.js';
import type { AppointmentOwners } from './appointment-contracts.js';
import { trustedInternalOrigin } from '../../infrastructure/private-transport.js';
import { DomainError } from '../../contracts/actor.js';

export async function traceGateway(action:string,body:unknown,correlationId:string){
  if(!['intake','evidence','response','progress'].includes(action))throw new Error('DISPUTE_ROUTE_DENIED');
  const base=new URL(process.env.VITAL_TRACE_GATEWAY_URL??'');
  if(!trustedInternalOrigin(base)||base.username||base.password||base.pathname!=='/'||base.search||base.hash||!process.env.GATEWAY_VITAL_DISPUTE_KEY)throw new Error('DISPUTE_CONFIG_REQUIRED');
  const response=await fetch(new URL('/trace/api/integrations/v1/vital-disputes/'+action,base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
    headers:{'Content-Type':'application/json','X-Dispute-Service-Key':process.env.GATEWAY_VITAL_DISPUTE_KEY,'X-Correlation-ID':correlationId},body:JSON.stringify(body)});
  if(!response.ok)throw new Error('DISPUTE_DELIVERY_FAILED');
  const text=await response.text();if(Buffer.byteLength(text)>1048576)throw new Error('DISPUTE_RESPONSE_LIMIT');
  return z.object({success:z.literal(true),data:z.record(z.string(),z.unknown())}).parse(JSON.parse(text)).data;
}
const actor=(reportId:string,correlationId:string)=>({authId:z.uuid().parse(process.env.VITAL_TRACE_SERVICE_ACTOR_ID),role:'service' as const,serviceId:'vital-web' as const,scopes:['trace-disputes.receive'],resource:reportId,correlationId,isSuperAdmin:false});
export async function deliverNativeDisputes(core:Pool,integrations:Pool,owners:AppointmentOwners={}){
  if(!disputesEnabled())return;
  const lease=randomUUID();
  const rows=(await core.query(`WITH due AS (SELECT id FROM trace_dispute_deliveries WHERE (status='pending' AND "nextAttemptAt"<=now() OR status='processing' AND "leaseUntil"<now())
    ORDER BY "createdAt",id LIMIT 4 FOR UPDATE SKIP LOCKED) UPDATE trace_dispute_deliveries d SET status='processing',"leaseOwner"=$1,"leaseUntil"=now()+interval '10 minutes'
    FROM due WHERE d.id=due.id RETURNING d.*`,[lease])).rows;
  for(const row of rows){try{
    let result:Record<string,unknown>;
    if(row.kind==='refund-reconcile'){result=await reconcileExternalDisputeRefund(core,integrations,row.payload);}
    else if(row.kind==='intake'){
      const files=row.payload.evidence.length?await verifiedDisputeEvidence(core,row.reportId,row.correlationId):[];
      result=await traceGateway('intake',row.payload,row.correlationId);
      const caseId=z.uuid().parse(result.case_id);
      // The owner links only the report that the worker actually submitted.
      await core.query(`UPDATE appointment_disputes SET "traceCaseId"=$2,"traceDisputeSeq"=$3,"deliveryStatus"='transferring_evidence' WHERE id=$1 AND ("traceCaseId" IS NULL OR "traceCaseId"=$2)`,[row.reportId,caseId,result.dispute_seq??null]);
      for(const file of files)await traceGateway('evidence',{contract_version:1,report_id:row.reportId,case_id:caseId,...file},row.correlationId);
      await core.query(`UPDATE appointment_disputes SET "deliveryStatus"='delivered' WHERE id=$1`,[row.reportId]);
    }else result=await traceGateway(row.kind,row.payload,row.correlationId);
    if(result.event){await receiveNativeEvent(core,actor(row.reportId,row.correlationId),nativeEvent.parse(result.event),Date.now,owners);}
    await core.query(`UPDATE trace_dispute_deliveries SET status='delivered',result=$3::jsonb,"leaseUntil"=NULL,"leaseOwner"=NULL WHERE id=$1 AND "leaseOwner"=$2`,[row.id,lease,JSON.stringify(result)]);
  }catch(error){
    if(error instanceof DomainError&&[403,409,422].includes(error.status)){
      await core.query(`INSERT INTO trace_dispute_reviews(id,"reportId","decisionId",reason) SELECT $1,id,"decisionId",$3 FROM appointment_disputes WHERE id=$2 ON CONFLICT DO NOTHING`,[randomUUID(),row.reportId,error.code]);
      await core.query(`UPDATE trace_dispute_deliveries SET status='admin_review',"leaseOwner"=NULL,"leaseUntil"=NULL WHERE id=$1 AND "leaseOwner"=$2`,[row.id,lease]);
      continue;
    }
    await core.query(`UPDATE trace_dispute_deliveries SET status='pending',attempts=attempts+1,"nextAttemptAt"=now()+make_interval(secs=>LEAST(900,power(2,LEAST(attempts+1,9)))::int),"leaseOwner"=NULL,"leaseUntil"=NULL WHERE id=$1 AND "leaseOwner"=$2`,[row.id,lease]);
  }}
}
export async function reconcileNativeDisputes(core:Pool,owners:AppointmentOwners={}){
  if(!disputesEnabled())return;
  const reports=(await core.query(`SELECT * FROM appointment_disputes WHERE "reporterAuthId" IS NOT NULL AND "traceCaseId" IS NOT NULL AND "deliveryStatus"='delivered'
    ORDER BY "updatedAt" LIMIT 20`)).rows;
  for(const report of reports){try{
    const correlationId=randomUUID(),result=await traceGateway('progress',{contract_version:1,report_id:report.id,case_id:report.traceCaseId,appointment_id:report.appointmentId,reporter_auth_id:report.reporterAuthId},correlationId);
    if(result.event)await receiveNativeEvent(core,actor(report.id,correlationId),result.event,Date.now,owners);
    await core.query('UPDATE appointment_disputes SET "updatedAt"=now() WHERE id=$1',[report.id]);
  }catch{ /* Hold and owner state remain intact until reconciliation succeeds. */ }}
}
