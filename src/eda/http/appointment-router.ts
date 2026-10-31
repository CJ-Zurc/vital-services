import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { DomainError, type Actor } from "../contracts/actor.js";
import type { AppointmentCommand } from "../modules/appointment/appointment-contracts.js";
import type { createAppointmentModule } from "../modules/appointment/appointment.js";
import type { createAppointmentSaga } from "../modules/appointment/appointment-saga.js";
import type { AppointmentReads } from '../modules/appointment/appointment-reads.js';

export interface AppointmentRuntime {module:ReturnType<typeof createAppointmentModule>;saga:ReturnType<typeof createAppointmentSaga>;reads:AppointmentReads;listRequests:AppointmentReads['streamRequests'];resume:(actor:Actor,id:string,meta:AppointmentCommand,body:unknown)=>Promise<unknown>;maintenanceTick:()=>Promise<unknown>}
type Handler=RequestHandler<Record<string,string>,unknown,unknown,Record<string,unknown>,{actor?:Actor;command?:AppointmentCommand}>;
export function createAppointmentRouters(runtime?:AppointmentRuntime){
  const appointments=Router(),schedules=Router(),blocks=Router();
  for(const router of[appointments,schedules,blocks])router.use((_req,_res,next)=>next(runtime?undefined:new DomainError(503,"APPOINTMENT_OWNER_DISABLED","Appointment extraction is disabled.")));
  const handle=(run:(actor:Actor,id:string,meta:AppointmentCommand|undefined,input:unknown)=>Promise<unknown>):Handler=>async(req,res)=>{
    const actor=res.locals.actor;if(!actor)throw new DomainError(401,"ACTOR_REQUIRED","Verified actor required.");
    const id=req.params.id??actor.authId;z.uuid().parse(id);
    const data=await run(actor,id,res.locals.command,req.method==='GET'?req.query:req.body??{});
    const processing=typeof data==='object'&&data!==null&&'operationStatus' in data&&['processing','pending','unknown'].includes(String(data.operationStatus));
    res.status(processing?202:req.method==='POST'&&req.originalUrl.endsWith('/schedules')?201:200).json({success:true,contractVersion:1,data});
  };
  const command=(meta:AppointmentCommand|undefined)=>{if(!meta)throw new DomainError(401,"COMMAND_METADATA_REQUIRED","Signed command ID required.");return meta;};
  appointments.get('/doctors',handle((actor,_id,_meta,input)=>runtime!.reads.discovery(actor,input)));
  appointments.get('/doctors/:id/availability',handle((actor,id,_meta,input)=>runtime!.reads.availability(actor,id,input)));
  appointments.get('/requests',handle((actor,_id,_meta,input)=>runtime!.reads.listRequests(actor,input)));
  appointments.get('/dashboard',handle(actor=>runtime!.reads.dashboard(actor)));
  appointments.get('/',handle((actor,_id,_meta,input)=>runtime!.reads.list(actor,input)));
  appointments.post('/',handle((actor,_id,meta,input)=>runtime!.module.book(actor,command(meta),input)));
  appointments.post('/workflows',handle((actor,_id,meta,input)=>runtime!.module.prepareWorkflow(actor,command(meta),input)));
  appointments.get('/workflows/:id',handle((actor,id)=>runtime!.module.workflow(actor,id)));
  appointments.post('/workflows/:id/commit',handle((actor,id,meta,input)=>runtime!.module.commitWorkflow(actor,id,command(meta),input)));
  appointments.post('/workflows/:id/external-start',handle((actor,id,meta,input)=>runtime!.module.startExternal(actor,id,command(meta),input)));
  appointments.get('/operations/:id',handle((actor,id)=>runtime!.saga.status(actor,id)));
  appointments.post('/operations/:id/resume',handle((actor,id,meta,input)=>runtime!.resume(actor,id,command(meta),input)));
  appointments.get('/:id/access',handle((actor,id)=>runtime!.module.access.execute(actor,id,'read')));
  appointments.get('/:id/access/code',handle((actor,id)=>runtime!.module.access.execute(actor,id,'code')));
  for(const action of ['redeem','reissue','withdraw'] as const)appointments.post('/:id/access/'+action,handle((actor,id,meta,input)=>runtime!.module.access.execute(actor,id,action,input,command(meta))));
  appointments.get('/:id/history',handle((actor,id,_meta,input)=>runtime!.reads.history(actor,id,input)));
  appointments.get('/:id/relationships',handle((actor,id,_meta,input)=>runtime!.reads.relationships(actor,id,input)));
  appointments.get('/:id',handle((actor,id)=>runtime!.module.read(actor,id)));
  appointments.post('/:id/reject',handle((actor,id,meta,input)=>runtime!.module.reject(actor,id,command(meta),input)));
  appointments.post('/:id/reschedule',handle((actor,id,meta,input)=>runtime!.module.propose(actor,id,command(meta),input)));
  appointments.post('/:id/decline-reschedule',handle((actor,id,meta,input)=>runtime!.module.decline(actor,id,command(meta),input)));
  appointments.post('/:id/accept-reschedule',handle((actor,id,meta,input)=>runtime!.saga.accept(actor,id,command(meta),input)));
  appointments.post('/:id/cancel',handle((actor,id,meta,input)=>runtime!.module.cancel(actor,id,command(meta),input)));
  appointments.post('/:id/complete',handle((actor,id,meta,input)=>runtime!.module.complete(actor,id,command(meta),input)));
  schedules.get('/',handle((actor,_id,_meta,input)=>runtime!.reads.schedules(actor,input)));
  schedules.get('/:id/bookings',handle((actor,id,_meta,input)=>runtime!.reads.bookings(actor,id,input)));
  schedules.post('/preview',handle((actor,_id,_meta,input)=>runtime!.module.previewSlotBatch(actor,input)));
  schedules.post('/batch',handle((actor,_id,meta,input)=>runtime!.module.createSlotBatch(actor,command(meta),input)));
  schedules.post('/',handle((actor,_id,meta,input)=>runtime!.module.createSchedule(actor,command(meta),input)));
  schedules.patch('/:id',handle((actor,id,meta,input)=>runtime!.module.changeSchedule(actor,id,command(meta),input)));
  schedules.post('/:id/delete',handle((actor,id,meta,input)=>runtime!.module.changeSchedule(actor,id,command(meta),input,true)));
  blocks.use((_req,_res,next)=>next(new DomainError(410,'DATE_BLOCKS_RETIRED','Date blocking has been retired.')));
  blocks.get('/preview', handle((actor,_id,_meta,input) => {
    const query=z.object({ selection:z.string().max(4096) }).strict().parse(input);
    return runtime!.module.previewDateBlocks(actor,JSON.parse(query.selection));
  }));
  blocks.post('/batch',handle((actor,_id,meta,input)=>runtime!.module.batchDateBlocks(actor,command(meta),input)));
  blocks.get('/', handle((actor,_id,_meta,input)=>runtime!.reads.blocks(actor,input)));
  blocks.post('/',handle((actor,_id,meta,input)=>runtime!.module.createDateBlock(actor,command(meta),input)));
  blocks.post('/:id/delete',handle((actor,id,meta,input)=>runtime!.module.deleteDateBlock(actor,id,command(meta),input)));
  return{appointments,schedules,blocks};
}
