import type {Pool} from "pg";
import type {Actor} from "../../contracts/actor.js";
import {completionRole,completionCount} from "../../contracts/completion.js";
import {reportRange,reportBounds,type ReportRange,type SatisfactionReport,type SpecialtyReport} from "../../contracts/admin-reporting.js";
import {createCompletionProfileOwner} from "../profile/profile-completion.js";
export function createAppointmentAdminReporting(pool:Pool){
 const profile=createCompletionProfileOwner(pool);
 async function read<T>(actor:Actor,scope:string,range:ReportRange,query:(db:Pick<Pool,"query">,range:ReportRange)=>Promise<T>){
  completionRole(actor,"admin",scope);const validated=reportRange(range),db=await pool.connect();
  try{await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");await profile.admin(actor,db);const value=await query(db,validated);await profile.admin(actor,db);await db.query("COMMIT");return value;}
  catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
 }
 return{
  satisfaction:(actor:Actor,range:ReportRange)=>read<SatisfactionReport>(actor,"completion.admin.satisfaction",range,async(db,r)=>{
   const row=(await db.query(`SELECT COUNT(*)::text AS count,AVG(f."starRating")::float8 AS overall,
    AVG(f."friendlinessAttitude")::float8 AS "friendlinessAttitude",AVG(f.professionalism)::float8 AS professionalism,
    AVG(f.explanation)::float8 AS explanation,AVG(f."careServices")::float8 AS "careServices"
    FROM feedback f JOIN appointments a ON a.id=f."appointmentId" AND a.status='completed'
    WHERE f."ratingVersion"=2 AND f."submittedAt">=$1 AND f."submittedAt"<$2
    AND f."friendlinessAttitude" BETWEEN 1 AND 5 AND f.professionalism BETWEEN 1 AND 5
    AND f.explanation BETWEEN 1 AND 5 AND f."careServices" BETWEEN 1 AND 5 AND f."starRating" BETWEEN 1 AND 5`,reportBounds(r))).rows[0];
   return{range:r,count:completionCount(row.count),overall:row.overall,criteria:{friendlinessAttitude:row.friendlinessAttitude,professionalism:row.professionalism,explanation:row.explanation,careServices:row.careServices}};
  }),
  specialties:(actor:Actor,range:ReportRange)=>read<SpecialtyReport>(actor,"completion.admin.specialties",range,async(db,r)=>{
   const items=(await db.query(`SELECT COALESCE(NULLIF(TRIM(d.specialty),''),'Unlisted') AS specialty,COUNT(DISTINCT a.id)::text AS count
    FROM appointments a LEFT JOIN vital_doctors d ON d."userId"=a."doctorId"
    WHERE a.status='completed' AND a."completedAt">=$1 AND a."completedAt"<$2
    GROUP BY COALESCE(NULLIF(TRIM(d.specialty),''),'Unlisted') ORDER BY COUNT(DISTINCT a.id) DESC,specialty`,reportBounds(r))).rows.map(row=>({specialty:row.specialty as string,count:completionCount(row.count)}));
   return{range:r,total:items.reduce((n,row)=>n+row.count,0),items};
  })
 };
}
