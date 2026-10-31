import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Actor } from '../src/eda/contracts/actor.js';
import { patientDoctorRatings } from '../src/eda/modules/appointment/patient-ratings.js';
function fixture(empty=false){
 const doctorId=randomUUID(),authId=randomUUID();let active=true,changed=false;
 const rows=empty?[]:[5,4,3].map((rating,index)=>({id:randomUUID(),rating,submittedAt:new Date(Date.UTC(2026,10,3-index)),patientName:'Private patient',appointmentId:randomUUID()}));
 const actor={authId,role:'patient',resource:doctorId,scopes:['appointments.discovery.read'],serviceId:'vital-web',correlationId:randomUUID(),isSuperAdmin:false} as Actor;
 const calls:{sql:string;args:unknown[]}[]=[];
 const db={async query(sql:string,args:unknown[]=[]){calls.push({sql,args});
  if(sql.includes('SELECT p.*'))return{rows:active?[{userId:authId}]:[]};
  if(sql.includes('SELECT d."userId"'))return{rows:[{userId:doctorId}]};
  if(sql.includes('AVG('))return{rows:[{count:rows.length,average:rows.length?'4':null}]};
  if(sql.includes('AS revision'))return{rows:[{revision:changed?'new':'stable',total:String(rows.length)}]};
  if(sql.startsWith('SELECT r.*')){const after=args.length>2?new Date(String(args[1])).getTime():Infinity;return{rows:rows.filter(row=>row.submittedAt.getTime()<after).slice(0,Number(args.at(-1)))};}
  return{rows:[]};
 },release(){}};
 return{doctorId,actor,calls,pool:{...db,connect:async()=>db} as unknown as Pool,revoke:()=>{active=false;},change:()=>{changed=true;}};
}
test('patient ratings paginate anonymously and retain aggregate counts',async()=>{
 const f=fixture(),first=await patientDoctorRatings(f.pool,f.actor,f.doctorId,{limit:2});
 assert.equal(first.count,3);assert.equal(first.average,4);assert.equal(first.items.length,2);assert.ok(first.meta.nextCursor);assert.deepEqual(Object.keys(first.items[0]!).sort(),["rating","submittedAt"]);
 assert.doesNotMatch(JSON.stringify(first),/Private patient|appointmentId|patientName|patientAuthId/);
 const second=await patientDoctorRatings(f.pool,f.actor,f.doctorId,{limit:2,cursor:first.meta.nextCursor});assert.equal(second.items.length,1);assert.equal(second.meta.nextCursor,null);
 assert.equal(first.meta.snapshot,second.meta.snapshot);
 f.change();await assert.rejects(patientDoctorRatings(f.pool,f.actor,f.doctorId,{cursor:first.meta.nextCursor}),{code:'APPOINTMENT_READ_SNAPSHOT_CHANGED'});
});
test('empty ratings are distinct from unavailable or forbidden ratings',async()=>{
 const f=fixture(true),result=await patientDoctorRatings(f.pool,f.actor,f.doctorId,{});assert.equal(result.count,0);assert.equal(result.average,0);assert.deepEqual(result.items,[]);
 await assert.rejects(patientDoctorRatings(f.pool,{...f.actor,role:'doctor'},f.doctorId,{}),{code:'APPOINTMENT_ROLE_DENIED'});
 await assert.rejects(patientDoctorRatings(f.pool,{...f.actor,resource:randomUUID()},f.doctorId,{}),{code:'ACTOR_SCOPE_DENIED'});
 await assert.rejects(patientDoctorRatings(f.pool,f.actor,f.doctorId,{patientId:randomUUID()}));
 f.revoke();await assert.rejects(patientDoctorRatings(f.pool,f.actor,f.doctorId,{}),{code:'APPOINTMENT_MEMBERSHIP_REVOKED'});
});
