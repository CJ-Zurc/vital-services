import { accessFixtureSql } from './fixtures/appointment-access.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import type { Actor } from '../src/eda/contracts/actor.js';
import { DomainError } from '../src/eda/contracts/actor.js';
import { createAppointmentReads, serializeReadSlot } from '../src/eda/modules/appointment/appointment-reads.js';

function fixture(){
  const authId=randomUUID(),userId=randomUUID(),id=randomUUID(),patientAuthId=randomUUID();
  const actor:Actor={authId,role:'doctor',resource:authId,scopes:['appointments.requests.read'],correlationId:randomUUID(),isSuperAdmin:false,serviceId:'vital-web'};
  const row={id,doctorId:userId,patientId:randomUUID(),doctorAuthId:authId,patientAuthId,status:'pending',consultationType:'virtual',version:2,
    scheduledAt:new Date('2026-10-16T01:00:00Z'),proposedEndAt:new Date('2026-10-16T02:00:00Z'),billingLineageId:randomUUID(),associationVersion:1,sourceAppointmentId:null};
  const calls:{sql:string;args:unknown[]}[]=[];let revoked=false;
  const query=async(sql:string,args:unknown[]=[])=>{calls.push({sql,args});
    const privacy=accessFixtureSql(sql,args,row);if(privacy)return privacy;
    if(/^(BEGIN|COMMIT|ROLLBACK)/.test(sql))return{rows:[]};
    if(sql.includes(' AS revision')&&sql.includes('COUNT(*)'))return{rows:[{revision:'fixture',total:sql.includes('SELECT a.*,p.')?'1':'0'}]};
    if(sql.includes('SELECT md5(jsonb_build_array'))return{rows:[{revision:'a'.repeat(32)}]};
    if(sql.includes('SELECT p.* FROM vital_'))return{rows:revoked?[]:[{userId,specialty:'Cardiology',availabilityType:'both'}]};
    if(sql.includes('SELECT a.*,p.'))return{rows:[row]};
    if(sql.includes('SELECT id,version FROM appointments'))return{rows:[{id:row.id,version:row.version}]};
    if(sql.includes('SELECT EXISTS'))return{rows:[{active:true}]};
    if(sql.includes('FROM schedules s WHERE'))return{rows:[]};
    if(sql.includes('SELECT id,"fromStatus"')||sql.includes('SELECT a.id,a.status'))return{rows:[]};
    throw new Error('UNEXPECTED_READ:'+sql);
  };
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
  const reads=createAppointmentReads(pool,{payment:{byAppointment:async()=>null}});
  return{actor,row,calls,reads,pool,revoke:()=>{revoked=true;}};
}
test('appointment reads enforce exact request scope resource role and current membership',async()=>{
  const f=fixture();
  for(const actor of[{...f.actor,scopes:['appointments.read']},{...f.actor,resource:randomUUID()},{...f.actor,role:'patient' as const}]){
    await assert.rejects(f.reads.listRequests(actor),e=>e instanceof DomainError&&e.status===403);
  }
  f.revoke();await assert.rejects(f.reads.listRequests(f.actor),e=>e instanceof DomainError&&e.code==='APPOINTMENT_MEMBERSHIP_REVOKED');
});
test('appointment pending requests bind owning doctor and pending status without mutations',async()=>{
  const f=fixture(),result=await f.reads.listRequests(f.actor);
  assert.equal(result.requests[0]?.id,f.row.id);assert.equal(result.requests[0]?.patientAuthId,null);
  const query=f.calls.find(c=>c.sql.startsWith('SELECT r.*')&&c.sql.includes('SELECT a.*,p.'))!;
  assert.equal(query.args[0],f.row.doctorId);assert.equal(query.args[1],'pending');assert.match(query.sql,/createdAt"::timestamp DESC/);
  assert.equal(result.requests[0]?.payment,null);assert.equal(result.requests[0]?.consultation,null);
  assert.ok(f.calls.every(c=>! /INSERT|UPDATE|DELETE/.test(c.sql)));
});
test('appointment reads reject invalid page sizes dates and stale payment associations',async()=>{
  const f=fixture();await assert.rejects(f.reads.listRequests(f.actor,{limit:51}));
  await assert.rejects(f.reads.list({...f.actor,scopes:['appointments.read']},{dateFrom:'2026-02-30'}));
  const g=fixture();const reads=createAppointmentReads(g.pool,{payment:{byAppointment:async()=>({billingLineageId:randomUUID()}) as never}});
  await assert.rejects(reads.listRequests(g.actor),e=>e instanceof DomainError&&e.code==='APPOINTMENT_PAYMENT_READ_STALE');
});
test('appointment list date filters use inclusive Philippine dates and owning patient identity',async()=>{
  const f=fixture();await f.reads.list({...f.actor,role:'patient',scopes:['appointments.read']},{status:'approved',dateFrom:'2026-10-15',dateTo:'2026-10-15'});
  const q=f.calls.find(c=>c.sql.startsWith('SELECT r.*')&&c.sql.includes('SELECT a.*,p.'))!;
  assert.match(q.sql,/a\."patientId"=\$1/);assert.equal(q.args[1],'approved');assert.equal((q.args[2] as Date).toISOString(),'2026-10-14T16:00:00.000Z');
  assert.equal((q.args[3] as Date).toISOString(),'2026-10-15T16:00:00.000Z');
});
test('appointment slots preserve overnight expiry competing requests and public privacy',()=>{
  const row={id:randomUUID(),version:1,slotDate:'2026-10-15',startTime:'23:00:00',endTime:'01:00:00',isPublished:true,consultationType:'both',
    appointments:[{id:randomUUID(),status:'pending',consultationType:'virtual',patientId:randomUUID()}]};
  const slot=serializeReadSlot(row,Date.parse('2026-10-15T16:30:00Z'));
  assert.equal(slot.endsNextDay,true);assert.equal(slot.isExpired,false);assert.equal(slot.isSelectable,true);assert.equal(slot.hasPendingRequest,true);
  const publicSlot=serializeReadSlot(row,Date.parse('2026-10-15T17:00:00Z'),true);
  assert.equal(publicSlot.isExpired,true);assert.deepEqual(publicSlot.pendingAppointments,[]);
  row.appointments[0]!.status='confirmed';assert.equal(serializeReadSlot(row,0).isSelectable,false);
});
test('appointment owner absence gates payment and patient dashboard instead of synthetic empty values',async()=>{
  const f=fixture();await assert.rejects(createAppointmentReads(f.pool).listRequests(f.actor),e=>e instanceof DomainError&&e.code==='APPOINTMENT_PAYMENT_READ_UNAVAILABLE');
  await assert.rejects(f.reads.dashboard({...f.actor,role:'patient',scopes:['appointments.dashboard.read']}),e=>e instanceof DomainError&&e.code==='APPOINTMENT_DASHBOARD_RECORDS_NOTIFICATIONS_READ_UNAVAILABLE');
  const result=await f.reads.schedules({...f.actor,scopes:['appointments.schedule.read']});
  assert.deepEqual(result.doctor,{specialty:'Cardiology',availabilityType:'both',hasActivePaymentQr:true});assert.deepEqual(result.slots,[]);
  assert.equal(result.meta.total,0);assert.equal(result.meta.nextCursor,null);
});
