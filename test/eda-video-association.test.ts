import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { DomainError } from '../src/eda/contracts/actor.js';
import { parseEvent } from '../src/eda/contracts/events.js';
import { createVideoAssociations } from '../src/eda/modules/video/association.js';
import { selectionHash,type VideoAuthority,type VideoWorkflowIntent,type VideoSagaIntent,type VideoSelection } from '../src/eda/modules/video/contracts.js';
import type { AppointmentRow } from '../src/eda/modules/appointment/appointment-contracts.js';

function fixture(selection:VideoSelection={meetingUrl:'https://meet.google.com/abc-defg-hij'}){
  const now=Date.now(),id=randomUUID(),source=randomUUID(),doctorId=randomUUID(),lineage=randomUUID(),generationId=randomUUID();
  const intent:VideoWorkflowIntent={workflowId:id,sourceAppointmentId:source,targetAppointmentId:source,doctorId,doctorAuthId:randomUUID(),patientAuthId:randomUUID(),kind:'approve',consultationType:'virtual',billingLineageId:lineage,quotaLineageId:lineage,expectedSourceVersion:0,expectedTargetVersion:0,associationVersion:1,selectionHash:selectionHash(selection),state:'prepared',expiresAt:new Date(now+300000),externalStartedAt:null,videoProcessingState:'pending',receipt:null,correlationId:randomUUID()};
  const saga:VideoSagaIntent={operationId:randomUUID(),doctorId,sourceAppointmentId:source,replacementAppointmentId:randomUUID(),doctorAuthId:intent.doctorAuthId,patientAuthId:intent.patientAuthId,billingLineageId:lineage,associationVersion:1,expectedSourceVersion:1,expectedReplacementVersion:0,requestHash:'a'.repeat(64),state:'preparing',deadlineAt:new Date(now+300000),pivotCommittedAt:null,correlationId:randomUUID(),sourceConsultationType:'virtual',replacementConsultationType:'virtual'};
  let state={resources:new Map<string,any>(),holds:new Map<string,any>(),sagas:new Map<string,any>(),events:[] as any[],generation:{id:selection.meetingGenerationId??generationId,doctorId,appointmentId:source,billingLineageId:lineage,purpose:'approval',status:'ready',claimedAppointmentId:null as string|null,reservedWorkflowId:null as string|null,connectionId:randomUUID(),connectionRevision:1,expiresAt:new Date(now+86400000),spaceName:'spaces/preserved_room',meetingUrl:'https://meet.google.com/abc-defg-hij',createdAt:new Date(now),version:1},connection:{status:'connected',revision:1}};
  let before=structuredClone(state),tail=Promise.resolve(),failCore=false,failOutbox=false,coreWrites=0;
  const sqls:string[]=[];const result=(rows:any[]=[],rowCount=rows.length)=>({rows,rowCount});
  async function query(sql:string,a:any[]=[]):Promise<{rows:any[];rowCount:number}>{sqls.push(sql);if(sql.includes('pg_advisory_xact_lock'))return result();
    if(sql.startsWith('SELECT * FROM video_workflow_holds'))return result(sql.includes('"workflowId"=$1')?(state.holds.has(a[0])?[structuredClone(state.holds.get(a[0]))]:[]):[...state.holds.values()].filter(h=>h.targetAppointmentId===a[0]&&h.state==='prepared'));
    if(sql.startsWith('SELECT "workflowId" FROM video_workflow_holds'))return result([...state.holds.values()].filter(h=>['prepared','finalized'].includes(h.state)).map(h=>({workflowId:h.workflowId})));
    if(sql.startsWith('SELECT "operationId","freezeToken"'))return result([...state.sagas.values()].filter(h=>h.state==='prepared').map(h=>({operationId:h.operationId,freezeToken:h.freezeToken})));
    if(sql.startsWith('SELECT * FROM video_association_holds'))return result(state.sagas.has(a[0])?[structuredClone(state.sagas.get(a[0]))]:[]);
    if(sql.startsWith('SELECT "operationId" FROM video_association_holds'))return result([...state.sagas.values()].filter(h=>h.billingLineageId===a[0]&&h.state==='prepared'));
    if(sql.startsWith('SELECT * FROM video_resources'))return result([...state.resources.values()].filter(r=>sql.includes('WHERE id=$1')?r.id===a[0]:sql.includes('"meetingUrlHash"=$1')?r.meetingUrlHash===a[0]:r.appointmentId===a[0]).map(r=>structuredClone(r)));
    if(sql.startsWith('SELECT id,"appointmentId","retiredAt"'))return result([...state.resources.values()].filter(r=>r.meetingUrlHash===a[0]));
    if(sql.startsWith('SELECT * FROM google_meet_generations'))return result(a[0]===state.generation.id?[structuredClone(state.generation)]:[]);
    if(sql.startsWith('SELECT status,revision'))return result(a[0]===state.generation.connectionId?[structuredClone(state.connection)]:[]);
    if(sql.startsWith('INSERT INTO video_resources')){const r={id:a[0],appointmentId:a[1],providerOriginAppointmentId:a[1],doctorId:a[2],billingLineageId:a[3],associationVersion:a[4],version:a[5],provider:'gmeet',meetingUrl:a[6],normalizedMeetingUrl:a[7],meetingUrlHash:a[8],validationStatus:'validated',googleSpaceName:a[9],generationId:a[10],linkGeneratedAt:a[11],preparedWorkflowId:a[12],retiredAt:null};state.resources.set(r.id,r);return result([structuredClone(r)],1);}
    if(sql.startsWith('INSERT INTO video_workflow_holds')){state.holds.set(a[0],{workflowId:a[0],targetAppointmentId:a[2],resourceId:a[9],resourceVersion:a[10],receipt:JSON.parse(a[12]),state:'prepared'});return result([],1);}
    if(sql.startsWith('INSERT INTO video_association_holds')){state.sagas.set(a[0],{operationId:a[0],billingLineageId:a[1],videoResourceId:a[8],videoResourceVersion:a[9],freezeToken:a[10],receipt:JSON.parse(a[11]),state:'prepared'});return result([],1);}
    if(sql.startsWith('UPDATE video_workflow_holds')){if(sql.includes('SET "updatedAt"'))return result([],1);state.holds.get(a[0]).state=sql.includes("state='aborted'")?'aborted':sql.includes("state='acknowledged'")?'acknowledged':'finalized';return result([],1);}
    if(sql.startsWith('UPDATE video_association_holds')){if(sql.includes('SET "updatedAt"'))return result([],1);state.sagas.get(a[0]).state=sql.includes("state='aborted'")?'aborted':'finalized';return result([],1);}
    if(sql.startsWith('UPDATE google_meet_generations')){const g=state.generation;if(g.id!==a[0])return result();if(sql.includes("status='claimed'")){if(g.reservedWorkflowId!==a[1]||g.status!=='ready'||g.claimedAppointmentId)return result();g.status='claimed';g.claimedAppointmentId=a[2];g.reservedWorkflowId=null;g.version++;}
      else if(sql.includes('SET "reservedWorkflowId"=NULL'))g.reservedWorkflowId=null;else{if(g.status!=='ready'||g.claimedAppointmentId||g.reservedWorkflowId&&g.reservedWorkflowId!==a[1])return result();g.reservedWorkflowId=a[1];}return result([],1);}
    if(sql.startsWith('UPDATE video_resources')){const r=state.resources.get(a[0]);if(sql.includes('"retiredAt"=NULL')){Object.assign(r,{appointmentId:a[1],billingLineageId:a[2],associationVersion:a[3],version:a[4],meetingUrl:a[5],normalizedMeetingUrl:a[6],meetingUrlHash:a[7],googleSpaceName:a[8],generationId:a[9],linkGeneratedAt:a[10],preparedWorkflowId:a[11],retiredAt:null});}
      else{r.version++;if(sql.includes('providerOriginAppointmentId')){r.appointmentId=a[1];r.associationVersion=a[2];}else{r.preparedWorkflowId=null;if(sql.includes('"retiredAt"=NOW()'))r.retiredAt=new Date(now);else r.linkSavedAt=a[1];}}return result([structuredClone(r)],1);}
    if(sql.startsWith('INSERT INTO outbox_events')){if(failOutbox){failOutbox=false;throw new Error('TEST_ASSOCIATION_OUTBOX_CRASH');}state.events.push(parseEvent({eventId:a[0],eventType:a[1],schemaVersion:1,producer:a[2],aggregateId:a[3],aggregateVersion:a[4],correlationId:a[5],causationId:a[6],occurredAt:a[7],data:JSON.parse(a[8])}));return result([],1);}
    throw new Error('UNEXPECTED_ASSOCIATION_SQL:'+sql);
  }
  const pool={query,connect:async()=>{let unlock:()=>void=()=>{};return{async query(sql:string,a:any[]=[]){if(sql==='BEGIN'){const prior=tail;tail=new Promise<void>(r=>{unlock=r;});await prior;before=structuredClone(state);return result();}if(sql==='ROLLBACK'){state=before;unlock();return result();}if(sql==='COMMIT'){unlock();return result();}return query(sql,a);},release(){}};}} as unknown as Pool;
  const authority:VideoAuthority={doctor:async()=>({doctorId}),appointment:async()=>{throw new Error('UNUSED');},generation:async()=>{throw new Error('UNUSED');},workflow:async()=>structuredClone(intent),saga:async()=>structuredClone(saga),
    completeWorkflow:async()=>{if(failCore){failCore=false;throw new Error('TEST_CORE_FINALIZATION_CRASH');}intent.videoProcessingState='finalized';coreWrites++;},
    abandonExpiredWorkflow:async()=>{if(intent.state==='prepared'&&!intent.externalStartedAt&&intent.expiresAt.getTime()<=now){intent.state='abandoned';return true;}return false;},expiredWorkflows:async()=>[]};
  const api=createVideoAssociations(pool,authority,()=>now);
  const row=()=>({id:source,doctorId,billingLineageId:lineage,associationVersion:1,consultationType:intent.consultationType,status:intent.state==='prepared'?'pending':'approved',version:intent.state==='prepared'?0:1}) as AppointmentRow;
  return{api,intent,saga,selection,state:()=>state,row,sqls,coreWrites:()=>coreWrites,failCore:()=>{failCore=true;},failOutbox:()=>{failOutbox=true;},
    prepare:()=>api.prepareWorkflow(id,selection),commit:(receipt:any)=>{intent.state='committed';intent.receipt=receipt;intent.videoProcessingState='prepared';},
    pivot:(receipt:any)=>{saga.pivotCommittedAt=new Date(now);saga.state='finalizing';saga.receipt=receipt;}};
}
const code=(value:string)=>(error:unknown)=>error instanceof DomainError&&error.code===value;

