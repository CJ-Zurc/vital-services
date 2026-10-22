import { membership } from '../appointment/appointment.js';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, requireScope, type Actor } from '../../contracts/actor.js';
import { appendSqlOutbox } from '../../infrastructure/outbox.js';
import { protectPayload, unprotectPayload, type RecordsKeyring } from './protection.js';
import { ArtifactError, detectRecordsMime, sha256, validateUpload } from './upload-validation.js';
import type { FileInspector } from './inspection.js';
import { verifyQrScan } from '../profile/profile-qr.js';

export const signatureInput = z.object({ base64: z.string().min(1).max(44000), mimeType: z.enum(['image/png','image/jpeg']) }).strict();
export type SigningSnapshot = { signatureBase64: string; signatureHash: string; signatureAssetId: string; s2License: string; s2ValidFrom: string; s2ValidUntil: string };
export const signatureDate=(value:string|Date)=>typeof value==='string'?z.iso.date().parse(value):value.toISOString().slice(0,10);
const binding = (owner: string, id: string) => ({ patientId: owner, resourceId: id, schema: 'doctor-signature.v1' });
export function createDoctorSigning(pool: Pool, keyring: RecordsKeyring, scanner: FileInspector) {
  async function own(actor: Actor, write = false) {
    if (actor.role !== 'doctor') throw new DomainError(403,'SIGNATURE_DOCTOR_REQUIRED','Doctor required.');
    requireScope(actor, write ? 'records.signature.write' : 'records.signature.read', actor.authId);
    await membership(pool,actor,'doctor');
  }
  return {
    async read(actor: Actor) {
      await own(actor);
      const row = (await pool.query('SELECT s.id,s."contentHash",s."protectedPayload",s."createdAt" FROM doctor_signatures s JOIN vital_doctors d ON d."signatureAssetId"=s.id WHERE d."authId"=$1 AND s."doctorAuthId"=$1',[actor.authId])).rows[0];
      if (!row) return { signature: null };
      const payload = unprotectPayload<{base64:string}>(keyring,binding(actor.authId,row.id),row.protectedPayload);
      return { signature: { id: row.id, sha256: row.contentHash, base64: payload.base64, mimeType:'image/png', createdAt:row.createdAt.toISOString() } };
    },
    async upload(actor: Actor, operationId: string, raw: unknown) {
      await own(actor,true); z.uuid().parse(operationId);
      let stage = 'validation';
      try {
        const input = signatureInput.parse(raw), bytes=Buffer.from(input.base64,'base64');
        if (!bytes.length || bytes.length>32768 || bytes.toString('base64')!==input.base64 || detectRecordsMime(bytes)!==input.mimeType) throw new DomainError(400,'SIGNATURE_INVALID','Use a PNG/JPEG signature up to 32 KiB.');
        stage = 'input_scan';
        verifyQrScan(await scanner.scan(bytes),bytes,Date.now(),false,scanner.policy);
        stage = 'normalization';
        const normalized=await validateUpload(bytes,input.mimeType);
        const sharp=(await import('sharp')).default;
        const final=await sharp(normalized.bytes).resize({width:600,height:240,fit:'inside',withoutEnlargement:true}).png().toBuffer();
        if(final.length>32768)throw new DomainError(413,'SIGNATURE_TOO_LARGE','Use a smaller signature image.');
        stage = 'final_scan';
        const evidence=await scanner.scan(final); verifyQrScan(evidence,final,Date.now(),false,scanner.policy);
        const hash=sha256(bytes), contentHash=sha256(final),id=randomUUID();
        stage = 'persistence';
        const tx=await pool.connect();
        try {
          await tx.query('BEGIN');
          await membership(tx,actor,'doctor');
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['signature:'+actor.authId]);
          const old=(await tx.query('SELECT id,"inputHash","contentHash" FROM doctor_signatures WHERE "doctorAuthId"=$1 AND "operationId"=$2',[actor.authId,operationId])).rows[0];
          if(old){if(old.inputHash!==hash)throw new DomainError(409,'SIGNATURE_REPLAY_CONFLICT','Upload ID already used.');await tx.query('COMMIT');return {id:old.id,sha256:old.contentHash};}
          const payload=protectPayload(keyring,binding(actor.authId,id),{base64:final.toString('base64')});
          await tx.query('INSERT INTO doctor_signatures (id,"doctorAuthId","operationId","inputHash","contentHash","protectedPayload","scanEvidence") VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)',[id,actor.authId,operationId,hash,contentHash,JSON.stringify(payload),JSON.stringify(evidence)]);
          await tx.query('UPDATE vital_doctors SET "signatureAssetId"=$2,"changedAt"=NOW() WHERE "authId"=$1',[actor.authId,id]);
          await appendSqlOutbox(tx,{producer:'profile',eventType:'vital.audit.requested',aggregateId:id,aggregateVersion:1,correlationId:actor.correlationId,data:{auditType:'vital.profile.signature_saved',actorAuthId:actor.authId,resourceId:id,resourceType:'profile'}});
          await tx.query('COMMIT'); return {id,sha256:contentHash};
        }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
      } catch (error) {
        // Stable metadata only: never log image bytes, credentials, SQL or the
        // underlying exception message. Internal diagnostics do not cross BFF.
        if (error instanceof ArtifactError || !(error instanceof DomainError) && !(error instanceof z.ZodError)) {
          const code = error instanceof ArtifactError && /^(SCANNER|UPLOAD|IMAGE)_[A-Z_]+$/.test(error.code) ? error.code : 'SIGNATURE_PROCESSING_FAILED';
          console.error(JSON.stringify({level:'error',event:'vital.signature.upload_failed',correlationId:actor.correlationId,stage,code}));
        }
        if (error instanceof ArtifactError) {
          if (error.retryable || error.code.startsWith('SCANNER_')) throw new DomainError(503,'SIGNATURE_SERVICE_UNAVAILABLE','Signature processing is temporarily unavailable. Please try again later.');
          throw new DomainError(400,'SIGNATURE_INVALID','Choose a valid PNG or JPEG signature image.');
        }
        throw error;
      }
    },
  };
}

export async function signingSnapshot(pool: Pick<Pool,'query'>,keyring:RecordsKeyring,doctorAuthId:string):Promise<SigningSnapshot> {
  const row=(await pool.query('SELECT d."s2License",d."s2ValidFrom"::text AS "s2ValidFrom",d."s2ValidUntil"::text AS "s2ValidUntil",s.id,s."contentHash",s."protectedPayload" FROM vital_doctors d JOIN doctor_signatures s ON s.id=d."signatureAssetId" AND s."doctorAuthId"=d."authId" WHERE d."authId"=$1',[doctorAuthId])).rows[0];
  if(!row||!row.s2License||!row.s2ValidFrom||!row.s2ValidUntil)throw new DomainError(409,'SIGNING_PROFILE_REQUIRED','Complete your S2 credentials and signature.');
  const payload=unprotectPayload<{base64:string}>(keyring,binding(doctorAuthId,row.id),row.protectedPayload);
  if(sha256(Buffer.from(payload.base64,'base64'))!==row.contentHash)throw new DomainError(503,'SIGNATURE_HASH_INVALID','Signature unavailable.');
  return {signatureBase64:payload.base64,signatureHash:row.contentHash,signatureAssetId:row.id,s2License:row.s2License,s2ValidFrom:signatureDate(row.s2ValidFrom),s2ValidUntil:signatureDate(row.s2ValidUntil)};
}
