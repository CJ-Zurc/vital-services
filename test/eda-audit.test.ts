import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { makeEvent,envelopeFromRow } from '../src/eda/infrastructure/outbox.js';
import { enqueueAudit } from '../src/eda/modules/platform-delivery/delivery.js';
import { auditMetadataSchema } from '../src/eda/contracts/audit.js';
import { auditRuntime } from '../src/eda/modules/audit/runtime.js';
import type { Actor } from '../src/eda/contracts/actor.js';
import { auditCatalog } from '../src/eda/contracts/audit-catalog.js';
import { readFileSync,existsSync } from 'node:fs';

test('new audit intents receive universal metadata while persisted legacy events remain unchanged',async()=>{
 const input={producer:'appointment' as const,eventType:'vital.audit.requested' as const,aggregateId:randomUUID(),aggregateVersion:1,
  correlationId:randomUUID(),data:{auditType:'vital.appointment.complaint_updated',actorAuthId:randomUUID(),resourceId:randomUUID(),resourceType:'appointment'}};
 const fresh=makeEvent(input);assert.deepEqual(auditMetadataSchema.parse(fresh.data.auditMetadata).changed_fields,['chief_complaint']);
 const legacy=envelopeFromRow({...fresh,id:fresh.eventId,payload:input.data,occurredAt:new Date(fresh.occurredAt),attempts:0});assert.equal(legacy.data.auditMetadata,undefined);
 for(const event of [fresh,legacy]){
  let payload:Record<string,unknown>|undefined;const tx={async query(sql:string,args:unknown[]=[]){
   if(sql.startsWith('INSERT INTO inbox'))return{rowCount:1,rows:[]};
   if(sql.startsWith('INSERT INTO integration_deliveries'))payload=JSON.parse(args[7] as string);
   if(sql.startsWith('SELECT "requestHash"'))return{rows:[{requestHash:(await import('../src/eda/infrastructure/security.js')).requestHash('POST','delivery',payload)}]};return{rows:[],rowCount:1};},release(){}};
  await enqueueAudit({connect:async()=>tx} as unknown as Pool,event);
  assert.equal(payload!.event_id,event.eventId);assert.equal(payload!.system,'vital');
  assert.equal(payload!.schema_version,event===fresh?2:undefined);
  assert.doesNotMatch(JSON.stringify(payload),/Fictional complaint|accessToken|ciphertext/);
 }
});

test('audit metadata rejects secret content and unapproved changed fields',()=>{
 const base={actor_id:randomUUID(),actor_type:'user',entity_type:'appointment',action:'update',outcome:'success'};
 for(const extra of [{code:'012345'},{ip:'127.0.0.1'},{changed_fields:['raw_patient_notes']},{route:'/record?token=secret'}])assert.equal(auditMetadataSchema.safeParse({...base,...extra}).success,false);
});

test('publisher vocabulary stays in parity with the scoped BGH Audit receiver',{skip:!existsSync('../BGH_AUDIT_LOGS/app/api/vital_contract.py')},()=>{
 const source=readFileSync('../BGH_AUDIT_LOGS/app/api/vital_contract.py','utf8');
 const accepted=new Set([...source.matchAll(/"(vital\.[a-z_.]+)"/g)].map(m=>m[1]));
 assert.deepEqual(Object.keys(auditCatalog).sort(),[...accepted].sort());
 for(const [auditType,entry]of Object.entries(auditCatalog)){
  const event=makeEvent({producer:'profile',eventType:'vital.audit.requested',aggregateId:randomUUID(),aggregateVersion:1,correlationId:randomUUID(),
   data:{auditType,actorAuthId:null,resourceId:null,resourceType:entry.entity}});
  assert.equal(auditMetadataSchema.safeParse(event.data.auditMetadata).success,true,auditType);
 }
});

test('denied operations use an independent transaction and retain denial on audit storage failure',async()=>{
 const actor:Actor={authId:randomUUID(),resource:randomUUID(),role:'doctor',serviceId:'vital-web',scopes:['records.read'],correlationId:randomUUID(),isSuperAdmin:false};
 for(const failed of [false,true]){
  const calls:string[]=[],tx={async query(sql:string,args:unknown[]=[]){calls.push(sql);
    if(sql.startsWith('INSERT INTO outbox')){const event=JSON.parse(args[8] as string);assert.equal(event.auditMetadata.outcome,'denied');assert.equal(event.resourceId,null);if(failed)throw Error('DB unavailable');}
    return{rows:[],rowCount:1};},release(){}};
  const runtime=auditRuntime({connect:async()=>tx} as unknown as Pool);
  const record=runtime.denied(actor,'/internal/v1/records/{id}','GET',403);
  if(failed){await assert.rejects(record);assert.ok(calls.includes('ROLLBACK'));}else{await record;assert.ok(calls.includes('COMMIT'));}
 }
});

test('admin audit intents verify membership, persist transactionally and never trust SuperAdmin alone',async()=>{
 const actor:Actor={authId:randomUUID(),resource:'',role:'admin',serviceId:'vital-web',scopes:['audit.admin.write'],correlationId:randomUUID(),isSuperAdmin:true};actor.resource=actor.authId;
 for(const present of [true,false]){
  const calls:string[]=[],tx={async query(sql:string){calls.push(sql);return{rows:sql.startsWith('SELECT a.')&&present?[{userId:randomUUID()}]:[],rowCount:1};},release(){}};
  const module=auditRuntime({connect:async()=>tx} as unknown as Pool);
  if(present){assert.deepEqual(await module.intent(actor,randomUUID(),'a'.repeat(64),{event:'export_requested'}),{recorded:true});assert.ok(calls.some(s=>s.startsWith('INSERT INTO outbox')));assert.ok(calls.includes('COMMIT'));}
  else{await assert.rejects(module.intent(actor,randomUUID(),'a'.repeat(64),{event:'viewed'}),{code:'AUDIT_ADMIN_REVOKED'});assert.ok(calls.includes('ROLLBACK'));assert.ok(!calls.some(s=>s.startsWith('INSERT INTO outbox')));}
 }
});
