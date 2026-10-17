import assert from 'node:assert/strict';
import { generateKeyPairSync,randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer,request as httpsRequest } from 'node:https';
import type { TestContext } from 'node:test';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '../../src/eda/generated/core/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { createEdaApp } from '../../src/eda/http/app.js';
import { requestHash } from '../../src/eda/infrastructure/security.js';
import { envelopeFromRow,type OutboxRow } from '../../src/eda/infrastructure/outbox.js';
import { publishConfirmed } from '../../src/eda/infrastructure/broker.js';
import { consumeVideoFact } from '../../src/eda/workers/video.js';
import { parseEvent } from '../../src/eda/contracts/events.js';
import { createVideoModule } from '../../src/eda/modules/video/module.js';
import { createVideoAuthority } from '../../src/eda/modules/video/authority.js';
import { createVideoAssociations } from '../../src/eda/modules/video/association.js';
import { selectionHash } from '../../src/eda/modules/video/contracts.js';
import { meetKeyring,encryptMeetSecret } from '../../src/eda/modules/video/crypto.js';
import { MEET_SCOPE,type MeetProvider } from '../../src/eda/modules/video/provider.js';
import { fixture,type Context } from './payment-live.js';

export function videoLiveConfiguration(environment:NodeJS.ProcessEnv){
  if(environment.EDA_TEST_VIDEO_ENABLED===undefined||environment.EDA_TEST_VIDEO_ENABLED==='false')return false;
  if(environment.EDA_TEST_VIDEO_ENABLED!=='true'||environment.EDA_TEST_ENABLED!=='true'||environment.EDA_TEST_ISOLATED!=='yes')throw new Error('VIDEO_TEST_ISOLATION_REQUIRED');
  for(const domain of ['core','integrations']){const url=new URL(environment['EDA_TEST_'+domain.toUpperCase()+'_DATABASE_URL']??'');
    if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='postgres'||(url.port||'5432')!=='5432'||url.pathname!=='/vital_'+domain+'_test'||decodeURIComponent(url.username)!=='vital_'+domain+'_worker'||!url.password||url.search||url.hash)throw new Error('VIDEO_TEST_SHARED_DATABASE_DENIED');}
  return true;
}
async function videoFixture<T>(context:Context,run:(value:Awaited<ReturnType<typeof setup>>)=>Promise<T>){
  return fixture(context,async f=>{const video=await setup(context,f);
    try{return await run(video);}finally{
      const resources=(await context.integrations.query('SELECT id FROM video_resources WHERE "doctorId"=$1',[f.doctorId])).rows.map(r=>r.id);
      const generations=(await context.integrations.query('SELECT id FROM google_meet_generations WHERE "doctorId"=$1',[f.doctorId])).rows.map(r=>r.id);
      const events=(await context.integrations.query('SELECT id FROM outbox_events WHERE "aggregateId"=ANY($1::text[])',[[...resources,...generations]])).rows.map(r=>r.id);
      await context.integrations.query('DELETE FROM inbox_events WHERE "consumerId"=$1 AND "eventId"=ANY($2::text[])',['video-state',events]);
      await context.integrations.query('DELETE FROM outbox_events WHERE id=ANY($1::text[])',[events]);
      await context.integrations.query('DELETE FROM video_association_holds WHERE "billingLineageId"=$1',[f.lineage]);
      await context.integrations.query('DELETE FROM video_workflow_holds WHERE "doctorId"=$1',[f.doctorId]);
      await context.integrations.query('DELETE FROM video_resources WHERE "doctorId"=$1',[f.doctorId]);
      await context.integrations.query('DELETE FROM video_operations WHERE "actorAuthId"=$1',[f.doctorAuthId]);
      await context.integrations.query('DELETE FROM meet_generation_quotas WHERE "doctorId"=$1',[f.doctorId]);
      await context.integrations.query('DELETE FROM google_meet_generations WHERE "doctorId"=$1',[f.doctorId]);
      await context.integrations.query('DELETE FROM google_meet_oauth_states WHERE "doctorId"=$1',[f.doctorId]);
      await context.integrations.query('DELETE FROM google_meet_connections WHERE "doctorId"=$1',[f.doctorId]);
      await context.core.query('DELETE FROM consultations WHERE "appointmentId"=$1',[f.appointmentId]);
    }
  });
}
async function setup(context:Context,f:Parameters<Parameters<typeof fixture>[1]>[0]){
  const keyring=meetKeyring({activeKeyId:'test',keys:{test:Buffer.alloc(32,42).toString('base64')}});let writes=0;
  // Real DB/broker/mTLS, but provider transport is deliberately an injected test fixture.
  const provider:MeetProvider={create:async()=>{writes++;const code=['abc-defg-hij','xyz-abcd-efg'][writes-1]!;return{spaceName:'spaces/test_'+randomUUID(),meetingUrl:'https://meet.google.com/'+code};},
    get:async()=>{throw new Error('UNUSED');},exchangeCode:async()=>{throw new Error('UNUSED');},refresh:async()=>{throw new Error('UNUSED');},identity:async()=>{throw new Error('UNUSED');},revoke:async()=>{}};
  await context.core.query(`UPDATE appointments SET status='pending',"consultationType"='virtual',"proposedEndAt"="scheduledAt"+INTERVAL '1 hour' WHERE id=$1`,[f.appointmentId]);
  await context.integrations.query(`INSERT INTO google_meet_connections (id,"doctorId",status,revision,scopes,"accessToken","refreshToken","expiresAt","updatedAt") VALUES($1,$2,'connected',1,$3,$4,$5,NOW()+INTERVAL '1 hour',NOW())`,[randomUUID(),f.doctorId,[MEET_SCOPE],encryptMeetSecret(keyring,'fixture-access',f.doctorId),encryptMeetSecret(keyring,'fixture-refresh',f.doctorId)]);
  const authority=createVideoAuthority(context.core),associations=createVideoAssociations(context.integrations,authority);
  const module=createVideoModule(context.integrations,authority,associations,{googleEnabled:true,appOrigin:'https://vital.test',clientId:'fixture-client',redirectUri:'https://vital.test/api/doctor/google-meet/callback',provider,keyring});
  const actor={...f.actor,authId:f.doctorAuthId,role:'doctor' as const,resource:f.appointmentId,scopes:['video.generate']};
  const generate=(id=randomUUID())=>module.generate(actor,{operationId:id,requestHash:'a'.repeat(64)},{requestId:id,appointmentId:f.appointmentId,purpose:'approval'});
  return{...f,module,authority,associations,actor,generate,writes:()=>writes};
}
export async function videoLiveScenarios(t:TestContext,context:Context){
  await t.test('EDA Video real PostgreSQL concurrent commands quota rollback and unknown creation remain bounded',()=>videoFixture(context,async f=>{
    const id=randomUUID();await Promise.all([f.generate(id),f.generate(id)]);assert.equal(f.writes(),1);
    const outcomes=await Promise.allSettled([f.generate(),f.generate()]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.writes(),2);
    const quota=(await context.integrations.query('SELECT "attemptsStarted" FROM meet_generation_quotas WHERE "doctorId"=$1 AND "billingLineageId"=$2',[f.doctorId,f.lineage])).rows[0];assert.equal(quota.attemptsStarted,2);
    const generation=(await context.integrations.query('SELECT id,"requestId" FROM google_meet_generations WHERE "doctorId"=$1 ORDER BY "createdAt" LIMIT 1',[f.doctorId])).rows[0];
    await context.integrations.query(`UPDATE google_meet_generations SET status='uncertain',"spaceName"=NULL,"meetingUrl"=NULL WHERE id=$1`,[generation.id]);
    assert.equal((await f.generate(generation.requestId)).status,'uncertain');assert.equal(f.writes(),2);
  }));
  await t.test('EDA Video real association commits and broker inbox deduplicates without generating another room',()=>videoFixture(context,async f=>{
    const generation=await f.generate(),workflowId=randomUUID(),selection={meetingGenerationId:generation.generationId},hash=selectionHash(selection);
    await context.core.query(`INSERT INTO appointment_workflows (id,"appointmentId","targetAppointmentId","actorAuthId",kind,"inputHash","expectedVersion","prepareOperationId","expiresAt","videoSelectionHash","videoTargetVersion","videoCorrelationId","updatedAt") VALUES($1::uuid,$2,$2,$3,'approve',$4,0,$5::uuid,NOW()+INTERVAL '5 minutes',$6,0,$7,NOW())`,[workflowId,f.appointmentId,f.doctorAuthId,'a'.repeat(64),randomUUID(),hash,randomUUID()]);
    const receipt=await f.associations.prepareWorkflow(workflowId,selection);
    await context.core.query('UPDATE appointment_workflows SET "videoReceipt"=$2::jsonb,"videoProcessingState"=\'prepared\' WHERE id=$1::uuid',[workflowId,JSON.stringify(receipt)]);
    // This is explicit owner-state fixture setup, not a synthetic runtime acknowledgement.
    await context.core.query(`UPDATE appointments SET status='approved',version=version+1 WHERE id=$1`,[f.appointmentId]);
    await context.core.query(`UPDATE appointment_workflows SET state='committed',receipt=$2::jsonb WHERE id=$1::uuid`,[workflowId,JSON.stringify({ehrCaseId:randomUUID()})]);
    await f.associations.finalizeWorkflow(workflowId);await f.associations.finalizeWorkflow(workflowId);assert.equal(f.writes(),1);
    const resource=(await context.integrations.query('SELECT id,version,"googleSpaceName" FROM video_resources WHERE "appointmentId"=$1',[f.appointmentId])).rows[0];assert.equal(resource.version,1);assert.ok(resource.googleSpaceName);
    assert.equal((await context.core.query('SELECT "videoResourceId" FROM consultations WHERE "appointmentId"=$1',[f.appointmentId])).rows[0].videoResourceId,resource.id);
    const fact=(await context.integrations.query<OutboxRow>('SELECT * FROM outbox_events WHERE "aggregateId"=$1 AND "eventType"=$2',[resource.id,'vital.video.resource.changed'])).rows[0]!;
    const event=envelopeFromRow(fact);await publishConfirmed(context.publisher,context.exchange,'routed',event);const delivered=await context.channel.get(context.queue,{noAck:false});assert.ok(delivered);
    const received=parseEvent(JSON.parse(delivered.content.toString()));assert.equal(received.eventId,event.eventId);
    await Promise.all([consumeVideoFact(context.integrations,received),consumeVideoFact(context.integrations,received)]);context.channel.ack(delivered);
    assert.equal((await context.integrations.query('SELECT 1 FROM inbox_events WHERE "consumerId"=$1 AND "eventId"=$2',['video-state',event.eventId])).rowCount,1);
    assert.equal(f.writes(),1);
  }));
  await t.test('EDA Video actual process mTLS denies wrong certificate audience scope resource and payload',()=>videoFixture(context,async f=>{
    const prisma=new PrismaClient({adapter:new PrismaPg(context.core,{disposeExternalPool:false})}),keys=generateKeyPairSync('rsa',{modulusLength:2048});
    const app=createEdaApp(prisma,{issuer:'vital-web',audience:'vital-services',peerName:'vital-web',keyId:'test',publicKey:keys.publicKey.export({format:'pem',type:'spki'}).toString()},false,undefined,undefined,undefined,undefined,f.module);
    const server=createServer({key:readFileSync(context.certs.apiKey),cert:readFileSync(context.certs.apiCert),ca:readFileSync(context.certs.serviceCa),requestCert:true,rejectUnauthorized:true},app);
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port,path='/internal/v1/video/generations';
    const call=(cert=true,audience='vital-services',resource=f.appointmentId,scope='video.generate',extra={})=>{const id=randomUUID(),body=JSON.stringify({requestId:id,appointmentId:f.appointmentId,purpose:'approval',...extra});
      const token=jwt.sign({actor:{...f.actor,resource,scopes:[scope]},action:'POST '+path,requestHash:requestHash('POST',path,JSON.parse(body))},keys.privateKey,{algorithm:'RS256',keyid:'test',issuer:'vital-web',audience,subject:f.doctorAuthId,jwtid:id,expiresIn:30});
      return new Promise<number>((resolve,reject)=>{const req=httpsRequest({host:'127.0.0.1',port,servername:'vital-api.test',method:'POST',path,ca:readFileSync(context.certs.serviceCa),...(cert?{key:readFileSync(context.certs.webKey),cert:readFileSync(context.certs.webCert)}:{}),headers:{'X-Vital-Actor-Assertion':token,'Content-Type':'application/json'}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode??0));});req.setTimeout(5000,()=>req.destroy(new Error('VIDEO_TEST_TLS_TIMEOUT')));req.once('error',reject);req.end(body);});};
    try{await assert.rejects(call(false));assert.equal(await call(true,'other-audience'),401);assert.equal(await call(true,'vital-services',randomUUID()),403);assert.equal(await call(true,'vital-services',f.appointmentId,'payments.checkout'),403);assert.equal(await call(true,'vital-services',f.appointmentId,'video.generate',{doctorId:randomUUID()}),400);assert.equal(await call(),200);assert.equal(f.writes(),1);}
    finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await prisma.$disconnect();}
  }));
}
