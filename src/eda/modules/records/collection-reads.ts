import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Actor } from '../../contracts/actor.js';
import { prepareReadPage, readCollectionPage, readPageInput, type ReadOrder } from '../../infrastructure/read-pages.js';

type Owners={authorize(actor:Actor,scope:string,resource:string):Promise<{userId:string}>;
  patient(db:Pick<Pool,'query'>,id:string):Promise<{userId:string;ehrPatientId:string|null}>};
export function createRecordsCollections(pool:Pool,owners:Owners,clock=Date.now){
  async function page<T extends{id:string}>(actor:Actor,collection:string,filters:unknown,input:unknown,sql:string,values:unknown[],order:ReadOrder[]){
    try{return await readCollectionPage<T>(pool,prepareReadPage(actor,collection,filters,z.object(readPageInput).strict().parse(input),clock),{sql,values,order});}
    catch(error){if(error instanceof DomainError&&error.code.startsWith('APPOINTMENT_READ_'))throw new DomainError(error.status,error.code.replace('APPOINTMENT_','RECORDS_'),'Records collection could not be verified.');throw error;}
  }
  function doctor(actor:Actor){if(actor.role!=='doctor')throw new DomainError(403,'RECORDS_DOCTOR_DENIED','Doctor authority required.');}
  return{
    async patients(actor:Actor,input:unknown={}){
      doctor(actor);const owner=await owners.authorize(actor,'patients.read',actor.authId);
      const result=await page<{id:string;patientId:string;authId:string;ehrPatientId:string|null}>(actor,'records:patients',{},input,
        `SELECT DISTINCT p."userId" AS id,p."userId" AS "patientId",p."authId",p."ehrPatientId" FROM records_episode_grants g JOIN vital_patients p ON p."userId"=g."patientId"
        WHERE g."doctorId"=$1 AND (g."snapshotId" IS NOT NULL OR (g.status='live' AND EXISTS(SELECT 1 FROM appointment_access ax JOIN appointments ap ON ap.id=ax."appointmentId" WHERE ax."appointmentId"=g."appointmentId" AND ax."grantedAt" IS NOT NULL AND ax."revokedAt" IS NULL AND ax."grantUntil">NOW() AND ap.status='confirmed' AND ap."paperworkLockedAt" IS NULL AND ap."doctorConfirmedAt" IS NULL))) AND COALESCE((SELECT c.accepted FROM consent_records c WHERE c."patientId"=g."patientId"
          AND c."consentType"='medical_record' AND (c."appointmentId" IS NULL OR c."appointmentId"=g."appointmentId") ORDER BY c."consentedAt" DESC,c.id DESC LIMIT 1),false)`,
        [owner.userId],[{key:'id',direction:'ASC',cast:'text'}]);
      if((await owners.authorize(actor,'patients.read',actor.authId)).userId!==owner.userId)throw new DomainError(409,'RECORDS_READ_SNAPSHOT_CHANGED','Owner changed.');
      return{items:result.items.map(({id:_id,...row})=>row),meta:result.meta};
    },
    async episodes(actor:Actor,id:string,input:unknown={}){
      doctor(actor);z.uuid().parse(id);const owner=await owners.authorize(actor,'episodes.read',id),patient=await owners.patient(pool,id);
      const result=await page<{id:string;appointmentId:string;version:number;associationVersion:number;status:string;snapshotId:string|null;ehrCaseId:string|null;
        recordsBlockCode:string|null;scheduledAt:Date;ehrPatientId:string|null}>(actor,'records:episodes:'+id,{},input,
        `SELECT a.id,a.id AS "appointmentId",a.version,a."associationVersion",a.status,a."scheduledAt",$3::text AS "ehrPatientId",
        COALESCE(g."frozenSnapshotId",g."snapshotId") AS "snapshotId",a."ehrCaseId",a."recordsBlockCode" FROM appointments a JOIN records_episode_grants g ON g."appointmentId"=a.id
        WHERE a."patientId"=$1 AND a."doctorId"=$2 AND (g."snapshotId" IS NOT NULL OR EXISTS(SELECT 1 FROM appointment_access ax WHERE ax."appointmentId"=a.id AND ax."grantedAt" IS NOT NULL AND ax."revokedAt" IS NULL AND ax."grantUntil">NOW() AND a.status='confirmed' AND a."paperworkLockedAt" IS NULL AND a."doctorConfirmedAt" IS NULL)) AND COALESCE((SELECT c.accepted FROM consent_records c WHERE c."patientId"=a."patientId"
          AND c."consentType"='medical_record' AND (c."appointmentId" IS NULL OR c."appointmentId"=a.id) ORDER BY c."consentedAt" DESC,c.id DESC LIMIT 1),false)`,
        [patient.userId,owner.userId,patient.ehrPatientId],[{key:'scheduledAt',direction:'DESC',cast:'timestamp'},{key:'id',direction:'ASC',cast:'text'}]);
      if((await owners.authorize(actor,'episodes.read',id)).userId!==owner.userId)throw new DomainError(409,'RECORDS_READ_SNAPSHOT_CHANGED','Owner changed.');
      return{items:result.items.map(({id:_id,scheduledAt:_scheduled,...row})=>({...row,recoveryRequired:row.recordsBlockCode==='RECORD_SNAPSHOT_REQUIRED'})),meta:result.meta};
    },
  };
}
