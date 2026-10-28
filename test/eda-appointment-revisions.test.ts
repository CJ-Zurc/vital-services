import { accessFixtureSql } from './fixtures/appointment-access.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../src/eda/contracts/actor.js';
import { selectedBlockDates, previewDateBlocks, saveDateBlocks } from '../src/eda/modules/appointment/appointment-date-blocks.js';
import { complaintEditable, updateComplaint, complaintHistory } from '../src/eda/modules/appointment/appointment-clinical.js';
import { rescheduleAllowed, type AppointmentRow } from '../src/eda/modules/appointment/appointment-contracts.js';
import { complaintSchema } from '../src/eda/modules/appointment/appointment-intake.js';

const now=Date.parse('2026-10-21T00:00:00Z');
test('S6 booking complaints remain optional and bounded',()=>{
  for(const value of [undefined,null,'','   '])assert.equal(complaintSchema.parse(value),null);
  assert.equal(complaintSchema.parse(' headache '),'headache');
  assert.throws(()=>complaintSchema.parse('x'.repeat(2001)));
});
test('S6 date selection includes endpoints deduplicates custom dates and bounds calendar days',()=>{
  assert.deepEqual(selectedBlockDates({mode:'range',startDate:'2026-10-31',endDate:'2026-11-02'},now),['2026-10-31','2026-11-01','2026-11-02']);
  assert.deepEqual(selectedBlockDates({mode:'custom',dates:['2026-12-01','2026-11-01','2026-12-01']},now),['2026-11-01','2026-12-01']);
  assert.throws(()=>selectedBlockDates({mode:'range',startDate:'2026-11-01',endDate:'2027-11-02'},now));
  assert.deepEqual(selectedBlockDates({mode:'custom',dates:Array(101).fill('2026-11-01')},now),['2026-11-01']);
  assert.throws(()=>selectedBlockDates({mode:'custom',dates:[]},now));
  assert.throws(()=>selectedBlockDates({mode:'custom',dates:['2026-02-30']},now));
  assert.throws(()=>selectedBlockDates({mode:'custom',dates:Array.from({length:101},(_,i)=>new Date(now+(i+1)*86400000).toISOString().slice(0,10))},now));
});
test('S6 reschedule allowances preserve historical usage and enforce role plus combined limits',()=>{
  assert.equal(rescheduleAllowed({patientRescheduleCount:1,doctorRescheduleCount:0},'patient'),false);
  assert.equal(rescheduleAllowed({patientRescheduleCount:0,doctorRescheduleCount:2},'doctor'),true);
  assert.equal(rescheduleAllowed({patientRescheduleCount:0,doctorRescheduleCount:3},'doctor'),false);
  assert.equal(rescheduleAllowed({patientRescheduleCount:2,doctorRescheduleCount:2},'doctor'),false);
  assert.equal(rescheduleAllowed({patientRescheduleCount:2,doctorRescheduleCount:1},'doctor'),true);
});

