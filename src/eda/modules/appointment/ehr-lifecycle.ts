import {appointmentPayloadCrypto} from './access-crypto.js';
import { randomUUID, createHash, createPublicKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { DomainError, requireScope, type Actor } from '../../contracts/actor.js';
import { boundedJsonReceipt } from '../../infrastructure/http-receipt.js';
import { trustedInternalOrigin } from '../../infrastructure/private-transport.js';
import {assertRecordsIdle,currentPaid} from '../records/authorization.js';
import { requireLiveAppointmentAccess } from './appointment-access.js';
import { membership, readAppointment, appointmentOwn, lockAppointment, appointmentTransition } from './appointment.js';
import type { AppointmentRow,AppointmentOwners } from './appointment-contracts.js';

type DB=Pick<PoolClient,'query'>;
type Binding={appointmentId:string;patientId:string;doctorAuthId:string;caseId:string};
type Action='readiness'|'diagnosis-read'|'diagnosis-save'|'close'|'follow-up-create'|'follow-up-cancel'|'operation-read';
const diagnosis=z.object({diagnosis_role:z.literal('discharge'),description:z.string().trim().min(1).max(5000),
  condition_id:z.uuid().nullable().optional(),certainty:z.enum(['provisional','confirmed','ruled_out']).nullable().optional(),notes:z.string().trim().max(5000).nullable().optional()}).strict();
const fail=(code:string,status=409):never=>{throw new DomainError(status,code,'Refresh the appointment and review its EHR status.');};
export function lifecycleStep(id:string,label:string){const h=createHash('sha256').update(id+':'+label).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);}
export function verifyReadiness(receipt:string,keys:Record<string,string>,binding:Binding){
  try{
    const header=jwt.decode(receipt,{complete:true})?.header;
    if(header?.alg!=='RS256'||!header.kid||!Object.hasOwn(keys,header.kid))throw Error('KEY');
    const key=createPublicKey(keys[header.kid]!);
    if(key.asymmetricKeyType!=='rsa'||(key.asymmetricKeyDetails?.modulusLength??0)<2048)throw Error('WEAK_KEY');
    const value=z.object({iss:z.literal('uhse-ehr'),aud:z.literal('vital-services.lifecycle'),iat:z.number().int(),exp:z.number().int(),
      appointmentId:z.uuid(),patientId:z.uuid(),doctorAuthId:z.uuid(),caseId:z.uuid(),diagnosisId:z.uuid()}).strict()
      .parse(jwt.verify(receipt,keys[header.kid]!,{algorithms:['RS256'],issuer:'uhse-ehr',audience:'vital-services.lifecycle'}));
    if(value.exp-value.iat>60||value.exp<=value.iat||value.iat>Math.floor(Date.now()/1000)||
      Object.entries(binding).some(([key,v])=>value[key as keyof Binding]!==v))throw Error('BINDING');
    return value.diagnosisId;
  }catch{fail('EHR_LIFECYCLE_EVIDENCE_INVALID',403);}
}
export function createEhrLifecycle(pool:Pool,config:{baseUrl:string;key:string;keys:Record<string,string>;financial?:AppointmentOwners['financial']},fetcher:typeof fetch=fetch){
  const base=new URL(config.baseUrl);
  if(!trustedInternalOrigin(base)||base.username||base.password||config.key.length<16||!Object.keys(config.keys).length)throw Error('EHR_LIFECYCLE_CONFIGURATION_INVALID');
  async function call(action:Action,binding:Binding,extra:Record<string,unknown>={}):Promise<Record<string,unknown>>{
    const payload:Record<string,unknown>={...binding,...extra};
    const correlationId=payload.correlationId;delete payload.correlationId;
    const response=await fetcher(new URL('/vital-integration/lifecycle/v1/'+action,base),{method:'POST',redirect:'error',
      headers:{'Content-Type':'application/json','X-Internal-Service':'vital-services','X-Internal-Service-Key':config.key,'X-Correlation-ID':typeof correlationId==='string'?correlationId:randomUUID()},
      body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)}).catch(()=>fail('EHR_LIFECYCLE_UNAVAILABLE',503));
    if(response.status===404&&action==='operation-read')fail('EHR_LIFECYCLE_RECEIPT_NOT_FOUND',404);
    if(!response.ok){
      const error=await boundedJsonReceipt(response).catch(()=>null) as {detail?:{code?:string}}|null;
      if(error?.detail?.code==='FOLLOW_UP_PENDING_EXISTS')fail('EHR_FOLLOW_UP_PENDING_EXISTS');
      fail(response.status>=500?'EHR_LIFECYCLE_UNAVAILABLE':'EHR_LIFECYCLE_CONFLICT',response.status>=500?503:409);
    }
    const closed=z.object({caseId:z.uuid(),appointmentId:z.uuid(),status:z.literal('closed'),closedAt:z.iso.datetime({offset:true}),diagnosisId:z.uuid()}).strict();
    const plan=z.object({followUpId:z.uuid(),sourceCaseId:z.uuid()}).strict(),saved=z.object({diagnosisId:z.uuid()}).strict(),cancelled=z.object({followUpId:z.uuid(),status:z.literal('cancelled')}).strict();
    const schema=action==='diagnosis-read'?z.object({diagnosis:z.object({id:z.uuid(),description:z.string().max(5000),condition_id:z.uuid().nullable(),certainty:z.enum(['provisional','confirmed','ruled_out']).nullable(),notes:z.string().max(5000).nullable()}).strict().nullable()}).strict():action==='diagnosis-save'?saved:action==='readiness'?z.object({ready:z.boolean(),diagnosisId:z.uuid().nullable(),receipt:z.string().max(8192).nullable()}).strict():action==='close'?closed:action==='follow-up-create'?plan:action==='follow-up-cancel'?cancelled:z.union([closed,plan,saved,cancelled]);
    try{return z.object({success:z.literal(true),data:schema}).strict().parse(await boundedJsonReceipt(response)).data;}
    catch{return fail('EHR_LIFECYCLE_UNAVAILABLE',503);}
  }
  async function binding(db:DB,row:AppointmentRow):Promise<Binding>{
    if(row.consultationType!=='virtual'||!row.ehrCaseId)fail('EHR_VIRTUAL_CASE_REQUIRED');
    const patient=(await db.query('SELECT "ehrPatientId" FROM vital_patients WHERE "userId"=$1',[row.patientId])).rows[0];
    if(!patient?.ehrPatientId)fail('EHR_PATIENT_LINK_REQUIRED');
    // Reschedules retain the original case reference. Find its originating episode.
    const origin=(await db.query(`WITH RECURSIVE chain AS (
      SELECT id,"sourceAppointmentId",0 AS depth FROM appointments WHERE id=$1
      UNION ALL SELECT a.id,a."sourceAppointmentId",c.depth+1 FROM appointments a JOIN chain c ON a.id=c."sourceAppointmentId" WHERE c.depth<100)
      SELECT id,"sourceAppointmentId" FROM chain ORDER BY depth DESC LIMIT 1`,[row.id])).rows[0];
    if(!origin||origin.sourceAppointmentId)fail('EHR_CASE_ORIGIN_INVALID');
    return{appointmentId:origin?.id??row.id,caseId:row.ehrCaseId!,patientId:patient.ehrPatientId,doctorAuthId:row.doctorAuthId};
  }
  async function ready(db:DB,row:AppointmentRow){
    const b=await binding(db,row),result=await call('readiness',b);
    if(result.ready!==true||typeof result.receipt!=='string')fail('EHR_FINAL_DIAGNOSIS_REQUIRED');
    const prior=(await db.query('SELECT "diagnosisId" FROM appointment_ehr_lifecycle WHERE "appointmentId"=$1',[row.id])).rows[0];
    const diagnosisId=verifyReadiness(z.string().parse(result.receipt),config.keys,b);
    if(row.doctorConfirmedAt&&prior?.diagnosisId&&prior.diagnosisId!==diagnosisId)fail('EHR_FINAL_DIAGNOSIS_CHANGED');
    if(result.diagnosisId!==diagnosisId)fail('EHR_LIFECYCLE_EVIDENCE_INVALID',403);
    await db.query(`INSERT INTO appointment_ehr_lifecycle("appointmentId","diagnosisId",state) VALUES($1,$2,'ready')
      ON CONFLICT("appointmentId") DO UPDATE SET "diagnosisId"=EXCLUDED."diagnosisId","updatedAt"=NOW() WHERE appointment_ehr_lifecycle.state='ready'`,[row.id,diagnosisId]);
    return diagnosisId;
  }
  async function enqueue(db:DB,row:AppointmentRow){
    if(row.consultationType!=='virtual')return;
    const b=await binding(db,row),record=(await db.query('SELECT "diagnosisId" FROM appointment_ehr_lifecycle WHERE "appointmentId"=$1',[row.id])).rows[0];
    if(!record?.diagnosisId)fail('EHR_FINAL_DIAGNOSIS_REQUIRED');
    const completed=(await db.query('SELECT status,version,"completedAt" FROM appointments WHERE id=$1',[row.id])).rows[0];
    if(completed?.status!=='completed'||!completed.completedAt)fail('EHR_COMPLETION_REQUIRED');
    const payload={...b,operationId:lifecycleStep(row.id,'close'),expectedDiagnosisId:record.diagnosisId,
      completedVersion:completed.version,completedAt:new Date(completed.completedAt).toISOString()};
    await db.query(`UPDATE appointment_ehr_lifecycle SET state='pending',payload=$2::jsonb,"availableAt"=NOW(),"updatedAt"=NOW() WHERE "appointmentId"=$1 AND state='ready'`,[row.id,JSON.stringify(payload)]);
  }
  async function status(actor:Actor,id:string){
    requireScope(actor,'appointments.ehr.read',id);await membership(pool,actor);const row=await readAppointment(pool,id);appointmentOwn(actor,row);
    if(row.consultationType!=='virtual')return{enabled:false};
    const state=(await pool.query('SELECT state,"diagnosisId","lastError","syncedAt" FROM appointment_ehr_lifecycle WHERE "appointmentId"=$1',[id])).rows[0];
    const canWrite=actor.role==='doctor'&&!row.reviewHold&&await import('./appointment-access.js').then(m=>m.hasLiveAppointmentAccess(pool,row));
    return{enabled:true,state:state?.state??'not_ready',diagnosisReady:!!state?.diagnosisId,lastError:state?.lastError??null,
      syncedAt:state?.syncedAt?.toISOString()??null,canWrite};
  }
  async function clinical(actor:Actor,id:string,raw:unknown,operationId?:string){
    requireScope(actor,operationId?'appointments.ehr.write':'appointments.ehr.read',id);await membership(pool,actor,'doctor');
    const tx=await pool.connect();try{await tx.query('BEGIN');const row=await lockAppointment(tx,id);appointmentOwn(actor,row);await requireLiveAppointmentAccess(tx,row);
      if(row.reviewHold)fail('APPOINTMENT_UNDER_DISPUTE_HOLD');await assertRecordsIdle(tx,row);await currentPaid(tx,row,config.financial);
      const b=await binding(tx,row);
      if(!operationId){const value=await call('diagnosis-read',b,{correlationId:actor.correlationId});await tx.query('COMMIT');return value;}
      const input=z.object({expectedVersion:z.number().int().nonnegative(),expectedDiagnosisId:z.uuid().nullable(),diagnosis}).strict().parse(raw);
      if(input.expectedVersion!==row.version)fail('APPOINTMENT_VERSION_CHANGED');
      const result=await call('diagnosis-save',b,{correlationId:actor.correlationId,operationId:z.uuid().parse(operationId),expectedDiagnosisId:input.expectedDiagnosisId,diagnosis:input.diagnosis});
      await ready(tx,row);await tx.query('COMMIT');return result;
    }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
  }
  async function checkReady(actor:Actor,id:string,raw:unknown){
    requireScope(actor,'appointments.ehr.write',id);await membership(pool,actor,'doctor');
    const input=z.object({expectedVersion:z.number().int().nonnegative()}).strict().parse(raw);
    const tx=await pool.connect();try{await tx.query('BEGIN');const row=await lockAppointment(tx,id);appointmentOwn(actor,row);await requireLiveAppointmentAccess(tx,row);
      if(row.version!==input.expectedVersion)fail('APPOINTMENT_VERSION_CHANGED');
      const diagnosisId=await ready(tx,row);await tx.query('COMMIT');return{ready:true,diagnosisId};
    }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
  }
  async function deliver(){
    const rows=(await pool.query(`WITH due AS (SELECT "appointmentId" FROM appointment_ehr_lifecycle WHERE state='pending' AND "availableAt"<=NOW() ORDER BY "availableAt" LIMIT 10 FOR UPDATE SKIP LOCKED)
      UPDATE appointment_ehr_lifecycle l SET "availableAt"=NOW()+INTERVAL '60 seconds',attempts=attempts+1 FROM due WHERE l."appointmentId"=due."appointmentId" RETURNING l.*`)).rows;
    for(const row of rows){try{
      const p=row.payload as Binding&{operationId:string;expectedDiagnosisId:string};const result=await call('close',p);
      if(result.caseId!==p.caseId||result.appointmentId!==p.appointmentId||result.diagnosisId!==p.expectedDiagnosisId||result.status!=='closed'||!z.iso.datetime({offset:true}).safeParse(result.closedAt).success)fail('EHR_CLOSURE_RECEIPT_INVALID');
      await pool.query(`UPDATE appointment_ehr_lifecycle SET state='synced',receipt=$2::jsonb,"syncedAt"=NOW(),"lastError"=NULL,"updatedAt"=NOW() WHERE "appointmentId"=$1 AND state='pending'`,[row.appointmentId,JSON.stringify(result)]);
    }catch(error){const code=error instanceof DomainError?error.code:'EHR_LIFECYCLE_UNAVAILABLE',terminal=code!=='EHR_LIFECYCLE_UNAVAILABLE'||row.attempts>=12;
      await pool.query(`UPDATE appointment_ehr_lifecycle SET state=$2,"lastError"=$3,"availableAt"=NOW()+($4*INTERVAL '1 second'),"updatedAt"=NOW() WHERE "appointmentId"=$1 AND state='pending'`,[row.appointmentId,terminal?'needs_attention':'pending',code,Math.min(3600,30*2**Math.min(row.attempts,7))]);
    }}return rows.length;
  }
  async function abandonExpired(){
    const candidates=(await pool.query(`SELECT id FROM appointment_workflows WHERE kind='follow-up' AND state='prepared' AND "externalStartedAt" IS NULL AND "expiresAt"<NOW() ORDER BY "expiresAt" LIMIT 10`)).rows;
    for(const item of candidates){const tx=await pool.connect();try{await tx.query('BEGIN');
      const w=(await tx.query(`SELECT * FROM appointment_workflows WHERE id=$1::uuid AND state='prepared' AND "externalStartedAt" IS NULL AND "expiresAt"<NOW() FOR UPDATE`,[item.id])).rows[0];
      if(!w){await tx.query('COMMIT');continue;}
      const source=await readAppointment(tx,w.appointmentId),b=await binding(tx,source);
      let plan=w.ehrFollowUpId;
      if(!plan&&w.ehrPlanStartedAt){
        const child=await readAppointment(tx,w.targetAppointmentId);
        // Finish the durable, same-ID plan operation before compensating it. This
        // resolves a lost response without racing an in-flight plan creation.
        plan=await followUp(source,w.id,child.scheduledAt,w.ehrFollowUpInstructions);
      }
      if(plan)await call('follow-up-cancel',b,{operationId:lifecycleStep(w.id,'cancel-follow-up'),followUpId:plan});
      await tx.query(`UPDATE appointment_workflows SET state='abandoned',"updatedAt"=NOW() WHERE id=$1::uuid`,[w.id]);
      if(w.targetAppointmentId&&w.targetAppointmentId!==source.id){const child=await lockAppointment(tx,w.targetAppointmentId);if(child.status==='pending')await appointmentTransition(tx,child,'rejected',null,lifecycleStep(w.id,'abandon'),randomUUID(),'workflow_abandoned');}
      await tx.query('COMMIT');
    }catch{await tx.query('ROLLBACK');}finally{tx.release();}}
  }
  async function retry(actor:Actor,id:string){
    requireScope(actor,'appointments.ehr.write',id);await membership(pool,actor,'doctor');const row=await readAppointment(pool,id);appointmentOwn(actor,row);
    if(row.status!=='completed'||row.consultationType!=='virtual')fail('EHR_COMPLETION_REQUIRED');
    await pool.query(`UPDATE appointment_ehr_lifecycle SET state='pending',attempts=0,"availableAt"=NOW(),"updatedAt"=NOW() WHERE "appointmentId"=$1 AND state='needs_attention'`,[id]);
    return{state:'pending'};
  }
  async function cancelFollowUp(row:AppointmentRow,workflowId:string,followUpId:string){
    const b=await binding(pool,row);
    await call('follow-up-cancel',b,{operationId:lifecycleStep(workflowId,'cancel-follow-up'),followUpId});
  }
  async function requireClosedSource(db:DB,row:AppointmentRow){
    const state=(await db.query('SELECT state FROM appointment_ehr_lifecycle WHERE "appointmentId"=$1',[row.id])).rows[0];
    if(row.status!=='completed'||row.consultationType!=='virtual'||state?.state!=='synced')fail('EHR_SOURCE_CLOSURE_PENDING');
  }
  async function followUp(row:AppointmentRow,operationId:string,targetAt:Date,protectedInstructions?:unknown){
    await requireClosedSource(pool,row);
    const b=await binding(pool,row),dueOn=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(targetAt);
    const instructions=protectedInstructions?z.string().max(4000).parse(appointmentPayloadCrypto().decrypt(protectedInstructions,'ehr-follow-up:'+operationId)):undefined;
    const result=await call('follow-up-create',b,{operationId:lifecycleStep(operationId,'follow-up-plan'),dueOn,...(instructions?{instructions}:{})});
    return z.uuid().parse(result.followUpId);
  }
  return{ready,enqueue,status,clinical,checkReady,deliver,followUp,retry,cancelFollowUp,abandonExpired,requireClosedSource};
}
export type EhrLifecycle=ReturnType<typeof createEhrLifecycle>;
