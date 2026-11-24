import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import jwt from 'jsonwebtoken';
import type {Pool} from 'pg';
import {createEhrLifecycle,verifyReadiness,lifecycleStep} from '../src/eda/modules/appointment/ehr-lifecycle.js';
import type {AppointmentRow} from '../src/eda/modules/appointment/appointment-contracts.js';

const keys=generateKeyPairSync('rsa',{modulusLength:2048}),publicKeys={test:keys.publicKey.export({type:'spki',format:'pem'}).toString()};
const binding={appointmentId:randomUUID(),patientId:randomUUID(),caseId:randomUUID(),doctorAuthId:randomUUID()},diagnosisId=randomUUID();
function proof(overrides={}){return jwt.sign({...binding,diagnosisId,...overrides},keys.privateKey,{algorithm:'RS256',keyid:'test',issuer:'uhse-ehr',audience:'vital-services.lifecycle',...('exp' in overrides?{}:{expiresIn:60})});}
function fixture(){
  let state='ready',ready=true,replyStatus=200,attempts=1;const writes:Array<{sql:string;args:unknown[]}>=[],calls:Array<{path:string;body:any}>=[];
  const row={id:binding.appointmentId,patientId:randomUUID(),doctorAuthId:binding.doctorAuthId,ehrCaseId:binding.caseId,consultationType:'virtual',status:'completed'} as AppointmentRow;
  const payload={...binding,operationId:lifecycleStep(row.id,'close'),expectedDiagnosisId:diagnosisId,completedVersion:4,completedAt:new Date().toISOString()};
  const db={async query(sql:string,args:unknown[]=[]):Promise<{rows:any[];rowCount:number}>{
    if(sql.startsWith('SELECT "ehrPatientId"'))return{rows:[{ehrPatientId:binding.patientId}],rowCount:1};
    if(sql.startsWith('WITH RECURSIVE chain'))return{rows:[{id:binding.appointmentId}],rowCount:1};
    if(sql.startsWith('SELECT "diagnosisId"'))return{rows:[{diagnosisId}],rowCount:1};
    if(sql.startsWith('SELECT status,version'))return{rows:[{status:'completed',version:4,completedAt:new Date(payload.completedAt)}],rowCount:1};
    if(sql.startsWith('SELECT state'))return{rows:[{state}],rowCount:1};
    if(sql.startsWith('WITH due'))return{rows:state==='pending'?[{appointmentId:row.id,payload,attempts}]:[],rowCount:state==='pending'?1:0};
    writes.push({sql,args});
    if(sql.includes("SET state='synced'"))state='synced';
    else if(sql.includes('SET state=$2'))state=String(args[1]);
    else if(sql.includes("SET state='pending'"))state='pending';
    return{rows:[],rowCount:1};
  }};
  const fetcher:typeof fetch=async(input,options)=>{
    const body=JSON.parse(String(options?.body)),path=new URL(String(input)).pathname;calls.push({path,body});
    assert.equal((options!.headers as Record<string,string>)['X-Internal-Service'],'vital-services');
    if(replyStatus!==200)return new Response('{}',{status:replyStatus});
    const data=path.endsWith('/readiness')?{ready,diagnosisId,receipt:ready?proof():null}:path.endsWith('/follow-up-create')?{followUpId:randomUUID(),sourceCaseId:binding.caseId}:
      {caseId:binding.caseId,appointmentId:binding.appointmentId,status:'closed',diagnosisId,closedAt:new Date().toISOString()};
    return Response.json({success:true,data});
  };
  const owner=createEhrLifecycle(db as unknown as Pool,{baseUrl:'https://ehr.test',key:'separate-lifecycle-test-key',keys:publicKeys},fetcher);
  return{owner,db,row,writes,calls,state:()=>state,setReady:(value:boolean)=>{ready=value;},pending:()=>{state='pending';},reply:(status:number)=>{replyStatus=status;},attempts:(n:number)=>{attempts=n;}};
}
test('readiness rejects expired signatures, substituted bindings and unknown keys',()=>{
  assert.equal(verifyReadiness(proof(),publicKeys,binding),diagnosisId);
  assert.throws(()=>verifyReadiness(proof(),publicKeys,{...binding,caseId:randomUUID()}),{code:'EHR_LIFECYCLE_EVIDENCE_INVALID'});
  assert.throws(()=>verifyReadiness(proof(),{},binding));
  assert.throws(()=>verifyReadiness(proof({exp:1}),publicKeys,binding));
});
test('missing final diagnosis blocks readiness without persisting success',async()=>{
  const f=fixture();f.setReady(false);
  await assert.rejects(f.owner.ready(f.db,f.row),{code:'EHR_FINAL_DIAGNOSIS_REQUIRED'});assert.equal(f.writes.length,0);
});
test('completion intent retains exact case, diagnosis and stable operation binding',async()=>{
  const f=fixture();await f.owner.ready(f.db,f.row);await f.owner.enqueue(f.db,f.row);
  const payload=JSON.parse(String(f.writes.at(-1)!.args[1]));
  assert.equal(payload.expectedDiagnosisId,diagnosisId);assert.equal(payload.caseId,binding.caseId);
  assert.equal(payload.operationId,lifecycleStep(f.row.id,'close'));assert.equal(payload.completedVersion,4);
});
test('F2F never enqueues closure and cannot authorize an EHR readiness read',async()=>{
  const f=fixture();f.row.consultationType='in_person';await f.owner.enqueue(f.db,f.row);
  await assert.rejects(f.owner.ready(f.db,f.row),{code:'EHR_VIRTUAL_CASE_REQUIRED'});
  assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
});
test('worker retries transient errors but records clinical conflicts for attention',async()=>{
  const f=fixture();f.pending();f.reply(503);await f.owner.deliver();assert.equal(f.state(),'pending');
  f.reply(409);await f.owner.deliver();assert.equal(f.state(),'needs_attention');
});
test('worker accepts verified closure and does not redeliver synchronized intents',async()=>{
  const f=fixture();f.pending();assert.equal(await f.owner.deliver(),1);assert.equal(f.state(),'synced');
  assert.equal(await f.owner.deliver(),0);assert.equal(f.calls.length,1);
});
test('follow-up waits for source closure and uses the Philippine date',async()=>{
  const f=fixture();await assert.rejects(f.owner.followUp(f.row,randomUUID(),new Date('2099-01-01T16:30:00Z')),{code:'EHR_SOURCE_CLOSURE_PENDING'});
  f.pending();await f.owner.deliver();await f.owner.followUp(f.row,randomUUID(),new Date('2099-01-01T16:30:00Z'));
  assert.equal(f.calls.at(-1)!.body.dueOn,'2099-01-02');assert.equal(f.calls.at(-1)!.body.caseId,binding.caseId);
});

test('rescheduled encounters retain their original EHR appointment reference',async()=>{
  const f=fixture();f.row.id=randomUUID();await f.owner.ready(f.db,f.row);
  assert.equal(f.calls[0]!.body.appointmentId,binding.appointmentId);
  assert.equal(f.writes[0]!.args[0],f.row.id);
});