function clinicalFixture(){
  const id=randomUUID(),doctorId=randomUUID(),patientId=randomUUID(),doctorAuthId=randomUUID(),patientAuthId=randomUUID();
  const row={id,doctorId,patientId,doctorAuthId,patientAuthId,status:'confirmed',version:0,billingLineageId:randomUUID(),scheduledAt:new Date(now+3600000),proposedEndAt:new Date(now+7200000),paperworkLockedAt:null,doctorConfirmedAt:null} as AppointmentRow;
  const actor:Actor={authId:doctorAuthId,role:'doctor',resource:id,scopes:['appointments.intake.read','appointments.intake.write'],serviceId:'vital-web',isSuperAdmin:false,correlationId:randomUUID()};
  let current:string|null=null,processing=false,command:any=null;
  const history:any[]=[],events:any[]=[],calls:{sql:string;args:unknown[]}[]=[];
  const tx={async query(sql:string,args:unknown[]=[]){calls.push({sql,args});
    const privacy=accessFixtureSql(sql,args,row);if(privacy)return privacy;
    if(sql.includes('SELECT p.* FROM vital_'))return{rows:[{userId:actor.role==='doctor'?doctorId:patientId}]};
    if(sql.includes('SELECT a.*'))return{rows:[row]};
    if(sql.includes('SELECT * FROM command_operations'))return{rows:command?[command]:[]};
    if(sql.includes('pg_advisory_xact_lock'))return{rows:[]};
    if(sql.startsWith('SELECT "chiefComplaint"'))return{rows:[{chiefComplaint:current}]};
    if(sql.includes('FROM chief_complaint_history'))return{rows:history};
    if(sql.includes('FROM appointment_workflows'))return{rows:processing?[{id}]:[]};
    if(sql.startsWith('INSERT INTO pre_consultations')){current=String(args[2]);return{rows:[]};}
    if(sql.startsWith('UPDATE appointments SET version'))return{rows:[]};
    if(sql.startsWith('INSERT INTO chief_complaint_history')){history.push({id:args[0],previousText:args[2],currentText:args[3],doctorAuthId:args[4],appointmentVersion:args[5],changedAt:args[6]});return{rows:[]};}
    if(sql.startsWith('INSERT INTO command_operations')){command={action:'appointment.complaint',resourceId:id,requestHash:args[4],status:'completed',result:JSON.parse(String(args[5]))};return{rows:[]};}
    if(sql.startsWith('INSERT INTO outbox_events')){events.push(JSON.parse(String(args[8])));return{rows:[]};}
    throw new Error('Unhandled clinical SQL:'+sql);
  }} as unknown as PoolClient;
  return{tx,row,actor,history,events,calls,id,processing:()=>{processing=true;}};
}
test('S6 complaint corrections preserve original text history version and private audit references',async()=>{
  const f=clinicalFixture(),meta={operationId:randomUUID(),requestHash:'a'.repeat(64)},input={expectedVersion:0,chiefComplaint:'Private correction'};
  const first=await updateComplaint(f.tx,f.actor,f.id,meta,input,now);
  assert.deepEqual(first,{appointmentId:f.id,version:1});
  assert.equal(f.history.length,1);assert.equal(f.history[0].previousText,null);assert.equal(f.history[0].currentText,input.chiefComplaint);
  assert.deepEqual(await updateComplaint(f.tx,f.actor,f.id,meta,input,now),first);assert.equal(f.history.length,1);
  assert.doesNotMatch(JSON.stringify(f.events),/Private correction/);
  assert.equal(f.calls.some(call=>/UPDATE.*opqrst|ehr_/i.test(call.sql)),false);
  const patient={...f.actor,authId:f.row.patientAuthId,role:'patient' as const};
  assert.equal((await complaintHistory(f.tx,patient,f.id,{},now)).canEdit,false);
  await assert.rejects(updateComplaint(f.tx,patient,f.id,meta,input,now),{code:'APPOINTMENT_DOCTOR_REQUIRED'});
});
test('S6 complaint corrections deny another doctor stale versions workflows and paperwork locks',async()=>{
  const meta=()=>({operationId:randomUUID(),requestHash:'a'.repeat(64)}),input={expectedVersion:0,chiefComplaint:'Correction'};
  const f=clinicalFixture();await assert.rejects(updateComplaint(f.tx,{...f.actor,authId:randomUUID()},f.id,meta(),input,now),{code:'APPOINTMENT_OWNER_DENIED'});
  await assert.rejects(updateComplaint(f.tx,f.actor,f.id,meta(),{...input,expectedVersion:1},now),{code:'COMPLAINT_EDIT_CLOSED'});
  f.processing();await assert.rejects(updateComplaint(f.tx,f.actor,f.id,meta(),input,now),{code:'APPOINTMENT_PROCESSING'});
  for(const status of ['completed','cancelled','rescheduled'])assert.equal(complaintEditable({...f.row,status},now),false);
  assert.equal(complaintEditable({...f.row,paperworkLockedAt:new Date(now)},now),false);
  assert.equal(complaintEditable({...f.row,status:'pending',sourceAppointmentId:randomUUID()},now),false);
  assert.equal(complaintEditable(f.row,now+2*86400000),false);
  assert.equal(f.history.length,0);
});

test('S6 calendar batch rejects stale previews or reservations before writes and replays one atomic save',async()=>{
  const authId=randomUUID(),doctorId=randomUUID();let appointments:any[]=[],holds:any[]=[],writes=0,command:any=null;
  const actor:Actor={authId,role:'doctor',resource:authId,scopes:['appointments.blocks.read','appointments.blocks.write'],serviceId:'vital-web',isSuperAdmin:false,correlationId:randomUUID()};
  const query=async(sql:string,args:unknown[]=[])=>{
    if(sql.includes('SELECT p.* FROM vital_'))return{rows:[{userId:doctorId}]};
    if(sql.startsWith('SELECT * FROM command_operations'))return{rows:command?[command]:[]};
    if(sql.includes('FROM doctor_date_blocks'))return{rows:[]};
    if(sql.includes('FROM appointments a'))return{rows:appointments};
    if(sql.includes('FROM slot_reservations'))return{rows:holds};
    if(sql.startsWith('INSERT INTO doctor_date_blocks'))writes++;
    if(sql.startsWith('INSERT INTO command_operations'))command={action:args[3],resourceId:args[4],requestHash:args[5],status:'completed',result:JSON.parse(String(args[6]))};
    return{rows:[],rowCount:1};
  };
  const pool={connect:async()=>({query,release(){}})} as unknown as Pool;
  const selection={mode:'custom',dates:['2026-11-01','2026-11-03']},meta={operationId:randomUUID(),requestHash:'a'.repeat(64)};
  const preview=await previewDateBlocks(pool,actor,selection,now);
  appointments=[{id:randomUUID(),version:1}];
  await assert.rejects(saveDateBlocks(pool,actor,meta,{selection,previewHash:preview.previewHash},now),{code:'DATE_BLOCK_REVIEW_CHANGED'});assert.equal(writes,0);
  holds=[{id:randomUUID()}];const busy=await previewDateBlocks(pool,actor,selection,now);
  await assert.rejects(saveDateBlocks(pool,actor,meta,{selection,previewHash:busy.previewHash},now),{code:'CALENDAR_TRANSITION_PENDING'});assert.equal(writes,0);
  holds=[];const reviewed=await previewDateBlocks(pool,actor,selection,now);
  const input={selection,previewHash:reviewed.previewHash};
  const saved=await saveDateBlocks(pool,actor,meta,input,now);assert.equal(saved.createdDateCount,2);assert.equal(writes,2);
  assert.deepEqual(await saveDateBlocks(pool,actor,meta,input,now),saved);assert.equal(writes,2);
  assert.deepEqual(await saveDateBlocks(pool,actor,meta,input,now+366*86400000),saved);assert.equal(writes,2);
});
