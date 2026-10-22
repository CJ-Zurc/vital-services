import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import type { ArtifactClaim,ArtifactRepository,ArtifactJob,ArtifactPrepared } from "./artifacts.js";
import type { RecordsConfig } from "./contracts.js";
import type { CanonicalDocument } from "./artifacts.js";
import type { PrescriptionPdf,CertificatePdf } from "./pdf.js";
import { unprotectPayload } from "./protection.js";
import { appendSqlOutbox } from "../../infrastructure/outbox.js";
import { verifyFileInspection, type FileInspectionPolicy } from './inspection.js';
import { recordsDenied } from "./authorization.js";

export function createArtifactRepository(pool:Pool, inspectionPolicy:FileInspectionPolicy='clamav'):ArtifactRepository {
  const fenced=`id=$1::uuid AND "leaseOwner"=$2 AND version=$3 AND state='processing' AND "leaseUntil">clock_timestamp()`;
  const capacityFenced=`id=1 AND "operationId"=$1::uuid AND "leaseOwner"=$2 AND "operationFence"=$3 AND "leaseUntil">clock_timestamp()`;
  const params=(c:ArtifactClaim)=>[c.operationId,c.leaseOwner,c.fence];
  class LeaseLost extends Error {}
  const changed=(count:number|null)=>{if(count!==1)throw new LeaseLost();};
  const leaseMs=(value:number)=>z.number().int().positive().max(60000).parse(value);
  async function local<T>(claim:ArtifactClaim,run:(tx:PoolClient,row:Record<string,unknown>)=>Promise<T>,absent:T,release=false){const tx=await pool.connect();try{
    // All repository paths acquire capacity before the operation; expiry uses the fresh DB clock.
    await tx.query('BEGIN');
    const capacity=(await tx.query('SELECT id FROM records_artifact_capacity WHERE '+capacityFenced+' FOR UPDATE',params(claim))).rows[0];
    if(!capacity){await tx.query('COMMIT');return absent;}
    const op=(await tx.query('SELECT * FROM record_operations WHERE '+fenced+' FOR UPDATE',params(claim))).rows[0];
    if(!op){await tx.query('COMMIT');return absent;}
    const result=await run(tx,op);
    if(release)changed((await tx.query(`UPDATE records_artifact_capacity SET "operationId"=NULL,"operationFence"=NULL,"leaseOwner"=NULL,"leaseUntil"=NULL WHERE `+capacityFenced,params(claim))).rowCount);
    else if(!(await tx.query('SELECT id FROM records_artifact_capacity WHERE '+capacityFenced+' AND EXISTS (SELECT 1 FROM record_operations WHERE '+fenced+')',params(claim))).rows.length)throw new LeaseLost();
    await tx.query('COMMIT');return result;
  }catch(error){await tx.query('ROLLBACK');if(error instanceof LeaseLost)return absent;throw error;}finally{tx.release();}}
  return{
    async claimDue(options){
      const duration=leaseMs(options.leaseMs),tx=await pool.connect();try{
        await tx.query('BEGIN');
        const capacity=(await tx.query(`SELECT id FROM records_artifact_capacity WHERE id=1 AND ("leaseUntil" IS NULL OR "leaseUntil"<=clock_timestamp()) FOR UPDATE SKIP LOCKED`)).rows[0];
        if(!capacity){await tx.query('COMMIT');return null;}
        const result=(await tx.query(`WITH due AS (SELECT id FROM record_operations WHERE (state='pending' AND "nextAttemptAt"<=clock_timestamp()) OR (state='processing' AND "leaseUntil"<=clock_timestamp()) ORDER BY "nextAttemptAt",id LIMIT 1 FOR UPDATE SKIP LOCKED)
          UPDATE record_operations o SET state='processing',"leaseOwner"=$1,"leaseUntil"=clock_timestamp()+$2*INTERVAL '1 millisecond',version=version+1,attempts=attempts+1,"updatedAt"=clock_timestamp() FROM due WHERE o.id=due.id RETURNING o.*`,[options.leaseOwner,duration])).rows[0];
        if(!result){await tx.query('COMMIT');return null;}
        changed((await tx.query(`UPDATE records_artifact_capacity SET "operationId"=$1::uuid,"operationFence"=$3,"leaseOwner"=$2,"leaseUntil"=(SELECT "leaseUntil" FROM record_operations WHERE id=$1::uuid) WHERE id=1`,[result.id,options.leaseOwner,result.version])).rowCount);
        const asset=(await tx.query('SELECT a.*,d.id AS "documentId" FROM records_file_assets a LEFT JOIN records_documents d ON d."assetId"=a.id WHERE a.id=$1::uuid',[result.resourceId])).rows[0];
        if(!asset)throw new Error('RECORDS_ARTIFACT_ASSET_MISSING');
        const job:ArtifactJob={operationId:result.id,assetId:asset.id,documentId:asset.documentId??undefined,patientId:asset.patientId,kind:asset.kind,attempts:result.attempts,fence:result.version,
          ...(asset.kind==='upload'?{input:{objectKey:asset.objectKey,contentHash:asset.contentHash,byteLength:Number(asset.byteLength),mimeType:asset.mimeType}}:{}),
          ...(result.preparedArtifact?{prepared:result.preparedArtifact as ArtifactPrepared}:{})};
        if(!(await tx.query('SELECT id FROM records_artifact_capacity WHERE '+capacityFenced+' AND EXISTS (SELECT 1 FROM record_operations WHERE '+fenced+')',[result.id,options.leaseOwner,result.version])).rows.length)throw new LeaseLost();
        await tx.query('COMMIT');return job;
      }catch(error){await tx.query('ROLLBACK');if(error instanceof LeaseLost)return null;throw error;}finally{tx.release();}
    },
    async renew(claim,options){const duration=leaseMs(options.leaseMs);return local(claim,async tx=>{
      changed((await tx.query('UPDATE record_operations SET "leaseUntil"=clock_timestamp()+$4*INTERVAL \'1 millisecond\',"updatedAt"=clock_timestamp() WHERE '+fenced,[...params(claim),duration])).rowCount);
      changed((await tx.query('UPDATE records_artifact_capacity SET "leaseUntil"=(SELECT "leaseUntil" FROM record_operations WHERE id=$1::uuid) WHERE '+capacityFenced,params(claim))).rowCount);return true;
    },false);},
    async savePrepared(claim,prepared){return local(claim,async(tx,op)=>{
      if(op.preparedArtifact){const old=op.preparedArtifact as ArtifactPrepared;if(old.objectKey!==prepared.objectKey||old.contentHash!==prepared.contentHash||old.byteLength!==prepared.byteLength||old.mimeType!==prepared.mimeType)throw new Error('ARTIFACT_OUTPUT_CONFLICT');}
      changed((await tx.query('UPDATE record_operations SET "preparedArtifact"=$4::jsonb WHERE '+fenced,[...params(claim),JSON.stringify(prepared)])).rowCount);return true;
    },false);},
    async recordScan(claim,evidence){return local(claim,async(tx,op)=>{
      const expected=op.preparedArtifact as ArtifactPrepared|null;
      if(!expected)throw new Error('ARTIFACT_SCAN_BINDING_INVALID');
      verifyFileInspection(evidence.final,expected,Date.now(),inspectionPolicy);
      await tx.query('UPDATE records_file_assets SET "scanEvidence"=$2::jsonb WHERE id=$1::uuid',[op.resourceId,JSON.stringify(evidence)]);return true;
    },false);},
    async publish(claim,publication){return local(claim,async(tx,op)=>{
      const expected=op.preparedArtifact as ArtifactPrepared|null;
      if(!expected||expected.objectKey!==publication.objectKey||expected.contentHash!==publication.contentHash||expected.byteLength!==publication.byteLength)throw new Error('ARTIFACT_OUTPUT_CONFLICT');
      verifyFileInspection(publication.scanEvidence.final,publication,Date.now(),inspectionPolicy);
      const asset=(await tx.query(`UPDATE records_file_assets SET state='ready',"publishedKey"=$2,"publishedHash"=$3,"mimeType"=$4,"byteLength"=$5,"scanEvidence"=$6::jsonb,version=version+1 WHERE id=$1::uuid AND state IN ('processing','quarantine') RETURNING version`,[op.resourceId,publication.objectKey,publication.contentHash,publication.mimeType,publication.byteLength,JSON.stringify(publication.scanEvidence)])).rows[0];
      if(!asset)throw new Error('ARTIFACT_ASSET_STATE_CHANGED');
      changed((await tx.query('UPDATE record_operations SET state=\'completed\',"leaseOwner"=NULL,"leaseUntil"=NULL,"errorCode"=NULL,"updatedAt"=clock_timestamp() WHERE '+fenced,params(claim))).rowCount);
      await appendSqlOutbox(tx,{producer:'records',eventType:'vital.records.artifact.ready',aggregateId:String(op.resourceId),aggregateVersion:asset.version,correlationId:claim.operationId,causationId:claim.operationId,data:{assetId:String(op.resourceId),operationId:claim.operationId}});
      return true;
    },false,true);},
    async retry(claim,options){await local(claim,async tx=>{
      changed((await tx.query('UPDATE record_operations SET state=$4,"nextAttemptAt"=$5,"errorCode"=$6,"leaseOwner"=NULL,"leaseUntil"=NULL,"updatedAt"=clock_timestamp() WHERE '+fenced,[...params(claim),options.blocked?'blocked':'pending',options.nextAttemptAt,options.errorCode])).rowCount);return true;
    },false,true);},
    async reject(claim,errorCode){await local(claim,async(tx,op)=>{
      await tx.query('UPDATE records_file_assets SET state=\'rejected\',version=version+1 WHERE id=$1::uuid AND state<>\'ready\'',[op.resourceId]);
      changed((await tx.query('UPDATE record_operations SET state=\'rejected\',"errorCode"=$4,"leaseOwner"=NULL,"leaseUntil"=NULL,"updatedAt"=clock_timestamp() WHERE '+fenced,[...params(claim),errorCode])).rowCount);return true;
    },false,true);},
  };
}

