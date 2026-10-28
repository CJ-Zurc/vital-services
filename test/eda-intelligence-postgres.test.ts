import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createIntelligence } from '../src/eda/modules/intelligence/module.js';
import { intelligenceWorker } from '../src/eda/modules/intelligence/worker.js';
import type { Actor } from '../src/eda/contracts/actor.js';

test('isolated PostgreSQL drafts enforce encryption, versions, isolation, expiry and logout', {skip:!process.env.VITAL_AI_TEST_DATABASE_URL}, async()=>{
  const url=new URL(process.env.VITAL_AI_TEST_DATABASE_URL!);
  assert.equal(url.hostname,'127.0.0.1');
  assert.equal(url.pathname,'/vital_ai_implementation_test');
  const pool=new Pool({connectionString:url.toString()});
  const authId=randomUUID(),userId=randomUUID();
  const environment={VITAL_AI_ENABLED:'true',VITAL_AI_PATIENT_ENABLED:'true',VITAL_AI_ENCRYPTION_KEYS:JSON.stringify({1:Buffer.alloc(32,9).toString('base64')}),VITAL_AI_ACTIVE_KEY_VERSION:'1'};
  const module=createIntelligence(pool,environment);
  const actor:Actor={authId,role:'patient',serviceId:'vital-web',scopes:['ai.intakes/save','ai.intakes/read','ai.intakes/delete'],resource:authId,correlationId:randomUUID(),isSuperAdmin:false};
  const session={binding:'c'.repeat(64),expiresAt:new Date(Date.now()+120000).toISOString()};
  const payload={chiefComplaint:'Synthetic private fixture',primarySymptom:{id:null,name:'Other / not sure'},opqrst:{}};
  try{
    await pool.query('INSERT INTO vital_users(id,"authId",role) VALUES($1,$2,\'patient\')',[userId,authId]);
    await pool.query('INSERT INTO vital_patients("userId","authId") VALUES($1,$2)',[userId,authId]);
    const first=await module.execute(actor,'intakes/save',{session,expectedVersion:null,payload,ageYears:30}) as {id:string;version:number;payload:unknown};
    assert.deepEqual(first.payload,payload);
    const stored=(await pool.query('SELECT payload FROM ai_intake_drafts WHERE id=$1',[first.id])).rows[0];
    assert.doesNotMatch(JSON.stringify(stored),/Synthetic private fixture/);
    await assert.rejects(module.execute(actor,'intakes/save',{session,expectedVersion:null,payload,ageYears:30}),{code:'AI_DRAFT_VERSION_CHANGED'});
    const next=await module.execute(actor,'intakes/save',{session,expectedVersion:first.version,payload,ageYears:30}) as {version:number};
    assert.equal(next.version,first.version+1);
    await assert.rejects(module.execute(actor,'intakes/read',{session:{...session,binding:'d'.repeat(64)}}),{code:'AI_DRAFT_NOT_FOUND'});
    await pool.query('UPDATE ai_intake_drafts SET "expiresAt"=NOW()-INTERVAL \'1 second\' WHERE id=$1',[first.id]);
    await assert.rejects(module.execute(actor,'intakes/read',{session}),{code:'AI_DRAFT_NOT_FOUND'});
    const worker=intelligenceWorker(pool,environment);
    await worker.maintenance();
    assert.equal((await pool.query('SELECT 1 FROM ai_intake_drafts WHERE id=$1',[first.id])).rowCount,0);
    const jobId=randomUUID();
    await pool.query('INSERT INTO ai_jobs(id,kind,"resourceId","sourceVersion") VALUES($1,\'interactive\',$2,0)',[jobId,first.id]);
    assert.equal(await worker.tick(),true);
    assert.equal((await pool.query('SELECT status FROM ai_jobs WHERE id=$1',[jobId])).rows[0].status,'stale');
    await pool.query('DELETE FROM ai_jobs WHERE id=$1',[jobId]);
    await module.execute(actor,'intakes/delete',{session});
    await assert.rejects(module.execute(actor,'intakes/save',{session,expectedVersion:null,payload,ageYears:30}),{code:'AI_SESSION_REVOKED'});
  }finally{
    await pool.query('DELETE FROM ai_intake_drafts WHERE "patientAuthId"=$1',[authId]);
    await pool.query('DELETE FROM ai_intake_sessions WHERE "patientAuthId"=$1',[authId]);
    await pool.query('DELETE FROM vital_patients WHERE "authId"=$1',[authId]);
    await pool.query('DELETE FROM vital_users WHERE id=$1',[userId]);
    await pool.end();
  }
});
