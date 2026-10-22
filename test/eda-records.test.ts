import assert from 'node:assert/strict';
import { randomBytes,randomUUID,generateKeyPairSync,createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import jwt from 'jsonwebtoken';
import test from 'node:test';
import type { Pool } from 'pg';
import type { Actor } from '../src/eda/contracts/actor.js';
import { DomainError } from '../src/eda/contracts/actor.js';
import { clinicalHash,protectPayload,recordsKeyring,unprotectPayload } from '../src/eda/modules/records/protection.js';
import { verifyEhrEvidence } from '../src/eda/modules/records/ehr-evidence.js';
import { assertPaperwork,normalizeEhrSnapshot,paperworkDeadline } from '../src/eda/modules/records/authorization.js';
import { createRecordsModule } from '../src/eda/modules/records/records.js';
import { createRecordsLifecycle } from '../src/eda/modules/records/lifecycle.js';
import { createRecordsFiles } from '../src/eda/modules/records/files.js';
import { recordsRuntime } from '../src/eda/modules/records/runtime.js';
import { prescriptionData } from '../src/eda/modules/records/contracts.js';
import { recordsReaderDelegation } from '../src/eda/http/records-reader.js';
import { parseEvent } from '../src/eda/contracts/events.js';
import { ArtifactError, sha256 } from '../src/eda/modules/records/upload-validation.js';
import { createFileInspector, type FileInspector } from '../src/eda/modules/records/inspection.js';
import { createDoctorSigning } from '../src/eda/modules/records/signing.js';
import type { RecordsScanner } from '../src/eda/modules/records/scanner.js';
import sharp from 'sharp';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppointmentRow } from '../src/eda/modules/appointment/appointment-contracts.js';
import express from 'express';
import { createEdaApp } from '../src/eda/http/app.js';
import { requestHash } from '../src/eda/infrastructure/security.js';
import type { RecordsRuntime } from '../src/eda/modules/records/runtime.js';