export function canonicalArtifactData(pool:Pool,config:Pick<RecordsConfig,'keyring'>){return async(job:ArtifactJob):Promise<CanonicalDocument>=>{
  const row=(await pool.query<{id:string;patientId:string;kind:string;protectedPayload:unknown}>(`SELECT id,"patientId",kind,"protectedPayload" FROM records_documents WHERE "assetId"=$1::uuid AND id=$2::uuid`,[job.assetId,z.uuid().parse(job.documentId)])).rows[0];
  if(!row||row.patientId!==job.patientId||row.kind!==job.kind)recordsDenied(503,'RECORDS_CANONICAL_DOCUMENT_MISSING');
  const payload=unprotectPayload<Record<string,unknown>>(config.keyring,{patientId:row.patientId,resourceId:row.id,schema:'document.v1'},row.protectedPayload);
  const base={...payload,issuedAt:new Date(String(payload.issuedAt))};
  if(job.kind==='prescription')return{kind:'prescription',data:base as unknown as PrescriptionPdf};
  const optionalDate=(value:unknown)=>typeof value==='string'?new Date(value+'T00:00:00+08:00'):null;
  return{kind:'medical-certificate',data:{...base,consultationDate:optionalDate(payload.consultationDate),restStartDate:optionalDate(payload.restStartDate),restEndDate:optionalDate(payload.restEndDate)} as unknown as CertificatePdf};
};}
