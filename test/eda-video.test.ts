import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createVideoModule,meetAutomationRetired } from '../src/eda/modules/video/module.js';
import { videoRuntime } from '../src/eda/modules/video/runtime.js';
import type { Pool } from 'pg';
import type { Actor } from '../src/eda/contracts/actor.js';
import type { VideoAuthority,VideoAssociations } from '../src/eda/modules/video/contracts.js';
test('Meet automation retirement returns 410 without provider or database work',()=>{
  assert.throws(meetAutomationRetired,(e:any)=>e.status===410&&e.code==='MEET_AUTOMATION_RETIRED');
});
test('Manual video runtime starts without Google config, even with obsolete generation flag',()=>{
 const pools={corePool:{} as Pool,integrationsPool:{} as Pool};
 assert.ok(videoRuntime(pools,{VITAL_EDA_ENABLED:'true',VITAL_EDA_VIDEO_ENABLED:'true',VITAL_VIDEO_GOOGLE_ENABLED:'true'}));
 assert.equal(videoRuntime(pools,{}),undefined);
 assert.throws(()=>videoRuntime(pools,{VITAL_EDA_VIDEO_MAINTENANCE_ENABLED:'true'}));
});
test('Video resource reads retain saved generated links and delegate current membership and ownership checks',async()=>{
 const id=randomUUID(),doctorId=randomUUID(),resourceId=randomUUID(),lineage=randomUUID();let recovered=0;
 const authority={appointment:async()=>({consultationType:'virtual',doctorId,billingLineageId:lineage,associationVersion:1,videoResourceId:resourceId})} as unknown as VideoAuthority;
 const pool={query:async()=>({rows:[{id:resourceId,doctorId,version:2,provider:'gmeet',meetingUrl:'https://meet.google.com/abc-defg-hij',normalizedMeetingUrl:'https://meet.google.com/abc-defg-hij',meetingUrlHash:'a'.repeat(64),validationStatus:'validated',linkGeneratedAt:new Date(),linkSavedAt:new Date()}]})} as unknown as Pool;
 const module=createVideoModule(pool,authority,{recover:async()=>{recovered++;return 1;}} as VideoAssociations);
 const actor={authId:randomUUID(),role:'doctor',scopes:['video.resource.read'],resource:id} as Actor;
 assert.equal((await module.resource(actor,id)).meetingUrl,'https://meet.google.com/abc-defg-hij');
 await assert.rejects(module.resource({...actor,scopes:[]},id));
 authority.appointment=async()=>{throw new Error('OWNER_DENIED');};await assert.rejects(module.resource(actor,id),/OWNER_DENIED/);
 await module.tick();assert.equal(recovered,1);
});

test('Internal retired routes return 410 even when the resource owner is disabled',async()=>{
 const express=(await import('express')).default;const {createVideoRouter}=await import('../src/eda/http/video-router.js');
 const app=express();app.use('/internal/v1/video',createVideoRouter());
 app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status).json({code:error.code}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
 try{const port=(server.address() as {port:number}).port;
  for(const [path,method] of [['connection','GET'],['connection','DELETE'],['oauth/start','POST'],['oauth/callback','POST'],['generations','POST'],['generations/'+randomUUID(),'GET']]){
   const response=await fetch('http://127.0.0.1:'+port+'/internal/v1/video/'+path,{method});assert.equal(response.status,410);assert.equal((await response.json()).code,'MEET_AUTOMATION_RETIRED');
  }
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
