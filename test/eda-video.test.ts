import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import type { Actor } from '../src/eda/contracts/actor.js';
import { DomainError } from '../src/eda/contracts/actor.js';
import { parseEvent } from '../src/eda/contracts/events.js';
import { createVideoModule } from '../src/eda/modules/video/module.js';
import { meetKeyring,encryptMeetSecret,decryptMeetSecret } from '../src/eda/modules/video/crypto.js';
import { MEET_SCOPE,type MeetProvider } from '../src/eda/modules/video/provider.js';
import type { VideoAuthority,VideoAssociations,VideoAppointment } from '../src/eda/modules/video/contracts.js';
import { videoRuntime } from '../src/eda/modules/video/runtime.js';

function fixture(){
  let now=Date.now();const doctorId=randomUUID(),authId=randomUUID(),appointmentId=randomUUID(),lineage=randomUUID();
  const keyring=meetKeyring({activeKeyId:'v1',keys:{v1:Buffer.alloc(32,7).toString('base64')}});
  const context={id:appointmentId,doctorId,doctorAuthId:authId,billingLineageId:lineage,associationVersion:1,consultationType:'virtual'} as VideoAppointment;
  let state={connections:new Map<string,any>([[doctorId,{id:randomUUID(),doctorId,revision:1,status:'connected',googleSubject:'google-subject',email:'doctor@example.com',
    accessToken:encryptMeetSecret(keyring,'google-access-secret',doctorId),refreshToken:encryptMeetSecret(keyring,'google-refresh-secret',doctorId),expiresAt:new Date(now+3600000),scopes:[MEET_SCOPE]}]]),
    operations:new Map<string,any>(),generations:new Map<string,any>(),oauth:new Map<string,any>(),quota:new Map<string,number>(),events:[] as any[],resources:[] as any[]};
  let tail=Promise.resolve();let outboxCrash=false;
  const queries:string[]=[];
  const result=(rows:any[]=[],rowCount=rows.length)=>({rows,rowCount});
  async function query(sql:string,a:any[]=[]):Promise<{rows:any[];rowCount:number}>{
    queries.push(sql);
    if(sql.includes('pg_advisory_xact_lock'))return result();
    if(sql.startsWith('SELECT * FROM video_operations'))return result([...state.operations.values()].filter(r=>r.actorAuthId===a[0]&&r.operationId===a[1]).map(r=>structuredClone(r)));
    if(sql.startsWith('INSERT INTO video_operations')){state.operations.set(a[0],{id:a[0],operationId:a[1],actorAuthId:a[2],action:a[3],resourceId:a[4],requestHash:a[5],state:'prepared',resultMetadata:null});return result([],1);}
    if(sql.startsWith('UPDATE video_operations SET state=$2')){Object.assign(state.operations.get(a[0]),{state:a[1],resultMetadata:JSON.parse(a[2]),failureCode:a[3]});return result([],1);}
    if(sql.startsWith("UPDATE video_operations SET state='completed'")){for(const op of state.operations.values())if(op.actorAuthId===a[0]&&op.operationId===a[1]&&op.state==='unknown')op.state='completed';return result([],1);}
    if(sql.startsWith("UPDATE video_operations SET state='executing'")){Object.assign(state.operations.get(a[0]),{state:'executing',executionStartedAt:a[1],leaseUntil:a[3]??a[2],resultMetadata:sql.includes('revoked')?{revoked:false}:null});return result([],1);}
    if(sql.startsWith('SELECT * FROM google_meet_connections'))return result(state.connections.has(a[0])?[structuredClone(state.connections.get(a[0]))]:[]);
    if(sql.startsWith('UPDATE google_meet_connections SET "refreshLease"=$3')){const c=state.connections.get(a[0]);if(c.revision!==a[1]||c.refreshLeaseUntil&&c.refreshLeaseUntil>a[4])return result();Object.assign(c,{refreshLease:a[2],refreshLeaseUntil:a[3]});return result([],1);}
    if(sql.startsWith('UPDATE google_meet_connections SET "accessToken"=$4')){const c=state.connections.get(a[0]);if(c.status!=='connected'||c.revision!==a[1]||c.refreshLease!==a[2])return result();Object.assign(c,{accessToken:a[3],refreshToken:a[4]??c.refreshToken,expiresAt:a[5]});return result([],1);}
    if(sql.startsWith("UPDATE google_meet_connections SET status='reconnect_required'")){const c=state.connections.get(a[0]);if(c.revision===a[1]&&(!sql.includes('"refreshLease"=$3')||c.refreshLease===a[2]))Object.assign(c,{status:'reconnect_required',accessToken:null,refreshToken:null,revision:c.revision+1});return result([],1);}
    if(sql.startsWith('UPDATE google_meet_connections SET "refreshLease"=NULL')){const c=state.connections.get(a[0]);if(c.refreshLease===a[1])Object.assign(c,{refreshLease:null,refreshLeaseUntil:null});return result([],1);}
    if(sql.startsWith('UPDATE google_meet_connections SET "googleSubject"')){const c=state.connections.get(a[0]);Object.assign(c,{googleSubject:a[1],email:a[2],scopes:a[3],accessToken:a[4],refreshToken:a[5],expiresAt:a[6],status:'connected',revision:c.revision+1});return result([],1);}
    if(sql.startsWith("UPDATE google_meet_connections SET status='disconnected'")){const c=state.connections.get(a[0]);Object.assign(c,{status:'disconnected',accessToken:null,refreshToken:null,email:null,googleSubject:null,revision:c.revision+1});return result([],1);}
    if(sql.startsWith('SELECT * FROM google_meet_oauth_states'))return result(state.oauth.has(a[0])?[structuredClone(state.oauth.get(a[0]))]:[]);
    if(sql.startsWith('INSERT INTO google_meet_oauth_states')){state.oauth.set(a[0],{id:a[0],doctorId:a[1],authId:a[2],bindingHash:a[3],secret:a[4],returnTo:a[5],expiresAt:a[6],operationId:a[7],state:'prepared'});return result([],1);}
    if(sql.startsWith('UPDATE google_meet_oauth_states')){
      if(sql.includes("state='superseded'")){for(const r of state.oauth.values())if(r.doctorId===a[0]&&r.state==='prepared')r.state='superseded';}
      else{const r=state.oauth.get(a[0]);if(sql.includes("state='exchanging'")){r.state='exchanging';r.executionStartedAt=a[1];r.callbackHash=a[2];}
        else if(sql.includes("state='unknown'")){r.state='unknown';r.outcome='failed';}else{r.state='completed';r.outcome=sql.includes("outcome='connected'")?'connected':'cancelled';}}
      return result([],1);
    }
    if(sql.startsWith('SELECT * FROM google_meet_generations')){
      return result([...state.generations.values()].filter(r=>sql.includes('"requestId"=$2')?r.doctorId===a[0]&&r.requestId===a[1]:r.id===a[0]&&(!sql.includes('"doctorId"=$2')||r.doctorId===a[1])).map(r=>structuredClone(r)));
    }
    if(sql.includes('COUNT(*) FILTER')){const rows=[...state.generations.values()].filter(r=>r.createdAt>a[1]);return result([{doctorCount:String(rows.filter(r=>r.doctorId===a[0]).length),projectCount:String(rows.length)}]);}
    if(sql.startsWith('SELECT "attemptsStarted"')){const key=a.join(':');return result(state.quota.has(key)?[{attemptsStarted:state.quota.get(key)}]:[]);}
    if(sql.startsWith('INSERT INTO meet_generation_quotas')){const key=a.join(':');if(!state.quota.has(key))state.quota.set(key,0);return result([],1);}
    if(sql.startsWith('UPDATE meet_generation_quotas')){const key=a.join(':');if((state.quota.get(key)??0)>=2)return result();state.quota.set(key,(state.quota.get(key)??0)+1);return result([],1);}
    if(sql.startsWith('INSERT INTO google_meet_generations')){state.generations.set(a[0],{id:a[0],doctorId:a[1],connectionId:a[2],connectionRevision:a[3],requestId:a[4],purpose:a[5],appointmentId:a[6],status:'creating',createdAt:a[7],expiresAt:a[8],version:0,billingLineageId:a[9],commandHash:a[10],executionLeaseOwner:a[11],executionLeaseUntil:a[12],providerAttemptStartedAt:null});return result([],1);}
    if(sql.startsWith('UPDATE google_meet_generations SET "providerAttemptStartedAt"')){const r=state.generations.get(a[0]);r.providerAttemptStartedAt=a[1];r.version++;return result([],1);}
    if(sql.startsWith('UPDATE google_meet_generations SET "executionLeaseOwner"=$2')){const r=state.generations.get(a[0]);if(r.status!=='uncertain'||r.executionLeaseUntil&&r.executionLeaseUntil>a[3])return result();r.executionLeaseOwner=a[1];r.executionLeaseUntil=a[2];return result([],1);}
    if(sql.startsWith('UPDATE google_meet_generations SET "executionLeaseOwner"=NULL')){const r=state.generations.get(a[0]);if(r.executionLeaseOwner===a[1]){r.executionLeaseOwner=null;r.executionLeaseUntil=null;}return result([],1);}
    if(sql.startsWith("UPDATE google_meet_generations SET status='ready'")){const r=state.generations.get(a[0]);if(r.status!=='uncertain'||r.executionLeaseOwner!==a[1]||r.executionLeaseUntil<=a[2])return result();r.status='ready';r.version++;r.executionLeaseOwner=null;r.executionLeaseUntil=null;return result([structuredClone(r)],1);}
    if(sql.startsWith('UPDATE google_meet_generations SET status=$2')){const r=state.generations.get(a[0]);if(sql.includes("AND status='creating'")&&r.status!=='creating')return result();r.status=a[1];r.version++;r.executionLeaseOwner=null;r.executionLeaseUntil=null;if(sql.includes('"meetingUrl"=$3')){r.meetingUrl=a[2];r.spaceName=a[3];}else{r.failureCode=a[2];r.spaceName=a[3]??r.spaceName;r.meetingUrl=a[4]??r.meetingUrl;}return result([structuredClone(r)],1);}
    if(sql.startsWith('INSERT INTO outbox_events')){if(outboxCrash){outboxCrash=false;throw new Error('TEST_OUTBOX_CRASH');}state.events.push(parseEvent({eventId:a[0],eventType:a[1],schemaVersion:1,producer:a[2],aggregateId:a[3],aggregateVersion:a[4],correlationId:a[5],causationId:a[6],occurredAt:a[7],data:JSON.parse(a[8])}));return result([],1);}
    if(sql.startsWith('SELECT * FROM video_resources'))return result(state.resources.filter(r=>sql.includes('WHERE id=$1')?r.id===a[0]&&r.doctorId===a[1]&&r.billingLineageId===a[2]:r.appointmentId===a[0]&&r.doctorId===a[1]&&r.associationVersion===a[2]));
    throw new Error('UNEXPECTED_VIDEO_SQL:'+sql);
  }
  const pool={query,connect:async()=>{let unlock:()=>void=()=>{},before=structuredClone(state);return{async query(sql:string,a:any[]=[]){
    if(sql==='BEGIN'){const prior=tail;tail=new Promise<void>(r=>{unlock=r;});await prior;before=structuredClone(state);return result();}
    if(sql==='ROLLBACK'){state=before;unlock();return result();}if(sql==='COMMIT'){unlock();return result();}return query(sql,a);},release(){}};}} as unknown as Pool;
  let revoked=false,eligible=true;const calls={create:0,exchange:0,refresh:0,revoke:0};
  const authority:VideoAuthority={doctor:async actor=>{if(revoked||actor.role!=='doctor'||actor.authId!==authId)throw new DomainError(403,'VIDEO_DOCTOR_REVOKED','Denied.');return{doctorId};},
    appointment:async()=>context,generation:async actor=>{await authority.doctor(actor);if(!eligible)throw new DomainError(409,'VIDEO_GENERATION_INELIGIBLE','Denied.');return context;},
    workflow:async()=>{throw new Error('UNUSED');},saga:async()=>{throw new Error('UNUSED');},completeWorkflow:async()=>{},abandonExpiredWorkflow:async()=>false,expiredWorkflows:async()=>[]};
  const associations={recover:async()=>0} as VideoAssociations;
  const tokens=()=>({accessToken:'new-access-secret',refreshToken:'new-refresh-secret',expiresAt:new Date(now+3600000),scopes:[MEET_SCOPE]});
  const provider:MeetProvider={exchangeCode:async()=>{calls.exchange++;return tokens();},refresh:async()=>{calls.refresh++;return tokens();},identity:async()=>({subject:'google-subject',email:'doctor@example.com'}),
    create:async()=>{calls.create++;return{spaceName:'spaces/known_room',meetingUrl:'https://meet.google.com/abc-defg-hij'};},get:async()=>{throw new Error('NO_BLIND_RECOVERY');},revoke:async()=>{calls.revoke++;}};
  const actor=(action:string,resource:string=authId):Actor=>({authId,role:'doctor',resource,scopes:['video.'+action],correlationId:randomUUID(),serviceId:'vital-web',isSuperAdmin:false});
  const meta=(id=randomUUID())=>({operationId:id,requestHash:'a'.repeat(64)});
  const module=createVideoModule(pool,authority,associations,{googleEnabled:true,appOrigin:'http://localhost:3001',clientId:'doctor-meet-client',redirectUri:'http://localhost:3001/api/doctor/google-meet/callback',provider,keyring},()=>now);
  const generate=(id=randomUUID(),purpose:'approval'|'follow_up'='approval')=>module.generate(actor('generate',appointmentId),meta(id),{requestId:id,appointmentId,purpose});
  return{pool,module,provider,authority,actor,meta,generate,state:()=>state,keyring,calls,doctorId,authId,appointmentId,lineage,context,queries,
    revoke:()=>{revoked=true;},ineligible:()=>{eligible=false;},advance:(ms:number)=>{now+=ms;},crashAudit:()=>{outboxCrash=true;}};
}
const code=(expected:string)=>(error:unknown)=>error instanceof DomainError&&error.code===expected;

