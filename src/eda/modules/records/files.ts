import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { requestHash } from "../../infrastructure/security.js";
import { requireScope,type Actor } from "../../contracts/actor.js";
import { appendSqlOutbox } from "../../infrastructure/outbox.js";
import { lockAppointment,membership } from "../appointment/appointment.js";
import type { AppointmentCommand } from "../appointment/appointment-contracts.js";
import type { RecordsAssetRow,RecordsConfig } from "./contracts.js";
import { recordsCommand } from "./commands.js";
import { medicalConsent,assertRecordsIdle,assertPaperwork,currentPaid,recordsDenied } from "./authorization.js";
import { protectPayload,unprotectPayload } from "./protection.js";
import { assertUploadSize,detectRecordsMime,sha256,type RecordsMime } from "./upload-validation.js";
import type { RecordsStorage } from "./storage.js";

export const uploadDescriptor=z.object({operationId:z.uuid(),byteLength:z.number().int().positive().max(10*1024*1024),sha256:z.string().regex(/^[a-f0-9]{64}$/),mimeType:z.enum(['application/pdf','image/png','image/jpeg','image/webp']),
  title:z.string().trim().min(1).max(255),description:z.string().trim().max(4000).nullable().default(null)}).strict();
export function createRecordsFiles(pool:Pool,config:RecordsConfig,storage:RecordsStorage,clock=Date.now){
  async function readAsset(db:Pick<PoolClient,'query'>,id:string):Promise<RecordsAssetRow>{
    const asset=(await db.query<RecordsAssetRow>('SELECT * FROM records_file_assets WHERE id=$1::uuid',[z.uuid().parse(id)])).rows[0];if(!asset)recordsDenied(404,'RECORDS_FILE_NOT_FOUND');return asset;
  }
  async function authorize(db:Pick<PoolClient,'query'>,actor:Actor,asset:RecordsAssetRow,integration:boolean){
    if(integration){requireScope(actor,'records.integration.read','records:integration');if(asset.kind==='upload')recordsDenied(403,'RECORDS_FOREIGN_FILE_DENIED');return;}
    const member=await membership(db,actor);
    if(actor.role==='patient'){if(member.userId!==asset.patientId)recordsDenied(403,'RECORDS_PATIENT_DENIED');return;}
    if(actor.role!=='doctor')recordsDenied(403,'RECORDS_DOCTOR_DENIED');
    const historical=(await db.query<{appointmentId:string}>(`SELECT s."appointmentId" FROM records_snapshot_assets r JOIN records_snapshots s ON s.id=r."snapshotId" JOIN records_episode_grants g ON g."appointmentId"=s."appointmentId"
      WHERE r."assetId"=$1::uuid AND s."patientId"=$2 AND s."doctorId"=$3 AND g."patientId"=s."patientId" AND g."doctorId"=s."doctorId"
      AND s.id=COALESCE(g."frozenSnapshotId",g."snapshotId") ORDER BY s."capturedAt" DESC LIMIT 100`,[asset.id,asset.patientId,member.userId])).rows;
    for(const episode of historical)try{await medicalConsent(db,asset.patientId,episode.appointmentId);return;}catch(error){if(!(error instanceof Error&&'code'in error&&error.code==='RECORDS_MEDICAL_CONSENT_REQUIRED'))throw error;}
    const active=(await db.query<{id:string}>(`SELECT a.id FROM appointments a JOIN records_episode_grants g ON g."appointmentId"=a.id AND g."patientId"=a."patientId" AND g."doctorId"=a."doctorId" AND g."associationVersion"=a."associationVersion"
      WHERE a."patientId"=$1 AND a."doctorId"=$2 AND a.status='confirmed' AND g.status='live' ORDER BY a."doctorId",a."scheduledAt" DESC LIMIT 20`,[asset.patientId,member.userId])).rows;
    for(const item of active){const row=await lockAppointment(db as PoolClient,item.id);try{
      if(row.patientId!==asset.patientId||row.doctorId!==member.userId)recordsDenied(403,'RECORDS_DOCTOR_DENIED');
      const grant=(await db.query(`SELECT "appointmentId" FROM records_episode_grants WHERE "appointmentId"=$1 AND "patientId"=$2 AND "doctorId"=$3 AND "associationVersion"=$4 AND status='live'`,[row.id,row.patientId,row.doctorId,row.associationVersion])).rows[0];
      if(!grant)recordsDenied(403,'RECORDS_EPISODE_ACCESS_DENIED');
      await medicalConsent(db,row.patientId,row.id);assertPaperwork(row,clock());await assertRecordsIdle(db,row);await currentPaid(db,row,config.financial);return;}catch(error){if(error instanceof Error&&'status'in error&&[403,409].includes(Number(error.status)))continue;throw error;}}
    recordsDenied(403,'RECORDS_FILE_ACCESS_DENIED');
  }
  return{
    async read(actor:Actor,id:string){requireScope(actor,'records.file.read',id);const tx=await pool.connect();try{await tx.query('BEGIN');const file=await readAsset(tx,id);await authorize(tx,actor,file,false);await tx.query('COMMIT');
      return{id:file.id,assetId:file.id,patientId:file.patientId,version:file.version,processingState:file.state,operationStatus:file.state==='ready'?'completed':file.state};
    }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}},
    async upload(actor:Actor,meta:AppointmentCommand,descriptor:unknown,bytes:Buffer){
      const input=uploadDescriptor.parse(descriptor);if(input.operationId!==meta.operationId)recordsDenied(409,'UPLOAD_OPERATION_MISMATCH');
      assertUploadSize(bytes);if(bytes.length!==input.byteLength||sha256(bytes)!==input.sha256)recordsDenied(400,'UPLOAD_CHECKSUM_MISMATCH');
      if(detectRecordsMime(bytes)!==input.mimeType)recordsDenied(400,'UPLOAD_MIME_MISMATCH');
      const assetId=meta.operationId,key=storage.key('quarantine',assetId,input.sha256,input.mimeType);
      const receipt=await recordsCommand(pool,actor,'upload',meta.operationId,meta,input,async tx=>{
        const p=await membership(tx,actor,'patient');
        const payload=protectPayload(config.keyring,{patientId:p.userId,resourceId:assetId,schema:'file.v1'},{title:input.title,description:input.description});
        await tx.query(`INSERT INTO records_file_assets (id,"patientId",kind,version,state,"protectedPayload","objectKey","contentHash","mimeType","byteLength","createdAt")
          VALUES($1,$2,'upload',0,'quarantine',$3::jsonb,$4,$5,$6,$7,NOW())`,[assetId,p.userId,JSON.stringify(payload),key,input.sha256,input.mimeType,input.byteLength]);
        await tx.query(`INSERT INTO record_operations (id,"resourceId","actorAuthId","patientId",kind,state,version,attempts,"nextAttemptAt","createdAt","updatedAt") VALUES($1,$1,$2,$3,'upload','pending',0,0,NOW(),NOW(),NOW())`,[meta.operationId,actor.authId,p.userId]);
        await appendSqlOutbox(tx,{producer:'records',eventType:'vital.records.artifact.requested',aggregateId:assetId,aggregateVersion:0,correlationId:actor.correlationId,causationId:meta.operationId,data:{assetId,operationId:meta.operationId}});
        await appendSqlOutbox(tx,{producer:'records',eventType:'vital.audit.requested',aggregateId:assetId,aggregateVersion:0,correlationId:actor.correlationId,causationId:meta.operationId,data:{auditType:'vital.records.file_uploaded',actorAuthId:actor.authId,resourceId:assetId,resourceType:'document'}});
        return{id:assetId,assetId,operationId:meta.operationId,operationStatus:'pending'};
      });
      const operation=(await pool.query<{state:string;attempts:number}>('SELECT state,attempts FROM record_operations WHERE id=$1::uuid',[meta.operationId])).rows[0];
      if(!operation||!['pending','processing'].includes(operation.state))return{...receipt,operationStatus:operation?.state??'pending'};
      try{await storage.putQuarantine(key,bytes,input.mimeType);}
      catch{return{...receipt,operationStatus:'pending',errorCode:'UPLOAD_STORAGE_OUTCOME_PENDING'};}
      return receipt;
    },
    async list(actor:Actor,query:unknown){requireScope(actor,'records.files.read',actor.authId);const p=await membership(pool,actor,'patient');
      const filter=z.object({patientAuthId:z.uuid().optional(),page:z.coerce.number().int().min(1).max(100000).default(1),limit:z.coerce.number().int().min(1).max(100).default(20)}).strict().parse(query);
      if(filter.patientAuthId&&filter.patientAuthId!==actor.authId)recordsDenied(403,'RECORDS_PATIENT_DENIED');
      const total=Number((await pool.query(`SELECT COUNT(*)::int AS total FROM records_file_assets WHERE "patientId"=$1 AND kind='upload'`,[p.userId])).rows[0]?.total??0);
      const files=(await pool.query<RecordsAssetRow>(`SELECT * FROM records_file_assets WHERE "patientId"=$1 AND kind='upload' ORDER BY "createdAt" DESC,id LIMIT $2 OFFSET $3`,[p.userId,filter.limit,(filter.page-1)*filter.limit])).rows;
      return{items:files.map(file=>({id:file.id,assetId:file.id,hrecordId:null,patientId:p.userId,recordType:file.mimeType,sourceLabel:'external_patient_submitted',...unprotectPayload<Record<string,unknown>>(config.keyring,{patientId:p.userId,resourceId:file.id,schema:'file.v1'},file.protectedPayload),filePath:null,createdAt:file.createdAt.toISOString(),version:file.version,processingState:file.state,operationStatus:file.state==='ready'?'completed':file.state,byteLength:Number(file.byteLength)})),total,page:filter.page,limit:filter.limit};
    },
    async link(actor:Actor,id:string,meta:AppointmentCommand,body:unknown,integration=false){const input=z.object({expectedVersion:z.number().int().nonnegative()}).strict().parse(body);
      if(integration){const asset=await readAsset(pool,id);await authorize(pool,actor,asset,true);if(asset.state!=='ready'||!asset.publishedKey)recordsDenied(409,'RECORDS_FILE_NOT_READY');
        if(asset.version!==input.expectedVersion)recordsDenied(409,'RECORDS_FILE_VERSION_CHANGED');
        const tx=await pool.connect();try{await tx.query('BEGIN');
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['records-command:'+actor.authId+':'+meta.operationId]);
          const hash=requestHash('RECORDS-INTEGRATION','file.link',{id,input,transportHash:meta.requestHash});
          const old=(await tx.query<{action:string;resourceId:string;requestHash:string}>('SELECT * FROM command_operations WHERE "actorId"=$1 AND "operationId"=$2',[actor.authId,meta.operationId])).rows[0];
          if(old&&(old.action!=='records.integration.file_link'||old.resourceId!==id||old.requestHash!==hash))recordsDenied(409,'COMMAND_REPLAY_CONFLICT');
          if(!old){
            await appendSqlOutbox(tx,{producer:'records',eventType:'vital.audit.requested',aggregateId:asset.id,aggregateVersion:asset.version,correlationId:actor.correlationId,causationId:meta.operationId,data:{auditType:'vital.records.file_link_issued',actorAuthId:actor.authId,resourceId:asset.id,resourceType:'document'}});
            await tx.query(`INSERT INTO command_operations (id,"actorId","operationId",action,"resourceId","requestHash",status,result,"createdAt","updatedAt") VALUES($1,$2,$3,'records.integration.file_link',$4,$5,'completed',$6::jsonb,NOW(),NOW())`,[randomUUID(),actor.authId,meta.operationId,id,hash,JSON.stringify({assetId:id})]);
          }await tx.query('COMMIT');
        }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
        return{url:await storage.signedLink(asset.publishedKey),expiresIn:300};}
      await recordsCommand(pool,actor,'file.link',id,meta,input,async tx=>{const asset=await readAsset(tx,id);await authorize(tx,actor,asset,false);if(asset.version!==input.expectedVersion)recordsDenied(409,'RECORDS_FILE_VERSION_CHANGED');
        if(asset.state!=='ready'||!asset.publishedKey)recordsDenied(409,'RECORDS_FILE_NOT_READY');
        await appendSqlOutbox(tx,{producer:'records',eventType:'vital.audit.requested',aggregateId:asset.id,aggregateVersion:asset.version,correlationId:actor.correlationId,causationId:meta.operationId,data:{auditType:'vital.records.file_link_issued',actorAuthId:actor.authId,resourceId:asset.id,resourceType:'document'}});
        // Bearer URL is never retained in command results, audit or the broker.
        return{assetId:asset.id};
      });
      const tx=await pool.connect();let asset:RecordsAssetRow;try{await tx.query('BEGIN');asset=await readAsset(tx,id);await authorize(tx,actor,asset,false);if(asset.state!=='ready'||!asset.publishedKey)recordsDenied(409,'RECORDS_FILE_NOT_READY');await tx.query('COMMIT');}catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
      return{url:await storage.signedLink(asset.publishedKey!),expiresIn:300};
    },
  };
}
