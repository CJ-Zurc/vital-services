import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import type { Actor } from '../src/eda/contracts/actor.js';
import { DomainError } from '../src/eda/contracts/actor.js';
import { createVideoAuthority } from '../src/eda/modules/video/authority.js';
import { consumeVideoWorkflow,consumeVideoFact } from '../src/eda/workers/video.js';
import { makeEvent } from '../src/eda/infrastructure/outbox.js';

function fixture(){const doctorId=randomUUID(),doctorAuthId=randomUUID(),patientId=randomUUID(),patientAuthId=randomUUID(),appointmentId=randomUUID(),workflowId=randomUUID();
  const row={id:appointmentId,doctorId,doctorAuthId,patientId,patientAuthId,version:0,status:'pending',consultationType:'virtual',sourceAppointmentId:null,billingLineageId:randomUUID(),associationVersion:1,
    scheduledAt:new Date(Date.now()+3600000),proposedEndAt:new Date(Date.now()+7200000),slotEndsAt:null};
  const receipt={workflowId,sourceAppointmentId:appointmentId,targetAppointmentId:appointmentId,expectedSourceVersion:0,expectedTargetVersion:0,billingLineageId:row.billingLineageId,associationVersion:1,selectionHash:'a'.repeat(64),resourceId:randomUUID(),resourceVersion:0,freezeToken:randomUUID()};
  const workflow={id:workflowId,appointmentId,targetAppointmentId:appointmentId,actorAuthId:doctorAuthId,kind:'approve',state:'prepared',expectedVersion:0,videoTargetVersion:0,videoSelectionHash:'a'.repeat(64),videoReceipt:receipt,receipt:null as unknown,videoProcessingState:'prepared',expiresAt:new Date(Date.now()+300000),externalStartedAt:null,videoCorrelationId:randomUUID()};
  let revoked=false,proposal=false;const statements:string[]=[],writes:any[]=[];const pointer={videoResourceId:null as string|null,videoResourceVersion:null as number|null};
  const query=async(sql:string,a:any[]=[]):Promise<{rows:any[];rowCount:number}>=>{statements.push(sql);const result=(rows:any[]=[],rowCount=rows.length)=>({rows,rowCount});
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.includes('pg_advisory_xact_lock'))return result();
    if(sql.includes('SELECT p.* FROM vital_')){const own=sql.includes('vital_doctors')?doctorAuthId:patientAuthId;return result(!revoked&&a[0]===own?[{userId:sql.includes('vital_doctors')?doctorId:patientId}]:[]);}
    if(sql.includes('SELECT d."userId" FROM vital_doctors'))return result(!revoked&&a[0]===doctorAuthId&&a[1]===doctorId?[{userId:doctorId}]:[]);
    if(sql.includes('SELECT a.*'))return result(a[0]===appointmentId?[structuredClone(row)]:[]);
    if(sql.includes('FROM consultations'))return result([structuredClone(pointer)]);
    if(sql.includes('FROM appointments WHERE "followUpOfAppointmentId"'))return result(proposal?[{id:randomUUID()}]:[]);
    if(sql.includes('FROM saga_operations'))return result();
    if(sql.includes('SELECT * FROM appointment_workflows'))return result(a[0]===workflowId?[structuredClone(workflow)]:[]);
    if(sql.startsWith('INSERT INTO consultations')){writes.push(a);Object.assign(pointer,{videoResourceId:a[2],videoResourceVersion:a[3]});return result([],1);}
    if(sql.startsWith('UPDATE appointment_workflows')){workflow.videoProcessingState='finalized';return result([],1);}
    throw new Error('UNEXPECTED_AUTHORITY_SQL:'+sql);
  };
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
  const actor:Actor={authId:doctorAuthId,role:'doctor',serviceId:'vital-web',scopes:[],resource:appointmentId,correlationId:randomUUID(),isSuperAdmin:false};
  return{authority:createVideoAuthority(pool),actor,receipt,workflow,row,statements,writes,pointer,revoked:()=>{revoked=true;},followUp:()=>{proposal=true;}};
}
const code=(name:string)=>(error:unknown)=>error instanceof DomainError&&error.code===name;
test('EDA Video Core authority independently distinguishes Auth UUID doctor marker and appointment owner',async()=>{
  const f=fixture();assert.deepEqual(await f.authority.doctor(f.actor),{doctorId:f.row.doctorId});
  await assert.rejects(f.authority.doctor({...f.actor,authId:f.row.doctorId}),code('APPOINTMENT_MEMBERSHIP_REVOKED'));
  await assert.rejects(f.authority.appointment({...f.actor,role:'patient',authId:f.row.patientAuthId},randomUUID()),code('APPOINTMENT_NOT_FOUND'));
  f.revoked();await assert.rejects(f.authority.doctor(f.actor),code('APPOINTMENT_MEMBERSHIP_REVOKED'));assert.equal(f.writes.length,0);
});
test('EDA Video Core generation eligibility enforces purpose lifecycle expiry proposal and stable lineage',async()=>{
  const f=fixture();assert.equal((await f.authority.generation(f.actor,f.row.id,'approval')).billingLineageId,f.row.billingLineageId);
  f.row.status='approved';await assert.rejects(f.authority.generation(f.actor,f.row.id,'approval'),code('VIDEO_GENERATION_INELIGIBLE'));
  f.row.status='completed';assert.equal((await f.authority.generation(f.actor,f.row.id,'follow_up')).id,f.row.id);
  f.followUp();await assert.rejects(f.authority.generation(f.actor,f.row.id,'follow_up'),code('VIDEO_GENERATION_INELIGIBLE'));assert.equal(f.writes.length,0);
});
test('EDA Video workflow reads enforce current revisions and cannot mutate or release expired external preparation',async()=>{
  const f=fixture();f.workflow.expiresAt=new Date(0);f.workflow.externalStartedAt=new Date() as any;
  assert.equal((await f.authority.workflow(f.workflow.id)).state,'prepared');assert.ok(f.statements.every(sql=>!sql.startsWith('UPDATE')));
  f.row.version++;await assert.rejects(f.authority.workflow(f.workflow.id),code('VIDEO_WORKFLOW_PREPARATION_STALE'));
});
test('EDA Video Core finalization validates durable receipt and preserves consultation history on replay',async()=>{
  const f=fixture();f.workflow.state='committed';f.workflow.receipt={ehrCaseId:randomUUID()};f.row.status='approved';f.row.version=1;
  await assert.rejects(f.authority.completeWorkflow(f.workflow.id,{...f.receipt,resourceId:randomUUID()}),code('VIDEO_WORKFLOW_RECEIPT_INVALID'));assert.equal(f.writes.length,0);
  await f.authority.completeWorkflow(f.workflow.id,f.receipt);assert.equal(f.pointer.videoResourceId,f.receipt.resourceId);assert.equal(f.pointer.videoResourceVersion,1);assert.equal(f.workflow.videoProcessingState,'finalized');
  f.row.version=2;f.row.status='confirmed';await f.authority.completeWorkflow(f.workflow.id,f.receipt);assert.equal(f.writes.length,1);
  assert.ok(f.statements.every(sql=>!sql.startsWith('UPDATE appointments')));
});
test('EDA Video worker verifies committed source evidence deduplicates and persists wake before ACK',async()=>{
  const appointmentId=randomUUID();const event=makeEvent({producer:'appointment',eventType:'vital.video.workflow.finalization.requested',aggregateId:appointmentId,aggregateVersion:1,correlationId:randomUUID(),data:{workflowId:randomUUID(),appointmentId,appointmentVersion:1,operationId:randomUUID()}});
  let seen=false,wakes=0,commits=0;const query=async(sql:string)=>{if(sql.startsWith('INSERT INTO inbox_events')){const fresh=!seen;seen=true;return{rows:[],rowCount:fresh?1:0};}
    if(sql.startsWith('SELECT "eventType"'))return{rows:[{eventType:event.eventType,aggregateId:event.aggregateId,aggregateVersion:event.aggregateVersion,payload:event.data}],rowCount:1};
    if(sql.startsWith('SELECT state'))return{rows:[{state:'committed',targetAppointmentId:event.data.appointmentId,commitOperationId:event.data.operationId,videoReceipt:{resourceId:randomUUID()}}],rowCount:1};
    if(sql.startsWith('UPDATE appointment_workflows'))wakes++;if(sql==='COMMIT')commits++;return{rows:[],rowCount:0};};
  const pool={connect:async()=>({query,release(){}})} as unknown as Pool;
  await consumeVideoWorkflow(pool,event);await consumeVideoWorkflow(pool,event);assert.equal(wakes,1);assert.equal(commits,2);
  await assert.rejects(consumeVideoFact(pool,event),/SUBSCRIPTION_MISMATCH/);
});