test('EDA Video quota claims serialize duplicate and concurrent provider starts without third creation',async()=>{
  const f=fixture(),id=randomUUID();const [one,two]=await Promise.all([f.generate(id),f.generate(id)]);
  assert.equal(one.generationId,two.generationId);assert.equal(f.calls.create,1);
  const results=await Promise.allSettled([f.generate(),f.generate()]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.calls.create,2);
  assert.equal([...f.state().quota.values()][0],2);assert.equal([...f.state().generations.values()].filter(r=>r.providerAttemptStartedAt).length,2);
  assert.equal(f.state().events.filter(e=>e.eventType==='vital.video.generation.changed'&&e.data.status==='ready').length,2);
});
test('EDA Video unknown started creation consumes quota and same command never repeats provider write',async()=>{
  const f=fixture(),id=randomUUID();f.provider.create=async()=>{f.calls.create++;throw new DomainError(503,'VIDEO_PROVIDER_UNCERTAIN','Unknown.');};
  await assert.rejects(f.generate(id),code('VIDEO_PROVIDER_UNCERTAIN'));const retry=await f.generate(id);
  assert.equal(retry.status,'uncertain');assert.equal(retry.meetingUrl,null);assert.equal(f.calls.create,1);assert.equal([...f.state().quota.values()][0],1);
  await assert.rejects(f.generate(),code('VIDEO_PROVIDER_UNCERTAIN'));await assert.rejects(f.generate(),code('VIDEO_GENERATION_QUOTA_REACHED'));assert.equal(f.calls.create,2);
});
test('EDA Video pre-provider rejection and quota transaction rollback do not consume starts',async()=>{
  const f=fixture();f.ineligible();await assert.rejects(f.generate(),code('VIDEO_GENERATION_INELIGIBLE'));assert.equal(f.state().operations.size,0);assert.equal(f.state().quota.size,0);
  const g=fixture();g.crashAudit();await assert.rejects(g.generate(),code('VIDEO_PROVIDER_UNCERTAIN'));assert.equal([...g.state().quota.values()][0]??0,0);assert.equal(g.calls.create,0);
});
test('EDA Video failed provider starts count separately from preflight and follow-up lineages',async()=>{
  const f=fixture();f.provider.create=async()=>{f.calls.create++;throw new DomainError(503,'VIDEO_PROVIDER_REJECTED','Rejected.');};
  await assert.rejects(f.generate(),code('VIDEO_PROVIDER_REJECTED'));assert.equal([...f.state().quota.values()][0],1);
  await assert.rejects(f.generate(randomUUID(),'follow_up'),code('VIDEO_PROVIDER_REJECTED'));assert.equal(f.state().quota.size,2);assert.equal(f.calls.create,2);
  const g=fixture();g.provider.create=async()=>{g.calls.create++;throw new DomainError(409,'VIDEO_RECONNECT_REQUIRED','Revoked.');};await assert.rejects(g.generate(),code('VIDEO_RECONNECT_REQUIRED'));assert.equal(g.state().connections.get(g.doctorId).status,'reconnect_required');assert.equal(g.state().connections.get(g.doctorId).refreshToken,null);assert.equal(g.calls.create,1);assert.equal([...g.state().quota.values()][0],1);
});
test('EDA Video command hash conflicts revoked doctors and appointment substitution fail closed',async()=>{
  const f=fixture(),id=randomUUID();await f.generate(id);
  await assert.rejects(f.module.generate(f.actor('generate',f.appointmentId),{...f.meta(id),requestHash:'b'.repeat(64)},{requestId:id,appointmentId:f.appointmentId,purpose:'approval'}),code('VIDEO_COMMAND_REPLAY_CONFLICT'));
  await assert.rejects(f.module.generate(f.actor('generate',f.appointmentId),f.meta(),{requestId:randomUUID(),appointmentId:f.appointmentId,purpose:'approval'}),code('VIDEO_COMMAND_ID_MISMATCH'));
  f.revoke();await assert.rejects(f.generate(id),code('VIDEO_DOCTOR_REVOKED'));assert.equal(f.calls.create,1);
});
test('EDA Video short-term doctor and application throttles reject before quota or provider start',async()=>{
  for(const application of [false,true]){const f=fixture();for(let i=0;i<(application?50:5);i++){const id=randomUUID();f.state().generations.set(id,{id,doctorId:application?randomUUID():f.doctorId,createdAt:new Date()});}
    await assert.rejects(f.generate(),code('VIDEO_GENERATION_THROTTLED'));assert.equal(f.state().quota.size,0);assert.equal(f.calls.create,0);assert.equal(f.state().operations.size,0);}
});
test('EDA Video OAuth encrypts PKCE binding only and replays completed callback without another exchange',async()=>{
  const f=fixture(),start=f.meta();const connection=await f.module.start(f.actor('oauth.start'),start,{returnTo:'/doctor/dashboard/appointments'});
  assert.deepEqual(await f.module.start(f.actor('oauth.start'),start,{returnTo:'/doctor/dashboard/appointments'}),connection);
  const url=new URL(connection.authorizationUrl);assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.ok(url.searchParams.get('scope')!.includes(MEET_SCOPE));
  const saved=[...f.state().oauth.values()][0],secret=JSON.parse(decryptMeetSecret(f.keyring,saved.secret,f.doctorId));assert.deepEqual(Object.keys(secret).sort(),['binding','revision','state','verifier']);
  const meta=f.meta(),body={state:url.searchParams.get('state')!,binding:connection.binding,code:'sensitive-callback-code'};
  const outcome=await f.module.callback(f.actor('oauth.callback'),meta,body);assert.equal(outcome.outcome,'connected');assert.deepEqual(await f.module.callback(f.actor('oauth.callback'),meta,body),outcome);assert.equal(f.calls.exchange,1);
  assert.doesNotMatch(JSON.stringify([...f.state().operations.values(),...f.state().events]),/sensitive-callback-code|google-access-secret|new-refresh-secret|meet\.google\.com|authorizationUrl/);
});
test('EDA Video callback binding expiry cancellation and ambiguous exchange cannot reuse authorization codes',async()=>{
  const f=fixture(),start=await f.module.start(f.actor('oauth.start'),f.meta(),{}),state=new URL(start.authorizationUrl).searchParams.get('state')!;
  await assert.rejects(f.module.callback(f.actor('oauth.callback'),f.meta(),{state,binding:'forged',code:'code'}),code('VIDEO_OAUTH_STATE_INVALID'));assert.equal(f.calls.exchange,0);
  f.provider.exchangeCode=async()=>{f.calls.exchange++;throw new Error('private-provider-failure');};const meta=f.meta(),body={state,binding:start.binding,code:'code'};
  await assert.rejects(f.module.callback(f.actor('oauth.callback'),meta,body),code('VIDEO_OAUTH_OUTCOME_UNKNOWN'));
  await assert.rejects(f.module.callback(f.actor('oauth.callback'),meta,body),code('VIDEO_OAUTH_OUTCOME_UNKNOWN'));assert.equal(f.calls.exchange,1);
  const g=fixture(),pending=await g.module.start(g.actor('oauth.start'),g.meta(),{});g.advance(600001);
  await assert.rejects(g.module.callback(g.actor('oauth.callback'),g.meta(),{state:new URL(pending.authorizationUrl).searchParams.get('state'),binding:pending.binding,error:'access_denied'}),code('VIDEO_OAUTH_OUTCOME_UNKNOWN'));
  const h=fixture(),cancel=await h.module.start(h.actor('oauth.start'),h.meta(),{});assert.equal((await h.module.callback(h.actor('oauth.callback'),h.meta(),{state:new URL(cancel.authorizationUrl).searchParams.get('state'),binding:cancel.binding,error:'access_denied'})).outcome,'cancelled');assert.equal(h.calls.exchange,0);
});
test('EDA Video refresh disconnect race fences credentials and never resets quota or saved resources',async()=>{
  const f=fixture();await f.generate();f.state().connections.get(f.doctorId).expiresAt=new Date(0);
  f.provider.refresh=async()=>{f.calls.refresh++;await f.module.disconnect(f.actor('disconnect'),f.meta());return{accessToken:'late-access',refreshToken:'late-refresh',expiresAt:new Date(Date.now()+3600000),scopes:[MEET_SCOPE]};};
  await assert.rejects(f.generate(),code('VIDEO_RECONNECT_REQUIRED'));const c=f.state().connections.get(f.doctorId);assert.equal(c.status,'disconnected');assert.equal(c.accessToken,null);assert.equal(c.refreshToken,null);assert.equal([...f.state().quota.values()][0],1);assert.equal(f.calls.create,1);
  const g=fixture();g.state().connections.get(g.doctorId).expiresAt=new Date(0);g.provider.refresh=async()=>{throw new DomainError(429,'VIDEO_PROVIDER_THROTTLED','Temporary.');};
  await assert.rejects(g.generate(),code('VIDEO_PROVIDER_THROTTLED'));assert.equal(g.state().connections.get(g.doctorId).status,'connected');assert.ok(g.state().connections.get(g.doctorId).refreshToken);assert.equal(g.calls.create,0);assert.equal(g.state().quota.size,0);
});
test('EDA Video disconnect duplicate command does not repeat revoke or claim unknown provider success',async()=>{
  const f=fixture(),meta=f.meta();f.provider.revoke=async()=>{f.calls.revoke++;throw new Error('unknown-revoke');};
  assert.deepEqual(await f.module.disconnect(f.actor('disconnect'),meta),{revoked:false});assert.deepEqual(await f.module.disconnect(f.actor('disconnect'),meta),{revoked:false});assert.equal(f.calls.revoke,1);
  const op=[...f.state().operations.values()][0];op.state='executing';assert.deepEqual(await f.module.disconnect(f.actor('disconnect'),meta),{revoked:false});assert.equal(f.calls.revoke,1);
});
test('EDA Video post-provider commit crash stays uncertain with no automatic replacement creation',async()=>{
  const f=fixture(),id=randomUUID(),create=f.provider.create;f.provider.create=async token=>{const space=await create(token);f.crashAudit();return space;};
  await assert.rejects(f.generate(id),code('VIDEO_PROVIDER_UNCERTAIN'));assert.equal((await f.generate(id)).status,'uncertain');assert.equal(f.calls.create,1);assert.equal([...f.state().quota.values()][0],1);
});
test('EDA Video historical resource reads follow authorized Core pointers and remain link-free in journals',async()=>{
  const f=fixture(),resourceId=randomUUID();f.context.videoResourceId=resourceId;
  f.state().resources.push({id:resourceId,appointmentId:randomUUID(),doctorId:f.doctorId,billingLineageId:f.lineage,associationVersion:2,version:2,provider:'gmeet',meetingUrl:'https://meet.google.com/abc-defg-hij',validationStatus:'validated',linkSavedAt:new Date()});
  const row=await f.module.resource(f.actor('resource.read',f.appointmentId),f.appointmentId);assert.equal(row.resourceId,resourceId);assert.equal(row.meetingUrl,'https://meet.google.com/abc-defg-hij');
  assert.ok(f.queries.every(sql=>!sql.includes('JOIN consultations')));assert.equal(f.state().operations.size,0);
});
test('EDA Video known uncertain creation recovers only by scoped retrieval without another provider start',async()=>{
  const f=fixture(),id=randomUUID(),create=f.provider.create;f.provider.create=async token=>{const space=await create(token);f.crashAudit();return space;};
  await assert.rejects(f.generate(id),code('VIDEO_PROVIDER_UNCERTAIN'));const row=[...f.state().generations.values()][0];let reads=0;
  f.provider.get=async(_token,name)=>{reads++;assert.equal(name,row.spaceName);return{spaceName:row.spaceName,meetingUrl:row.meetingUrl};};
  const recovered=await f.module.generation(f.actor('generation.read',row.id),row.id);assert.equal(recovered.status,'ready');assert.equal(reads,1);assert.equal(f.calls.create,1);assert.equal([...f.state().quota.values()][0],1);
  await f.module.generation(f.actor('generation.read',row.id),row.id);assert.equal(reads,1);assert.equal([...f.state().operations.values()][0].state,'completed');
  const g=fixture();g.provider.create=async()=>{g.calls.create++;throw new DomainError(503,'VIDEO_PROVIDER_UNCERTAIN','Unknown.');};await assert.rejects(g.generate());
  const unknown=[...g.state().generations.values()][0];assert.equal((await g.module.generation(g.actor('generation.read',unknown.id),unknown.id)).status,'uncertain');assert.equal(g.calls.create,1);
});
test('EDA Video expired ready generation serializes an unavailable result without exposing its saved link',async()=>{
  const f=fixture(),ready=await f.generate();f.advance(86400001);
  const row=await f.module.generation(f.actor('generation.read',ready.generationId),ready.generationId);assert.equal(row.status,'expired');assert.equal(row.meetingUrl,null);
});
test('EDA Video runtime is default-off and cannot activate maintenance without a real owner',()=>{
  const f=fixture();assert.equal(videoRuntime({corePool:f.pool,integrationsPool:f.pool},{}),undefined);
  assert.throws(()=>videoRuntime({corePool:f.pool,integrationsPool:f.pool},{VITAL_EDA_VIDEO_MAINTENANCE_ENABLED:'true'}),/VIDEO_MAINTENANCE_WITHOUT_OWNER/);
  assert.throws(()=>videoRuntime({corePool:f.pool,integrationsPool:f.pool},{VITAL_EDA_VIDEO_ENABLED:'true'}),/VIDEO_RUNTIME_DISABLED/);
});

