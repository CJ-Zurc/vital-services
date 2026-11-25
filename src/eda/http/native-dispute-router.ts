import {readDisputeReport} from "../modules/appointment/dispute-reporting.js";
import { Router } from 'express';
import type { Pool } from 'pg';
import { DomainError } from '../contracts/actor.js';
import { requireScope } from '../contracts/actor.js';
import { receiveNativeEvent, confirmNativeTimeout, readNativeDispute } from '../modules/appointment/native-dispute.js';
import { uploadDisputeEvidence } from '../modules/appointment/dispute-evidence.js';
import type { AppointmentRuntime } from './appointment-router.js';
export function createNativeDisputeRouter(pool:Pool,appointment?:AppointmentRuntime){
  const router=Router();
  router.get('/trace-disputes/reviews',async(req,res)=>{
    const query=new URL(req.originalUrl,"https://internal.invalid").searchParams;
    if([...query.keys()].some(key=>key!=="cursor"||query.getAll(key).length!==1))throw new DomainError(400,"DISPUTE_QUERY_INVALID","Invalid follow-up query.");
    const data=await readDisputeReport(pool,res.locals.actor,Object.fromEntries(query));
    res.json({success:true,contractVersion:2,data});
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
