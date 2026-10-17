import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";
import { createPaymentAssociation } from "../src/eda/modules/payment/payment-association.js";
import { createPaymentStore } from "../src/eda/modules/payment/payment-store.js";
import type { RescheduleIntent, ParticipantReceipt } from "../src/eda/modules/appointment/appointment-contracts.js";
import { DomainError } from "../src/eda/contracts/actor.js";
import { parseEvent } from "../src/eda/contracts/events.js";

const conflict=(error:unknown)=>error instanceof DomainError&&error.status===409;
function fixture(){
  const source=randomUUID(),replacement=randomUUID(),lineage=randomUUID(),operationId=randomUUID(),paymentId=randomUUID(),patientAuthId=randomUUID(),doctorAuthId=randomUUID();
  const intent:RescheduleIntent={operationId,correlationId:randomUUID(),sourceAppointmentId:source,replacementAppointmentId:replacement,billingLineageId:lineage,associationVersion:1,
    expectedSourceVersion:3,expectedReplacementVersion:1,requestHash:"a".repeat(64),deadlineAt:new Date(Date.now()+300000),pivotCommittedAt:null,state:"preparing",patientAuthId,doctorAuthId,amountCentavos:150000};
  let state={holds:new Map<string,Record<string,any>>(),payment:{id:paymentId,appointmentId:source,billingLineageId:lineage,associationVersion:1,version:4,
    providerMode:"sandbox",status:"pending",checkoutSessionId:"cs_known",paymongoPaymentId:null,refundId:null,reviewRequired:false,reconcileLeaseUntil:null,
    patientAuthId,doctorAuthId,currency:"PHP",amountCentavos:150000,providerOriginAppointmentId:null as string|null},events:[] as unknown[]};
  let previous=structuredClone(state),present=true,unknown=false,failCommit=false;
  const calls:string[]=[];
  const tx={async query(sql:string,args:unknown[]=[]):Promise<{rows:any[];rowCount:number}>{
    calls.push(sql);if(sql==="BEGIN"){previous=structuredClone(state);return{rows:[],rowCount:0};}
    if(sql==="ROLLBACK"){state=previous;return{rows:[],rowCount:0};}
    if(sql==="COMMIT"){if(failCommit){failCommit=false;throw new Error("COMMIT_TEST_FAILURE");}return{rows:[],rowCount:0};}
    if(sql.includes("pg_advisory_xact_lock"))return{rows:[],rowCount:0};
    if(sql.includes("FROM payment_association_holds")){
      if(sql.includes('"operationId"=$1')){const hold=state.holds.get(String(args[0]));return{rows:hold?[structuredClone(hold)]:[],rowCount:hold?1:0};}
      const holds=[...state.holds.values()].filter(x=>x.billingLineageId===args[0]&&x.state==="prepared");return{rows:structuredClone(holds),rowCount:holds.length};
    }
    if(sql.includes("FROM payments"))return{rows:present?[structuredClone(state.payment)]:[],rowCount:present?1:0};
    if(sql.includes("FROM payment_operations"))return{rows:unknown?[{id:randomUUID()}]:[],rowCount:unknown?1:0};
    if(sql.includes("INSERT INTO payment_association_holds")){
      state.holds.set(String(args[0]),{operationId:args[0],billingLineageId:args[1],sourceAppointmentId:args[2],replacementAppointmentId:args[3],requestHash:args[4],
        paymentId:args[8],paymentVersion:args[9],freezeToken:args[10],receipt:JSON.parse(String(args[11])),state:"prepared"});return{rows:[],rowCount:1};
    }
    if(sql.includes("UPDATE payment_association_holds")){
      state.holds.get(String(args[0]))!.state=sql.includes("aborted")?"aborted":"finalized";return{rows:[],rowCount:1};
    }
    if(sql.includes("UPDATE payments")){
      state.payment.providerOriginAppointmentId??=state.payment.appointmentId;state.payment.appointmentId=String(args[1]);state.payment.associationVersion=Number(args[2]);state.payment.version++;
      return{rows:[structuredClone(state.payment)],rowCount:1};
    }
    if(sql.includes("INSERT INTO outbox_events")){
      const event=parseEvent({eventId:args[0],eventType:args[1],schemaVersion:1,producer:args[2],aggregateId:args[3],aggregateVersion:args[4],correlationId:args[5],causationId:args[6],occurredAt:args[7],data:JSON.parse(String(args[8]))});
      state.events.push(event);return{rows:[],rowCount:1};
    }
    throw new Error("UNEXPECTED_TEST_SQL:"+sql);
  },release(){}};
  const pool={connect:async()=>tx,query:tx.query.bind(tx)} as unknown as Pool;
  const participant=createPaymentAssociation(pool,async()=>structuredClone(intent));
  return{intent,participant,pool,calls,state:()=>state,missing:()=>{present=false;},unknown:()=>{unknown=true;},fail:()=>{failCommit=true;},
    pivot:(receipt:ParticipantReceipt)=>{intent.pivotCommittedAt=new Date();intent.state="finalizing";intent.receipt=receipt;}};
}
test("EDA Payment association preparation freezes once and preserves known provider origin",async()=>{
  const f=fixture(),receipt=await f.participant.prepare(f.intent.operationId);assert.deepEqual(await f.participant.prepare(f.intent.operationId),receipt);
  assert.equal(f.state().holds.size,1);assert.equal(f.state().payment.appointmentId,f.intent.sourceAppointmentId);
  f.pivot(receipt);await f.participant.finalize(f.intent.operationId,receipt.freezeToken);await f.participant.finalize(f.intent.operationId,receipt.freezeToken);
  assert.equal(f.state().payment.appointmentId,f.intent.replacementAppointmentId);assert.equal(f.state().payment.providerOriginAppointmentId,f.intent.sourceAppointmentId);
  assert.equal(f.state().payment.checkoutSessionId,"cs_known");assert.equal(f.state().payment.version,5);
  assert.equal(f.state().events.length,2);assert.equal(f.state().holds.get(f.intent.operationId)!.state,"finalized");
  assert.ok(f.calls.every(sql=>!sql.includes("UPDATE invoices")));
});
test("EDA Payment association verified absence freezes future creation instead of treating timeout as absence",async()=>{
  const f=fixture();f.missing();const receipt=await f.participant.prepare(f.intent.operationId);assert.equal(receipt.resourceId,null);
  let writes=0;await assert.rejects(createPaymentStore(f.pool).transaction(f.intent.billingLineageId,async()=>{writes++;}),conflict);assert.equal(writes,0);
  f.pivot(receipt);await f.participant.finalize(f.intent.operationId,receipt.freezeToken);assert.equal(f.state().events.length,0);
});
test("EDA Payment association rejects unknown writes reviews quote ownership and concurrent reconciliation",async()=>{
  const mutations=[
    (f:ReturnType<typeof fixture>)=>f.unknown(),
    (f:ReturnType<typeof fixture>)=>{f.state().payment.reviewRequired=true;},
    (f:ReturnType<typeof fixture>)=>{f.state().payment.patientAuthId=randomUUID();},
    (f:ReturnType<typeof fixture>)=>{f.state().payment.amountCentavos++;},
    (f:ReturnType<typeof fixture>)=>{f.state().payment.providerMode="live";},
    (f:ReturnType<typeof fixture>)=>{f.state().payment.reconcileLeaseUntil=new Date(Date.now()+60000) as any;},
    (f:ReturnType<typeof fixture>)=>{f.state().payment.checkoutSessionId=null as any;},
  ];
  for(const mutate of mutations){const f=fixture();mutate(f);await assert.rejects(f.participant.prepare(f.intent.operationId),conflict);assert.equal(f.state().holds.size,0);}
});
test("EDA Payment association abort requires compensating Core intent and never releases a committed pivot",async()=>{
  const f=fixture(),receipt=await f.participant.prepare(f.intent.operationId);
  await assert.rejects(f.participant.abort(f.intent.operationId,receipt.freezeToken),conflict);f.intent.state="compensating";
  await f.participant.abort(f.intent.operationId,receipt.freezeToken);await f.participant.abort(f.intent.operationId,receipt.freezeToken);
  assert.equal(f.state().holds.get(f.intent.operationId)!.state,"aborted");
  const g=fixture(),other=await g.participant.prepare(g.intent.operationId);g.pivot(other);await assert.rejects(g.participant.abort(g.intent.operationId,other.freezeToken),conflict);
  assert.equal(g.state().holds.get(g.intent.operationId)!.state,"prepared");
});
test("EDA Payment association receipt conflicts and crash recovery cannot duplicate transfers",async()=>{
  const f=fixture();f.fail();await assert.rejects(f.participant.prepare(f.intent.operationId),/COMMIT_TEST_FAILURE/);assert.equal(f.state().holds.size,0);
  const receipt=await f.participant.prepare(f.intent.operationId);f.intent.requestHash="b".repeat(64);await assert.rejects(f.participant.prepare(f.intent.operationId),conflict);
  f.intent.requestHash="a".repeat(64);f.pivot(receipt);await assert.rejects(f.participant.finalize(f.intent.operationId,randomUUID()),conflict);
  f.fail();await assert.rejects(f.participant.finalize(f.intent.operationId,receipt.freezeToken),/COMMIT_TEST_FAILURE/);
  assert.equal(f.state().payment.appointmentId,f.intent.sourceAppointmentId);assert.equal(f.state().events.length,0);
  await f.participant.finalize(f.intent.operationId,receipt.freezeToken);assert.equal(f.state().events.length,2);
});
