import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";
import pg from 'pg';
import { createRequire } from 'node:module';
import { dirname,join } from 'node:path';
import { parseEvent } from "../src/eda/contracts/events.js";
import { consumeAppointmentPayment } from "../src/eda/workers/appointment-payment.js";
import { utcPgTypes,configureUtcDateParameters } from "../src/eda/infrastructure/utc-types.js";
import { createEhrCaseRecovery } from "../src/eda/modules/appointment/adapters/ehr-case-recovery.js";
const fixture=()=>{
  const paymentId=randomUUID(),appointmentId=randomUUID(),lineage=randomUUID(),paidAt=new Date();
  const event=parseEvent({eventId:randomUUID(),eventType:"vital.payment.completed",schemaVersion:1,producer:"payment",occurredAt:paidAt.toISOString(),
    aggregateId:paymentId,aggregateVersion:1,correlationId:randomUUID(),causationId:null,data:{paymentId,appointmentId,paymentVersion:1,billingLineageId:lineage,associationVersion:1,reviewRequired:false,paidAt:paidAt.toISOString()}});
  const committedFact=structuredClone(event);
  const source={id:paymentId,appointmentId,billingLineageId:lineage,associationVersion:1,version:1,status:"paid",providerMode:"sandbox",paidAt,reviewRequired:false};
  let state={inbox:new Set<string>(),effects:0},previous=structuredClone(state),committed=true,fail=false;
  const calls:string[]=[];
  const tx={query:async(sql:string,args:unknown[]=[])=>{
    calls.push(sql);if(sql==="BEGIN"){previous=structuredClone(state);return{rows:[],rowCount:0};}
    if(sql==="ROLLBACK"){state=previous;return{rows:[],rowCount:0};}if(sql==="COMMIT")return{rows:[],rowCount:0};
    if(sql.includes("INSERT INTO inbox_events")){const key=String(args[0])+":"+String(args[1]);if(state.inbox.has(key))return{rows:[],rowCount:0};state.inbox.add(key);return{rows:[{eventId:args[1]}],rowCount:1};}
    throw new Error("UNEXPECTED_CORE_QUERY");
  },release(){}};
  const core={connect:async()=>tx} as unknown as Pool;
  const integrations={query:async(sql:string)=>({rows:sql.includes("FROM payments")?[source]:committed?[{...committedFact,id:committedFact.eventId,occurredAt:paidAt,payload:committedFact.data}]:[],rowCount:1})} as unknown as Pool;
  const run=()=>consumeAppointmentPayment(core,integrations,event,async(client,evidence)=>{
    assert.equal(client,tx);assert.equal(evidence.appointmentId,appointmentId);assert.equal(evidence.paymentVersion,source.version);
    state.effects++;if(fail)throw new Error("OWNER_EFFECT_FAILURE");
  });
  return{event,source,core,integrations,run,state:()=>state,fail:(value:boolean)=>{fail=value;},uncommit:()=>{committed=false;},calls};
};
test("EDA Appointment payment consumer verifies committed evidence and independently deduplicates business effects",async()=>{
  const f=fixture();await f.run();await f.run();assert.equal(f.state().effects,1);assert.equal(f.state().inbox.size,1);
  assert.ok(f.calls.includes("COMMIT"));assert.ok(f.calls.every(sql=>!sql.includes("appointment_payment_projections")));
});
test("EDA Appointment payment consumer rolls back effects and inbox before redelivery",async()=>{
  const f=fixture();f.fail(true);await assert.rejects(f.run(),/OWNER_EFFECT_FAILURE/);assert.equal(f.state().effects,0);assert.equal(f.state().inbox.size,0);
  f.fail(false);await f.run();assert.equal(f.state().effects,1);
});
test("EDA Appointment payment consumer skips reviewed refunded and superseded associations",async()=>{
  for(const change of[(f:ReturnType<typeof fixture>)=>{f.source.version=2;f.source.status="refunded";},(f:ReturnType<typeof fixture>)=>{f.source.version=2;f.source.reviewRequired=true;},
    (f:ReturnType<typeof fixture>)=>{f.source.version=2;f.source.associationVersion=2;f.source.appointmentId=randomUUID();}]){
    const f=fixture();change(f);await f.run();assert.equal(f.state().effects,0);assert.equal(f.state().inbox.size,1);
  }
});
test("EDA Appointment payment consumer rejects uncommitted forged and live-mode facts before inbox",async()=>{
  for(const change of[(f:ReturnType<typeof fixture>)=>f.uncommit(),(f:ReturnType<typeof fixture>)=>{f.source.id=randomUUID();},
    (f:ReturnType<typeof fixture>)=>{f.source.providerMode="live";},(f:ReturnType<typeof fixture>)=>{f.event.correlationId=randomUUID();},
    (f:ReturnType<typeof fixture>)=>{f.source.version=0;}]){
    const f=fixture();change(f);await assert.rejects(f.run());assert.equal(f.state().inbox.size,0);
  }
});
test("EDA UTC date and timestamp parsers do not depend on Windows or container timezone",()=>{
  const timestamp=utcPgTypes.getTypeParser(1114,"text")("2026-10-15 15:00:00.123") as Date;
  const date=utcPgTypes.getTypeParser(1082,"text")("2026-10-15") as Date;
  assert.equal(timestamp.toISOString(),"2026-10-15T15:00:00.123Z");assert.equal(date.toISOString(),"2026-10-15T00:00:00.000Z");
  const require=createRequire(import.meta.url);
  // Exercise the installed driver's actual binding serializer, not a Date mock.
  const serializer=require(join(dirname(require.resolve('pg')),'utils.js')) as {prepareValue(value:unknown):string};
  const old=pg.defaults.parseInputDatesAsUTC,tz=process.env.TZ;
  try{process.env.TZ='Asia/Manila';configureUtcDateParameters();assert.equal(serializer.prepareValue(timestamp),'2026-10-15T15:00:00.123+00:00');}
  finally{pg.defaults.parseInputDatesAsUTC=old;if(tz===undefined)delete process.env.TZ;else process.env.TZ=tz;}
});
test("EDA EHR recovery reads scoped existing case receipts and never creates clinical resources",async()=>{
  const appointmentId=randomUUID(),caseId=randomUUID(),patientId=randomUUID(),doctorAuthId=randomUUID();let reads=0;
  const recover=createEhrCaseRecovery({baseUrl:"http://ehr-internal",key:"isolated-recovery-key"},async(url,options)=>{
    reads++;assert.equal(options?.method,"GET");assert.match(String(url),new RegExp("/internal/vital/v1/appointment-cases/"+appointmentId+"$"));
    const headers=new Headers(options?.headers);assert.equal(headers.get("X-Internal-Service"),"vital-services");assert.equal(headers.get("Authorization"),null);
    return Response.json({success:true,data:{appointment_id:appointmentId,case_id:caseId,patient_id:patientId,doctor_auth_id:doctorAuthId,external_system_ref:"vital:appointment:"+appointmentId}});
  });
  assert.deepEqual(await recover(appointmentId),{caseId,patientId,doctorAuthId,externalSystemRef:"vital:appointment:"+appointmentId});assert.equal(reads,1);
  const absent=createEhrCaseRecovery({baseUrl:"http://ehr-internal",key:"isolated-recovery-key"},async()=>new Response(null,{status:404}));assert.equal(await absent(appointmentId),null);
  const forged=createEhrCaseRecovery({baseUrl:"http://ehr-internal",key:"isolated-recovery-key"},async()=>Response.json({success:true,data:{appointment_id:randomUUID(),case_id:caseId,patient_id:patientId,doctor_auth_id:doctorAuthId,external_system_ref:"vital:appointment:"+appointmentId}}));await assert.rejects(forged(appointmentId));
});