const pair=generateKeyPairSync('rsa',{modulusLength:2048}),privateKey=pair.privateKey.export({type:'pkcs8',format:'pem'}).toString(),publicKey=pair.publicKey.export({type:'spki',format:'pem'}).toString();
const keyring=recordsKeyring({activeKeyId:'v1',keys:{v1:randomBytes(32).toString('base64')}});
const isCode=(code:string)=>(error:unknown)=>error instanceof DomainError&&error.code===code;
function fixture(){
  const now=Date.now(),patientId=randomUUID(),patientAuthId=randomUUID(),doctorId=randomUUID(),doctorAuthId=randomUUID(),ehrPatientId=randomUUID(),ehrCaseId=randomUUID(),id=randomUUID();
  const appointment:AppointmentRow={id,patientId,patientAuthId,doctorId,doctorAuthId,ehrCaseId,status:'confirmed',version:1,billingLineageId:randomUUID(),associationVersion:1,
    scheduledAt:new Date(now-3600000),proposedEndAt:new Date(now+3600000),slotEndsAt:null,scheduleSlotId:null,sourceAppointmentId:null,appointmentKind:'standard',consultationType:'virtual',
    patientRescheduleCount:0,doctorRescheduleCount:0,doctorConfirmedAt:null,patientConfirmedAt:null,completionDeadlineAt:null,paperworkLockedAt:null,completedAt:null,proposalRole:null};
  let state={appointment,commands:new Map<string,any>(),workflows:new Map<string,any>(),snapshots:new Map<string,any>(),documents:new Map<string,any>(),assets:new Map<string,any>(),operations:new Map<string,any>(),refs:[] as unknown[][],
    grant:{status:'live',snapshotId:null as string|null,frozenSnapshotId:null as string|null},events:[] as any[],freezes:new Map<string,any>()};
  let prior=structuredClone(state),revoked=false,consented=true,busy=false,outboxFail=false,paymentStale=false,partyCalls=0,objectWrites=0,profileVersion=0;
  const signatureId=randomUUID(),signatureBytes=Buffer.from('synthetic signature');
  const signature={id:signatureId,contentHash:sha256(signatureBytes),s2License:'DEMO-S2',s2ValidFrom:new Date('2026-01-01Z'),s2ValidUntil:new Date('2027-01-01Z'),protectedPayload:protectPayload(keyring,{patientId:doctorAuthId,resourceId:signatureId,schema:'doctor-signature.v1'},{base64:signatureBytes.toString('base64')})};
  let prcLicense:string|null='TEST-LICENSE';
  const calls:Array<{sql:string;args:unknown[]}>=[];
  const tx={release(){},async query(sql:string,args:unknown[]=[]):Promise<{rows:any[];rowCount:number}>{
    calls.push({sql,args});const done=(rows:any[]=[],rowCount=rows.length)=>({rows,rowCount});
    if(sql.startsWith('BEGIN')){prior=structuredClone(state);return done();}if(sql==='ROLLBACK'){state=prior;return done();}if(sql==='COMMIT'||sql.includes('pg_advisory_xact_lock'))return done();
    if(sql.includes('FROM vital_doctors d JOIN doctor_signatures'))return done([signature]);
    if(sql.startsWith('SELECT "signatureAssetId"'))return done([{signatureAssetId:signatureId,...signature}]);
    if(sql.startsWith('SELECT s.id,s."protectedPayload"'))return done([]);
    if(sql.includes(' AS revision,COUNT(*)'))return done([{revision:String(consented),total:consented?'1':'0'}]);
    if(sql.startsWith('SELECT r.*')&&sql.includes('SELECT DISTINCT p.'))return done(consented?[{id:patientId,patientId,authId:patientAuthId,ehrPatientId}]:[]);
    if(sql.startsWith('SELECT r.*')&&sql.includes('a.id AS "appointmentId"'))return done(consented?[{id,appointmentId:id,version:state.appointment.version,associationVersion:1,status:state.appointment.status,
      scheduledAt:state.appointment.scheduledAt,snapshotId:state.grant.snapshotId,ehrCaseId,ehrPatientId,recordsBlockCode:null}]:[]);
    if(sql.includes('SELECT p.* FROM vital_'))return done(revoked?[]:[{userId:sql.includes('vital_doctors')?doctorId:patientId}]);
    if(sql.includes('SELECT p."userId",p."authId"'))return done(args[0]===patientId?[{userId:patientId,authId:patientAuthId,ehrPatientId,version:profileVersion}]:[]);
    if(sql==='SELECT "userId" FROM vital_patients WHERE "authId"=$1')return done(args[0]===patientAuthId?[{userId:patientId}]:[]);
    if(sql.includes('SELECT "prc_license"'))return done([{prcLicense}]);
    if(sql.includes('SELECT * FROM command_operations'))return done(state.commands.has(String(args[1]))?[state.commands.get(String(args[1]))]:[]);
    if(sql.includes('INSERT INTO command_operations')){state.commands.set(String(args[2]),{action:args[3],resourceId:args[4],requestHash:args[5],status:'completed',result:JSON.parse(String(args[6]))});return done([],1);}
    if(sql.includes('SELECT a.*'))return done(args[0]===id?[structuredClone(state.appointment)]:[]);
    if(sql.includes('SELECT accepted FROM consent_records'))return done([{accepted:consented}]);
    if(sql.includes('AS "appointmentId"')&&sql.includes('c."consentType"'))return done(consented?[{appointmentId:id,version:1,associationVersion:1,status:'confirmed',snapshotId:null,ehrCaseId,recordsBlockCode:null}]:[]);
    if(sql.includes('SELECT DISTINCT p."userId"')&&sql.includes('c."consentType"'))return done(consented?[{patientId,authId:patientAuthId,ehrPatientId}]:[]);
    if(sql.includes('SELECT g."appointmentId"')&&sql.includes('c."consentType"'))return done(consented&&(state.grant.status==='live'||state.grant.snapshotId)?[{appointmentId:id}]:[]);
    if(sql.includes('SELECT id FROM saga_operations')||sql.includes('SELECT id FROM appointments WHERE "sourceAppointmentId"'))return done(busy?[{id:randomUUID()}]:[]);
    if(sql.includes('SELECT * FROM appointment_payment_projections'))return done([{paymentId:randomUUID(),sourceVersion:2,status:'paid',reviewRequired:false,billingLineageId:state.appointment.billingLineageId,associationVersion:1}]);
    if(sql.includes('FROM records_episode_grants')&&sql.includes('SELECT'))return done([{...state.grant}]);
    if(sql.includes('SELECT * FROM records_workflows')){const w=state.workflows.get(String(args[0]));return done(w&&(!args[1]||w.actorAuthId===args[1])?[structuredClone(w)]:[]);}
    if(sql.includes('INSERT INTO records_workflows')){state.workflows.set(String(args[0]),{id:args[0],actorAuthId:args[1],patientId:args[2],doctorId:args[3],appointmentId:args[4],expectedVersion:args[5],associationVersion:args[6],ehrPatientId:args[7],ehrCaseId:args[8],kind:args[9],inputHash:args[10],recovery:args[11],state:'prepared',expiresAt:args[13]});return done([],1);}
    if(sql.includes('UPDATE records_workflows')){const w=state.workflows.get(String(args[0]));w.state='committed';w.resourceId=args[1];w.receiptMetadata=JSON.parse(String(args[2]));w.commitOperationId=args[3];return done([],1);}
    if(sql.includes('INSERT INTO records_snapshots')){state.snapshots.set(String(args[0]),{id:args[0],workflowId:args[1],appointmentId:args[2],patientId:args[3],doctorId:args[4],appointmentVersion:args[5],associationVersion:args[6],ehrPatientId:args[7],ehrCaseId:args[8],sourceHash:args[9],protectedPayload:JSON.parse(String(args[10])),receiptMetadata:JSON.parse(String(args[11])),capturedAt:args[12]});return done([],1);}
    if(sql.includes('SELECT s.id FROM records_snapshots'))return done(state.snapshots.has(String(args[0]))?[{id:args[0]}]:[]);
    if(sql.includes('SELECT "sourceHash" FROM records_snapshots'))return done(state.snapshots.has(String(args[0]))?[state.snapshots.get(String(args[0]))]:[]);
    if(sql.includes('SELECT s.* FROM records_snapshots'))return done(state.snapshots.has(String(args[0]))?[state.snapshots.get(String(args[0]))]:[]);
    if(sql.includes('INSERT INTO records_snapshot_assets')){state.refs.push(args);return done([],1);}
    if(sql.includes('UPDATE records_episode_grants SET "snapshotId"')){state.grant.snapshotId=String(args[1]);return done([],1);}
    if(sql.includes('UPDATE records_episode_grants SET "frozenSnapshotId"')){state.grant.frozenSnapshotId??=String(args[1]);return done([],1);}
    if(sql.includes('UPDATE records_episode_grants SET status=')){state.grant.status=sql.includes("'historical'")?'historical':'revoked';return done([],1);}
    if(sql.includes('SELECT "appointmentId" FROM records_episode_freezes'))return done(state.freezes.has(String(args[0]))?[{}]:[]);
    if(sql.includes('SELECT "protectedPayload" FROM records_episode_freezes'))return done(state.freezes.has(String(args[0]))?[state.freezes.get(String(args[0]))]:[]);
    if(sql.includes('INSERT INTO records_episode_freezes')){state.freezes.set(String(args[0]),{snapshotId:args[1],protectedPayload:JSON.parse(String(args[3])),cutoffAt:args[4]});return done([],1);}
    if(sql.includes('FROM records_documents')&&sql.includes('c."consentType"')){
      const docs=[...state.documents.values()].filter(d=>(!args[0]||d.patientId===args[0])&&(!args[1]||d.doctorId===args[1])&&(!args[7]||consented));
      return sql.includes('COUNT(*)')?done([{total:docs.length}]):done(docs.map(d=>({...d,state:'processing',assetVersion:0})));
    }
    if(sql.includes('FROM records_documents')&&sql.includes('SELECT'))return done(args[0]===patientId?[...state.documents.values()].filter(d=>!args[1]||d.issuedAt<=args[1]):state.documents.has(String(args[0]))?[state.documents.get(String(args[0]))]:[]);
    if(sql.includes('FROM records_file_assets')&&sql.includes('SELECT'))return done(sql.includes('WHERE id=')?(state.assets.has(String(args[0]))?[state.assets.get(String(args[0]))]:[]):[...state.assets.values()].filter(a=>a.kind==='upload'&&a.state==='ready'&&a.createdAt<=(args[1] as Date)));
    if(sql.includes('INSERT INTO records_documents')){state.documents.set(String(args[0]),{id:args[0],patientId:args[1],doctorId:args[2],appointmentId:args[3],kind:args[4],accessCode:args[5],protectedPayload:JSON.parse(String(args[6])),assetId:args[7],issuedAt:args[8]});return done([],1);}
    if(sql.includes('INSERT INTO records_file_assets')){const upload=sql.includes("'upload'");state.assets.set(String(args[0]),upload?{id:args[0],patientId:args[1],kind:'upload',version:0,state:'quarantine',protectedPayload:JSON.parse(String(args[2])),objectKey:args[3],contentHash:args[4],mimeType:args[5],byteLength:args[6],createdAt:new Date(now)}:
      {id:args[0],patientId:args[1],appointmentId:args[2],kind:args[3],version:0,state:'processing',protectedPayload:JSON.parse(String(args[4])),objectKey:args[5],mimeType:'application/pdf',byteLength:0,createdAt:args[6]});return done([],1);}
    if(sql.includes('SELECT state,attempts FROM record_operations'))return done(state.operations.has(String(args[0]))?[state.operations.get(String(args[0]))]:[]);
    if(sql.includes('INSERT INTO record_operations')){state.operations.set(String(args[0]),{id:args[0],resourceId:sql.includes("'upload'")?args[0]:args[1],actorAuthId:sql.includes("'upload'")?args[1]:args[2],state:'pending',attempts:0});return done([],1);}
    if(sql.includes('UPDATE record_operations'))return done([],1);
    if(sql.includes('UPDATE appointments SET "recordsBlockCode"'))return done([],1);
    if(sql.includes('INSERT INTO outbox_events')){if(outboxFail)throw new Error('TEST_OUTBOX_FAILURE');const e=parseEvent({eventId:args[0],eventType:args[1],schemaVersion:1,producer:args[2],aggregateId:args[3],aggregateVersion:args[4],correlationId:args[5],causationId:args[6],occurredAt:args[7],data:JSON.parse(String(args[8]))});state.events.push(e);return done([],1);}
    if(sql.startsWith('INSERT INTO records_episode_grants'))return done([],1);
    if(sql==='SELECT id FROM appointments WHERE "ehrCaseId"=$1')return done(args[0]===ehrCaseId?[{id}]:[]);
    throw new Error('UNEXPECTED_RECORDS_TEST_SQL:'+sql);
  }};
  const pool={connect:async()=>tx,query:tx.query.bind(tx)} as unknown as Pool;
  const config={appOrigin:"https://web.example.test",keyring,evidence:{keys:{ehr:publicKey}},financial:{verifyPaid:async()=>{if(paymentStale)throw new DomainError(409,'PAYMENT_AUTHORIZATION_STALE','Stale.');}},parties:async()=>{partyCalls++;return{patientName:'SYNTHETIC PATIENT',doctorName:'SYNTHETIC DOCTOR',doctorLicense:prcLicense??''};}};
  const actor=(action:string,resource:string=id,role:'doctor'|'patient'='doctor'):Actor=>({authId:role==='doctor'?doctorAuthId:patientAuthId,role,scopes:['records.'+action],resource,serviceId:'vital-web',correlationId:randomUUID(),isSuperAdmin:false});
  const meta=()=>({operationId:randomUUID(),requestHash:'a'.repeat(64)});
  const receipt=(workflowId:string,payload:unknown,kind='snapshot',overrides:Record<string,unknown>={})=>jwt.sign({kind,workflowId,actorAuthId:doctorAuthId,patientId:ehrPatientId,caseId:ehrCaseId,payloadHash:clinicalHash(payload),externalSystemRef:'vital:appointment:'+id,
    iss:'uhse-ehr',aud:'vital-services.records',iat:Math.floor(now/1000),exp:Math.floor(now/1000)+60,jti:randomUUID(),...overrides},privateKey,{algorithm:'RS256',keyid:'ehr'});
  const storage={key:(area:string,assetId:string,hash:string,mime:string)=>area+'/'+assetId+'/'+hash+(mime==='application/pdf'?'.pdf':'.png'),putQuarantine:async()=>{objectWrites++;},readQuarantine:async()=>Buffer.alloc(0),ensureFinal:async()=>{},inspectFinal:async()=>false,signedLink:async()=>'https://gateway.invalid/media?signature=private'};
  return{prc:(value:string|null)=>{prcLicense=value;},signature,now,id,patientId,patientAuthId,doctorId,doctorAuthId,ehrPatientId,ehrCaseId,pool,tx,config,actor,meta,receipt,state:()=>state,calls,module:createRecordsModule(pool,config,()=>now),files:createRecordsFiles(pool,config,storage,()=>now),lifecycle:createRecordsLifecycle(keyring,()=>now),
    revoked:()=>{revoked=true;},consent:(v:boolean)=>{consented=v;},busy:()=>{busy=true;},stale:()=>{paymentStale=true;},fail:()=>{outboxFail=true;},profileVersion:(v:number)=>{profileVersion=v;},partyCalls:()=>partyCalls,objectWrites:()=>objectWrites};
}

