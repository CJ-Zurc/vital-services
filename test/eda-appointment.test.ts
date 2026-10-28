import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";
import type { Actor } from "../src/eda/contracts/actor.js";
import { DomainError } from "../src/eda/contracts/actor.js";
import { parseEvent } from "../src/eda/contracts/events.js";
import { appointmentCommand, createAppointmentModule, assertCalendarAvailable,resolveOpenProposals,appointmentTransition } from "../src/eda/modules/appointment/appointment.js";
import { appointmentExpired, slotInterval, scheduleInput, type AppointmentRow } from "../src/eda/modules/appointment/appointment-contracts.js";
import { completionDue, createAppointmentMaintenance } from "../src/eda/modules/appointment/appointment-maintenance.js";
import { appointmentRuntime } from "../src/eda/modules/appointment/appointment-runtime.js";
import { emergencyContactSchema, complaintSchema, intakeSchema } from "../src/eda/modules/appointment/appointment-intake.js";
import { selectionHash,type VideoSelection,type VideoPreparationReceipt } from '../src/eda/modules/video/contracts.js';

const statusIs=(status:number)=>(error:unknown)=>error instanceof DomainError&&error.status===status;
function fixture(){
  const scheduleSlotId=randomUUID(),now=Date.now(),doctorId=randomUUID(),patientId=randomUUID(),doctorAuthId=randomUUID(),patientAuthId=randomUUID(),id=randomUUID();
  const row:AppointmentRow={id,doctorId,patientId,doctorAuthId,patientAuthId,status:"pending",version:0,billingLineageId:randomUUID(),associationVersion:1,
    scheduledAt:new Date(now+3600000),proposedEndAt:new Date(now+7200000),slotEndsAt:null,scheduleSlotId:null,consultationType:"virtual",sourceAppointmentId:null,
    appointmentKind:"standard",patientRescheduleCount:0,doctorRescheduleCount:0,ehrCaseId:null,doctorConfirmedAt:null,patientConfirmedAt:null,
    completionDeadlineAt:null,paperworkLockedAt:null,completedAt:null,proposalRole:null};
  let state={row,proposals:new Map<string,AppointmentRow>(),commands:new Map<string,Record<string,unknown>>(),events:[] as Record<string,unknown>[],workflows:new Map<string,Record<string,unknown>>(),logs:[] as unknown[][]};
  const slot={id:scheduleSlotId,doctorId,slotDate:new Date("2099-01-02T00:00:00Z"),startTime:"23:45",endTime:"01:00",consultationType:"both",isPublished:true};
  let blocked=false,occupied=false,quoted=false; const billingInserts: Array<{sql:string;args:unknown[]}> = [];
  let previous=structuredClone(state);let revoked=false,failOutbox=false,hasProposal=false;
  const pendingConflicts:string[]=[];
  const calls:string[]=[];const effects:string[]=[];
  const tx={async query(sql:string,args:unknown[]=[]):Promise<{rows:any[];rowCount:number}>{
    calls.push(sql);
    if(sql==='SELECT pg_notify($1,$2)::text') { assert.equal(args[0],'vital_appointment_events'); const hint=JSON.parse(String(args[1])); assert.deepEqual(Object.keys(hint).sort(),['appointmentId','kind']); assert.equal(hint.kind,'eligibility'); return{rows:[],rowCount:1}; }
    if(sql==="BEGIN"){previous=structuredClone(state);return{rows:[],rowCount:0};}
    if(sql==="ROLLBACK"){state=previous;return{rows:[],rowCount:0};}
    if(sql==="COMMIT"||sql.includes("pg_advisory_xact_lock"))return{rows:[],rowCount:0};
    if(sql.startsWith('SELECT * FROM schedules'))return{rows:args[0]===slot.id&&args[1]===slot.doctorId&&slot.isPublished?[slot]:[],rowCount:1};
    if(sql.startsWith('SELECT "doctorId" FROM schedules'))return{rows:args[0]===slot.id&&slot.isPublished?[{doctorId:slot.doctorId}]:[],rowCount:1};
    if(sql.startsWith('SELECT d.* FROM vital_doctors'))return{rows:[{userId:doctorId,isDoctorOnboardingComplete:true,specialty:"Test",availabilityType:"both"}],rowCount:1};
    if(sql.includes("SELECT p.* FROM vital_")||sql.startsWith("SELECT p.*,u.version,u.role FROM vital_patients"))return{rows:revoked?[]:[{userId:sql.includes("vital_doctors")?doctorId:patientId,isRecordAvailable:true,isOnboardingComplete:true,ehrPatientId:patientId,emergency_contact_name:"Test Contact",emergency_contact_relationship:"Sibling",emergency_contact_phone:"+639123456789"}],rowCount:revoked?0:1};
    if(sql.includes("SELECT * FROM command_operations"))return{rows:state.commands.has(String(args[1]))?[state.commands.get(String(args[1]))]:[],rowCount:0};
    if(sql.includes('SELECT a.id FROM appointments')&&sql.includes("a.status='pending'")&&sql.includes('ORDER BY a."createdAt",a.id'))return{rows:pendingConflicts.map(id=>({id})),rowCount:pendingConflicts.length};
    if(sql.includes("INSERT INTO command_operations")){state.commands.set(String(args[2]),{action:args[3],resourceId:args[4],requestHash:args[5],status:"completed",result:JSON.parse(String(args[6]))});return{rows:[],rowCount:1};}
    if(sql.includes("SELECT a.*"))return{rows:sql.includes('a.id<>$2')||sql.includes('a."sourceAppointmentId"=$1')?[]:[structuredClone(state.proposals.get(String(args[0]))??state.row)],rowCount:1};
    if(sql.startsWith('INSERT INTO pre_consultations'))return{rows:[],rowCount:1};
    if(sql.startsWith('INSERT INTO appointments')&&!sql.includes('"sourceAppointmentId"')){state.proposals.set(String(args[0]),{...structuredClone(state.row),id:String(args[0]),scheduleSlotId:String(args[3]),scheduledAt:args[5] as Date,proposedEndAt:args[6] as Date});return{rows:[],rowCount:1};}
    if(sql.startsWith('INSERT INTO consent_records'))return{rows:[],rowCount:1};
    if(sql.startsWith('INSERT INTO appointments')){
      assert.ok(sql.includes('"patientRescheduleCount","doctorRescheduleCount"'));
      state.proposals.set(String(args[0]),{...structuredClone(state.row),id:String(args[0]),sourceAppointmentId:String(args[3]),
        status:String(args[5]),scheduledAt:args[6] as Date,proposedEndAt:args[7] as Date,billingLineageId:String(args[8]),
        associationVersion:Number(args[9]),patientRescheduleCount:Number(args[10]),doctorRescheduleCount:Number(args[11]),version:0,scheduleSlotId:args[12] as string|null});
      return{rows:[],rowCount:1};
    }
    if(sql.includes('SELECT a.id FROM appointments a LEFT JOIN schedules s')&&sql.includes('maintenanceDueAt'))return{rows:[{id}],rowCount:1};
    if(sql.includes("SELECT id FROM appointments WHERE"))return{rows:hasProposal?[{id:randomUUID()}]:[],rowCount:hasProposal?1:0};
    if(sql.includes("SELECT id FROM doctor_date_blocks"))return{rows:blocked?[{id:randomUUID()}]:[],rowCount:blocked?1:0};
    if(sql.includes("SELECT a.id FROM appointments")&&sql.includes("approved"))return{rows:occupied?[{id:randomUUID()}]:[],rowCount:occupied?1:0};
    if(sql.includes("SELECT id FROM saga_operations")||sql.includes("SELECT id FROM doctor_date_blocks")||sql.includes("SELECT a.id FROM appointments")||sql.includes("SELECT id FROM slot_reservations"))return{rows:[],rowCount:0};
    if(sql.includes("UPDATE appointments SET status=")){const row=state.proposals.get(String(args[0]))??state.row;row.status=String(args[1]);row.version++;return{rows:[{version:row.version}],rowCount:1};}
    if(sql.includes('UPDATE appointments SET "doctorConfirmedAt"')){state.row.doctorConfirmedAt=args[1] as Date;state.row.patientConfirmedAt=args[2] as Date;state.row.completionDeadlineAt=args[3] as Date;state.row.version++;return{rows:[],rowCount:1};}
    if(sql.includes('UPDATE appointments SET "maintenanceDueAt"'))return{rows:[],rowCount:1};
    if(sql.includes('UPDATE appointments SET "expiryProcessedAt"')){state.row.status=String(args[3]);state.row.version++;return{rows:[{version:state.row.version}],rowCount:1};}
    if(sql.includes('UPDATE appointments SET "rejectionReason"')||sql.includes('UPDATE appointments SET "completedAt"')||sql.includes('UPDATE appointments SET "ehrCaseId"'))return{rows:[],rowCount:1};
    if(sql.includes("INSERT INTO appointment_logs")){state.logs.push(args);return{rows:[],rowCount:1};}
    if(sql.includes("INSERT INTO outbox_events")){if(failOutbox)throw new Error("OUTBOX_TEST_FAILURE");const event=parseEvent({eventId:args[0],eventType:args[1],schemaVersion:1,producer:args[2],aggregateId:args[3],aggregateVersion:args[4],correlationId:args[5],causationId:args[6],occurredAt:args[7],data:JSON.parse(String(args[8]))});state.events.push(event);return{rows:[],rowCount:1};}
    if(sql.includes("INSERT INTO appointment_workflows")){state.workflows.set(String(args[0]),{id:args[0],appointmentId:args[1],actorAuthId:args[2],kind:args[3],inputHash:args[4],expectedVersion:args[5],prepareOperationId:args[6],expiresAt:args[7],state:"prepared",externalStartedAt:null,receipt:null});return{rows:[],rowCount:1};}
    if(sql.includes("UPDATE appointment_workflows SET state='abandoned'"))return{rows:[],rowCount:0};
    if(sql.includes('SELECT id FROM appointment_workflows'))return{rows:[],rowCount:0};
    if(sql.includes('UPDATE appointment_workflows SET "videoSelectionHash"')){Object.assign(state.workflows.get(String(args[0]))!,{videoSelectionHash:args[1],videoTargetVersion:args[2],videoCorrelationId:args[3]});return{rows:[],rowCount:1};}
    if(sql.includes('UPDATE appointment_workflows SET "videoReceipt"')){Object.assign(state.workflows.get(String(args[0]))!,{videoReceipt:JSON.parse(String(args[1])),videoProcessingState:'prepared'});return{rows:[],rowCount:1};}
    if(sql.includes("SELECT * FROM appointment_workflows")){const w=state.workflows.get(String(args[0]));return{rows:w&&w.actorAuthId===args[1]?[structuredClone(w)]:[],rowCount:w?1:0};}
    if(sql.includes('UPDATE appointment_workflows SET "externalStartedAt"')){state.workflows.get(String(args[0]))!.externalStartedAt=args[1];return{rows:[],rowCount:1};}
    if(sql.includes('UPDATE appointment_workflows SET "targetAppointmentId"')){state.workflows.get(String(args[0]))!.targetAppointmentId=args[1];return{rows:[],rowCount:1};}
    if(sql.includes("UPDATE appointment_workflows SET state=")){state.workflows.get(String(args[0]))!.state="committed";return{rows:[],rowCount:1};}
    if(sql.includes('SELECT "ehrPatientId" FROM vital_patients'))return{rows:[{ehrPatientId:patientId}],rowCount:1};
    if(sql.includes("SELECT * FROM appointment_payment_projections"))return{rows:[{paymentId:randomUUID(),sourceVersion:1,status:"paid",reviewRequired:false,billingLineageId:state.row.billingLineageId,associationVersion:state.row.associationVersion}],rowCount:1};
    if(sql.includes("FROM appointment_billing_quotes"))return{rows:quoted?[{billingLineageId:state.row.billingLineageId}]:[],rowCount:quoted?1:0};
    if(sql.includes("INSERT INTO appointment_billing_intents")){billingInserts.push({sql,args});return{rows:[],rowCount:1};}
    throw new Error("UNEXPECTED_TEST_SQL:"+sql);
  },release(){}};
  const pool={connect:async()=>tx,query:tx.query.bind(tx)} as unknown as Pool;
  const actor=(action:string,role:"doctor"|"patient"="doctor",resource=id):Actor=>({authId:role==="doctor"?doctorAuthId:patientAuthId,role,resource,
    scopes:["appointments."+action],correlationId:randomUUID(),serviceId:"vital-web",isSuperAdmin:false});
  const meta=()=>({operationId:randomUUID(),requestHash:"a".repeat(64)});
  const participant={prepare:async()=>{throw new Error("PARTICIPANT_NOT_USED");},abort:async()=>{},finalize:async()=>{}};
  const receipts=new Map<string,VideoPreparationReceipt>();
  const owners={records:{apply:async(_tx:unknown,_row:unknown,action:string)=>{effects.push(action);},beforeDoctorAcknowledgement:async()=>{}},video:{validate:async()=>{},participant,
    prepareWorkflow:async(workflowId:string,selection:VideoSelection)=>{const receipt={workflowId,sourceAppointmentId:id,targetAppointmentId:id,expectedSourceVersion:0,expectedTargetVersion:0,billingLineageId:state.row.billingLineageId,associationVersion:1,selectionHash:selectionHash(selection),resourceId:randomUUID(),resourceVersion:0,freezeToken:randomUUID()};receipts.set(workflowId,receipt);return receipt;},
    finalizeWorkflow:async(workflowId:string)=>{state.workflows.get(workflowId)!.videoProcessingState='finalized';return receipts.get(workflowId)!;}},
    financial:{verifyPaid:async()=>{}}};
  return{now,id,patientId,patientAuthId,scheduleSlotId,slot,block:()=>{blocked=true;},occupy:()=>{occupied=true;},quote:()=>{quoted=true;},billingInserts,pool,tx,calls,effects,actor,meta,owners,state:()=>state,revoke:()=>{revoked=true;},fail:()=>{failOutbox=true;},proposal:()=>{hasProposal=true;},
    conflict:()=>{const id=randomUUID();pendingConflicts.push(id);return id;},
    module:(enabled=false)=>createAppointmentModule(pool,enabled?owners:{},()=>now)};
}

