import { episodeEvidence } from '../src/eda/modules/records/episode-evidence.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { accessCrypto,patientReference,displayReference } from '../src/eda/modules/appointment/access-crypto.js';
import { reviewText,reviewIntake } from '../src/eda/modules/appointment/review-sanitizer.js';
import { accessBinding,createAppointmentAccess } from '../src/eda/modules/appointment/appointment-access.js';
import type { Pool } from 'pg';
import type { AppointmentRow } from '../src/eda/modules/appointment/appointment-contracts.js';
import type { Actor } from '../src/eda/contracts/actor.js';
const env={VITAL_APPOINTMENT_ACCESS_KEYS:JSON.stringify({1:Buffer.alloc(32,7).toString('base64')}),VITAL_APPOINTMENT_ACCESS_ACTIVE_KEY_VERSION:'1',VITAL_APPOINTMENT_ACCESS_DIGEST_KEY:Buffer.alloc(32,9).toString('base64')};
test('references are independently random, readable, and avoid ambiguous symbols',()=>{const values=new Set(Array.from({length:500},patientReference));assert.equal(values.size,500);for(const value of values){assert.match(value,/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);assert.match(displayReference(value),/^Patient #[A-Z2-9]{4}-[A-Z2-9]{4}$/);}});
test('six digit codes round-trip with binding; ciphertext and digest do not disclose plaintext',()=>{const crypto=accessCrypto(env),binding='appointment/patient/doctor/generation';for(let i=0;i<50;i++){const secret=crypto.issue(binding),code=crypto.retrieve(secret.ciphertext,binding);assert.match(code,/^\d{6}$/);assert.equal(crypto.verify(code,binding,secret.digest),true);assert.equal(crypto.verify(code,binding+'/changed',secret.digest),false);assert.throws(()=>crypto.retrieve(secret.ciphertext,binding+'/changed'));assert.notEqual(secret.digest,code);assert.equal(crypto.verify('123',binding,secret.digest),false);}});
test('clinical and multilingual text stays readable while known names are redacted',()=>{
 assert.equal(reviewText('sharp chest pain worse walking').text,'sharp chest pain worse walking');
 assert.equal(reviewText('Masakit ang tiyan ko, doctor.',['Jane Example']).text,'Masakit ang tiyan ko, doctor.');
 assert.equal(reviewText('Jane Example has pain',['Jane Example']).text,'[Patient] has pain');
 assert.equal(reviewText('Jane has pain',['Jane Example']).text,'[Patient] has pain');
 assert.equal(reviewText('Janet has pain',['Jane']).text,'Janet has pain');
 assert.equal(reviewText('Jane has pain',null).withheld,true);
 assert.deepEqual(reviewIntake({severity:7,additionalNotes:'Jane has pain'},['Jane Example']),{severity:7,additionalNotes:'[Patient] has pain'});
});

function harness(){
 const now=Date.parse('2026-10-28T02:00:00Z');
 const row={id:'62d63529-bec8-4b76-b50f-f96670002fb6',patientId:'patient',doctorId:'doctor',patientAuthId:'33333333-3333-4333-8333-333333333333',doctorAuthId:'44444444-4444-4444-8444-444444444444',version:2,status:'confirmed',scheduledAt:new Date(now),proposedEndAt:new Date(now+3600000),slotEndsAt:null,completionDeadlineAt:null,doctorConfirmedAt:null,paperworkLockedAt:null,billingLineageId:'lineage',associationVersion:1} as AppointmentRow;
 const a={appointmentId:row.id,patientId:row.patientId,doctorId:row.doctorId,reference:'7K4M9Q2R',generation:1,attempts:0,consumedAt:null,grantedAt:null,grantUntil:null,revokedAt:null,digest:null as string|null,ciphertext:null as unknown};
 const secret=accessCrypto(env).issue(accessBinding(a as never));Object.assign(a,secret);const code=accessCrypto(env).retrieve(a.ciphertext,accessBinding(a as never));let committed=false;const attempts:string[]=[];
 const db={async query(sql:string,args:unknown[]=[]){if(sql.includes("kind='reissue'")&&sql.includes('COUNT(*)'))return{rows:[{n:attempts.filter(x=>x==='reissue').length}]};if(sql.includes('INSERT INTO appointment_access_attempts'))attempts.push(sql.includes("'reissue'")?'reissue':'redeem');if(sql.startsWith('UPDATE appointment_access SET \"patientId\"'))Object.assign(a,{patientId:args[1],doctorId:args[2],generation:args[3],digest:args[4],ciphertext:JSON.parse(String(args[5])),attempts:0});if(sql==='COMMIT')committed=true;if(sql.includes('SELECT * FROM appointment_access'))return{rows:[structuredClone(a)]};if(sql.includes('SELECT accepted'))return{rows:[{accepted:true}]};if(sql.includes('SELECT 1 FROM appointment_payment'))return{rows:[{}],rowCount:1};if(sql.includes('SELECT * FROM appointment_payment'))return{rows:[{paymentId:'payment',sourceVersion:1,status:'paid',reviewRequired:false,billingLineageId:'lineage',associationVersion:1}],rowCount:1};if(sql.includes('FILTER(WHERE'))return{rows:[{doctor:attempts.filter(x=>x==='redeem').length,booking:attempts.filter(x=>x==='redeem').length}]};if(sql.includes('attempts=attempts+1'))a.attempts++;if(sql.includes('"consumedAt"=NOW()'))Object.assign(a,{consumedAt:new Date(now),grantedAt:new Date(now)});return{rows:[],rowCount:1};},release(){}};
 const pool={connect:async()=>db} as unknown as Pool;
 const actor={authId:row.doctorAuthId,correlationId:'55555555-5555-4555-8555-555555555555',role:'doctor',scopes:['appointments.access.redeem'],resource:row.id} as Actor;
 return{service:createAppointmentAccess(pool,async()=>row,env,()=>now,{verifyPaid:async()=>{}}),row,a,actor,code,committed:()=>committed};
}
test('incorrect attempts are committed and the fifth locks the generation',async()=>{const h=harness();const wrong=h.code==='000000'?'111111':'000000';for(let i=0;i<5;i++){const result=await h.service.execute(h.actor,h.row.id,'redeem',{code:wrong,generation:1,expectedVersion:2});assert.equal(result.state,i===4?'locked':'review_only');}assert.equal(h.a.attempts,5);assert.equal(h.committed(),true);await assert.rejects(()=>h.service.execute(h.actor,h.row.id,'redeem',{code:h.code,generation:1,expectedVersion:2}),{code:'APPOINTMENT_CODE_LOCKED'});});
test('a successful redemption consumes the code and prevents replay',async()=>{const h=harness();assert.equal((await h.service.execute(h.actor,h.row.id,'redeem',{code:h.code,generation:1,expectedVersion:2})).state,'unlocked');await assert.rejects(()=>h.service.execute(h.actor,h.row.id,'redeem',{code:h.code,generation:1,expectedVersion:2}),{code:'APPOINTMENT_CODE_ALREADY_USED'});});
test('wrong doctors and stale generations cannot redeem',async()=>{const h=harness();await assert.rejects(()=>h.service.execute({...h.actor,authId:'someone-else'},h.row.id,'redeem',{code:h.code,generation:1,expectedVersion:2}),{code:'APPOINTMENT_ACCESS_OWNER_DENIED'});await assert.rejects(()=>h.service.execute(h.actor,h.row.id,'redeem',{code:h.code,generation:2,expectedVersion:2}),{code:'APPOINTMENT_CODE_STALE'});});

test('historical evidence excludes unrelated cases and evolving longitudinal records',()=>{
 const result=episodeEvidence({patient:{name:'Private',address:'Address'},allergies:['unrelated'],medications:['current'],clinical_notes:[{case_id:'this',text:'Episode note'},{case_id:'other',text:'Unrelated'},{text:'Unscoped'}]},'this');
 assert.deepEqual(result,{clinical_notes:[{case_id:'this',text:'Episode note'}],record_scope:'historical_care_episode'});
 assert.deepEqual(episodeEvidence({clinical_notes:[{case_id:'this'}]},null),{});
});

test('possession of the correct code cannot bypass payment confirmation or the time window',async()=>{
 const early=harness();early.row.scheduledAt=new Date(early.row.scheduledAt.getTime()+31*60000);
 await assert.rejects(()=>early.service.execute(early.actor,early.row.id,'redeem',{code:early.code,generation:1,expectedVersion:2}),{code:'APPOINTMENT_CODE_OUTSIDE_WINDOW'});
 const late=harness();late.row.proposedEndAt=new Date(late.row.scheduledAt.getTime()-7200001);
 await assert.rejects(()=>late.service.execute(late.actor,late.row.id,'redeem',{code:late.code,generation:1,expectedVersion:2}),{code:'APPOINTMENT_CODE_OUTSIDE_WINDOW'});
 const unpaid=harness();unpaid.row.status='approved';
 await assert.rejects(()=>unpaid.service.execute(unpaid.actor,unpaid.row.id,'redeem',{code:unpaid.code,generation:1,expectedVersion:2}),{code:'APPOINTMENT_CODE_PAYMENT_REQUIRED'});
});
test('cancellation, consent withdrawal, reassignment and stale appointment versions deny redemption',async()=>{
 const cancelled=harness();cancelled.row.status='cancelled';
 await assert.rejects(()=>cancelled.service.execute(cancelled.actor,cancelled.row.id,'redeem',{code:cancelled.code,generation:1,expectedVersion:2}),{code:'APPOINTMENT_ACCESS_INELIGIBLE'});
 const revoked=harness();Object.assign(revoked.a,{revokedAt:new Date()});
 await assert.rejects(()=>revoked.service.execute(revoked.actor,revoked.row.id,'redeem',{code:revoked.code,generation:1,expectedVersion:2}),{code:'APPOINTMENT_ACCESS_INELIGIBLE'});
 const changed=harness();changed.row.doctorId='replacement-doctor';
 await assert.rejects(()=>changed.service.execute(changed.actor,changed.row.id,'redeem',{code:changed.code,generation:1,expectedVersion:2}),{code:'APPOINTMENT_ACCESS_ASSOCIATION_CHANGED'});
 const stale=harness();stale.row.version++;
 await assert.rejects(()=>stale.service.execute(stale.actor,stale.row.id,'redeem',{code:stale.code,generation:1,expectedVersion:2}),{code:'APPOINTMENT_CODE_STALE'});
});

test('patient retrieval and reissue are private; old generations fail and reissues have a persistent hourly limit',async()=>{
 const h=harness(),patient={...h.actor,role:'patient' as const,authId:h.row.patientAuthId,scopes:['appointments.access.code']};
 assert.equal((await h.service.execute(patient,h.row.id,'code')).code,h.code);
 await assert.rejects(()=>h.service.execute({...h.actor,scopes:['appointments.access.code']},h.row.id,'code'),{code:'APPOINTMENT_ACCESS_PATIENT_REQUIRED'});
 for(let i=0;i<3;i++){const next=await h.service.execute({...patient,scopes:['appointments.access.reissue']},h.row.id,'reissue');assert.equal(next.generation,i+2);assert.match(String(next.code),/^\d{6}$/);}
 await assert.rejects(()=>h.service.execute({...patient,scopes:['appointments.access.reissue']},h.row.id,'reissue'),{code:'APPOINTMENT_CODE_REISSUE_LIMIT'});
 await assert.rejects(()=>h.service.execute(h.actor,h.row.id,'redeem',{code:h.code,generation:1,expectedVersion:2}),{code:'APPOINTMENT_CODE_STALE'});
 const state=await h.service.execute({...h.actor,scopes:['appointments.access.read']},h.row.id,'read');assert.ok(!('code' in state));assert.ok(!JSON.stringify(state).includes('ciphertext'));assert.ok(!JSON.stringify(state).includes('digest'));
});