test('EDA Records encryption binds patient resource schema and rejects substituted ciphertext',()=>{
  const binding={patientId:randomUUID(),resourceId:randomUUID(),schema:'snapshot.v1'},payload={clinical:'SYNTHETIC SECRET'};
  const sealed=protectPayload(keyring,binding,payload);assert.deepEqual(unprotectPayload(keyring,binding,sealed),payload);assert.doesNotMatch(JSON.stringify(sealed),/SYNTHETIC SECRET/);
  for(const changed of [{...binding,patientId:randomUUID()},{...binding,resourceId:randomUUID()},{...binding,schema:'document.v1'}])assert.throws(()=>unprotectPayload(keyring,changed,sealed),isCode('RECORDS_PAYLOAD_UNAVAILABLE'));
  assert.throws(()=>recordsKeyring({activeKeyId:'x',keys:{v1:randomBytes(32).toString('base64')}}));assert.throws(()=>unprotectPayload({activeKeyId:'none',keys:{}},binding,sealed));
});
test('EDA Records RFC8785 hashes preserve command contracts and cross-language numeric Unicode vectors',()=>{
  assert.equal(clinicalHash({a:1,b:'\u00f1'}),clinicalHash({b:'\u00f1',a:1.0}));
  assert.equal(clinicalHash({numbers:[333333333.33333329,1E30,4.50,2e-3,1e-27]}),createHash('sha256').update('{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}').digest('hex'));
});
test('EDA Records EHR evidence rejects substituted payload patient workflow actor key audience and expiry',()=>{
  const f=fixture(),workflowId=randomUUID(),payload={clinical:'SYNTHETIC'},token=f.receipt(workflowId,payload),expected={kind:'snapshot' as const,workflowId,actorAuthId:f.doctorAuthId,patientId:f.ehrPatientId,caseId:f.ehrCaseId,payloadHash:clinicalHash(payload)};
  const verified=verifyEhrEvidence(token,f.config.evidence,expected,Math.floor(f.now/1000));assert.equal(verified.claims.caseId,f.ehrCaseId);assert.doesNotMatch(JSON.stringify(verified.metadata),new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  for(const field of ['workflowId','actorAuthId','patientId','caseId'] as const)assert.throws(()=>verifyEhrEvidence(token,f.config.evidence,{...expected,[field]:randomUUID()},Math.floor(f.now/1000)),isCode('EHR_RECORDS_EVIDENCE_INVALID'));
  assert.throws(()=>verifyEhrEvidence(token,f.config.evidence,{...expected,payloadHash:clinicalHash({clinical:'SUBSTITUTED'})},Math.floor(f.now/1000)));
  for(const overrides of [{aud:'other'},{exp:Math.floor(f.now/1000)-1},{exp:Math.floor(f.now/1000)+61},{iat:Math.floor(f.now/1000)+1}])assert.throws(()=>verifyEhrEvidence(f.receipt(workflowId,payload,'snapshot',overrides),f.config.evidence,expected,Math.floor(f.now/1000)));
});
test('EDA Records prescription rejects a malformed line instead of partial issuance',()=>{
  const valid={medicineName:'Synthetic',isControlled:false,dosageAmount:'1',dosageUnit:'mg',frequency:'Daily'};assert.equal(prescriptionData.parse({signingConfirmed:true,lines:[valid]}).lines.length,1);
  assert.throws(()=>prescriptionData.parse({signingConfirmed:true,lines:[valid,{...valid,dosageUnit:''}]}));assert.throws(()=>prescriptionData.parse({signingConfirmed:true,lines:[valid],doctorName:'BROWSER AUTHORITY'}));
});
test('EDA Records preparation capture and replay commit encrypted evidence and one audit without tokens',async()=>{
  const f=fixture(),workflowId=randomUUID(),prepared=await f.module.prepareSnapshot(f.actor('snapshot.prepare'),f.meta(),{workflowId,appointmentId:f.id,expectedVersion:1}),payload={patient:{id:f.ehrPatientId},clinical:'SYNTHETIC CLINICAL'};
  const actor=f.actor('snapshot.capture',workflowId),meta=f.meta(),body={inputHash:prepared.inputHash,payload,receipt:f.receipt(workflowId,payload)};
  const first=await f.module.captureSnapshot(actor,workflowId,meta,body);assert.deepEqual(await f.module.captureSnapshot(actor,workflowId,meta,body),first);
  assert.equal(f.state().snapshots.size,1);assert.equal(f.state().events.filter(e=>e.eventType==='vital.audit.requested').length,1);
  assert.doesNotMatch(JSON.stringify([...f.state().workflows.values(),...f.state().snapshots.values(),...f.state().events,...f.state().commands.values()]),/SYNTHETIC CLINICAL|eyJhbGci/);
  const snapshot=f.state().snapshots.get(first.snapshotId!)!;assert.equal(unprotectPayload<any>(keyring,{patientId:f.patientId,resourceId:snapshot.id,schema:'snapshot.v1'},snapshot.protectedPayload).ehr.clinical,'SYNTHETIC CLINICAL');
});
test('EDA Records stale versions revoked ownership consent and unknown financial authority deny preparation',async()=>{
  const setups:Array<(f:ReturnType<typeof fixture>)=>void>=[f=>f.revoked(),f=>f.consent(false),f=>f.busy(),f=>f.stale(),f=>{f.state().appointment.version=2;}];
  for(const setup of setups){
    const f=fixture();setup(f);await assert.rejects(f.module.prepareSnapshot(f.actor('snapshot.prepare'),f.meta(),{workflowId:randomUUID(),appointmentId:f.id,expectedVersion:1}));assert.equal(f.state().workflows.size,0);
  }
  const f=fixture(),actor={...f.actor('snapshot.prepare'),authId:randomUUID()};await assert.rejects(f.module.prepareSnapshot(actor,f.meta(),{workflowId:randomUUID(),appointmentId:f.id,expectedVersion:1}),isCode('RECORDS_DOCTOR_DENIED'));
});
test('EDA Records capture rejects forged evidence changed association and atomically rolls back outbox failure',async()=>{
  for(const mode of ['forged','association','outbox']){
    const f=fixture(),workflowId=randomUUID(),p=await f.module.prepareSnapshot(f.actor('snapshot.prepare'),f.meta(),{workflowId,appointmentId:f.id,expectedVersion:1}),payload={clinical:'SYNTHETIC'};
    if(mode==='association')f.state().appointment.associationVersion=2;if(mode==='outbox')f.fail();
    await assert.rejects(f.module.captureSnapshot(f.actor('snapshot.capture',workflowId),workflowId,f.meta(),{inputHash:p.inputHash,payload,receipt:mode==='forged'?'forged':f.receipt(workflowId,payload)}));
    assert.equal(f.state().snapshots.size,0);assert.equal(f.state().grant.snapshotId,null);assert.equal(f.state().workflows.get(workflowId).state,'prepared');
  }
});
test('EDA Records committed workflow cannot present changed snapshot data as an idempotent capture',async()=>{
  const f=fixture(),workflowId=randomUUID(),p=await f.module.prepareSnapshot(f.actor('snapshot.prepare'),f.meta(),{workflowId,appointmentId:f.id,expectedVersion:1}),payload={clinical:'SYNTHETIC BASELINE'};
  await f.module.captureSnapshot(f.actor('snapshot.capture',workflowId),workflowId,f.meta(),{inputHash:p.inputHash,payload,receipt:f.receipt(workflowId,payload)});
  const changed={clinical:'SYNTHETIC SUBSTITUTION'};
  await assert.rejects(f.module.captureSnapshot(f.actor('snapshot.capture',workflowId),workflowId,f.meta(),{inputHash:p.inputHash,payload:changed,receipt:f.receipt(workflowId,changed)}),isCode('RECORDS_WORKFLOW_REPLAY_CONFLICT'));
  assert.equal(f.state().snapshots.size,1);
});
test('EDA Records paperwork deadline closes without a snapshot or completion public status change',()=>{
  const f=fixture(),row=f.state().appointment;assertPaperwork(row,f.now);row.proposedEndAt=new Date(f.now-86400000);assert.equal(paperworkDeadline(row).getTime(),f.now);
  assert.throws(()=>assertPaperwork(row,f.now),isCode('RECORDS_PAPERWORK_CLOSED'));assert.equal(row.status,'confirmed');
  row.completionDeadlineAt=new Date(f.now+1);assertPaperwork(row,f.now);row.paperworkLockedAt=new Date(f.now);assert.throws(()=>assertPaperwork(row,f.now));
});
test('EDA Records read-only recovery after deadline cannot reopen paperwork and permits verified completion',async()=>{
  const f=fixture();f.state().appointment.proposedEndAt=new Date(f.now-86400000-1);const workflowId=randomUUID();
  await assert.rejects(f.module.prepareSnapshot(f.actor('snapshot.prepare'),f.meta(),{workflowId:randomUUID(),appointmentId:f.id,expectedVersion:1}),isCode('RECORDS_PAPERWORK_CLOSED'));
  const p=await f.module.prepareSnapshot(f.actor('snapshot.prepare'),f.meta(),{workflowId,appointmentId:f.id,expectedVersion:1,recovery:true}),payload={clinical:'SYNTHETIC RECOVERY'};
  await f.module.captureSnapshot(f.actor('snapshot.capture',workflowId),workflowId,f.meta(),{inputHash:p.inputHash,payload,receipt:f.receipt(workflowId,payload)});
  await f.lifecycle.apply(f.tx as any,f.state().appointment,'complete',{operationId:randomUUID(),beforeState:'confirmed',afterState:'completed',effectiveAt:paperworkDeadline(f.state().appointment)});
  assert.equal(f.state().grant.status,'historical');assert.equal(f.state().freezes.size,1);assert.throws(()=>assertPaperwork(f.state().appointment,f.now));
  assert.ok(f.calls.every(c=>!c.sql.includes('INSERT INTO patients')&&!c.sql.includes('INSERT INTO cases')));
});
test('EDA Records doctor acknowledgement requires snapshot and freezes a local evidence cutoff once',async()=>{
  const f=fixture(),context={operationId:randomUUID(),beforeState:'confirmed',afterState:'confirmed',effectiveAt:new Date(f.now)};
  await assert.rejects(f.lifecycle.beforeDoctorAcknowledgement!(f.tx as any,f.state().appointment,context),isCode('RECORD_SNAPSHOT_REQUIRED'));
  const w=randomUUID(),p=await f.module.prepareSnapshot(f.actor('snapshot.prepare'),f.meta(),{workflowId:w,appointmentId:f.id,expectedVersion:1}),payload={clinical:'SYNTHETIC'};
  await f.module.captureSnapshot(f.actor('snapshot.capture',w),w,f.meta(),{inputHash:p.inputHash,payload,receipt:f.receipt(w,payload)});
  await f.lifecycle.beforeDoctorAcknowledgement!(f.tx as any,f.state().appointment,context);const old=JSON.stringify([...f.state().freezes.values()]);
  await f.lifecycle.beforeDoctorAcknowledgement!(f.tx as any,f.state().appointment,{...context,effectiveAt:new Date(f.now+1000)});assert.equal(JSON.stringify([...f.state().freezes.values()]),old);
});
test('EDA Records cancellation freezes post-baseline local evidence without rewriting the source snapshot',async()=>{
  const f=fixture(),workflowId=randomUUID(),prepared=await f.module.prepareSnapshot(f.actor('snapshot.prepare'),f.meta(),{workflowId,appointmentId:f.id,expectedVersion:1}),payload={clinical:'SYNTHETIC'};
  const captured=await f.module.captureSnapshot(f.actor('snapshot.capture',workflowId),workflowId,f.meta(),{inputHash:prepared.inputHash,payload,receipt:f.receipt(workflowId,payload)});
  const source=JSON.stringify(f.state().snapshots.get(captured.snapshotId!)),documentId=randomUUID(),assetId=randomUUID();
  f.state().documents.set(documentId,{id:documentId,assetId,patientId:f.patientId,kind:'prescription',issuedAt:new Date(f.now+1000),protectedPayload:protectPayload(keyring,{patientId:f.patientId,resourceId:documentId,schema:'document.v1'},{lines:[],signatureBase64:'PRIVATE_SIGNATURE_TEST',signatureHash:'test-hash'})});
  const context={operationId:randomUUID(),beforeState:'confirmed',afterState:'cancelled',effectiveAt:new Date(f.now+2000)} as const;
  await f.lifecycle.apply(f.tx as any,f.state().appointment,'cancel',context);
  assert.equal(f.state().grant.status,'historical');assert.equal(f.state().grant.frozenSnapshotId,captured.snapshotId);
  const freeze=f.state().freezes.get(f.id)!;
  const local=unprotectPayload<any>(keyring,{patientId:f.patientId,resourceId:f.id,schema:'freeze.v1'},freeze.protectedPayload);
  assert.equal(local.documents[0].id,documentId);assert.equal(local.documents[0].signatureBase64,undefined);assert.equal(local.documents[0].signatureHash,'test-hash');assert.equal(JSON.stringify(f.state().snapshots.get(captured.snapshotId!)),source);
  assert.ok(f.state().refs.some(ref=>ref[0]===captured.snapshotId&&ref[1]===assetId));
});

test('EDA Records evidence collection bounds fail atomically instead of truncating historical documents',async()=>{
  for(const mode of ['capture','freeze']){
    const f=fixture(),workflowId=randomUUID(),prepared=await f.module.prepareSnapshot(f.actor('snapshot.prepare'),f.meta(),{workflowId,appointmentId:f.id,expectedVersion:1}),payload={clinical:'SYNTHETIC'};
    const capture=()=>f.module.captureSnapshot(f.actor('snapshot.capture',workflowId),workflowId,f.meta(),{inputHash:prepared.inputHash,payload,receipt:f.receipt(workflowId,payload)});
    if(mode==='freeze')await capture();
    for(let i=0;i<257;i++){const id=randomUUID();f.state().documents.set(id,{id,patientId:f.patientId,assetId:randomUUID(),kind:'prescription',issuedAt:new Date(f.now-1),protectedPayload:{}});}
    if(mode==='capture'){await assert.rejects(capture(),isCode('RECORDS_EVIDENCE_COLLECTION_LIMIT'));assert.equal(f.state().snapshots.size,0);}
    else await assert.rejects(f.lifecycle.beforeDoctorAcknowledgement!(f.tx as any,f.state().appointment,{operationId:randomUUID(),beforeState:'confirmed',afterState:'confirmed',effectiveAt:new Date(f.now)}),isCode('RECORDS_EVIDENCE_COLLECTION_LIMIT'));
    assert.equal(f.state().freezes.size,0);assert.equal(f.state().grant.frozenSnapshotId,null);
    assert.ok(f.calls.filter(call=>call.sql.includes('WHERE "patientId"=$1 AND "issuedAt"')).every(call=>call.sql.includes('LIMIT 257')));
  }
});

test('EDA Records document commits once before rendering and unresolved reschedules prevent issuance',async()=>{
  const f=fixture(),workflowId=randomUUID(),data={signingConfirmed:true,lines:[{medicineName:'SYNTHETIC MEDICINE',isControlled:false,dosageAmount:'1',dosageUnit:'mg',frequency:'Daily'}]},p=await f.module.prepareDocument(f.actor('document.prepare'),f.meta(),{workflowId,kind:'prescription',patientId:f.patientId,appointmentId:f.id,expectedVersion:1,data});
  const meta=f.meta(),body={workflowId,inputHash:p.inputHash,data,receipt:f.receipt(workflowId,data,'treatment')},actor=f.actor('document.issue',workflowId);
  const result=await f.module.issueDocument(actor,meta,body);assert.equal(result.operationStatus,'pending');assert.deepEqual(await f.module.issueDocument(actor,meta,body),result);
  assert.equal(f.state().documents.size,1);assert.equal(f.state().operations.size,1);assert.equal(f.objectWrites(),0);assert.equal(f.partyCalls(),1);
  assert.doesNotMatch(JSON.stringify([...f.state().documents.values(),...f.state().events,...f.state().workflows.values()]),/SYNTHETIC MEDICINE|SYNTHETIC PATIENT/);
  const blocked=fixture();blocked.busy();await assert.rejects(blocked.module.prepareDocument(blocked.actor('document.prepare'),blocked.meta(),{workflowId:randomUUID(),kind:'prescription',patientId:blocked.patientId,appointmentId:blocked.id,expectedVersion:1,data}),isCode('RECORDS_APPOINTMENT_TRANSITION_PENDING'));
});
test('EDA Records omitted appointment cannot bypass linked-case paperwork and current financial checks',async()=>{
  const f=fixture(),workflowId=randomUUID(),data={signingConfirmed:true,purpose:'SYNTHETIC',diagnosis:'SYNTHETIC'};
  const p=await f.module.prepareDocument(f.actor('document.prepare',f.patientId),f.meta(),{workflowId,kind:'medical-certificate',patientId:f.patientId,expectedVersion:0,data});
  f.state().appointment.paperworkLockedAt=new Date(f.now);
  await assert.rejects(f.module.issueDocument(f.actor('document.issue',workflowId),f.meta(),{workflowId,inputHash:p.inputHash,data,receipt:f.receipt(workflowId,data,'treatment')}),isCode('RECORDS_PAPERWORK_CLOSED'));
  assert.equal(f.state().documents.size,0);
});
test('EDA Records Auth-ID document preparation resolves Core identity and fences the captured Profile revision',async()=>{
  const f=fixture(),workflowId=randomUUID(),data={signingConfirmed:true,purpose:'SYNTHETIC',diagnosis:'SYNTHETIC'};f.profileVersion(7);
  const input={workflowId,kind:'medical-certificate',patientAuthId:f.patientAuthId,expectedVersion:0,data};
  const prepared=await f.module.prepareDocument(f.actor('document.prepare',f.patientAuthId),f.meta(),input);
  assert.equal(prepared.expectedVersion,7);assert.equal(f.state().workflows.get(workflowId).patientId,f.patientId);
  await assert.rejects(f.module.prepareDocument(f.actor('document.prepare',f.patientAuthId),f.meta(),{...input,workflowId:randomUUID(),expectedVersion:7}),isCode('RECORDS_PROFILE_VERSION_CHANGED'));
  await assert.rejects(f.module.prepareDocument(f.actor('document.prepare',f.patientAuthId),f.meta(),{...input,patientId:f.patientId}));
  f.profileVersion(8);
  await assert.rejects(f.module.issueDocument(f.actor('document.issue',workflowId),f.meta(),{workflowId,inputHash:prepared.inputHash,data,receipt:f.receipt(workflowId,data,'treatment')}),isCode('RECORDS_PROFILE_VERSION_CHANGED'));
  await assert.rejects(f.module.issueDocument(f.actor('document.issue',workflowId),f.meta(),{workflowId,inputHash:prepared.inputHash,data,receipt:f.receipt(workflowId,data,'treatment',{caseId:randomUUID(),externalSystemRef:null})}),isCode('RECORDS_PROFILE_VERSION_CHANGED'));
  assert.equal(f.state().documents.size,0);
});

test('EDA Records upload binds exact bytes stores encrypted metadata and stays unavailable in quarantine',async()=>{
  const f=fixture(),meta=f.meta(),bytes=Buffer.from('%PDF-1.7\nsynthetic'),descriptor={operationId:meta.operationId,byteLength:bytes.length,sha256:sha256(bytes),mimeType:'application/pdf',title:'SYNTHETIC PRIVATE FILE',description:null};
  const actor=f.actor('upload',meta.operationId,'patient');await f.files.upload(actor,meta,descriptor,bytes);await f.files.upload(actor,meta,descriptor,bytes);
  assert.equal(f.state().assets.size,1);assert.equal(f.state().events.filter(e=>e.eventType==='vital.audit.requested').length,1);assert.doesNotMatch(JSON.stringify([...f.state().assets.values(),...f.state().events]),/SYNTHETIC PRIVATE FILE/);
  await assert.rejects(f.files.link(f.actor('file.link',meta.operationId,'patient'),meta.operationId,f.meta(),{expectedVersion:0}),isCode('RECORDS_FILE_NOT_READY'));
  await assert.rejects(f.files.upload(actor,meta,descriptor,Buffer.from('tampered')),isCode('UPLOAD_CHECKSUM_MISMATCH'));
});
test('EDA Records normalization removes temporary capabilities while preserving EHR attachment ownership',()=>{
  assert.deepEqual(normalizeEhrSnapshot({files:[{id:'ehr-asset',file_url:'https://ehr.invalid/file?X-Amz-Signature=secret'}],link:'https://ehr.invalid/file?token=secret'}),{files:[{id:'ehr-asset',file_url:{owner:'uhse-ehr',attachmentId:'ehr-asset'}}],link:null});
});
test('EDA Records integration reader delegation is route scoped and never invents Core membership',()=>{
  const f=fixture(),actor={...f.actor('integration.read','records:integration'),role:'service' as const,authId:randomUUID()},token=jwt.sign({delegation:{system:'ehr',roles:['nurse'],isSuperAdmin:false}},privateKey,{algorithm:'RS256'});
  assert.equal(recordsReaderDelegation(token,actor,'GET','/internal/v1/records/documents?limit=10'),true);
  for(const [method,path]of [['POST','/internal/v1/records/documents'],['GET','/internal/v1/profile/membership']])assert.throws(()=>recordsReaderDelegation(token,actor,method!,path!),isCode('RECORDS_INTEGRATION_DELEGATION_DENIED'));
  assert.throws(()=>recordsReaderDelegation(token,{...actor,scopes:['records.document.issue']},'GET','/internal/v1/records/documents'));
});
test('EDA Records historical file access checks consent on the authorizing snapshot episode',async()=>{
  const f=fixture(),assetId=randomUUID(),origin=randomUUID(),episode=randomUUID();let accepted=false;
  const asset={id:assetId,patientId:f.patientId,appointmentId:origin,kind:'prescription',state:'ready',version:1,publishedKey:'records/final/synthetic.pdf'};
  const queries:Array<{sql:string;args:unknown[]}>=[];
  const tx={release(){},async query(sql:string,args:unknown[]=[]){queries.push({sql,args});
    if(sql.includes('SELECT p.* FROM vital_'))return{rows:[{userId:f.doctorId}],rowCount:1};
    if(sql.includes('SELECT * FROM records_file_assets'))return{rows:[asset],rowCount:1};
    if(sql.includes('FROM records_snapshot_assets'))return{rows:[{appointmentId:episode}],rowCount:1};
    if(sql.includes('SELECT accepted FROM consent_records'))return{rows:[{accepted:args[1]===origin||accepted}],rowCount:1};
    if(sql.includes('SELECT a.id FROM appointments'))return{rows:[],rowCount:0};
    return{rows:[],rowCount:0};}};
  const pool={connect:async()=>tx,query:tx.query.bind(tx)} as unknown as Pool;
  const storage={key:()=>'',putQuarantine:async()=>{},readQuarantine:async()=>Buffer.alloc(0),ensureFinal:async()=>{},inspectFinal:async()=>false,signedLink:async()=>''};
  const files=createRecordsFiles(pool,f.config,storage,()=>f.now);
  await assert.rejects(files.read(f.actor('file.read',assetId),assetId),isCode('RECORDS_FILE_ACCESS_DENIED'));
  assert.deepEqual(queries.filter(q=>q.sql.includes('SELECT accepted')).map(q=>q.args[1]),[episode]);
  accepted=true;assert.equal((await files.read(f.actor('file.read',assetId),assetId)).assetId,assetId);
});
test('EDA Records runtime and artifact flags default off and dependencies never fall back to legacy',()=>{
  const f=fixture();assert.equal(recordsRuntime({corePool:f.pool},undefined,{}),undefined);
  assert.throws(()=>recordsRuntime({corePool:f.pool},undefined,{VITAL_EDA_RECORDS_ARTIFACTS_ENABLED:'true'}));
  assert.throws(()=>recordsRuntime({corePool:f.pool},undefined,{VITAL_EDA_RECORDS_ENABLED:'true'}));
  assert.throws(()=>recordsRuntime({corePool:f.pool},undefined,{VITAL_EDA_ENABLED:'true',VITAL_EDA_RECORDS_ENABLED:'true'}));assert.equal(f.calls.length,0);
});
test('EDA Records access-plan replay rechecks consent payment and effective deadline under lock',async()=>{
  const invalidations:Array<(f:ReturnType<typeof fixture>)=>void>=[f=>f.consent(false),f=>f.stale(),f=>{f.state().appointment.proposedEndAt=new Date(f.now-86400000);}];
  for(const invalidate of invalidations){
    const f=fixture(),meta=f.meta(),actor=f.actor('access'),input={appointmentId:f.id,expectedVersion:1};
    await f.module.accessPlan(actor,meta,input);invalidate(f);await assert.rejects(f.module.accessPlan(actor,meta,input));
    assert.equal(f.state().commands.size,1);
  }
});
test('EDA Records doctor document listing applies consent to rows and pagination totals',async()=>{
  const f=fixture(),id=randomUUID();f.state().documents.set(id,{id,patientId:f.patientId,doctorId:f.doctorId,appointmentId:f.id,kind:'prescription',assetId:randomUUID(),accessCode:'RX-SYNTHETIC',issuedAt:new Date(f.now),
    protectedPayload:protectPayload(keyring,{patientId:f.patientId,resourceId:id,schema:'document.v1'},{lines:[{medicineName:'SYNTHETIC',dosageAmount:'1',dosageUnit:'mg',frequency:'Daily'}]})});
  const actor=f.actor('documents.read',f.doctorAuthId);assert.equal((await f.module.listDocuments(actor,{})).items.length,1);
  f.consent(false);const denied=await f.module.listDocuments(actor,{});assert.equal(denied.items.length,0);assert.equal(denied.total,0);
  assert.ok(f.calls.filter(c=>c.sql.includes('FROM records_documents d')).every(c=>c.sql.includes('c."consentType"')));
});
test('EDA Records episode and patient directories use relevant episode consent rather than global-only authority',async()=>{
  const f=fixture();assert.equal((await f.module.episodes(f.actor('episodes.read',f.patientId),f.patientId)).items.length,1);
  assert.equal((await f.module.listPatients(f.actor('patients.read',f.doctorAuthId))).items.length,1);
  const selects=f.calls.filter(call=>call.sql.includes('c."consentType"'));
  assert.ok(selects.every(call=>call.sql.includes('c."appointmentId" IS NULL OR c."appointmentId"=')));
  assert.ok(f.calls.every(call=>!call.sql.includes('SELECT accepted FROM consent_records')));
  f.consent(false);assert.equal((await f.module.episodes(f.actor('episodes.read',f.patientId),f.patientId)).items.length,0);
  assert.equal((await f.module.listPatients(f.actor('patients.read',f.doctorAuthId))).items.length,0);
});

test('EDA Records doctor identity context denies revoked empty episodes absent consent and admin scope substitution',async()=>{
  const f=fixture(),actor=f.actor('context',f.patientId);
  assert.equal((await f.module.patientContext(actor,f.patientId)).authId,f.patientAuthId);
  f.state().grant.status='revoked';await assert.rejects(f.module.patientContext(actor,f.patientId),isCode('RECORDS_DOCTOR_DENIED'));
  f.state().grant.snapshotId=randomUUID();assert.equal((await f.module.patientContext(actor,f.patientId)).patientId,f.patientId);
  f.consent(false);await assert.rejects(f.module.patientContext(actor,f.patientId),isCode('RECORDS_DOCTOR_DENIED'));
  await assert.rejects(f.module.patientContext({...actor,role:'admin'},f.patientId),isCode('RECORDS_READER_DENIED'));
});

test('EDA Records upload replays preserve retry backoff and never touch terminal storage',async()=>{
  const f=fixture(),meta=f.meta(),bytes=Buffer.from('%PDF-1.7 synthetic'),descriptor={operationId:meta.operationId,byteLength:bytes.length,sha256:sha256(bytes),mimeType:'application/pdf',title:'SYNTHETIC',description:null};
  const actor=f.actor('upload',meta.operationId,'patient');await f.files.upload(actor,meta,descriptor,bytes);f.state().operations.get(meta.operationId).attempts=4;
  await f.files.upload(actor,meta,descriptor,bytes);assert.ok(f.calls.every(c=>!c.sql.includes('UPDATE record_operations SET "nextAttemptAt"')));
  f.state().operations.get(meta.operationId).state='completed';const writes=f.objectWrites();assert.equal((await f.files.upload(actor,meta,descriptor,bytes)).operationStatus,'completed');assert.equal(f.objectWrites(),writes);
});
test('EDA Records actual HTTP binary hop rejects header forgery byte substitution and chunked envelopes',async()=>{
  const f=fixture(),app=express();
  // Explicit unit-only peer fixture. Real process mTLS remains an isolated-suite gate.
  app.use((req,_res,next)=>{Object.defineProperty(req.socket,'authorized',{value:true,configurable:true});Object.assign(req.socket,{getPeerCertificate:()=>({subject:{CN:'vital-web'}})});next();});
  app.use(createEdaApp({} as any,{issuer:'vital-web',audience:'vital-services',peerName:'vital-web',keyId:'test',publicKey},false,undefined,undefined,undefined,
    {module:f.module,files:f.files,lifecycle:f.lifecycle,artifactTick:async()=>0} as RecordsRuntime));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const url='http://127.0.0.1:'+(server.address() as {port:number}).port,path='/internal/v1/records/uploads',bytes=Buffer.from('%PDF-1.7 synthetic'),operationId=randomUUID();
  const descriptor={operationId,byteLength:bytes.length,sha256:sha256(bytes),mimeType:'application/pdf',title:'SYNTHETIC',description:null};
  const actor=f.actor('upload',operationId,'patient');
  const token=jwt.sign({actor,action:'POST '+path,requestHash:requestHash('POST',path,descriptor)},privateKey,{algorithm:'RS256',keyid:'test',issuer:'vital-web',audience:'vital-services',subject:actor.authId,jwtid:operationId,expiresIn:30});
  const headers={'Content-Type':'application/octet-stream','Content-Length':String(bytes.length),'X-Vital-Upload-Descriptor':Buffer.from(JSON.stringify(descriptor)).toString('base64url'),'X-Vital-Actor-Assertion':token};
  try{
    const chunkedHeaders:Record<string,string>={...headers,'Transfer-Encoding':'chunked'};delete chunkedHeaders['Content-Length'];
    const chunkedStatus=await new Promise<number>((resolve,reject)=>{
      const request=httpRequest(url+path,{method:'POST',headers:chunkedHeaders},response=>{response.resume();resolve(response.statusCode??0);});
      request.once('error',reject);request.end(bytes);
    });
    assert.equal(chunkedStatus,400);assert.equal(f.state().assets.size,0);
    assert.equal((await fetch(url+path,{method:'POST',headers:{...headers,'X-Vital-Actor-Assertion':'forged','X-User-Id':actor.authId},body:bytes})).status,401);assert.equal(f.state().assets.size,0);
    assert.equal((await fetch(url+path,{method:'POST',headers,body:Buffer.alloc(bytes.length,65)})).status,400);assert.equal(f.state().assets.size,0);
    const accepted=await fetch(url+path,{method:'POST',headers,body:bytes});assert.equal(accepted.status,202);const body=await accepted.json() as any;assert.equal(body.contractVersion,1);assert.equal(body.data.assetId,operationId);
    const altered={...descriptor,title:'CHANGED INPUT'};assert.equal((await fetch(url+path,{method:'POST',headers:{...headers,'X-Vital-Upload-Descriptor':Buffer.from(JSON.stringify(altered)).toString('base64url')},body:bytes})).status,401);
    assert.equal(f.state().assets.size,1);assert.equal(f.state().events.filter(e=>e.eventType==='vital.audit.requested').length,1);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});


test('S6 ordinary, mixed and controlled issuance snapshots flags, signature and current S2 dates',async()=>{
 const missing=fixture();missing.prc(null);const workflowId=randomUUID(),data={signingConfirmed:true,lines:[{medicineName:'DEMO Generic',isControlled:false,dosageAmount:'1',dosageUnit:'tablet',frequency:'Daily'}]};
 const prepared=await missing.module.prepareDocument(missing.actor('document.prepare'),missing.meta(),{workflowId,kind:'prescription',patientId:missing.patientId,appointmentId:missing.id,expectedVersion:1,data});
 await assert.rejects(missing.module.issueDocument(missing.actor('document.issue',workflowId),missing.meta(),{workflowId,inputHash:prepared.inputHash,data,receipt:missing.receipt(workflowId,data,'treatment')}),isCode('SIGNING_PROFILE_REQUIRED'));
 assert.equal(missing.state().documents.size,0);

 for(const flags of [[false],[true],[false,true]]){
  const f=fixture(),workflowId=randomUUID(),data={signingConfirmed:true,lines:flags.map(isControlled=>({medicineName:'DEMO Generic',isControlled,dosageAmount:'1',dosageUnit:'tablet',frequency:'Daily'}))};
  const prepared=await f.module.prepareDocument(f.actor('document.prepare'),f.meta(),{workflowId,kind:'prescription',patientId:f.patientId,appointmentId:f.id,expectedVersion:1,data});
  const issued=await f.module.issueDocument(f.actor('document.issue',workflowId),f.meta(),{workflowId,inputHash:prepared.inputHash,data,receipt:f.receipt(workflowId,data,'treatment')});
  const saved=f.state().documents.get(issued.id),binding={patientId:f.patientId,resourceId:issued.id,schema:'document.v1'};
  const snapshot=unprotectPayload<Record<string,any>>(keyring,binding,saved.protectedPayload);
  assert.deepEqual(snapshot.lines.map((line:any)=>line.isControlled),flags);assert.equal(snapshot.templateVersion,'bgh-capstone-v1');
  const retrieval=new URL(snapshot.retrievalUrl);
  assert.equal(retrieval.origin,'https://web.example.test');assert.equal(retrieval.pathname,'/documents/prescription/'+issued.id);assert.equal(retrieval.search,'');
  const{contentHash,...unsigned}=snapshot;assert.equal(contentHash,clinicalHash(unsigned));
  const before=JSON.stringify(saved.protectedPayload);f.signature.s2License='CHANGED-DEMO';assert.equal(JSON.stringify(saved.protectedPayload),before);
 }
 for(const until of ['2020-01-01','2030-01-01']){
  const f=fixture();f.signature.s2ValidFrom=new Date(until==='2020-01-01'?'2019-01-01Z':'2029-01-01Z');f.signature.s2ValidUntil=new Date(until+'Z');
  const workflowId=randomUUID(),data={signingConfirmed:true,lines:[{medicineName:'DEMO Generic',isControlled:true,dosageAmount:'1',dosageUnit:'tablet',frequency:'Daily'}]};
  const prepared=await f.module.prepareDocument(f.actor('document.prepare'),f.meta(),{workflowId,kind:'prescription',patientId:f.patientId,appointmentId:f.id,expectedVersion:1,data});
  await assert.rejects(f.module.issueDocument(f.actor('document.issue',workflowId),f.meta(),{workflowId,inputHash:prepared.inputHash,data,receipt:f.receipt(workflowId,data,'treatment')}),isCode('S2_VALIDITY_REQUIRED'));
  assert.equal(f.state().documents.size,0);
 }
});

function signingFixture(failure?: string, inspector?: FileInspector) {
  const owner=randomUUID(),rows:Array<Record<string,any>>=[],events:unknown[]=[],queries:string[]=[];
  let pointer:string|null=null, scans=0;
  const query=async(sql:string,args:unknown[]=[])=>{
    queries.push(sql);let result:unknown[]=[];
    if(sql.startsWith('SELECT p.* FROM vital_doctors'))result=args[0]===owner?[{userId:randomUUID()}]:[];
    else if(sql.startsWith('SELECT s.id'))result=rows.filter(row=>row.id===pointer&&row.doctorAuthId===args[0]);
    else if(sql.startsWith('SELECT id,"inputHash"'))result=rows.filter(row=>row.doctorAuthId===args[0]&&row.operationId===args[1]);
    else if(sql.startsWith('INSERT INTO doctor_signatures'))rows.push({id:args[0],doctorAuthId:args[1],operationId:args[2],inputHash:args[3],contentHash:args[4],protectedPayload:JSON.parse(String(args[5])),createdAt:new Date()});
    else if(sql.startsWith('UPDATE vital_doctors'))pointer=String(args[1]);
    else if(sql.startsWith('INSERT INTO outbox_events'))events.push(args);
    else if(!['BEGIN','COMMIT','ROLLBACK'].includes(sql)&&!sql.includes('pg_advisory_xact_lock'))throw new Error('Unexpected signing query');
    return{rows:result,rowCount:result.length};
  };
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
  const scanner:RecordsScanner={async scan(bytes){scans++;if(failure)throw new ArtifactError(failure,true);return{engine:'clamav',engineVersion:'TEST',databaseVersion:1,databaseDate:new Date(Date.now()-1000).toISOString(),scannedAt:new Date().toISOString(),contentHash:sha256(bytes),byteLength:bytes.length,verdict:'clean'};}};
  const actor=(write=true):Actor=>({authId:owner,resource:owner,role:'doctor',serviceId:'vital-web',scopes:['records.signature.'+(write?'write':'read')],correlationId:randomUUID(),isSuperAdmin:false});
  return{module:createDoctorSigning(pool,keyring,inspector??scanner),actor,rows,events,queries,scans:()=>scans};
}

test('S6 signature saves scanned encrypted versions and preserves replay and owner isolation',async()=>{
  const f=signingFixture(),bytes=await sharp({create:{width:30,height:10,channels:4,background:'#111111'}}).png().toBuffer();
  const raw={base64:bytes.toString('base64'),mimeType:'image/png'},operation=randomUUID(),first=await f.module.upload(f.actor(),operation,raw);
  assert.equal(f.scans(),2);assert.equal(f.rows.length,1);assert.equal(f.events.length,1);
  assert.doesNotMatch(JSON.stringify(f.rows[0]!.protectedPayload),new RegExp(raw.base64));
  assert.equal((await f.module.read(f.actor(false))).signature?.id,first.id);
  assert.deepEqual(await f.module.upload(f.actor(),operation,raw),first);assert.equal(f.rows.length,1);assert.equal(f.events.length,1);
  const original=JSON.stringify(f.rows[0]!.protectedPayload),second=await f.module.upload(f.actor(),randomUUID(),raw);
  assert.notEqual(second.id,first.id);assert.equal(f.rows.length,2);assert.equal(JSON.stringify(f.rows[0]!.protectedPayload),original);
  assert.equal((await f.module.read(f.actor(false))).signature?.id,second.id);
  await assert.rejects(f.module.read({...f.actor(false),role:'patient'}),isCode('SIGNATURE_DOCTOR_REQUIRED'));
  await assert.rejects(f.module.read({...f.actor(false),authId:randomUUID()}),isCode('ACTOR_SCOPE_DENIED'));
  await assert.rejects(f.module.upload(f.actor(),operation,{base64:Buffer.from('invalid').toString('base64'),mimeType:'image/png'}),isCode('SIGNATURE_INVALID'));
});

test('S6 signature scanner failures return safe retryable errors with metadata-only diagnostics',async t=>{
  const diagnostics:unknown[][]=[];t.mock.method(console,'error',(...args:unknown[])=>{diagnostics.push(args);});
  const bytes=await sharp({create:{width:10,height:10,channels:3,background:'#000000'}}).png().toBuffer();
  for(const failure of ['SCANNER_POLICY_UNVERIFIED','SCANNER_UNAVAILABLE','SCANNER_DATABASE_STALE']){
    const f=signingFixture(failure),actor=f.actor();
    await assert.rejects(f.module.upload(actor,randomUUID(),{base64:bytes.toString('base64'),mimeType:'image/png'}),error=>error instanceof DomainError&&error.status===503&&error.code==='SIGNATURE_SERVICE_UNAVAILABLE'&&!error.message.includes('SCANNER'));
    assert.equal(f.rows.length,0);assert.equal(f.events.length,0);assert.ok(!f.queries.includes('BEGIN'));
    assert.deepEqual(JSON.parse(String(diagnostics.at(-1)![0])),{level:'error',event:'vital.signature.upload_failed',correlationId:actor.correlationId,stage:'input_scan',code:failure});
  }
  assert.doesNotMatch(JSON.stringify(diagnostics),new RegExp(bytes.toString('base64')));
});

test('S6 signature HTTP scanner failure returns 503 and Retry-After instead of a generic 500',async t=>{
  t.mock.method(console,'error',()=>{});
  const f=signingFixture('SCANNER_POLICY_UNVERIFIED'),app=express();
  app.use((req,_res,next)=>{Object.defineProperty(req.socket,'authorized',{value:true,configurable:true});Object.assign(req.socket,{getPeerCertificate:()=>({subject:{CN:'vital-web'}})});next();});
  app.use(createEdaApp({} as any,{issuer:'vital-web',audience:'vital-services',peerName:'vital-web',keyId:'test',publicKey},false,undefined,undefined,undefined,{signing:f.module} as RecordsRuntime));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  try{
    const path='/internal/v1/records/signing-profile',body={base64:(await sharp({create:{width:10,height:10,channels:3,background:'#000000'}}).png().toBuffer()).toString('base64'),mimeType:'image/png'},actor=f.actor();
    const token=jwt.sign({actor,action:'POST '+path,requestHash:requestHash('POST',path,body)},privateKey,{algorithm:'RS256',keyid:'test',issuer:'vital-web',audience:'vital-services',subject:actor.authId,jwtid:randomUUID(),expiresIn:30});
    const response=await fetch('http://127.0.0.1:'+(server.address() as {port:number}).port+path,{method:'POST',headers:{'Content-Type':'application/json','X-Vital-Actor-Assertion':token},body:JSON.stringify(body)});
    assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'5');assert.equal(response.headers.get('x-correlation-id'),actor.correlationId);
    assert.deepEqual(await response.json(),{success:false,code:'SIGNATURE_SERVICE_UNAVAILABLE',message:'Signature processing is temporarily unavailable. Please try again later.'});
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('Capstone signature upload preview replacement and replay do not require antivirus',async()=>{
  const f=signingFixture(undefined,createFileInspector(()=>{throw new Error('No scanner configuration');}));
  const bytes=await sharp({create:{width:30,height:10,channels:4,background:'#111111'}}).png().toBuffer(),raw={base64:bytes.toString('base64'),mimeType:'image/png'},operation=randomUUID();
  const first=await f.module.upload(f.actor(),operation,raw);assert.equal(f.scans(),0);assert.equal((await f.module.read(f.actor(false))).signature?.id,first.id);
  assert.deepEqual(await f.module.upload(f.actor(),operation,raw),first);assert.equal(f.rows.length,1);
  const prior=JSON.stringify(f.rows[0]!.protectedPayload),replacement=await f.module.upload(f.actor(),randomUUID(),raw);assert.notEqual(replacement.id,first.id);assert.equal(JSON.stringify(f.rows[0]!.protectedPayload),prior);
  assert.equal(f.events.length,2);await assert.rejects(f.module.read({...f.actor(false),role:'patient'}),isCode('SIGNATURE_DOCTOR_REQUIRED'));
});

test('Capstone Records runtime constructs signing and artifact owners without scanner paths',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'vital-inspection-test-'));
  try{
    const keyFile=join(directory,'keys.json'),evidenceFile=join(directory,'evidence.json');
    await writeFile(keyFile,JSON.stringify({activeKeyId:'demo',keys:{demo:randomBytes(32).toString('base64')}}));
    await writeFile(evidenceFile,JSON.stringify({ehr:publicKey}));
    const runtime=recordsRuntime({corePool:{} as Pool},undefined,{VITAL_EDA_ENABLED:'true',VITAL_EDA_RECORDS_ENABLED:'true',VITAL_EDA_RECORDS_ARTIFACTS_ENABLED:'true',
      VITAL_RECORDS_KEYRING_FILE:keyFile,VITAL_EHR_RECORDS_PUBLIC_KEYS_FILE:evidenceFile,VITAL_RECORDS_STORAGE_ENDPOINT:'https://storage.example.test',VITAL_RECORDS_STORAGE_PUBLIC_ENDPOINT:'https://media.example.test',VITAL_RECORDS_STORAGE_BUCKET:'demo-records',VITAL_RECORDS_STORAGE_REGION:'local',VITAL_RECORDS_STORAGE_ACCESS_KEY:'fictional-access',VITAL_RECORDS_STORAGE_SECRET_KEY:'fictional-secret',VITAL_PAYMENT_APP_ORIGIN:'https://vital.example.test',VITAL_AUTH_INTERNAL_URL:'https://auth.example.test',VITAL_SERVICES_AUTH_PROFILE_KEY:'fictional-test-key',VITAL_RECORDS_FONT_REGULAR_FILE:'demo-regular.ttf',VITAL_RECORDS_FONT_BOLD_FILE:'demo-bold.ttf'});
    assert.ok(runtime?.signing);assert.equal(typeof runtime.artifactTick,'function');
  }finally{await rm(directory,{recursive:true,force:true});}
});
