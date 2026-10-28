import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { intakeCrypto } from '../src/eda/modules/intelligence/crypto.js';
import { intakeBrief } from '../src/eda/modules/intelligence/summary.js';
import { safeCount,createIntelligence,dashboard } from '../src/eda/modules/intelligence/module.js';
import { derivedFeatures } from '../src/eda/modules/intelligence/worker.js';
import { intakePayloadSchema,type Concept,type Analysis } from '../src/eda/modules/intelligence/contracts.js';
import type { Actor } from '../src/eda/contracts/actor.js';
import type { Pool } from 'pg';
const keys={VITAL_AI_ENCRYPTION_KEYS:JSON.stringify({1:Buffer.alloc(32,7).toString('base64')}),VITAL_AI_ACTIVE_KEY_VERSION:'1'};
const payload=intakePayloadSchema.parse({primarySymptom:{id:'1',name:'Knee symptom'},chiefComplaint:null,opqrst:{version:1,symptomStartedAt:null,symptomStartedApprox:'Not sure',onsetType:'UNKNOWN',aggravatingFactors:'Walking',relievingFactors:'Rest',symptomQuality:['Aching'],symptomQualityOther:null,symptomLocation:{kind:'GENERALIZED',partId:null,label:'Whole body / Generalized'},specificBodyPart:'Right knee',radiates:'NO',radiationLocation:null,severity:6,timingPattern:'UNKNOWN',episodeDurationValue:null,episodeDurationUnit:null,progression:'UNKNOWN',associatedSymptoms:'No fever',additionalNotes:''}});
const concept:Concept={id:'1',name:'Knee symptom',assertion:'present',field:'primarySymptom',method:'selected'};
const department=randomUUID();
const analysis:Analysis={concepts:[concept],candidates:[{discipline:'Cardiology',score:1,sourceSpecialtyIds:['1']}],versions:{model:'test',candidateProvenance:'bodhi-specialty-ids-v1'},flags:[]};
test('AI encryption binds drafts to their row, authenticates modifications and supports versioned keys',()=>{
  const crypto=intakeCrypto(keys),encrypted=crypto.encrypt(payload,'draft-a');assert.deepEqual(crypto.decrypt(encrypted,'draft-a'),payload);
  assert.doesNotMatch(JSON.stringify(encrypted),/Walking|Rest|No fever/);assert.throws(()=>crypto.decrypt(encrypted,'draft-b'));
  assert.throws(()=>crypto.decrypt({...encrypted,tag:Buffer.alloc(16).toString('base64')},'draft-a'));
  const rotated=intakeCrypto({...keys,VITAL_AI_ENCRYPTION_KEYS:JSON.stringify({1:Buffer.alloc(32,7).toString('base64'),2:Buffer.alloc(32,8).toString('base64')}),VITAL_AI_ACTIVE_KEY_VERSION:'2'});
  assert.deepEqual(rotated.decrypt(encrypted,'draft-a'),payload);assert.equal(rotated.encrypt(payload,'a').keyVersion,2);
});
test('AI brief preserves optional blank complaint, uncertainty, source values and long text without truncation',()=>{
  const brief=intakeBrief(payload,[{...concept,assertion:'denied'}]);assert.match(brief,/Chief complaint: not provided/);assert.match(brief,/Not sure/);assert.match(brief,/6\/10/);assert.match(brief,/Knee symptom: denied/);assert.doesNotMatch(brief,/diagnosis:|arthritis/i);
  assert.ok(intakeBrief({...payload,chiefComplaint:'a'.repeat(2000)}).length>2000);
});
test('AI derived features deduplicate positive symptoms and exclude raw text, graphs and unknown-age cohort',()=>{
  const features=derivedFeatures(payload,[concept,concept,{...concept,id:'2',assertion:'denied'}],null);assert.equal(features.symptoms.length,1);assert.equal(features.cohort,null);assert.doesNotMatch(JSON.stringify(features),/Walking|No fever|condition|patient/i);
  assert.equal(derivedFeatures(payload,[concept],17).cohort,'pediatric');assert.equal(derivedFeatures(payload,[concept],18).cohort,'adult');
  assert.deepEqual(derivedFeatures(payload,[concept,{...concept,assertion:'denied'}],18).symptoms,[]);
});
test('AI counts distinguish empty data from suppressed groups',()=>{assert.equal(safeCount(0),0);assert.equal(safeCount(4),null);assert.equal(safeCount(5),5);});

