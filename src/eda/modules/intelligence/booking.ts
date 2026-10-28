import { saveOperationalBrief } from '../appointment/appointment-summary.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError,type Actor } from '../../contracts/actor.js';
import { intakeCrypto } from './crypto.js';
import { hasCurrentNormalization,intakePayloadSchema,type Concept } from './contracts.js';
import { hash } from './module.js';
export const intakeReferenceSchema=z.object({id:z.uuid(),version:z.number().int().nonnegative(),sessionBinding:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export async function consumeIntake(db:PoolClient,actor:Actor,appointmentId:string,raw:unknown,chiefComplaint:unknown,opqrst:unknown,environment:NodeJS.ProcessEnv=process.env){
  const ref=intakeReferenceSchema.parse(raw),crypto=intakeCrypto(environment);
  const row=(await db.query('SELECT * FROM ai_intake_drafts WHERE id=$1 AND "patientAuthId"=$2 AND "sessionBinding"=$3 AND "expiresAt">NOW() FOR UPDATE',[ref.id,actor.authId,ref.sessionBinding])).rows[0];
  if(!row||row.sandbox||row.version!==ref.version||!row.confirmedAt||!row.confirmation)throw new DomainError(409,'AI_DRAFT_STALE','Confirm your current symptom answers before booking.');
  const payload=intakePayloadSchema.parse(crypto.decrypt(row.payload,row.id));
  if(hash(payload.opqrst)!==hash(opqrst)||payload.chiefComplaint!==(chiefComplaint??null))throw new DomainError(409,'AI_INTAKE_MISMATCH','The confirmed answers changed.');
  const concepts=crypto.decrypt(row.confirmation,row.id) as Concept[],id=randomUUID(),sourceHash=hash({payload,concepts});
  const analyticsConcepts=row.analysis&&hasCurrentNormalization(crypto.decrypt(row.analysis,row.id))?concepts:concepts.length?concepts.map(c=>({...c,method:'corrected' as const})):null;
  const activation=(await db.query("SELECT \"activatedAt\" FROM ai_settings WHERE id='symptom-analytics'")).rows[0];
  await db.query('INSERT INTO ai_submissions(id,"appointmentId","patientAuthId","intakeVersion","submittedAt","reportDate","expiresAt","ageYears",payload,concepts,"sourceHash",status) VALUES($1,$2,$3,$4,NOW(),(NOW() AT TIME ZONE \'Asia/Manila\')::date,NOW()+INTERVAL \'12 months\',$5,$6,$7,$8,$9)',[id,appointmentId,actor.authId,row.version,row.ageYears,JSON.stringify(crypto.encrypt(payload,id)),JSON.stringify(analyticsConcepts),sourceHash,activation?'pending':'excluded']);
  await db.query('UPDATE pre_consultations SET "aiSubmissionId"=$2 WHERE "appointmentId"=$1',[appointmentId,id]);
  if(activation)await db.query("INSERT INTO ai_jobs(id,kind,\"resourceId\",\"sourceVersion\") VALUES($1,'submission',$2,$3)",[randomUUID(),id,row.version]);
  await saveOperationalBrief(db,appointmentId,payload.chiefComplaint,payload.opqrst,concepts,row.version);
  await db.query('DELETE FROM ai_intake_drafts WHERE id=$1',[row.id]);return id;
}
export async function approvedHandoff(db:{query:PoolClient['query']},appointmentId:string){
  const s=(await db.query('SELECT "approvedText","approvedHash","sourceHash" FROM appointment_intake_briefs WHERE "appointmentId"=$1',[appointmentId])).rows[0];
  return s&&s.approvedHash===s.sourceHash?s.approvedText as string:null;
}

export async function captureBooking(db:PoolClient,actor:Actor,appointmentId:string,chiefComplaint:string|null,opqrst:unknown,age:number|null){
  const settings=(await db.query("SELECT \"activatedAt\" FROM ai_settings WHERE id='symptom-analytics'")).rows[0];if(!settings)return;
  const payload=intakePayloadSchema.parse({chiefComplaint,opqrst,primarySymptom:{id:null,name:'Other / not sure'}}),id=randomUUID(),crypto=intakeCrypto();
  await db.query('INSERT INTO ai_submissions(id,"appointmentId","patientAuthId","intakeVersion","submittedAt","reportDate","expiresAt","ageYears",payload,"sourceHash") VALUES($1,$2,$3,0,NOW(),(NOW() AT TIME ZONE \'Asia/Manila\')::date,NOW()+INTERVAL \'12 months\',$4,$5,$6)',[id,appointmentId,actor.authId,age,JSON.stringify(crypto.encrypt(payload,id)),hash(payload)]);
  await db.query('UPDATE pre_consultations SET "aiSubmissionId"=$2 WHERE "appointmentId"=$1',[appointmentId,id]);
  await db.query("INSERT INTO ai_jobs(id,kind,\"resourceId\",\"sourceVersion\") VALUES($1,'submission',$2,0)",[randomUUID(),id]);
}
