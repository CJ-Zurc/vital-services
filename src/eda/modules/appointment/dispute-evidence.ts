import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from 'pg';
import { DomainError, requireScope, type Actor } from '../../contracts/actor.js';
import { validateUpload, type RecordsMime } from '../records/upload-validation.js';
import { S3RecordsStorage } from '../records/storage.js';
import { createFileInspector, verifyFileInspection } from '../records/inspection.js';
import { disputesEnabled, locklessOwned } from './native-dispute.js';

export function disputeStorage(env = process.env){
  const need=(key:string)=>{const value=env[key];if(!value)throw new DomainError(503,'STORAGE_UNAVAILABLE','Dispute storage is unavailable.');return value;};
  return new S3RecordsStorage({endpoint:need('VITAL_RECORDS_STORAGE_ENDPOINT'),publicEndpoint:need('VITAL_RECORDS_STORAGE_PUBLIC_ENDPOINT'),
    bucket:need('VITAL_RECORDS_STORAGE_BUCKET'),region:need('VITAL_RECORDS_STORAGE_REGION'),accessKeyId:need('VITAL_RECORDS_STORAGE_ACCESS_KEY'),secretAccessKey:need('VITAL_RECORDS_STORAGE_SECRET_KEY'),
    quarantinePrefix:'quarantine/disputes/',finalPrefix:'disputes/final/'});
}
export async function uploadDisputeEvidence(pool:Pool,actor:Actor,id:string,body:unknown){
  if(!disputesEnabled())throw new DomainError(503,'APPOINTMENT_DISPUTES_DISABLED','Disputes are disabled.');
  requireScope(actor,'appointments.dispute-evidence',id);const appointment=await locklessOwned(pool,actor,id);
  if(appointment.status!=='confirmed'||appointment.consultationType!=='virtual')throw new DomainError(409,'APPOINTMENT_APPEAL_INELIGIBLE','Report evidence cannot be added.');
  const input=z.object({attachment_id:z.uuid(),title:z.string().trim().min(1).max(255),mime_type:z.enum(['application/pdf','image/png','image/jpeg','image/webp']),content_base64:z.string().min(1).max(13981016)}).strict().parse(body);
  const bytes=Buffer.from(input.content_base64,'base64');
  if(bytes.toString('base64')!==input.content_base64)throw new DomainError(400,'RECORD_UPLOAD_INVALID','Invalid evidence encoding.');
  const validated=await validateUpload(bytes,input.mime_type),storage=disputeStorage();
  const key=storage.key('quarantine',input.attachment_id,validated.contentHash,validated.mimeType);
  await storage.putQuarantine(key,validated.bytes,validated.mimeType);
  const tx=await pool.connect();try{await tx.query('BEGIN');
    await tx.query('SELECT id FROM appointments WHERE id=$1 FOR UPDATE',[id]);
    const current=await locklessOwned(pool,actor,id);
    if(current.status!=='confirmed'||current.reviewHold)throw new DomainError(409,'APPOINTMENT_APPEAL_INELIGIBLE','Report evidence cannot be added.');
    const prior=(await tx.query('SELECT * FROM trace_dispute_evidence WHERE id=$1',[input.attachment_id])).rows[0];
    if(prior){if(prior.appointmentId!==id||prior.reporterAuthId!==actor.authId||prior.contentHash!==validated.contentHash||prior.title!==input.title)throw new DomainError(409,'RECORD_UPLOAD_CONFLICT','Evidence identifier conflict.');}
    else{
      const count=(await tx.query(`SELECT count(*)::int AS n FROM trace_dispute_evidence WHERE "appointmentId"=$1 AND "reportId" IS NULL AND "createdAt">now()-interval '1 day'`,[id])).rows[0];
      if(count.n>=25)throw new DomainError(409,'RECORD_UPLOAD_LIMIT','Evidence upload capacity is temporarily occupied.');
      await tx.query(`INSERT INTO trace_dispute_evidence(id,"appointmentId","reporterAuthId",title,"mimeType","contentHash","byteLength","storageKey") VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [input.attachment_id,id,actor.authId,input.title,validated.mimeType,validated.contentHash,validated.byteLength,key]);
    }
    await tx.query('COMMIT');return{attachmentId:input.attachment_id,status:'quarantined'};
  }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
}
export async function verifiedDisputeEvidence(pool:Pool,reportId:string,correlationId:string){
  const storage=disputeStorage(),rows=(await pool.query('SELECT * FROM trace_dispute_evidence WHERE "reportId"=$1 ORDER BY id',[reportId])).rows;
  const inspector=createFileInspector(()=>({socketPath:process.env.VITAL_RECORDS_CLAMAV_SOCKET??'',daemonConfigPath:process.env.VITAL_RECORDS_CLAMAV_CONFIG??'',deadlineMs:15000,maxDatabaseAgeMs:86400000}));
  const result=[];
  for(const row of rows){
    const expected={contentHash:row.contentHash,byteLength:row.byteLength,mimeType:row.mimeType as RecordsMime};
    const bytes=row.status==='verified'?await storage.readFinal(storage.key('final',row.id,row.contentHash,row.mimeType),expected):await storage.readQuarantine(row.storageKey,expected);
    const evidence=await inspector.scan(bytes,undefined,correlationId);verifyFileInspection(evidence,expected,Date.now());
    await storage.ensureFinal(storage.key('final',row.id,row.contentHash,row.mimeType),bytes,row.mimeType);
    await pool.query(`UPDATE trace_dispute_evidence SET status='verified' WHERE id=$1 AND "reportId"=$2`,[row.id,reportId]);
    result.push({attachment_id:row.id,content_base64:bytes.toString('base64'),sha256:row.contentHash});
  }return result;
}
