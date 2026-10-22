import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError,requireScope,type Actor } from '../../contracts/actor.js';
import { appendSqlOutbox } from '../../infrastructure/outbox.js';
import { createAcknowledgmentPdfBuffer,type AcknowledgmentPdf } from '../records/bgh-pdf.js';
import { sha256 } from '../records/upload-validation.js';
import type { BillingAuthority } from './payment.js';
import type { RecordsFontConfig } from '../records/pdf.js';
export function createAcknowledgments(pool:Pool,billing:BillingAuthority,fonts:RecordsFontConfig){
 return async(actor:Actor,appointmentId:string,file=false)=>{
  z.uuid().parse(appointmentId);requireScope(actor,'payments.acknowledgment.read',appointmentId);
  if(actor.role==='admin')await billing.assertAdmin(actor);
  else if(actor.role==='patient')await billing.authorize(actor,appointmentId);
  else throw new DomainError(403,'ACKNOWLEDGMENT_DENIED','Patient or authorized administrator required.');
  const tx=await pool.connect();
  try{await tx.query('BEGIN');
   const row=(await tx.query('SELECT i.*,p."patientAuthId",p.status AS "paymentStatus",p."refundedAt" FROM invoices i JOIN payments p ON p.id=i."paymentId" WHERE i."appointmentId"=$1 FOR UPDATE OF i',[appointmentId])).rows[0];
   if(!row||!row.acknowledgmentSnapshot)throw new DomainError(409,'ACKNOWLEDGMENT_NOT_READY','Acknowledgment is not available yet.');
   if(actor.role==='patient'&&row.patientAuthId!==actor.authId)throw new DomainError(403,'ACKNOWLEDGMENT_DENIED','Patient ownership required.');
   const snapshot=row.acknowledgmentSnapshot as AcknowledgmentPdf;
   let bytes:Buffer|undefined;
   if(file){bytes=row.acknowledgmentPdf?Buffer.from(row.acknowledgmentPdf):await createAcknowledgmentPdfBuffer(snapshot,fonts);
    if(row.acknowledgmentHash&&sha256(bytes)!==row.acknowledgmentHash)throw new DomainError(503,'ACKNOWLEDGMENT_HASH_INVALID','Acknowledgment unavailable.');
    if(!row.acknowledgmentPdf)await tx.query('UPDATE invoices SET "acknowledgmentPdf"=$2,"acknowledgmentHash"=$3 WHERE id=$1',[row.id,bytes,sha256(bytes)]);
   }
   await appendSqlOutbox(tx,{producer:'payment',eventType:'vital.audit.requested',aggregateId:row.id,aggregateVersion:1,correlationId:actor.correlationId,data:{auditType:file?'vital.payment.acknowledgment_downloaded':'vital.payment.acknowledgment_viewed',actorAuthId:actor.authId,resourceId:row.id,resourceType:'payment'}});
   await tx.query('COMMIT');return{...snapshot,paymentStatus:row.paymentStatus,refundedAt:row.refundedAt?.toISOString()??null,...(bytes?{base64:bytes.toString('base64'),sha256:sha256(bytes)}:{})};
  }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
 };
}
