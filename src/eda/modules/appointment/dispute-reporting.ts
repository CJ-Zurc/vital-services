import {z} from "zod";
import type {Pool} from "pg";
import {DomainError,requireScope,type Actor} from "../../contracts/actor.js";
const position=z.object({at:z.iso.datetime(),id:z.uuid(),upper:z.iso.datetime()}).strict();
export function disputePageQuery(raw:unknown){
 const input=z.object({cursor:z.string().min(1).max(2048).optional()}).strict().parse(raw);
 try{return input.cursor?position.parse(JSON.parse(Buffer.from(input.cursor,"base64url").toString("utf8"))):null;}
 catch{throw new DomainError(400,"DISPUTE_CURSOR_INVALID","Invalid follow-up cursor.");}
}
export async function readDisputeReport(pool:Pool,actor:Actor,raw:unknown,clock=Date.now){
 requireScope(actor,"trace-disputes.reviews",actor.authId);if(actor.role!=="admin")throw new DomainError(403,"ACTOR_SCOPE_DENIED","VITAL Admin access required.");
 const cursor=disputePageQuery(raw),upper=cursor?.upper??new Date(clock()).toISOString(),db=await pool.connect();
 try{await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
 const admin=async()=>{if(!(await db.query(`SELECT a."userId" FROM vital_admins a JOIN vital_users u ON u.id=a."userId" AND u."authId"=a."authId" WHERE a."authId"=$1 AND u.role='admin'`,[actor.authId])).rowCount)throw new DomainError(403,"ACTOR_SCOPE_DENIED","VITAL Admin access required.");};
 await admin();
 const base=`FROM trace_dispute_reviews r JOIN appointment_disputes ad ON ad.id=r."reportId" JOIN appointments a ON a.id=ad."appointmentId" WHERE r."resolvedAt" IS NULL AND r."createdAt"<=$1::timestamptz`;
 const found=(await db.query(`SELECT r.id,r."reportId",r."decisionId",r.reason,r."createdAt",ad."appointmentId",ad."traceCaseId",ad."deliveryStatus",a.status,a."reviewHold" ${base} AND ($2::timestamptz IS NULL OR (r."createdAt",r.id)>($2::timestamptz,$3::uuid)) ORDER BY r."createdAt",r.id LIMIT 26`,[upper,cursor?.at??null,cursor?.id??null])).rows;
 const counts=(await db.query(`SELECT r.reason,a.status,COUNT(*)::int AS count ${base} GROUP BY r.reason,a.status ORDER BY r.reason,a.status`,[upper])).rows;
 const summary=(await db.query(`SELECT
 (SELECT count(*)::int FROM trace_dispute_deliveries WHERE status IN ('pending','processing')) AS "pendingDeliveries",
 (SELECT count(*)::int FROM trace_dispute_responses WHERE status='pending') AS "pendingResponses",
 (SELECT count(*)::int FROM appointment_disputes ad JOIN appointments a ON a.id=ad."appointmentId" WHERE a."reviewHold" AND ad."originalCompletionDeadlineAt"<now()) AS "overdueHolds",
 (SELECT min("acceptedAt") FROM trace_dispute_responses WHERE status='pending') AS "oldestPendingResponseAt"`)).rows[0];
 await admin();await db.query("COMMIT");
 const items=found.slice(0,25),last=items.at(-1),reasons=new Map<string,number>(),statuses=new Map<string,number>();let total=0;
 for(const row of counts){const count=Number(row.count);reasons.set(row.reason,(reasons.get(row.reason)??0)+count);statuses.set(row.status,(statuses.get(row.status)??0)+count);total+=count;}
 return{items,summary,total,asOf:upper,counts:{reasons:[...reasons].map(([label,count])=>({label,count})),statuses:[...statuses].map(([label,count])=>({label,count}))},
 nextCursor:found.length>25&&last?Buffer.from(JSON.stringify({at:new Date(last.createdAt).toISOString(),id:last.id,upper})).toString("base64url"):null};
 }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
}