for(const role of ['patient','doctor'] as const){
  test(`EDA Appointment ${role} exhausted reschedule proposal is denied before writes`,async()=>{
    const f=fixture();Object.assign(f.state().row,{status:'confirmed',patientRescheduleCount:role==='patient'?1:0,doctorRescheduleCount:role==='doctor'?3:0});
    const before=structuredClone(f.state());
    await assert.rejects(f.module().propose(f.actor('reschedule',role),f.id,f.meta(),{
      expectedVersion:0,reason:'New time',...(role==='patient'?{scheduleSlotId:f.scheduleSlotId}:{slotDate:'2099-01-02',startTime:'10:00',endTime:'11:00'}),
    }),error=>error instanceof DomainError&&error.status===409&&error.code==='RESCHEDULE_LIMIT_REACHED');
    assert.deepEqual(f.state(),before);
    assert.ok(!f.calls.some(sql=>/^(INSERT|UPDATE|DELETE) /.test(sql)));
  });

  test(`EDA Appointment ${role} proposal inherits both counters without consuming quota on replay`,async()=>{
    const f=fixture();Object.assign(f.state().row,{status:'confirmed',patientRescheduleCount:role==='patient'?0:1,doctorRescheduleCount:role==='doctor'?2:2});
    const source=structuredClone(f.state().row),meta=f.meta(),actor=f.actor('reschedule',role);
    const input={expectedVersion:0,reason:'New time',...(role==='patient'?{scheduleSlotId:f.scheduleSlotId}:{slotDate:'2099-01-02',startTime:'10:00',endTime:'11:00'})};
    const result=await f.module().propose(actor,f.id,meta,input);
    const proposal=f.state().proposals.get(result.id)!;
    assert.equal(proposal.sourceAppointmentId,f.id);
    assert.equal(proposal.status,role==='doctor'?'pending_patient_confirmation':'pending');
    assert.equal(proposal.patientRescheduleCount,source.patientRescheduleCount);
    assert.equal(proposal.doctorRescheduleCount,source.doctorRescheduleCount);
    assert.deepEqual(f.state().row,source);
    const committed=structuredClone(f.state());
    assert.deepEqual(await f.module().propose(actor,f.id,meta,input),result);
    assert.deepEqual(f.state(),committed);
    assert.equal(f.state().proposals.size,1);
  });

  test(`EDA Appointment ${role} proposal rejection preserves source and proposal counters on replay`,async()=>{
    const f=fixture();Object.assign(f.state().row,{status:'confirmed',patientRescheduleCount:role==='patient'?0:1,doctorRescheduleCount:role==='doctor'?2:2});
    const source=structuredClone(f.state().row);
    const proposal=await f.module().propose(f.actor('reschedule',role),f.id,f.meta(),{
      expectedVersion:0,reason:'New time',...(role==='patient'?{scheduleSlotId:f.scheduleSlotId}:{slotDate:'2099-01-02',startTime:'10:00',endTime:'11:00'}),
    });
    const module=f.module(),meta=f.meta(),input={expectedVersion:proposal.version,reason:'Unavailable'};
    const actor=f.actor(role==='patient'?'reject':'decline-reschedule',role==='patient'?'doctor':'patient',proposal.id);
    const reject=()=>role==='patient'?module.reject(actor,proposal.id,meta,input):module.decline(actor,proposal.id,meta,input);
    const result=await reject();assert.equal(result.status,'rejected');
    assert.deepEqual(f.state().row,source);
    assert.equal(f.state().proposals.get(proposal.id)!.patientRescheduleCount,source.patientRescheduleCount);
    assert.equal(f.state().proposals.get(proposal.id)!.doctorRescheduleCount,source.doctorRescheduleCount);
    const committed=structuredClone(f.state());
    assert.deepEqual(await reject(),result);assert.deepEqual(f.state(),committed);
  });
}