test('EDA Video manual workflow reserves before approval finalizes once and redacts all broker facts',async()=>{
  const f=fixture(),receipt=await f.prepare();assert.equal([...f.state().resources.values()][0].preparedWorkflowId,f.intent.workflowId);assert.equal(f.state().events.length,0);
  await f.api.validate(f.row());assert.deepEqual(await f.prepare(),receipt);f.commit(receipt);
  await f.api.finalizeWorkflow(f.intent.workflowId);await f.api.finalizeWorkflow(f.intent.workflowId);const r=[...f.state().resources.values()][0];
  assert.equal(r.version,1);assert.equal(r.preparedWorkflowId,null);assert.equal(r.meetingUrl,'https://meet.google.com/abc-defg-hij');assert.equal(f.state().events.length,2);
  assert.doesNotMatch(JSON.stringify(f.state().events),/meet\.google\.com|spaces\/|meetingUrl|token|clinical/);
});
test('EDA Video generated workflow claims exactly the reserved doctor source purpose and connection revision',async()=>{
  const f=fixture({meetingGenerationId:randomUUID()}),receipt=await f.prepare();assert.equal(f.state().generation.reservedWorkflowId,f.intent.workflowId);
  await f.api.validate(f.row());f.commit(receipt);await f.api.finalizeWorkflow(f.intent.workflowId);
  assert.equal(f.state().generation.status,'claimed');assert.equal(f.state().generation.claimedAppointmentId,f.intent.targetAppointmentId);assert.equal(f.state().generation.spaceName,'spaces/preserved_room');
});
test('EDA Video generated selection denies wrong account stale revision expired and conflicting claims',async()=>{
  for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.state().generation.doctorId=randomUUID();},(f:ReturnType<typeof fixture>)=>{f.state().generation.purpose='follow_up';},
    (f:ReturnType<typeof fixture>)=>{f.state().generation.expiresAt=new Date(0);},(f:ReturnType<typeof fixture>)=>{f.state().connection.revision++;},
    (f:ReturnType<typeof fixture>)=>{f.state().generation.reservedWorkflowId=randomUUID();}]){const f=fixture({meetingGenerationId:randomUUID()});mutate(f);await assert.rejects(f.prepare());assert.equal(f.state().holds.size,0);assert.equal(f.state().resources.size,0);}
});
test('EDA Video workflow selection hash both sources and missing required links cannot mutate resources',async()=>{
  const f=fixture();await assert.rejects(f.api.prepareWorkflow(f.intent.workflowId,{meetingUrl:'https://meet.google.com/xyz-abcd-efg'}),code('VIDEO_SELECTION_BINDING_INVALID'));
  await assert.rejects(f.api.prepareWorkflow(f.intent.workflowId,{...f.selection,meetingGenerationId:randomUUID()}));assert.equal(f.state().resources.size,0);
  const g=fixture({});await assert.rejects(g.prepare(),code('VIDEO_SELECTION_REQUIRED'));assert.equal(g.state().holds.size,0);
});
test('EDA Video committed association recovers Core acknowledgement failure without duplicate claim or audit',async()=>{
  const f=fixture({meetingGenerationId:randomUUID()}),receipt=await f.prepare();f.commit(receipt);f.failCore();await assert.rejects(f.api.finalizeWorkflow(f.intent.workflowId),/TEST_CORE/);
  assert.equal(f.state().holds.get(f.intent.workflowId).state,'finalized');assert.equal(f.state().generation.status,'claimed');assert.equal(await f.api.recover(),1);
  assert.equal(f.intent.videoProcessingState,'finalized');assert.equal(f.state().events.length,2);assert.equal([...f.state().resources.values()][0].version,1);
});
test('EDA Video association finalization outbox failure rolls back claim and resource before retry',async()=>{
  const f=fixture({meetingGenerationId:randomUUID()}),receipt=await f.prepare();f.commit(receipt);f.failOutbox();await assert.rejects(f.api.finalizeWorkflow(f.intent.workflowId),/OUTBOX_CRASH/);
  assert.equal(f.state().generation.status,'ready');assert.equal(f.state().holds.get(f.intent.workflowId).state,'prepared');assert.equal(f.state().events.length,0);
  await f.api.finalizeWorkflow(f.intent.workflowId);assert.equal(f.state().generation.status,'claimed');assert.equal(f.state().events.length,2);
});
test('EDA Video unknown external preparation retains hold beyond expiry until durable Core abandonment',async()=>{
  const f=fixture({meetingGenerationId:randomUUID()});await f.prepare();f.intent.expiresAt=new Date(0);f.intent.externalStartedAt=new Date();assert.equal(await f.api.recover(),0);
  assert.equal(f.state().holds.get(f.intent.workflowId).state,'prepared');assert.equal(f.state().generation.reservedWorkflowId,f.intent.workflowId);
  f.intent.externalStartedAt=null;assert.equal(await f.api.recover(),1);assert.equal(f.state().holds.get(f.intent.workflowId).state,'aborted');assert.equal(f.state().generation.reservedWorkflowId,null);
  const oldResource=[...f.state().resources.values()][0].id;
  f.intent.workflowId=randomUUID();f.intent.targetAppointmentId=randomUUID();f.intent.state='prepared';f.intent.expiresAt=new Date(Date.now()+300000);
  const reused=await f.api.prepareWorkflow(f.intent.workflowId,f.selection);assert.equal(reused.resourceId,oldResource);assert.equal(f.state().resources.size,1);assert.equal(f.state().generation.status,'ready');assert.equal(f.state().generation.reservedWorkflowId,f.intent.workflowId);
});
test('EDA Video in-person preparation persists verified no-resource receipt rather than a synthetic participant',async()=>{
  const f=fixture({});f.intent.consultationType='in_person';const receipt=await f.prepare();assert.equal(receipt.resourceId,null);assert.equal(receipt.resourceVersion,null);await f.api.validate(f.row());
  f.commit(receipt);await f.api.finalizeWorkflow(f.intent.workflowId);assert.equal(f.state().resources.size,0);assert.equal(f.intent.videoProcessingState,'finalized');
});
test('EDA Video follow-up generation binds source quota but creates a distinct target resource lineage',async()=>{
  const f=fixture({meetingGenerationId:randomUUID()});f.intent.kind='follow-up';f.intent.targetAppointmentId=randomUUID();f.intent.billingLineageId=randomUUID();f.state().generation.purpose='follow_up';
  const receipt=await f.prepare();assert.equal(receipt.billingLineageId,f.intent.billingLineageId);assert.notEqual(receipt.targetAppointmentId,receipt.sourceAppointmentId);assert.equal(f.state().generation.billingLineageId,f.intent.quotaLineageId);
});
test('EDA Video reschedule freezes preserves Google identity and transfers only after committed pivot',async()=>{
  const f=fixture({meetingGenerationId:randomUUID()}),workflow=await f.prepare();f.commit(workflow);await f.api.finalizeWorkflow(f.intent.workflowId);
  const receipt=await f.api.participant.prepare(f.saga.operationId);await assert.rejects(f.api.validate(f.row()),code('VIDEO_LINEAGE_ALREADY_FROZEN'));
  await assert.rejects(f.api.participant.finalize(f.saga.operationId,receipt.freezeToken),code('VIDEO_SAGA_PIVOT_REQUIRED'));
  f.pivot(receipt);await f.api.participant.finalize(f.saga.operationId,receipt.freezeToken);await f.api.participant.finalize(f.saga.operationId,receipt.freezeToken);
  const r=[...f.state().resources.values()][0];assert.equal(r.appointmentId,f.saga.replacementAppointmentId);assert.equal(r.providerOriginAppointmentId,f.saga.sourceAppointmentId);assert.equal(r.meetingUrl,'https://meet.google.com/abc-defg-hij');assert.equal(r.googleSpaceName,'spaces/preserved_room');assert.equal(r.generationId,f.state().generation.id);assert.equal(r.version,2);assert.equal(f.state().events.length,4);
});
test('EDA Video reschedule abort requires compensation and never releases a committed participant',async()=>{
  const f=fixture(),workflow=await f.prepare();f.commit(workflow);await f.api.finalizeWorkflow(f.intent.workflowId);const receipt=await f.api.participant.prepare(f.saga.operationId);
  await assert.rejects(f.api.participant.abort(f.saga.operationId,receipt.freezeToken),code('VIDEO_SAGA_ABORT_INTENT_REQUIRED'));
  f.saga.state='compensating';await f.api.participant.abort(f.saga.operationId,receipt.freezeToken);await f.api.participant.abort(f.saga.operationId,receipt.freezeToken);assert.equal([...f.state().resources.values()][0].appointmentId,f.saga.sourceAppointmentId);
  const g=fixture(),w=await g.prepare();g.commit(w);await g.api.finalizeWorkflow(g.intent.workflowId);const r=await g.api.participant.prepare(g.saga.operationId);g.pivot(r);await assert.rejects(g.api.participant.abort(g.saga.operationId,r.freezeToken),code('VIDEO_SAGA_ABORT_INTENT_REQUIRED'));
});
test('EDA Video saga rejects substituted receipts changed resources and type changes',async()=>{
  const f=fixture(),workflow=await f.prepare();f.commit(workflow);await f.api.finalizeWorkflow(f.intent.workflowId);const receipt=await f.api.participant.prepare(f.saga.operationId);f.pivot({...receipt,resourceId:randomUUID()});
  await assert.rejects(f.api.participant.finalize(f.saga.operationId,receipt.freezeToken),code('VIDEO_SAGA_FREEZE_RECEIPT_INVALID'));assert.equal(f.state().events.length,2);
  const g=fixture();g.saga.replacementConsultationType='in_person';await assert.rejects(g.api.participant.prepare(g.saga.operationId),code('VIDEO_SAGA_PREPARATION_INVALID'));
});