test('EDA Video refresh preserves an omitted refresh token and denies a competing active refresh lease',async()=>{
  const f=fixture(),connection=f.state().connections.get(f.doctorId);connection.expiresAt=new Date(0);
  f.provider.refresh=async token=>{f.calls.refresh++;assert.equal(token,'google-refresh-secret');return{accessToken:'renewed-access',refreshToken:null,expiresAt:new Date(Date.now()+3600000),scopes:[MEET_SCOPE]};};
  await f.generate();assert.equal(f.calls.refresh,1);assert.equal(f.calls.create,1);
  assert.equal(decryptMeetSecret(f.keyring,f.state().connections.get(f.doctorId).refreshToken,f.doctorId),'google-refresh-secret');
  await f.generate();assert.equal(f.calls.refresh,1);assert.equal(f.calls.create,2);
  const g=fixture(),locked=g.state().connections.get(g.doctorId);locked.expiresAt=new Date(0);locked.refreshLease=randomUUID();locked.refreshLeaseUntil=new Date(Date.now()+30000);
  await assert.rejects(g.generate(),code('VIDEO_REFRESH_PENDING'));assert.equal(g.calls.refresh,0);assert.equal(g.calls.create,0);assert.equal(g.state().quota.size,0);
});

test('EDA Video revoked refresh consent clears local credentials without consuming provider creation quota',async()=>{
  const f=fixture();f.state().connections.get(f.doctorId).expiresAt=new Date(0);
  f.provider.refresh=async()=>{f.calls.refresh++;throw new DomainError(409,'VIDEO_RECONNECT_REQUIRED','Revoked.');};
  await assert.rejects(f.generate(),code('VIDEO_RECONNECT_REQUIRED'));const connection=f.state().connections.get(f.doctorId);
  assert.equal(connection.status,'reconnect_required');assert.equal(connection.accessToken,null);assert.equal(connection.refreshToken,null);
  assert.equal(connection.refreshLease,null);assert.equal(connection.revision,2);assert.equal(f.calls.refresh,1);assert.equal(f.calls.create,0);assert.equal(f.state().quota.size,0);
});

