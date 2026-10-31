import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, requireScope, type Actor } from '../../contracts/actor.js';
import { membership } from './appointment.js';
import { prepareReadPage, readCollectionPage, readPageInput } from '../../infrastructure/read-pages.js';

export async function patientDoctorRatings(pool:Pool,actor:Actor,doctorId:string,raw:unknown,clock=Date.now){
  z.uuid().parse(doctorId);requireScope(actor,'appointments.discovery.read',doctorId);
  await membership(pool,actor,'patient');
  const doctor=await pool.query(`SELECT d."userId" FROM vital_doctors d JOIN vital_users u ON u.id=d."userId" AND u."authId"=d."authId" WHERE d."userId"=$1 AND u.role='doctor' AND d."isDoctorOnboardingComplete"=true`,[doctorId]);
  if(!doctor.rows.length)throw new DomainError(404,'APPOINTMENT_DOCTOR_NOT_FOUND','Doctor not found.');
  const query=z.object(readPageInput).strict().parse(raw);
  const source=`FROM feedback f JOIN appointments a ON a.id=f."appointmentId" WHERE a."doctorId"=$1 AND a.status='completed' AND f."starRating" BETWEEN 1 AND 5`;
  const summary=async()=> (await pool.query<{count:number;average:string|null}>(`SELECT COUNT(*)::int AS count,AVG(f."starRating")::text AS average ${source}`,[doctorId])).rows[0]!;
  const before=await summary();
  const page=await readCollectionPage<{id:string;rating:number;submittedAt:Date}>(pool,prepareReadPage(actor,'patient-ratings:'+doctorId,{},query,clock),{
    sql:`SELECT f.id,f."starRating" AS rating,f."submittedAt" ${source}`,values:[doctorId],order:[{key:'submittedAt',direction:'DESC',cast:'timestamp'},{key:'id',direction:'DESC',cast:'text'}]});
  const after=await summary();
  if(before.count!==after.count||before.average!==after.average||page.meta.total!==after.count)throw new DomainError(409,'APPOINTMENT_READ_SNAPSHOT_CHANGED','Ratings changed. Refresh the list.');
  await membership(pool,actor,'patient');
  return{doctorId,average:after.average===null?0:Number(after.average),count:after.count,items:page.items.map(({rating,submittedAt})=>({rating,submittedAt})),meta:page.meta};
}
