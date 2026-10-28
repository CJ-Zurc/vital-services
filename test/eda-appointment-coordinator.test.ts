import { accessFixtureSql } from './fixtures/appointment-access.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { DomainError } from '../src/eda/contracts/actor.js';
import { createAppointmentSaga } from '../src/eda/modules/appointment/appointment-saga.js';
import type { AppointmentRow,ParticipantReceipt } from '../src/eda/modules/appointment/appointment-contracts.js';
import { parseEvent } from '../src/eda/contracts/events.js';

function fixture(initiator:'doctor'|'patient'='doctor',queued=true){
  const now=Date.now(),id=randomUUID(),sourceId=randomUUID(),nextId=randomUUID(),reservationId=randomUUID(),lineage=randomUUID();
  const base={doctorId:randomUUID(),patientId:randomUUID(),doctorAuthId:randomUUID(),patientAuthId:randomUUID(),billingLineageId:lineage,associationVersion:1,
    consultationType:'virtual',version:0,scheduledAt:new Date(now+2*86400000),proposedEndAt:new Date(now+2*86400000+3600000),slotEndsAt:null,scheduleSlotId:null,
    appointmentKind:'standard',patientRescheduleCount:0,doctorRescheduleCount:0,ehrCaseId:randomUUID(),doctorConfirmedAt:null,patientConfirmedAt:null,
    completionDeadlineAt:null,paperworkLockedAt:null,completedAt:null};
  const source:AppointmentRow={...base,id:sourceId,status:'confirmed',sourceAppointmentId:null,proposalRole:null};
  const next:AppointmentRow={...base,id:nextId,status:initiator==='doctor'?'pending_patient_confirmation':'pending',sourceAppointmentId:sourceId,proposalRole:initiator,scheduledAt:new Date(now+3*86400000),proposedEndAt:new Date(now+3*86400000+3600000),ehrCaseId:null};
  let state={queued,commands:new Map<string,Record<string,unknown>>(),rows:new Map<string,AppointmentRow>([[sourceId,source],[nextId,next]]),saga:{id,sourceAppointmentId:sourceId,replacementAppointmentId:nextId,expectedSourceVersion:0,expectedReplacementVersion:0,
    billingLineageId:lineage,associationVersion:1,requestHash:'a'.repeat(64),status:'preparing',actorAuthId:initiator==='doctor'?base.patientAuthId:base.doctorAuthId,actorRole:initiator==='doctor'?'patient':'doctor',correlationId:randomUUID(),
    reservationId,deadlineAt:new Date(now+300000),pivotCommittedAt:null as Date|null,fence:0,leaseOwner:null as string|null,leaseUntil:null as Date|null,attempts:0,
    prepareReceipts:{} as Record<string,ParticipantReceipt>,targetRequest:{initiator}},reservation:{id:reservationId,doctorId:base.doctorId,startsAt:next.scheduledAt,endsAt:next.proposedEndAt,status:'reserved',leaseUntil:new Date(now+60000)},events:[] as ReturnType<typeof parseEvent>[],logs:[] as unknown[][]};
  let previous=structuredClone(state);let failSql:string|null=null;let preparationFailure=false,finalizationFailure=false;
  const calls={prepare:0,abort:0,finalize:0};const queries:string[]=[];
  const tx={async query(sql:string,args:unknown[]=[]):Promise<{rows:any[];rowCount:number}>{
    queries.push(sql);
    const privacy=accessFixtureSql(sql,args,state.rows.get(String(args[0])));if(privacy)return privacy;
    if(sql==='SELECT pg_notify($1,$2)::text'){assert.equal(args[0],'vital_appointment_events');assert.equal(JSON.parse(String(args[1])).kind,'eligibility');return{rows:[],rowCount:1};}
    if(sql==='BEGIN'){previous=structuredClone(state);return{rows:[],rowCount:0};}if(sql==='ROLLBACK'){state=previous;return{rows:[],rowCount:0};}if(sql==='COMMIT'||sql.includes('pg_advisory_xact_lock'))return{rows:[],rowCount:0};
    if(failSql&&sql.includes(failSql)){failSql=null;throw new Error('TEST_CORE_CRASH');}
    if(sql.includes('SELECT p.* FROM vital_'))return{rows:[{userId:sql.includes('vital_doctors')?base.doctorId:base.patientId}],rowCount:1};
    if(sql.includes('SELECT * FROM command_operations')){const command=state.commands.get(String(args[1]));return{rows:command?[command]:[],rowCount:command?1:0};}
    if(sql.includes('INSERT INTO command_operations')){state.commands.set(String(args[2]),{action:args[3],resourceId:args[4],requestHash:args[5],status:'completed',result:JSON.parse(String(args[6]))});return{rows:[],rowCount:1};}
    if(sql.includes('SELECT id FROM saga_operations'))return{rows:state.queued&&state.saga.status!=='completed'?[{id}]:[],rowCount:0};
    if(sql.startsWith('INSERT INTO slot_reservations')){Object.assign(state.reservation,{id:String(args[0]),doctorId:String(args[2]),startsAt:args[5],endsAt:args[6],leaseUntil:args[7],status:'reserved'});return{rows:[],rowCount:1};}
    if(sql.startsWith('INSERT INTO saga_operations')){state.queued=true;Object.assign(state.saga,{id:args[0],sourceAppointmentId:args[1],replacementAppointmentId:args[2],actorAuthId:args[3],actorRole:args[4],expectedSourceVersion:args[5],expectedReplacementVersion:args[6],billingLineageId:args[7],associationVersion:args[8],requestHash:args[9],deadlineAt:args[10],correlationId:args[11],reservationId:args[12],targetRequest:JSON.parse(String(args[13]))});return{rows:[],rowCount:1};}
    if(sql.includes('SELECT * FROM saga_operations'))return{rows:[structuredClone(state.saga)],rowCount:1};
    if(sql.includes('SELECT a.*'))return{rows:[structuredClone(state.rows.get(String(args[0])))],rowCount:1};
    if(sql.includes('SELECT id FROM doctor_date_blocks')||sql.includes('SELECT a.id FROM appointments')||sql.includes('SELECT id FROM slot_reservations'))return{rows:[],rowCount:0};
    if(sql.includes('SELECT * FROM slot_reservations'))return{rows:[structuredClone(state.reservation)],rowCount:1};
    if(sql.includes('SELECT id FROM outbox_events'))return{rows:state.events.filter(event=>event.eventId===args[0]).map(event=>({id:event.eventId})),rowCount:0};
    if(sql.includes('INSERT INTO outbox_events')){state.events.push(parseEvent({eventId:args[0],eventType:args[1],schemaVersion:1,producer:args[2],aggregateId:args[3],aggregateVersion:args[4],correlationId:args[5],causationId:args[6],occurredAt:args[7],data:JSON.parse(String(args[8]))}));return{rows:[],rowCount:1};}
    if(sql.includes('INSERT INTO appointment_logs')){state.logs.push(args);return{rows:[],rowCount:1};}
    if(sql.startsWith('UPDATE appointments SET status=')){const row=state.rows.get(String(args[0]))!;row.status=String(args[1]);row.version++;return{rows:[{version:row.version}],rowCount:1};}
    if(sql.startsWith('UPDATE appointments SET "ehrCaseId"=NULL')){state.rows.get(String(args[0]))!.ehrCaseId=null;return{rows:[],rowCount:1};}
    if(sql.startsWith('UPDATE appointments SET "ehrCaseId"=$2')){const row=state.rows.get(String(args[0]))!;row.ehrCaseId=String(args[1]);row.associationVersion=Number(args[3]);row.patientRescheduleCount=Number(args[4]);row.doctorRescheduleCount=Number(args[5]);return{rows:[],rowCount:1};}
    if(sql.startsWith('INSERT INTO consultations'))return{rows:[],rowCount:1};
    if(sql.startsWith('UPDATE slot_reservations')){if(sql.includes("status='released'"))state.reservation.status='released';else if(sql.includes("status='consumed'"))state.reservation.status='consumed';else state.reservation.leaseUntil=args[1] as Date;return{rows:[],rowCount:1};}
    if(sql.startsWith('UPDATE saga_operations SET "leaseOwner"')){if(!['preparing','compensating','finalizing'].includes(state.saga.status)||state.saga.leaseUntil&&state.saga.leaseUntil.getTime()>now)return{rows:[],rowCount:0};state.saga.leaseOwner=String(args[1]);state.saga.leaseUntil=args[2] as Date;state.saga.fence++;return{rows:[structuredClone(state.saga)],rowCount:1};}
    if(sql.startsWith('UPDATE saga_operations')){
      if(sql.includes('prepareReceipts')){state.saga.prepareReceipts=JSON.parse(String(args[1]));state.saga.leaseUntil=args[2] as Date;}
      else if(sql.includes("status='finalizing'")){state.saga.status='finalizing';state.saga.pivotCommittedAt=args[1] as Date;state.saga.leaseUntil=args[3] as Date;}
      else if(sql.includes('CASE WHEN attempts')){state.saga.status=!state.saga.pivotCommittedAt&&args[3]?'compensating':state.saga.status;state.saga.attempts++;state.saga.leaseOwner=null;state.saga.leaseUntil=null;}
      else if(sql.includes("status='completed'")||sql.includes("status='compensated'")){state.saga.status=sql.includes("status='completed'")?'completed':'compensated';state.saga.leaseOwner=null;state.saga.leaseUntil=null;}
      else if(sql.includes("status='compensating'"))state.saga.status='compensating';else if(sql.includes('leaseUntil'))state.saga.leaseUntil=args[1] as Date;
      return{rows:[],rowCount:1};
    }
    throw new Error('UNEXPECTED_TEST_SQL:'+sql);
  },release(){}};
  const pool={query:tx.query.bind(tx),connect:async()=>tx} as unknown as Pool;
  const participant=(name:string)=>({async prepare(){calls.prepare++;if(preparationFailure){preparationFailure=false;throw new DomainError(409,'TEST_PREPARATION_DENIED','Denied.');}
    return{operationId:id,participant:name,freezeToken:randomUUID(),requestHash:state.saga.requestHash,billingLineageId:lineage,associationVersion:1,sourceAppointmentId:sourceId,replacementAppointmentId:nextId,
      expectedSourceVersion:0,expectedReplacementVersion:0,resourceId:randomUUID(),resourceVersion:1,verifiedPaid:name==='payment'};},
    async abort(){assert.equal(state.saga.pivotCommittedAt,null);calls.abort++;},async finalize(){assert.ok(state.saga.pivotCommittedAt);calls.finalize++;if(finalizationFailure){finalizationFailure=false;throw new Error('TEST_FINALIZE_CRASH');}}});
  const saga=createAppointmentSaga(pool,{records:{apply:async()=>{}},payment:participant('payment'),video:{validate:async()=>{},participant:participant('video'),prepareWorkflow:async()=>{throw new Error('UNUSED');},finalizeWorkflow:async()=>{throw new Error('UNUSED');}}},()=>now);
  const actor=()=>({authId:initiator==='doctor'?base.patientAuthId:base.doctorAuthId,role:initiator==='doctor'?'patient' as const:'doctor' as const,
    resource:nextId,scopes:['appointments.accept-reschedule'],correlationId:randomUUID(),serviceId:'vital-web',isSuperAdmin:false});
  return{id,sourceId,nextId,saga,calls,queries,actor,state:()=>state,crash:(sql:string)=>{failSql=sql;},denyPrepare:()=>{preparationFailure=true;},failFinalize:()=>{finalizationFailure=true;}};
}
for(const initiator of ['patient','doctor'] as const){
  test(`EDA Appointment coordinator rejects exhausted ${initiator} quota at acceptance without consuming either counter`,async()=>{
    const f=fixture(initiator,false),source=f.state().rows.get(f.sourceId)!;
    source.patientRescheduleCount=initiator==='patient'?1:0;source.doctorRescheduleCount=initiator==='doctor'?3:0;
    const before=structuredClone(f.state());
    await assert.rejects(f.saga.accept(f.actor(),f.nextId,{operationId:f.id,requestHash:'a'.repeat(64)},
      {expectedVersion:0,expectedSourceVersion:0}),error=>error instanceof DomainError&&error.status===409&&error.code==='RESCHEDULE_LIMIT_REACHED');
    assert.deepEqual(f.state(),before);assert.deepEqual(f.calls,{prepare:0,abort:0,finalize:0});
    assert.ok(!f.queries.some(sql=>/^(INSERT|UPDATE|DELETE) /.test(sql)));
  });

  test(`EDA Appointment coordinator accepted ${initiator} proposal increments only its initiator counter through rollback finalization retry and replay`,async()=>{
    for(const failure of ['pivot','finalize'] as const){
      const f=fixture(initiator,false),source=f.state().rows.get(f.sourceId)!,proposal=f.state().rows.get(f.nextId)!;
      source.patientRescheduleCount=initiator==='patient'?0:1;source.doctorRescheduleCount=initiator==='doctor'?2:2;
      proposal.patientRescheduleCount=source.patientRescheduleCount;proposal.doctorRescheduleCount=source.doctorRescheduleCount;
      const originalSource=structuredClone(source),originalProposal=structuredClone(proposal);
      const actor=f.actor(),meta={operationId:f.id,requestHash:'a'.repeat(64)},input={expectedVersion:0,expectedSourceVersion:0};
      if(failure==='pivot')f.crash('INSERT INTO appointment_logs');else f.failFinalize();
      const first=await f.saga.accept(actor,f.nextId,meta,input);assert.equal(first.operationStatus,'processing');
      if(failure==='pivot'){
        assert.deepEqual(f.state().rows.get(f.sourceId),originalSource);assert.deepEqual(f.state().rows.get(f.nextId),originalProposal);
        assert.equal(f.state().saga.pivotCommittedAt,null);assert.equal(f.state().logs.length,0);
      }else{assert.ok(f.state().saga.pivotCommittedAt);assert.equal(f.state().saga.status,'finalizing');}
      assert.deepEqual(await f.saga.accept(actor,f.nextId,meta,input),first);
      assert.equal(f.state().saga.status,'completed');assert.equal(f.state().saga.targetRequest.initiator,initiator);
      const accepted=f.state().rows.get(f.nextId)!;
      assert.equal(accepted.patientRescheduleCount,1);assert.equal(accepted.doctorRescheduleCount,initiator==='doctor'?3:2);
      assert.equal(accepted.patientRescheduleCount-originalSource.patientRescheduleCount,initiator==='patient'?1:0);
      assert.equal(accepted.doctorRescheduleCount-originalSource.doctorRescheduleCount,initiator==='doctor'?1:0);
      assert.equal(f.state().rows.get(f.sourceId)!.patientRescheduleCount,originalSource.patientRescheduleCount);
      assert.equal(f.state().rows.get(f.sourceId)!.doctorRescheduleCount,originalSource.doctorRescheduleCount);
      assert.equal(f.state().rows.get(f.sourceId)!.status,'rescheduled');assert.equal(accepted.status,'confirmed');
      const committed=structuredClone(f.state()),calls={...f.calls};
      assert.deepEqual(await f.saga.accept(actor,f.nextId,meta,input),first);await f.saga.advance(f.id);
      assert.deepEqual(f.state(),committed);assert.deepEqual(f.calls,calls);assert.equal(f.state().logs.length,2);
      const notifications=f.state().events.filter(event=>event.eventType==='vital.notification.requested');
      assert.equal(notifications.length,1);assert.equal(notifications[0]!.data.template,'appointment.rescheduled');
      assert.equal(notifications[0]!.data.recipientAuthId,initiator==='doctor'?accepted.patientAuthId:accepted.doctorAuthId);
      const details=JSON.parse(String(f.state().logs[0]![8]));assert.equal(details.initiatorRole,initiator);assert.equal(details.acceptedByAuthId,actor.authId);

    }
  });
}