test('EDA Video disconnect commits credential removal before provider revocation and never retries an uncertain revoke',async()=>{
  const f=fixture(),command=f.meta();f.provider.revoke=async token=>{
    f.calls.revoke++;assert.equal(token,'google-refresh-secret');const connection=f.state().connections.get(f.doctorId);
    assert.equal(connection.status,'disconnected');assert.equal(connection.accessToken,null);assert.equal(connection.refreshToken,null);
    assert.equal(f.state().events.filter(event=>event.eventType==='vital.audit.requested').length,1);throw new Error('Unknown revoke result');
  };
  assert.deepEqual(await f.module.disconnect(f.actor('disconnect'),command),{revoked:false});
  assert.deepEqual(await f.module.disconnect(f.actor('disconnect'),command),{revoked:false});assert.equal(f.calls.revoke,1);
});

test('EDA Video OAuth can change Meet email without changing Auth identity and preserves only same-subject refresh credentials',async()=>{
  for(const sameSubject of[true,false]){
    const f=fixture();f.provider.exchangeCode=async()=>({accessToken:'callback-access',refreshToken:null,expiresAt:new Date(Date.now()+3600000),scopes:[MEET_SCOPE]});
    f.provider.identity=async()=>({subject:sameSubject?'google-subject':'another-google-subject',email:'separate-meet-account@example.test'});
    const start=await f.module.start(f.actor('oauth.start'),f.meta(),{}),body={state:new URL(start.authorizationUrl).searchParams.get('state')!,binding:start.binding,code:'test-callback-code'};
    if(sameSubject){await f.module.callback(f.actor('oauth.callback'),f.meta(),body);const connection=f.state().connections.get(f.doctorId);
      assert.equal(connection.email,'separate-meet-account@example.test');assert.equal(decryptMeetSecret(f.keyring,connection.refreshToken,f.doctorId),'google-refresh-secret');
    }else{await assert.rejects(f.module.callback(f.actor('oauth.callback'),f.meta(),body),code('VIDEO_OAUTH_OUTCOME_UNKNOWN'));assert.equal(f.state().connections.get(f.doctorId).googleSubject,'google-subject');}
    assert.ok(f.queries.every(sql=>!/(?:UPDATE|INSERT INTO) vital_users/.test(sql)));assert.equal(f.state().connections.size,1);
  }
});