test('AI drafts hide legacy analysis, abstain and permit explicit reanalysis at the same draft version',async()=>{
  const crypto=intakeCrypto(keys),id=randomUUID(),authId=randomUUID(),calls:string[]=[];
  const row={id,version:0,payload:crypto.encrypt(payload,id),analysis:crypto.encrypt({...analysis,candidates:[{discipline:'Cardiology',score:1}]},id),
    confirmation:crypto.encrypt([concept],id),expiresAt:new Date(Date.now()+120000),confirmedAt:new Date(),ageYears:30,sandbox:true};
  const db={async query(sql:string){calls.push(sql);if(sql.startsWith('SELECT * FROM ai_intake_drafts'))return{rows:[row],rowCount:1};
    if(sql.startsWith('SELECT DISTINCT'))return{rows:[{id:department}],rowCount:1};
    if(sql.startsWith('INSERT INTO ai_jobs'))return{rows:[{id:randomUUID(),status:'pending'}],rowCount:1};
    return{rows:[],rowCount:1};},release(){}};
  const pool={...db,connect:async()=>db} as unknown as Pool;
  const module=createIntelligence(pool,{...keys,VITAL_AI_ENABLED:'true',VITAL_AI_SANDBOX_ENABLED:'true'});
  const actor:Actor={authId,role:'admin',serviceId:'vital-web',resource:authId,scopes:['ai.intakes/read','ai.intakes/recommendations','ai.intakes/analyze'],correlationId:randomUUID(),isSuperAdmin:false};
  const input={sandbox:true,session:{binding:'a'.repeat(64),expiresAt:row.expiresAt.toISOString()}};
  const read=await module.execute(actor,'intakes/read',input) as {analysis:unknown;reanalysisRequired:boolean};
  assert.equal(read.analysis,null);assert.equal(read.reanalysisRequired,true);
  await assert.rejects(()=>module.execute(actor,'intakes/recommendations',input),{code:'AI_RECOMMENDATIONS_RETIRED'});
  const job=await module.execute(actor,'intakes/analyze',{...input,expectedVersion:0}) as {status:string;draftVersion:number};
  assert.equal(job.status,'pending');assert.equal(job.draftVersion,0);
  assert.ok(calls.some(sql=>sql.startsWith('UPDATE ai_intake_drafts SET analysis=NULL')));
  assert.ok(calls.some(sql=>sql.includes("status IN ('completed','failed','stale')")));
});
test('AI disabled and spoofed roles cannot read drafts',async()=>{
  const actor:Actor={authId:randomUUID(),role:'patient',serviceId:'vital-web',scopes:['ai.intakes/read'],resource:'',correlationId:randomUUID(),isSuperAdmin:false};actor.resource=actor.authId;
  const pool={query:async()=>({rows:[],rowCount:0})} as unknown as Pool;
  await assert.rejects(createIntelligence(pool,{}).execute(actor,'intakes/read',{}),{code:'AI_DISABLED'});
  await assert.rejects(createIntelligence(pool,{VITAL_AI_ENABLED:'true',VITAL_AI_SANDBOX_ENABLED:'true'}).execute(actor,'intakes/read',{sandbox:true}),{code:'AI_SANDBOX_DENIED'});
});
test('AI logout deletion is actor-bound even after patient feature is disabled',async()=>{
  const calls:{sql:string;values:unknown[]}[]=[],db={query:async(sql:string,values:unknown[]=[])=>{calls.push({sql,values});return{rows:[],rowCount:1};},release(){}};const pool={...db,connect:async()=>db} as unknown as Pool;
  const actor:Actor={authId:randomUUID(),role:'patient',serviceId:'vital-web',scopes:['ai.intakes/delete'],resource:'',correlationId:randomUUID(),isSuperAdmin:false};actor.resource=actor.authId;
  await createIntelligence(pool,{}).execute(actor,'intakes/delete',{session:{binding:'a'.repeat(64),expiresAt:new Date(Date.now()-1000).toISOString()}});
  const deletion=calls.find(c=>c.sql.startsWith('DELETE'))!;assert.equal(deletion.values[0],actor.authId);assert.match(deletion.sql,/patientAuthId/);assert.ok(calls.some(c=>c.sql.includes('INSERT INTO ai_intake_sessions')));
});
test('AI dashboard hides cluster members, subthreshold cohort counts and unreviewed labels',async()=>{
  const pool={query:async(sql:string)=>({rows:sql.includes('FROM ai_submissions')?Array.from({length:5},()=>({date:'2026-10-25',status:'completed',features:{symptoms:[{id:'1',name:'Example'}]}})):sql.includes('FROM ai_cluster_versions')?[{id:'v1',payload:{featureVersion:'v1',cohorts:[{cohort:'pediatric',status:'completed',count:4,noise:1}],clusters:[{id:'c1',count:4,suggestedLabel:'Unreviewed',members:['private-id']}]}}]:[]})} as unknown as Pool;
  const result=await dashboard(pool,{from:'2026-10-25',to:'2026-10-25'});assert.doesNotMatch(JSON.stringify(result),/private-id|Unreviewed|members/);assert.equal(result.clusters!.cohorts[0].count,null);assert.equal(result.symptoms[0]!.percentage,1);
});
