import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createAppointmentAccess,accessBinding } from '../src/eda/modules/appointment/appointment-access.js';
import { accessCrypto } from '../src/eda/modules/appointment/access-crypto.js';
import type { Actor } from '../src/eda/contracts/actor.js';
import type { AppointmentRow } from '../src/eda/modules/appointment/appointment-contracts.js';

test('isolated PostgreSQL serializes code redemption, persists failed attempts and preserves replay denial', {skip:!process.env.VITAL_APPOINTMENT_ACCESS_TEST_DATABASE_URL},async()=>{
 const url=new URL(process.env.VITAL_APPOINTMENT_ACCESS_TEST_DATABASE_URL!);
 assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/vital_appointment_access_test');
 const schema='appointment_access_test_'+randomUUID().replaceAll('-','');assert.match(schema,/^appointment_access_test_[a-f0-9]{32}$/);
 const admin=new Pool({connectionString:url.href,max:1});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new Pool({connectionString:url.href,max:4,options:`-c search_path=${schema} -c timezone=UTC`});
 try{
  await pool.query(`CREATE TABLE appointments(id TEXT PRIMARY KEY,"patientId" TEXT,"doctorId" TEXT,"patientAuthId" TEXT,"doctorAuthId" TEXT,status TEXT,version INTEGER,"billingLineageId" TEXT,"associationVersion" INTEGER,"scheduledAt" TIMESTAMPTZ,"proposedEndAt" TIMESTAMPTZ,"slotEndsAt" TIMESTAMPTZ,"completionDeadlineAt" TIMESTAMPTZ,"doctorConfirmedAt" TIMESTAMPTZ,"paperworkLockedAt" TIMESTAMPTZ);
   CREATE TABLE vital_users(id TEXT,"authId" TEXT,role TEXT);
   CREATE TABLE vital_doctors("userId" TEXT,"authId" TEXT);
   CREATE TABLE vital_patients("userId" TEXT,"authId" TEXT);
   CREATE TABLE consent_records(id TEXT,"patientId" TEXT,"appointmentId" TEXT,"consentType" TEXT,accepted BOOLEAN,"consentedAt" TIMESTAMPTZ);
   CREATE TABLE appointment_access("appointmentId" TEXT PRIMARY KEY,reference TEXT,"patientId" TEXT,"doctorId" TEXT,generation INTEGER,digest TEXT,ciphertext JSONB,attempts INTEGER,"consumedAt" TIMESTAMPTZ,"revokedAt" TIMESTAMPTZ,"grantUntil" TIMESTAMPTZ,"grantedAt" TIMESTAMPTZ,"ageYears" INTEGER,sex TEXT);
   CREATE TABLE appointment_access_attempts(id BIGSERIAL,"appointmentId" TEXT,"doctorId" TEXT,kind TEXT,"createdAt" TIMESTAMPTZ DEFAULT NOW());
   CREATE TABLE appointment_payment_projections("appointmentId" TEXT,"paymentId" TEXT,"sourceVersion" INTEGER,status TEXT,"reviewRequired" BOOLEAN,"billingLineageId" TEXT,"associationVersion" INTEGER);
   CREATE TABLE saga_operations(id TEXT,"billingLineageId" TEXT,status TEXT);
   CREATE TABLE appointment_workflows("appointmentId" TEXT,"sourceAppointmentId" TEXT,status TEXT);
   ALTER TABLE appointments ADD COLUMN "sourceAppointmentId" TEXT;
   CREATE TABLE outbox_events(id TEXT,"eventType" TEXT,"schemaVersion" INTEGER,producer TEXT,"aggregateId" TEXT,"aggregateVersion" INTEGER,"correlationId" TEXT,"causationId" TEXT,"occurredAt" TIMESTAMPTZ,payload JSONB,status TEXT,attempts INTEGER,"nextAttemptAt" TIMESTAMPTZ);`);
  const id=randomUUID(),patientId=randomUUID(),doctorId=randomUUID(),doctorAuthId=randomUUID(),patientAuthId=randomUUID(),lineage=randomUUID(),now=Date.now();
  await pool.query(`INSERT INTO appointments(id,"patientId","doctorId","patientAuthId","doctorAuthId",status,version,"billingLineageId","associationVersion","scheduledAt","proposedEndAt") VALUES($1,$2,$3,$4,$5,'confirmed',1,$6,1,$7,$8)`,[id,patientId,doctorId,patientAuthId,doctorAuthId,lineage,new Date(now),new Date(now+3600000)]);
  await pool.query(`INSERT INTO vital_users VALUES($1,$2,'doctor');`,[doctorId,doctorAuthId]);
  await pool.query('INSERT INTO vital_doctors VALUES($1,$2)',[doctorId,doctorAuthId]);
  await pool.query(`INSERT INTO consent_records VALUES($1,$2,$3,'medical_record',true,NOW())`,[randomUUID(),patientId,id]);
  await pool.query(`INSERT INTO appointment_payment_projections VALUES($1,$2,1,'paid',false,$3,1)`,[id,randomUUID(),lineage]);
  const environment={VITAL_APPOINTMENT_ACCESS_KEYS:JSON.stringify({1:Buffer.alloc(32,17).toString('base64')}),VITAL_APPOINTMENT_ACCESS_ACTIVE_KEY_VERSION:'1',VITAL_APPOINTMENT_ACCESS_DIGEST_KEY:Buffer.alloc(32,19).toString('base64')};
  const binding=accessBinding({appointmentId:id,patientId,doctorId,generation:1} as never),crypto=accessCrypto(environment),secret=crypto.issue(binding),code=crypto.retrieve(secret.ciphertext,binding);
  await pool.query(`INSERT INTO appointment_access("appointmentId",reference,"patientId","doctorId",generation,digest,ciphertext,attempts) VALUES($1,'7K4M9Q2R',$2,$3,1,$4,$5::jsonb,0)`,[id,patientId,doctorId,secret.digest,JSON.stringify(secret.ciphertext)]);
  const service=createAppointmentAccess(pool,async(db,key,lock)=>(await db.query<AppointmentRow>('SELECT * FROM appointments WHERE id=$1'+(lock?' FOR UPDATE':''),[key])).rows[0]!,environment,Date.now,{verifyPaid:async()=>{}});
  const actor:Actor={authId:doctorAuthId,role:'doctor',scopes:['appointments.access.redeem'],resource:id,correlationId:randomUUID(),serviceId:'vital-web',isSuperAdmin:false};
  const wrong=code==='000000'?'111111':'000000';
  await Promise.all(Array.from({length:4},()=>service.execute(actor,id,'redeem',{code:wrong,generation:1,expectedVersion:1})));
  assert.equal((await pool.query('SELECT attempts FROM appointment_access WHERE "appointmentId"=$1',[id])).rows[0].attempts,4);
  const results=await Promise.allSettled([service.execute(actor,id,'redeem',{code,generation:1,expectedVersion:1}),service.execute(actor,id,'redeem',{code,generation:1,expectedVersion:1})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  const state=(await pool.query('SELECT * FROM appointment_access WHERE "appointmentId"=$1',[id])).rows[0];
  assert.ok(state.grantedAt);assert.ok(state.consumedAt);assert.equal(state.digest,null);assert.equal(state.ciphertext,null);
  const audit=(await pool.query('SELECT payload FROM outbox_events')).rows;assert.equal(audit.length,1);assert.ok(!JSON.stringify(audit).includes(code));
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
