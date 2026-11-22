import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import type {Pool} from 'pg';
import type {Actor} from '../src/eda/contracts/actor.js';
import {createAdminAppointmentOverview,philippineMonth} from '../src/eda/modules/appointment/appointment-admin-overview.js';
test('Philippine month bounds cross UTC midnight, leap years and year end correctly',()=>{
 for(const [now,from,to] of [['2026-10-31T15:59:59.999Z','2026-09-30T16:00:00.000Z','2026-10-31T16:00:00.000Z'],['2026-10-31T16:00:00Z','2026-10-31T16:00:00.000Z','2026-11-30T16:00:00.000Z'],['2026-12-31T16:00:00Z','2026-12-31T16:00:00.000Z','2027-01-31T16:00:00.000Z'],['2028-02-29T00:00:00Z','2028-01-31T16:00:00.000Z','2028-02-29T16:00:00.000Z']]){
  const period=philippineMonth(Date.parse(now));assert.equal(period.from.toISOString(),from);assert.equal(period.to.toISOString(),to);assert.equal(period.asOf.toISOString(),new Date(now).toISOString());
 }
});
function fixture(empty=false){const calls:{sql:string;args:unknown[]}[]=[];let member=true;
 const leaders=empty?[]:[1,2].map(()=>({id:randomUUID(),authId:randomUUID(),specialty:null,completedCount:'8',rating:null,reviewCount:'0'}));
 const tx={query:async(sql:string,args:unknown[]=[])=>{calls.push({sql,args});return{rows:sql.includes('FROM vital_admins')?(member?[{userId:randomUUID()}]:[]):sql.startsWith('SELECT status')?(empty?[]:[{status:'completed',consultationType:'virtual',count:'10'},{status:'no_show',consultationType:'in_person',count:'2'}]):sql.includes('AS completed,')?[{completed:empty?'0':'10',cancelled:'0',noShow:empty?'0':'2'}]:sql.startsWith('WITH volumes')?leaders:[]};},release(){}};
 const pool={connect:async()=>tx} as unknown as Pool;const actor={authId:randomUUID(),role:'admin',resource:'',scopes:['completion.admin.dashboard']} as Actor;actor.resource=actor.authId;
 return{read:createAdminAppointmentOverview(pool,()=>Date.parse('2026-11-15T00:00:00Z')),actor,calls,revoke:()=>{member=false;}};
}
test('Admin overview combines both modes, preserves joint leaders and reports no-rating nulls without Payment',async()=>{
 const f=fixture(),data=await f.read(f.actor);assert.deepEqual(data.consultationCounts,{virtual:10,in_person:2});assert.deepEqual(data.statusCounts,{completed:10,no_show:2});assert.equal(data.monthly.completed,10);assert.equal(data.doctorSpotlight.leaders.length,2);assert.equal(data.doctorSpotlight.leaders[0].rating,null);
 assert(f.calls.some(c=>c.sql==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));assert(f.calls.some(c=>c.sql==='COMMIT'));assert(!f.calls.some(c=>/payments|patientId|INSERT|UPDATE|DELETE/.test(c.sql)));
 const outcomes=f.calls.find(c=>c.sql.includes('AS completed,'))!;assert.match(outcomes.sql,/COUNT\(DISTINCT "appointmentId"\)/);assert.equal((outcomes.args[0] as Date).toISOString(),'2026-10-31T16:00:00.000Z');
 const leaders=f.calls.find(c=>c.sql.startsWith('WITH volumes'))!;assert.match(leaders.sql,/status='completed'/);assert.match(leaders.sql,/"completedAt">=\$1/);assert.match(leaders.sql,/"isDoctorOnboardingComplete"/);assert.match(leaders.sql,/MAX\(volume\)/);
});
test('Admin overview keeps empty periods empty, rejects foreign roles and rolls back revoked membership',async()=>{
 const f=fixture(true),data=await f.read(f.actor);assert.deepEqual(data.doctorSpotlight.leaders,[]);assert.deepEqual(data.consultationCounts,{virtual:0,in_person:0});
 await assert.rejects(f.read({...f.actor,role:'patient'}));f.revoke();await assert.rejects(f.read(f.actor));assert(f.calls.some(c=>c.sql==='ROLLBACK'));
});