test('EDA Appointment coordinator rolls back every Core pivot boundary and retries without duplicate counters',async()=>{
  for(const boundary of['UPDATE appointments SET "ehrCaseId"=NULL','INSERT INTO consultations','UPDATE appointments SET "ehrCaseId"=$2','UPDATE appointments SET status=','INSERT INTO appointment_logs',"status='consumed'","status='finalizing'"]){
    const f=fixture();f.crash(boundary);await f.saga.advance(f.id);assert.equal(f.state().saga.pivotCommittedAt,null);assert.equal(f.state().rows.get(f.sourceId)!.status,'confirmed');
    assert.equal(f.state().rows.get(f.nextId)!.doctorRescheduleCount,0);await f.saga.advance(f.id);assert.equal(f.state().saga.status,'completed');
    assert.equal(f.state().rows.get(f.nextId)!.doctorRescheduleCount,1);assert.equal(f.state().logs.length,2);assert.equal(f.calls.prepare,2);
    await f.saga.advance(f.id);assert.equal(f.state().logs.length,2);
  }
});
test('EDA Appointment coordinator aborts before pivot without preparing during compensation',async()=>{
  const f=fixture();f.denyPrepare();await f.saga.advance(f.id);assert.equal(f.state().saga.status,'compensating');await f.saga.advance(f.id);
  assert.equal(f.state().saga.status,'compensated');assert.equal(f.calls.prepare,1);assert.equal(f.calls.abort,2);assert.equal(f.state().reservation.status,'released');assert.equal(f.state().logs.length,0);
});
test('EDA Appointment coordinator recovers only forward after pivot and preserves one accepted increment',async()=>{
  const f=fixture();f.failFinalize();await f.saga.advance(f.id);assert.equal(f.state().saga.status,'finalizing');assert.ok(f.state().saga.pivotCommittedAt);
  assert.equal(f.state().reservation.status,'consumed');await f.saga.advance(f.id);assert.equal(f.state().saga.status,'completed');assert.equal(f.calls.abort,0);
  assert.equal(f.state().rows.get(f.nextId)!.doctorRescheduleCount,1);assert.equal(f.state().logs.length,2);
});


test('S6 successful reschedule notification failure retries independently without another quota increment',async()=>{
  const f=fixture('doctor');f.failFinalize();await f.saga.advance(f.id);
  assert.ok(f.state().saga.pivotCommittedAt);assert.equal(f.state().saga.status,'finalizing');
  const count=f.state().rows.get(f.nextId)!.doctorRescheduleCount;
  f.crash('INSERT INTO outbox_events');await f.saga.advance(f.id);
  assert.equal(f.state().saga.status,'finalizing');
  assert.equal(f.state().events.filter(event=>event.eventType==='vital.notification.requested').length,0);
  assert.equal(f.state().rows.get(f.nextId)!.doctorRescheduleCount,count);
  await f.saga.advance(f.id);assert.equal(f.state().saga.status,'completed');
  assert.equal(f.state().events.filter(event=>event.eventType==='vital.notification.requested').length,1);
  assert.equal(f.state().rows.get(f.nextId)!.doctorRescheduleCount,count);
  await f.saga.advance(f.id);assert.equal(f.state().events.filter(event=>event.eventType==='vital.notification.requested').length,1);
});
