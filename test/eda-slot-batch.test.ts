import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Actor } from '../src/eda/contracts/actor.js';
import { expandSlotBatch, previewSlotBatch, createSlotBatch } from '../src/eda/modules/appointment/appointment-slot-batch.js';

const now=Date.parse('2026-10-31T00:00:00Z');
const input={selection:{mode:'custom',dates:['2026-11-02','2026-11-03']},times:[{startTime:'09:00',endTime:'09:30'},{startTime:'10:00',endTime:'10:30'}],consultationType:'virtual',isPublished:true};
test('batch dates repeat time pairs, weekly selections and overnight ends use Philippine time',()=>{
  const slots=expandSlotBatch(input,now);assert.equal(slots.length,4);assert.equal(slots[0].startsAt.toISOString(),'2026-11-02T01:00:00.000Z');
  const weekly=expandSlotBatch({...input,selection:{mode:'weekly',startDate:'2026-11-01',endDate:'2026-11-14',weekday:1}},now);assert.equal(weekly.length,4);
  const overnight=expandSlotBatch({...input,times:[{startTime:'23:30',endTime:'00:30'}]},now);assert.equal(overnight[0].endsAt.getTime()-overnight[0].startsAt.getTime(),3600000);
});
test('batch rejects duplicate dates, too many time pairs and expanded limits',()=>{
  assert.throws(()=>expandSlotBatch({...input,selection:{mode:'custom',dates:['2026-11-02','2026-11-02']}},now));
  assert.throws(()=>expandSlotBatch({...input,times:Array(11).fill(input.times[0])},now));
  assert.throws(()=>expandSlotBatch({...input,selection:{mode:'range',startDate:'2026-11-01',endDate:'2027-10-31'},times:Array(3).fill(input.times[0])},now));
});
function harness({occupied=false,failInsert=false,availability='both'}={}){
  const authId=randomUUID(),doctorId=randomUUID();
  const actor={authId,role:'doctor',resource:authId,scopes:['appointments.schedule.write'],serviceId:'vital-web',correlationId:randomUUID(),isSuperAdmin:false} as Actor;
  const calls:string[]=[],journal=new Map<string,unknown>();let inserts=0;
  const db={async query(sql:string,args:unknown[]=[]){calls.push(sql);
    if(sql.includes('SELECT p.*'))return{rows:[{userId:doctorId,specialty:'Cardiology',availabilityType:availability}]};
    if(sql.includes('SELECT * FROM command_operations'))return{rows:journal.has(String(args[1]))?[journal.get(String(args[1]))]:[]};
    if(sql.includes('INSERT INTO command_operations')){journal.set(String(args[2]),{action:args[3],resourceId:args[4],requestHash:args[5],status:'completed',result:JSON.parse(String(args[6]))});return{rows:[]};}
    if(sql.startsWith('SELECT id FROM schedules'))return{rows:occupied?[{id:randomUUID()}]:[]};
    if(sql.startsWith('INSERT INTO schedules')){inserts++;if(failInsert&&inserts===2)throw Error('injected write failure');return{rows:[]};}
    return{rows:[],rowCount:1};
  },release(){}};
  return{pool:{connect:async()=>db} as unknown as Pool,actor,calls,get inserts(){return inserts;}};
}
test('preview takes the calendar lock and reports dated overlap conflicts without writes',async()=>{
  const h=harness({occupied:true});const result=await previewSlotBatch(h.pool,h.actor,input,now);
  assert.equal(result.conflicts.length,4);assert.equal(result.conflicts[0].slotDate,'2026-11-02');assert.equal(h.inserts,0);
  assert.ok(h.calls.find(sql=>sql.includes('pg_advisory_xact_lock')));
});
test('batch rejects internal overlaps and past times without writing',async()=>{
  const h=harness();const result=await previewSlotBatch(h.pool,h.actor,{...input,times:[{startTime:'09:00',endTime:'10:00'},{startTime:'09:30',endTime:'10:30'}]},now);
  assert.equal(result.conflicts[0].code,'SCHEDULE_BATCH_OVERLAP');
  const past=await previewSlotBatch(h.pool,h.actor,{...input,selection:{mode:'custom',dates:['2026-10-31']}},Date.parse('2026-10-31T04:00:00Z'));
  assert.ok(past.conflicts.every(row=>row.code==='SLOT_IN_PAST'));assert.equal(h.inserts,0);
});
test('batch commits once and same-key retries return original IDs',async()=>{
  const h=harness(),meta={operationId:randomUUID(),requestHash:'a'.repeat(64)};
  const first=await createSlotBatch(h.pool,h.actor,meta,input,now),second=await createSlotBatch(h.pool,h.actor,meta,input,now);
  assert.equal(first.createdCount,4);assert.deepEqual(second,first);assert.equal(h.inserts,4);
  await assert.rejects(createSlotBatch(h.pool,h.actor,meta,{...input,isPublished:false},now),{code:'COMMAND_REPLAY_CONFLICT'});
});
test('batch rechecks calendar conflicts on commit and does not insert a partial selection',async()=>{
  const h=harness({occupied:true});const result=await createSlotBatch(h.pool,h.actor,{operationId:randomUUID(),requestHash:'a'.repeat(64)},input,now);
  assert.equal(result.createdCount,0);assert.equal(result.conflicts.length,4);assert.equal(h.inserts,0);
});
test('write failures roll back the complete batch, and unsupported care modes are denied',async()=>{
  const h=harness({failInsert:true});await assert.rejects(createSlotBatch(h.pool,h.actor,{operationId:randomUUID(),requestHash:'a'.repeat(64)},input,now));
  assert.ok(h.calls.includes('ROLLBACK'));assert.ok(!h.calls.includes('COMMIT'));
  const denied=harness({availability:'in_person'});await assert.rejects(previewSlotBatch(denied.pool,denied.actor,input,now),{code:'SCHEDULE_CARE_MODE_UNAVAILABLE'});
});
