import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { intakeCrypto } from './crypto.js';
import { intakePayloadSchema } from './contracts.js';
import { hash } from './module.js';
export async function reviseIntelligence(db:PoolClient,appointmentId:string,complaint:string){
  const row=(await db.query('SELECT s.* FROM pre_consultations p JOIN ai_submissions s ON s.id=p."aiSubmissionId" WHERE p."appointmentId"=$1 FOR UPDATE OF s',[appointmentId])).rows[0];
  if(!row)return;
  const crypto=intakeCrypto(),payload=intakePayloadSchema.parse(crypto.decrypt(row.payload,row.id));payload.chiefComplaint=complaint;
  // Explicit patient corrections survive later NLP runs; other mentions are re-extracted.
  const retained=(row.concepts??[]).filter((c:{method:string})=>['corrected','selected'].includes(c.method));
  const version=row.intakeVersion+1;
  await db.query('UPDATE ai_submissions SET payload=$2,concepts=$3,"processedHash"=COALESCE("processedHash","sourceHash"),"sourceHash"=$4,"intakeVersion"=$5,status=\'pending\',"approvedHash"=NULL,"approvedBrief"=NULL,"approvedBy"=NULL,"approvedAt"=NULL,"updatedAt"=NOW() WHERE id=$1',
    [row.id,JSON.stringify(crypto.encrypt(payload,row.id)),JSON.stringify(retained),hash({payload,retained}),version]);
  await db.query("INSERT INTO ai_jobs(id,kind,\"resourceId\",\"sourceVersion\") VALUES($1,'submission',$2,$3) ON CONFLICT DO NOTHING",[randomUUID(),row.id,version]);
}
