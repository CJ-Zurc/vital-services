import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { makeEvent } from '../src/eda/infrastructure/outbox.js';
import { consumeSagaCommand } from '../src/eda/workers/appointment-saga.js';
import { resumeAppointmentSaga } from '../src/eda/modules/appointment/appointment-review.js';
import type { Actor } from '../src/eda/contracts/actor.js';

function fixture(){
  const id=randomUUID(),appointmentId=randomUUID(),lineage=randomUUID();
  const event=makeEvent({producer:'appointment',eventType:'vital.appointment.participant.requested',aggregateId:appointmentId,aggregateVersion:1,correlationId:randomUUID(),
    data:{appointmentId,appointmentVersion:1,billingLineageId:lineage,associationVersion:1,actorAuthId:randomUUID(),operationId:id,phase:'prepare',participants:['payment','video']}});
  const fact={...structuredClone(event),id:event.eventId,occurredAt:new Date(event.occurredAt),payload:structuredClone(event.data)};
  const saga={id,sourceAppointmentId:appointmentId,billingLineageId:lineage,associationVersion:1,status:'preparing'};
  let state={inbox:new Set<string>(),wakes:0},prior=structuredClone(state),fail=false,committed=true;
  const tx={async query(sql:string,args:unknown[]=[]){
    if(sql==='BEGIN'){prior=structuredClone(state);return{rows:[],rowCount:0};}if(sql==='ROLLBACK'){state=prior;return{rows:[],rowCount:0};}if(sql==='COMMIT')return{rows:[],rowCount:0};
    if(sql.includes('FROM outbox_events'))return{rows:committed?[fact]:[],rowCount:1};
    if(sql.includes('INSERT INTO inbox_events')){const key=String(args[1]);if(state.inbox.has(key))return{rows:[],rowCount:0};state.inbox.add(key);return{rows:[{eventId:key}],rowCount:1};}
    if(sql.includes('FROM saga_operations'))return{rows:[saga],rowCount:1};
    if(sql.includes('UPDATE saga_operations')){state.wakes++;if(fail)throw new Error('TEST_WAKE_ROLLBACK');return{rows:[],rowCount:1};}
    throw new Error('UNEXPECTED_SQL:'+sql);
  },release(){}};
  const core={query:tx.query.bind(tx),connect:async()=>tx} as unknown as Pool;
  return{event,saga,core,state:()=>state,run:()=>consumeSagaCommand(core,event),fail:(value:boolean)=>{fail=value;},uncommit:()=>{committed=false;}};
}
test('EDA Appointment saga command commits one durable wake before broker acknowledgement',async()=>{
  const f=fixture();await f.run();await f.run();assert.equal(f.state().inbox.size,1);assert.equal(f.state().wakes,1);
});
test('EDA Appointment saga command rolls back inbox on failed wake and skips superseded phases',async()=>{
  const f=fixture();f.fail(true);await assert.rejects(f.run(),/TEST_WAKE_ROLLBACK/);assert.equal(f.state().inbox.size,0);assert.equal(f.state().wakes,0);
  f.fail(false);f.saga.status='completed';await f.run();assert.equal(f.state().inbox.size,1);assert.equal(f.state().wakes,0);
});
test('EDA Appointment saga command rejects forged facts and mismatched associations',async()=>{
  const f=fixture();f.uncommit();await assert.rejects(f.run(),/SAGA_COMMAND_UNCOMMITTED/);assert.equal(f.state().inbox.size,0);
  const g=fixture();g.saga.billingLineageId=randomUUID();await assert.rejects(g.run(),/SAGA_COMMAND_BINDING_INVALID/);assert.equal(g.state().inbox.size,0);
});
test('EDA Appointment review requires current admin authority and only resumes the safe pivot direction',async()=>{
  for(const pivot of[false,true]){
    const id=randomUUID(),authId=randomUUID(),sourceId=randomUUID(),metadata={operationId:randomUUID(),requestHash:'a'.repeat(64)};
    const actor:Actor={authId,role:'admin',resource:id,scopes:['appointments.operation.resume'],serviceId:'vital-web',correlationId:randomUUID(),isSuperAdmin:true};
    let revoked=false;let result:unknown=null;let saved:Record<string,unknown>|undefined;let audits=0;
    const row={status:'review_required',fence:4,pivotCommittedAt:pivot?new Date():null,sourceAppointmentId:sourceId,expectedSourceVersion:1};
    const tx={async query(sql:string,args:unknown[]=[]):Promise<{rows:any[];rowCount:number}>{
      if(sql.includes('FROM vital_admins'))return{rows:revoked?[]:[{userId:randomUUID()}],rowCount:revoked?0:1};
      if(sql.includes('SELECT * FROM command_operations'))return{rows:saved?[saved]:[],rowCount:saved?1:0};
      if(sql.includes('SELECT * FROM saga_operations'))return{rows:[row],rowCount:1};
      if(sql.startsWith('UPDATE saga_operations'))row.status=String(args[1]);
      if(sql.includes('INSERT INTO command_operations')){result=JSON.parse(String(args[5]));saved={action:'saga.resume',resourceId:id,requestHash:args[4],result};}
      if(sql.includes('INSERT INTO outbox_events'))audits++;
      return{rows:[],rowCount:1};
    },release(){}};
    const pool={connect:async()=>tx} as unknown as Pool;
    await assert.rejects(resumeAppointmentSaga(pool,{...actor,role:'patient'},id,metadata,{expectedFence:4}));
    await assert.rejects(resumeAppointmentSaga(pool,actor,id,metadata,{expectedFence:3}));assert.equal(audits,0);
    const first=await resumeAppointmentSaga(pool,actor,id,metadata,{expectedFence:4});assert.equal(first.status,pivot?'finalizing':'compensating');
    assert.deepEqual(await resumeAppointmentSaga(pool,actor,id,metadata,{expectedFence:4}),first);assert.equal(audits,1);
    revoked=true;await assert.rejects(resumeAppointmentSaga(pool,actor,id,metadata,{expectedFence:4}));assert.equal(audits,1);
  }
});
