import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import type {Pool} from 'pg';
import type {Actor} from '../src/eda/contracts/actor.js';
import {createIntelligence,dashboard,patterns} from '../src/eda/modules/intelligence/module.js';
const env={VITAL_AI_ENABLED:'true',VITAL_AI_ANALYTICS_ENABLED:'true',VITAL_AI_ACTIVE_KEY_VERSION:'1',VITAL_AI_ENCRYPTION_KEYS:JSON.stringify({'1':Buffer.alloc(32,7).toString('base64')})};
test('Symptom report never queries clusters and distinguishes withheld days from genuine empty dates',async()=>{
 const calls:string[]=[];const rows=Array.from({length:5},(_,i)=>({date:i<2?'2026-11-01':'2026-11-02',status:'completed',features:{symptoms:i===0?[]:[{id:'symptom',name:'Headache'}]}}));
 const pool={query:async(sql:string)=>{calls.push(sql);assert.match(sql,/FROM ai_submissions/);return{rows};}} as unknown as Pool;
 const data=await dashboard(pool,{from:'2026-11-01',to:'2026-11-03'});assert.equal(data.clusters,null);assert.equal(data.totals.analyzed,5);assert.equal(data.totals.noPositive,null);assert.equal(data.symptoms[0].count,null);assert.equal(data.symptoms[0].percentage,null);
 assert.deepEqual(data.daily,[{date:'2026-11-01',submissions:null,analyzed:null},{date:'2026-11-02',submissions:null,analyzed:null},{date:'2026-11-03',submissions:0,analyzed:0}]);assert.equal(calls.length,1);
 await assert.rejects(dashboard(pool,{from:'2026-11-03',to:'2026-11-01'}));
});
test('Pattern read returns only aggregate snapshot metadata and never member IDs or raw text',async()=>{
 const payload={cohorts:[{cohort:'adult',status:'completed',count:8,noise:3}],clusters:[{id:'adult-0',count:5,suggestedLabel:'Headache, fever',members:['private-member-id'],chiefComplaint:'private-clinical-text'},{id:'adult-1',count:4,suggestedLabel:'withheld-symptom'}]};
 const pool={query:async(sql:string)=>({rows:sql.includes('ai_cluster_versions')?[{id:'v1',createdAt:new Date('2026-11-20T02:00:00Z'),payload}]:[{clusterId:'adult-0',label:'Headache, fever'},{clusterId:'adult-1',label:'withheld-symptom'}]})} as unknown as Pool;
 const result=await patterns(pool);assert.equal(result.snapshot!.generatedAt,'2026-11-20T02:00:00.000Z');assert.equal(result.snapshot!.cohorts[0].noise,null);assert.equal(result.snapshot!.clusters[0].reviewed,true);assert.doesNotMatch(JSON.stringify(result),/private-member|private-clinical|members|chiefComplaint/);
 assert.equal(result.snapshot!.clusters[1].count,null);assert.equal(result.snapshot!.clusters[1].suggestedLabel,null);assert.equal(result.snapshot!.clusters[1].label,null);assert.doesNotMatch(JSON.stringify(result),/withheld-symptom/);
 assert.equal((await patterns({query:async()=>({rows:[]})} as unknown as Pool)).snapshot,null);
});
function fixture(){let current=true,rollover=false,member=true;const labels=new Map();const calls:string[]=[];
 const pool={query:async(sql:string,args:unknown[]=[])=>{calls.push(sql);if(sql.includes('SELECT 1 FROM vital_admins'))return{rows:[],rowCount:member?1:0};
 if(sql.startsWith('SELECT payload'))return{rows:current?[{payload:{clusters:[{id:'adult-0',count:5,suggestedLabel:'Headache, fever'}]}}]:[],rowCount:current?1:0};
 if(sql.startsWith('INSERT INTO ai_cluster_labels')){if(rollover)return{rows:[],rowCount:0};labels.set(args[0]+':'+args[1],args[2]);return{rows:[{clusterId:args[1]}],rowCount:1};}return{rows:[],rowCount:0};}} as unknown as Pool;
 // intakeCrypto accepts an environment map; the same variable name is used by the runtime.
 const environment=env;
 const module=createIntelligence(pool,environment);const actor={authId:randomUUID(),role:'admin',scopes:['ai.admin'],resource:''} as Actor;actor.resource=actor.authId;
 return{module,actor,calls,labels,expire:()=>{current=false;},rollover:()=>{rollover=true;},revoke:()=>{member=false;},environment,pool};
}
const selection={versionId:'v1',clusterId:'adult-0',label:'Headache, fever'};
test('Pattern label review binds the current unexpired snapshot and repeated approval cannot duplicate a label',async()=>{
 const f=fixture();assert.deepEqual(await f.module.execute(f.actor,'admin/clusters/label',selection),{status:'reviewed'});await f.module.execute(f.actor,'admin/clusters/label',selection);assert.equal(f.labels.size,1);
 const before=f.calls.length;await assert.rejects(f.module.execute(f.actor,'admin/clusters/label',{...selection,label:'Disease diagnosis'}));assert.equal(f.calls.length,before+1);
 const g=fixture();g.expire();await assert.rejects(g.module.execute(g.actor,'admin/clusters/label',selection),(e:any)=>e.code==='AI_CLUSTER_SNAPSHOT_CHANGED');assert.equal(g.labels.size,0);
 const h=fixture();h.rollover();await assert.rejects(h.module.execute(h.actor,'admin/clusters/label',selection),(e:any)=>e.code==='AI_CLUSTER_SNAPSHOT_CHANGED');assert.equal(h.labels.size,0);
});
test('Pattern reads preserve admin membership and analytics feature gates',async()=>{
 const f=fixture();await assert.rejects(f.module.execute({...f.actor,role:'doctor'},'admin/patterns',{}));await assert.rejects(f.module.execute({...f.actor,scopes:[]},'admin/patterns',{}));f.revoke();await assert.rejects(f.module.execute(f.actor,'admin/patterns',{}));
 for(const flags of [{VITAL_AI_ENABLED:'false'},{VITAL_AI_ANALYTICS_ENABLED:'false'}])await assert.rejects(createIntelligence(f.pool,{...f.environment,...flags}).execute(f.actor,'admin/patterns',{}));
});
