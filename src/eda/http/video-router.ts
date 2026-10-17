import { Router,type RequestHandler } from 'express';
import { z } from 'zod';
import { DomainError,type Actor } from '../contracts/actor.js';
import type { AppointmentCommand } from '../modules/appointment/appointment-contracts.js';
import type { VideoRuntime } from '../modules/video/runtime.js';

type Handler=RequestHandler<Record<string,string>,unknown,unknown,Record<string,unknown>,{actor?:Actor;command?:AppointmentCommand}>;
export function createVideoRouter(video?:VideoRuntime){
  const router=Router();
  router.use((_req,_res,next)=>next(video?undefined:new DomainError(503,'VIDEO_OWNER_DISABLED','Video extraction is disabled.')));
  const handle=(run:(actor:Actor,id:string,body:unknown,meta:AppointmentCommand|undefined)=>Promise<unknown>):Handler=>async(req,res)=>{
    const actor=res.locals.actor;if(!actor)throw new DomainError(401,'ACTOR_REQUIRED','Verified actor required.');
    const id=req.params.id??actor.authId;z.uuid().parse(id);
    const data=await run(actor,id,req.body??{},res.locals.command);
    const pending=typeof data==='object'&&data!==null&&'status' in data&&['creating','uncertain'].includes(String(data.status));
    if(pending)res.set('Retry-After','5');
    res.status(pending?202:200).json({success:true,contractVersion:1,data});
  };
  const command=(meta:AppointmentCommand|undefined)=>{if(!meta)throw new DomainError(401,'COMMAND_METADATA_REQUIRED','Signed command required.');return meta;};
  router.get('/connection',handle(actor=>video!.status(actor)));
  router.delete('/connection',handle((actor,_id,body,meta)=>video!.disconnect(actor,command(meta),body)));
  router.post('/oauth/start',handle((actor,_id,body,meta)=>video!.start(actor,command(meta),body)));
  router.post('/oauth/callback',handle((actor,_id,body,meta)=>video!.callback(actor,command(meta),body)));
  router.post('/generations',handle((actor,_id,body,meta)=>video!.generate(actor,command(meta),body)));
  router.get('/generations/:id',handle((actor,id)=>video!.generation(actor,id)));
  router.get('/resources/appointments/:id',handle((actor,id)=>video!.resource(actor,id)));
  return router;
}