test('EDA Appointment approval requires explicit pending-conflict confirmation before external preparation',async()=>{
  const f=fixture(),conflictId=f.conflict(),input={workflowId:randomUUID(),appointmentId:f.id,expectedVersion:0,kind:'approve',meetingUrl:'https://meet.google.com/abc-defg-hij'};
  await assert.rejects(f.module(true).prepareWorkflow(f.actor('workflow.prepare'),f.meta(),input),error=>error instanceof DomainError
    &&error.code==='APPOINTMENT_SLOT_PENDING_CONFLICTS'&&'conflictIds'in error&&JSON.stringify(error.conflictIds)===JSON.stringify([conflictId]));
  assert.equal(f.state().workflows.size,0);assert.equal(f.state().events.length,0);assert.equal(f.state().row.status,'pending');
  const accepted=await f.module(true).prepareWorkflow(f.actor('workflow.prepare'),f.meta(),{...input,confirmConflicts:true});
  assert.equal(accepted.workflowId,input.workflowId);assert.equal(f.state().workflows.size,1);assert.equal(f.state().row.status,'pending');
});

test("EDA Appointment calendar uses Philippine overnight intervals and end-time expiry",()=>{
  const range=slotInterval("2026-10-15","23:00","01:00");assert.equal(range.startsAt.toISOString(),"2026-10-15T15:00:00.000Z");assert.equal(range.endsAt.toISOString(),"2026-10-15T17:00:00.000Z");
  assert.throws(()=>slotInterval("2026-02-30","10:00","11:00"));assert.throws(()=>slotInterval("2026-10-15","10:00","10:00"));
  assert.equal(appointmentExpired({scheduledAt:range.startsAt,proposedEndAt:range.endsAt},range.startsAt.getTime()+1),false);
  assert.equal(appointmentExpired({scheduledAt:range.startsAt,proposedEndAt:range.endsAt},range.endsAt.getTime()),true);
  assert.equal(appointmentExpired({scheduledAt:range.startsAt},range.startsAt.getTime()),true);
  assert.equal(completionDue({scheduledAt:range.startsAt,proposedEndAt:null,slotEndsAt:range.endsAt,completionDeadlineAt:null},range.startsAt.getTime()+86400000),true);
});

