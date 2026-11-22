import { Router } from 'express';
import type { Pool } from 'pg';
import { DomainError } from '../contracts/actor.js';
import { requireScope } from '../contracts/actor.js';
import { receiveNativeEvent, confirmNativeTimeout, readNativeDispute } from '../modules/appointment/native-dispute.js';
import { uploadDisputeEvidence } from '../modules/appointment/dispute-evidence.js';
import type { AppointmentRuntime } from './appointment-router.js';
export function createNativeDisputeRouter(pool:Pool,appointment?:AppointmentRuntime){
  const router=Router();
  router.get('/trace-disputes/reviews',async(_req,res)=>{
    const actor=res.locals.actor;requireScope(actor,'trace-disputes.reviews',actor.authId);
    const admin=actor.role==='admin'&&(await pool.query(`SELECT id FROM vital_users WHERE "authId"=$1 AND role='admin'`,[actor.authId])).rows.length===1;
    if(!admin)throw new DomainError(403,'ACTOR_SCOPE_DENIED','VITAL Admin access required.');
    const rows=(await pool.query(`SELECT r.id,r."reportId",r."decisionId",r.reason,r."createdAt",ad."appointmentId",ad."traceCaseId",ad."deliveryStatus",a.status,a."reviewHold"
      FROM trace_dispute_reviews r JOIN appointment_disputes ad ON ad.id=r."reportId" JOIN appointments a ON a.id=ad."appointmentId"
      WHERE r."resolvedAt" IS NULL ORDER BY r."createdAt" LIMIT 100`)).rows;
    const summary=(await pool.query(`SELECT
      (SELECT count(*)::int FROM trace_dispute_deliveries WHERE status IN ('pending','processing')) AS "pendingDeliveries",
      (SELECT count(*)::int FROM trace_dispute_responses WHERE status='pending') AS "pendingResponses",
      (SELECT count(*)::int FROM appointment_disputes ad JOIN appointments a ON a.id=ad."appointmentId" WHERE a."reviewHold" AND ad."originalCompletionDeadlineAt"<now()) AS "overdueHolds",
      (SELECT min("acceptedAt") FROM trace_dispute_responses WHERE status='pending') AS "oldestPendingResponseAt"`)).rows[0];
    res.json({success:true,contractVersion:1,data:{items:rows,summary}});
  });
  router.get('/appointments/:id/dispute',async(req,res)=>{
    const data=await readNativeDispute(pool,res.locals.actor,req.params.id);res.json({success:true,contractVersion:1,data});
  });
  router.post('/appointments/:id/dispute-evidence',async(req,res)=>{
    const data=await uploadDisputeEvidence(pool,res.locals.actor,req.params.id,req.body);res.json({success:true,contractVersion:1,data});
  });
  router.post(['/trace-disputes/events','/trace-disputes/refund-confirmed','/appointments/appeals/refund-confirmed'],async(req,res)=>{
    const data=await receiveNativeEvent(pool,res.locals.actor,req.body,Date.now,appointment?.module.owners);
    // A crash here is recovered by ordinary appointment maintenance.
    if(data.applied&&appointment)await appointment.maintenanceTick();
    res.json({success:true,contractVersion:1,data});
  });
  router.post('/trace-disputes/timeout',async(req,res)=>{
    const data=await confirmNativeTimeout(pool,res.locals.actor,req.body);res.json({success:true,contractVersion:1,data});
  });
  router.use('/appointments/appeals',(_req,_res,next)=>next(new DomainError(410,'APPOINTMENT_LEGACY_CALLBACK_RETIRED','Use the Gateway native dispute contract.')));
  return router;
}
