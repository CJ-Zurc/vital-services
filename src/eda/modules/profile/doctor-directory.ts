import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {DomainError} from '../../contracts/actor.js';
import {createPortalIdentityLookup} from '../portal-integrations/portal-integrations-runtime.js';

export async function directoryGeneration(pool:Pool){
 const row=(await pool.query<{generation:string|null}>('SELECT generation FROM doctor_directory_state WHERE id=1')).rows[0];
 if(!row?.generation)throw new DomainError(503,'DOCTOR_DIRECTORY_INITIALIZING','The doctor directory is preparing. Please retry shortly.');
 return row.generation;
}
/** Builds a new generation in bounded batches. Readers see the old generation until publication. */
export function createDoctorDirectoryWorker(pool:Pool,lookup:ReturnType<typeof createPortalIdentityLookup>,clock=Date.now,signal?:AbortSignal){
 let nextAttempt=0;
 return async()=>{
  if(clock()<nextAttempt)return;
  const tx=await pool.connect();let generation:string|undefined;
  try{
   if(!(await tx.query<{locked:boolean}>("SELECT pg_try_advisory_lock(hashtextextended('vital-doctor-directory',0)) AS locked")).rows[0]?.locked)return;
   const state=(await tx.query<{requestedVersion:string;publishedVersion:string;refreshedAt:Date|null}>('SELECT * FROM doctor_directory_state WHERE id=1')).rows[0]!;
   if(state.refreshedAt&&clock()-new Date(state.refreshedAt).getTime()<300000&&state.requestedVersion===state.publishedVersion)return;
   generation=randomUUID();let after='';
   for(;;){
    if(signal?.aborted)throw new Error("DIRECTORY_SHUTDOWN");
    const doctors=(await tx.query<{doctorId:string;authId:string}>(`SELECT d."userId" AS "doctorId",d."authId" FROM vital_doctors d JOIN vital_users u ON u.id=d."userId" AND u."authId"=d."authId" AND u.role='doctor'
      WHERE d."userId">$1 ORDER BY d."userId" LIMIT 100`,[after])).rows;
    if(!doctors.length)break;
    const identities=await lookup(doctors.map(d=>d.authId));
    for(const doctor of doctors){const identity=identities.get(doctor.authId);if(!identity)continue;
     await tx.query('INSERT INTO doctor_directory_entries(generation,"doctorId","authId",name,email) VALUES($1,$2,$3,$4,$5)',[generation,doctor.doctorId,doctor.authId,identity.name??'',identity.email]);}
    after=doctors.at(-1)!.doctorId;
   }
   // A profile change during refresh leaves the old published generation available.
   const published=await tx.query('UPDATE doctor_directory_state SET generation=$1,"publishedVersion"=$2,"refreshedAt"=$3 WHERE id=1 AND "requestedVersion"=$2 RETURNING id',[generation,state.requestedVersion,new Date(clock())]);
   if(!published.rowCount){await tx.query('DELETE FROM doctor_directory_entries WHERE generation=$1',[generation]);nextAttempt=clock()+1000;return;}
   await tx.query('DELETE FROM doctor_directory_entries WHERE generation<>$1',[generation]);
  }catch{if(generation)await tx.query('DELETE FROM doctor_directory_entries WHERE generation=$1 AND generation IS DISTINCT FROM (SELECT generation FROM doctor_directory_state WHERE id=1)',[generation]).catch(()=>{});
   nextAttempt=clock()+30000;console.error(JSON.stringify({level:'error',event:'eda.doctor_directory.refresh_failed'}));
  }finally{await tx.query("SELECT pg_advisory_unlock(hashtextextended('vital-doctor-directory',0))").catch(()=>{});tx.release();}
 };
}