test('EDA Appointment completion shares the patient retention fence before publishing its transition', async () => {
  const f = fixture();
  await appointmentTransition(f.tx as never, f.state().row, 'completed', f.actor('acknowledge'), f.meta().operationId, randomUUID());
  const fence = f.calls.findIndex(sql => sql.includes('pg_advisory_xact_lock'));
  const update = f.calls.findIndex(sql => sql.startsWith('UPDATE appointments SET status='));
  assert.ok(fence >= 0 && fence < update);
});
test("EDA Appointment schemas reject authority fields invalid intake and unsafe contacts",()=>{
  assert.throws(()=>scheduleInput.parse({slotDate:"2026-10-15",startTime:"10:00",endTime:"11:00",consultationType:"virtual",doctorId:randomUUID()}));
  assert.equal(emergencyContactSchema.parse({fullName:"Contact",relationship:"Parent",phoneNumber:"09123456789"}).phoneNumber,"+639123456789");
  assert.throws(()=>emergencyContactSchema.parse({fullName:"",relationship:"Parent",phoneNumber:"123"}));
  assert.equal(complaintSchema.parse("  "),null);assert.equal(complaintSchema.parse(undefined),null);assert.equal(complaintSchema.parse(" headache "),"headache");assert.throws(()=>complaintSchema.parse("x".repeat(2001)));
  assert.throws(()=>intakeSchema.parse({version:1,token:"forbidden"}));
});
test("EDA Appointment command replay binds actor action resource hash and current membership",async()=>{
  const f=fixture(),actor=f.actor("reject"),meta=f.meta();let executions=0;
  const run=()=>appointmentCommand(f.pool,actor,"reject",f.id,meta,{expectedVersion:0},async()=>({runs:++executions}));
  assert.deepEqual(await run(),{runs:1});assert.deepEqual(await run(),{runs:1});assert.equal(executions,1);
  await assert.rejects(appointmentCommand(f.pool,actor,"reject",f.id,meta,{expectedVersion:1},async()=>({})),statusIs(409));f.revoke();await assert.rejects(run(),statusIs(403));
  assert.equal(executions,1);assert.ok(f.calls.some(x=>x.includes("pg_advisory_xact_lock")));
});
test("EDA Appointment missing scopes roles and owners deny before lifecycle effects",async()=>{
  const f=fixture();await assert.rejects(f.module().reject(f.actor("read"),f.id,f.meta(),{expectedVersion:0,reason:"declined"}),statusIs(403));assert.equal(f.calls.length,0);
  f.state().row.status="approved";await assert.rejects(f.module().cancel(f.actor("cancel","patient"),f.id,f.meta(),{expectedVersion:0,reason:"cancel"}),statusIs(503));
  assert.equal(f.state().row.status,"approved");assert.equal(f.state().events.length,0);assert.equal(f.state().commands.size,0);
  assert.equal(f.calls.filter(x=>x.startsWith("UPDATE appointments")).length,0);
});
test("EDA Appointment rejection atomically commits true prior state command and one audit intent",async()=>{
  const f=fixture(),meta=f.meta(),actor=f.actor("reject");const result=await f.module().reject(actor,f.id,meta,{expectedVersion:0,reason:"declined"});
  assert.equal(result.status,"rejected");assert.equal(f.state().logs[0]![2],"pending");
  assert.equal(f.state().events.filter(e=>e.eventType==="vital.audit.requested").length,1);
  await f.module().reject(actor,f.id,meta,{expectedVersion:0,reason:"declined"});assert.equal(f.state().logs.length,1);
  for(const event of f.state().events)assert.doesNotMatch(JSON.stringify(event),/declined/);
});
test("EDA Appointment outbox failure rolls back lifecycle logs and command journal",async()=>{
  const f=fixture();f.fail();await assert.rejects(f.module().reject(f.actor("reject"),f.id,f.meta(),{expectedVersion:0,reason:"declined"}),/OUTBOX_TEST_FAILURE/);
  assert.equal(f.state().row.status,"pending");assert.equal(f.state().row.version,0);assert.equal(f.state().logs.length,0);assert.equal(f.state().commands.size,0);
});
test("EDA Appointment preparation gates EHR work and forged commit receipts preserve pending state",async()=>{
  const f=fixture(),workflowId=randomUUID();const prepare={workflowId,appointmentId:f.id,expectedVersion:0,kind:"approve",meetingUrl:'https://meet.google.com/abc-defg-hij'};
  await assert.rejects(f.module().prepareWorkflow(f.actor("workflow.prepare"),f.meta(),prepare),statusIs(503));assert.equal(f.state().workflows.size,0);
  const prepared=await f.module(true).prepareWorkflow(f.actor("workflow.prepare"),f.meta(),prepare);
  await f.module(true).startExternal(f.actor("workflow.external-start","doctor",workflowId),workflowId,f.meta(),{inputHash:prepared.inputHash});
  await assert.rejects(f.module(true).commitWorkflow(f.actor("workflow.commit","doctor",workflowId),workflowId,f.meta(),
    {inputHash:prepared.inputHash,receipt:{ehrPatientId:f.patientId,ehrCaseId:randomUUID(),externalSystemRef:"vital:appointment:"+f.id,requestHash:"b".repeat(64)}}),statusIs(409));
  assert.equal(f.state().row.status,"pending");assert.ok(f.state().workflows.get(workflowId)!.externalStartedAt);assert.equal(f.effects.length,0);
});
test("EDA Appointment verified EHR approval commits once and completed replay does not repeat external lookup",async()=>{
  const f=fixture(),workflowId=randomUUID(),caseId=randomUUID();let lookups=0;
  const module=createAppointmentModule(f.pool,{...f.owners,ehrRecovery:async()=>{lookups++;return{caseId,patientId:f.patientId,doctorAuthId:f.state().row.doctorAuthId,externalSystemRef:'vital:appointment:'+f.id};}},()=>f.now);
  const prepared=await module.prepareWorkflow(f.actor('workflow.prepare'),f.meta(),{workflowId,appointmentId:f.id,expectedVersion:0,kind:'approve',meetingUrl:'https://meet.google.com/abc-defg-hij'});
  await module.startExternal(f.actor('workflow.external-start','doctor',workflowId),workflowId,f.meta(),{inputHash:prepared.inputHash});
  const actor=f.actor('workflow.commit','doctor',workflowId),meta=f.meta(),input={inputHash:prepared.inputHash,
    receipt:{ehrPatientId:f.patientId,ehrCaseId:caseId,externalSystemRef:'vital:appointment:'+f.id,requestHash:prepared.inputHash}};
  const first=await module.commitWorkflow(actor,workflowId,meta,input);assert.equal(first.status,'approved');assert.equal(first.checkoutWarning,'CHECKOUT_PREPARATION_PENDING');
  assert.deepEqual(await module.commitWorkflow(actor,workflowId,meta,input),first);assert.equal(lookups,1);assert.equal(f.state().logs.length,1);
  await assert.rejects(module.commitWorkflow(actor,workflowId,{...meta,requestHash:'b'.repeat(64)},input),statusIs(409));assert.equal(lookups,1);
});
test("EDA Appointment duplicate acknowledgement with a new command does not extend deadlines or emit another audit",async()=>{
  const f=fixture();f.state().row.status='confirmed';f.state().row.scheduledAt=new Date(f.now-60000);
  const module=f.module(true);const first=await module.complete(f.actor('complete'),f.id,f.meta(),{expectedVersion:0});
  const deadline=f.state().row.completionDeadlineAt!.toISOString();const events=f.state().events.length;
  const second=await module.complete(f.actor('complete'),f.id,f.meta(),{expectedVersion:first.version});
  assert.equal(second.version,first.version);assert.equal(f.state().row.completionDeadlineAt!.toISOString(),deadline);assert.equal(f.state().events.length,events);
});
test("EDA Appointment source cancellation resolves proposals without consuming accepted counters",async()=>{
  const f=fixture();const proposal={...f.state().row,id:randomUUID(),sourceAppointmentId:f.id,status:'pending_patient_confirmation',version:1};
  const queries:Array<{sql:string;args:unknown[]}>=[];
  const tx={query:async(sql:string,args:unknown[]=[])=>{queries.push({sql,args});if(sql.includes('SELECT a.*'))return{rows:[proposal],rowCount:1};
    if(sql.startsWith('UPDATE appointments SET status='))return{rows:[{version:2}],rowCount:1};return{rows:[],rowCount:1};}};
  await resolveOpenProposals(tx as any,f.state().row,f.actor('cancel'),randomUUID(),randomUUID(),'source_cancelled');
  assert.equal(queries.find(query=>query.sql.startsWith('UPDATE appointments SET status='))?.args[1],'rejected');
  assert.equal(queries.find(query=>query.sql.includes('INSERT INTO appointment_logs'))?.args[2],'pending_patient_confirmation');
  assert.ok(queries.every(query=>!query.sql.includes('RescheduleCount')));
});
test("EDA Appointment completion blocks proposals and stale financial authorization",async()=>{
  const f=fixture();f.state().row.status="confirmed";f.state().row.scheduledAt=new Date(f.now-60000);f.proposal();
  await assert.rejects(f.module(true).complete(f.actor("complete"),f.id,f.meta(),{expectedVersion:0}),statusIs(409));assert.equal(f.effects.length,0);assert.equal(f.state().row.doctorConfirmedAt,null);
  const g=fixture();g.state().row.status="confirmed";g.state().row.scheduledAt=new Date(g.now-60000);
  const owners={...g.owners,financial:{verifyPaid:async()=>{throw new DomainError(409,"PAYMENT_AUTHORIZATION_STALE","Stale.");}}};
  await assert.rejects(createAppointmentModule(g.pool,owners,()=>g.now).complete(g.actor("complete"),g.id,g.meta(),{expectedVersion:0}),statusIs(409));assert.equal(g.state().row.doctorConfirmedAt,null);
});
test("EDA Appointment calendar checks committed occupancy and holds through one lock boundary",async()=>{
  const f=fixture();await assertCalendarAvailable(f.tx as any,randomUUID(),new Date(f.now+60000),new Date(f.now+120000));
  assert.ok(f.calls.some(x=>x.includes("status IN ('approved','confirmed')")));assert.ok(f.calls.some(x=>x.includes('"leaseUntil">CURRENT_TIMESTAMP')));
});
test("EDA Appointment runtime and maintenance fail closed without activating unextracted owners",async()=>{
  const f=fixture();assert.equal(appointmentRuntime({corePool:f.pool,integrationsPool:f.pool},undefined,{}),undefined);
  assert.throws(()=>appointmentRuntime({corePool:f.pool,integrationsPool:f.pool},undefined,{VITAL_EDA_APPOINTMENT_MAINTENANCE_ENABLED:"true"}));
  const maintenance=createAppointmentMaintenance(f.pool,{},undefined);assert.deepEqual(await maintenance.lifecycle(),{processed:0,blocked:"RECORDS_OWNER_UNAVAILABLE"});assert.equal(await maintenance.deliverBilling(),0);
  assert.equal(f.calls.length,0);
});
test("EDA Appointment maintenance expires proposals into existing terminal status without consuming quotas",async()=>{
  const f=fixture();f.state().row.status='pending_patient_confirmation';f.state().row.sourceAppointmentId=randomUUID();
  f.state().row.scheduledAt=new Date(f.now-7200000);f.state().row.proposedEndAt=new Date(f.now-3600000);
  assert.equal((await createAppointmentMaintenance(f.pool,f.owners,undefined,()=>f.now).lifecycle()).processed,1);
  assert.equal(f.state().row.status,'rejected');assert.equal(f.state().row.patientRescheduleCount,0);
  assert.equal(f.state().logs[0]![2],'pending_patient_confirmation');assert.equal(f.state().logs[0]![3],'rejected');
  assert.equal(f.state().events.filter(event=>event.eventType==='vital.audit.requested').length,1);
});
test("EDA Appointment maintenance records quoted expiry with distinct actor and operation parameters",async()=>{
  const f=fixture();f.quote();f.state().row.status='pending_patient_confirmation';f.state().row.sourceAppointmentId=randomUUID();
  f.state().row.scheduledAt=new Date(f.now-7200000);f.state().row.proposedEndAt=new Date(f.now-3600000);
  assert.equal((await createAppointmentMaintenance(f.pool,f.owners,undefined,()=>f.now).lifecycle()).processed,1);
  assert.equal(f.billingInserts.length,1);const {sql,args}=f.billingInserts[0]!;
  assert.match(sql,/VALUES\(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9/);
  assert.equal(args[5],args[6]);assert.match(String(args[6]),/^[0-9a-f-]{36}$/i);
  assert.equal(args[8],'expire');assert.equal(f.state().events.filter(event=>event.eventType==='vital.audit.requested').length,1);
});
test("EDA Appointment automatic completion rechecks unresolved proposals rather than completing a stale selection",async()=>{
  const f=fixture();f.state().row.status='confirmed';f.state().row.scheduledAt=new Date(f.now-3*86400000);f.state().row.proposedEndAt=new Date(f.now-2*86400000);f.proposal();
  assert.equal((await createAppointmentMaintenance(f.pool,f.owners,undefined,()=>f.now).lifecycle()).processed,0);
  assert.equal(f.state().row.status,'confirmed');assert.equal(f.state().events.length,0);assert.equal(f.effects.length,0);
});
test('EDA Appointment late first acknowledgement cannot reopen an expired fallback paperwork window',async()=>{
  for(const role of ['patient','doctor'] as const){const f=fixture();f.state().row.status='confirmed';f.state().row.scheduledAt=new Date(f.now-3*86400000);f.state().row.proposedEndAt=new Date(f.now-2*86400000);
    await assert.rejects(f.module(true).complete(f.actor('complete',role),f.id,f.meta(),{expectedVersion:0}),error=>error instanceof DomainError&&error.code==='APPOINTMENT_COMPLETION_DEADLINE');
    assert.equal(f.state().row.completionDeadlineAt,null);assert.equal(f.state().row.doctorConfirmedAt,null);assert.equal(f.state().row.patientConfirmedAt,null);assert.equal(f.state().events.length,0);}
});

// Published slots are authoritative for patient proposals, including historical custom sources.
test('patient reschedule requires published slot and rejects free time before any transaction', async()=>{
 const f=fixture();
 for(const body of [{expectedVersion:0,reason:'Test'}, {expectedVersion:0,reason:'Test',slotDate:'2099-01-02',startTime:'10:00',endTime:'11:00'}, {expectedVersion:0,reason:'Test',scheduleSlotId:f.scheduleSlotId,startTime:'12:00'}]) {
  await assert.rejects(f.module().propose(f.actor('reschedule','patient'),f.id,f.meta(),body));
 }
 assert.equal(f.calls.length,0);
});
test('patient published reschedule binds overnight slot while retaining original custom history and counters',async()=>{
 const f=fixture();f.state().row.status='confirmed';const original=structuredClone(f.state().row);
 const result=await f.module().propose(f.actor('reschedule','patient'),f.id,f.meta(),{expectedVersion:0,reason:'Test',scheduleSlotId:f.scheduleSlotId});
 const next=f.state().proposals.get(result.id)!;
 assert.equal(next.scheduleSlotId,f.scheduleSlotId);
 assert.equal(next.scheduledAt.toISOString(),'2099-01-02T15:45:00.000Z');
 assert.equal(next.proposedEndAt!.toISOString(),'2099-01-02T17:00:00.000Z');
 assert.deepEqual(f.state().row,original);
 assert.ok(f.calls.findIndex(s=>s.includes('appointment-calendar:')||s.includes('pg_advisory_xact_lock'))<f.calls.findIndex(s=>s.startsWith('SELECT * FROM schedules')));
});
for(const scenario of ['unpublished','other doctor','incompatible','past','blocked','occupied'] as const)test('patient slot rejects '+scenario+' before appointment writes',async()=>{
 const f=fixture();f.state().row.status='confirmed';
 if(scenario==='unpublished')f.slot.isPublished=false;
 if(scenario==='other doctor')f.slot.doctorId=randomUUID();
 if(scenario==='incompatible')f.slot.consultationType='in_person';
 if(scenario==='past')f.slot.slotDate=new Date('2000-01-01');
 if(scenario==='blocked')f.block();if(scenario==='occupied')f.occupy();
 await assert.rejects(f.module().propose(f.actor('reschedule','patient'),f.id,f.meta(),{expectedVersion:0,reason:'Test',scheduleSlotId:f.scheduleSlotId}));
 assert.ok(!f.calls.some(sql=>sql.startsWith('INSERT INTO appointments')));
});

function bookingFixture(f:ReturnType<typeof fixture>) {return {
 scheduleSlotId:f.scheduleSlotId,doctorId:f.slot.doctorId,consultationType:'virtual',ehrPatientId:f.patientId,consentAccepted:true,chiefComplaint:null,
 emergencyContact:{fullName:'Test Contact',relationship:'Sibling',phoneNumber:'09123456789'},
 opqrst:{version:1,symptomStartedAt:null,symptomStartedApprox:'Fictional test',onsetType:'UNKNOWN',aggravatingFactors:'',relievingFactors:'',symptomQuality:['Aching'],symptomQualityOther:null,symptomLocation:{kind:'GENERALIZED',partId:null,label:'Whole body / Generalized'},radiates:'NO',radiationLocation:null,severity:1,timingPattern:'UNKNOWN',episodeDurationValue:null,episodeDurationUnit:null,progression:'UNKNOWN',associatedSymptoms:'',additionalNotes:''}
};}
test('patient booking derives the full doctor slot duration and replays once with intake preserved',async()=>{
 const f=fixture(),body=bookingFixture(f),meta=f.meta(),actor=f.actor('book','patient',f.patientAuthId);
 const result=await f.module().book(actor,meta,body);const booked=f.state().proposals.get(result.id)!;
 assert.equal(booked.scheduleSlotId,f.scheduleSlotId);assert.equal(booked.proposedEndAt!.getTime()-booked.scheduledAt.getTime(),75*60000);
 const count=f.calls.filter(s=>s.startsWith('INSERT INTO appointments')).length;
 assert.deepEqual(await f.module().book(actor,meta,body),result);assert.equal(f.calls.filter(s=>s.startsWith('INSERT INTO appointments')).length,count);
 assert.ok(f.calls.some(s=>s.startsWith('INSERT INTO pre_consultations')));assert.ok(f.calls.some(s=>s.startsWith('INSERT INTO consent_records')));
});
test('patient booking denies missing slot custom overrides and mismatched doctor',async()=>{
 const f=fixture(),body=bookingFixture(f),actor=f.actor('book','patient',f.patientAuthId);
 const custom={...body,scheduleSlotId:undefined};
 for(const input of [custom,{...body,startTime:'10:00'},{...body,slotDate:'2099-01-01'},{...body,doctorId:randomUUID()}])await assert.rejects(f.module().book(actor,f.meta(),input));
 assert.ok(!f.calls.some(s=>s.startsWith('INSERT INTO appointments')));
});
