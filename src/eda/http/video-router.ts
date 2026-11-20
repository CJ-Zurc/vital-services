import { meetAutomationRetired } from '../modules/video/module.js';
import { Router,type RequestHandler } from 'express';
import { z } from 'zod';
import { DomainError,type Actor } from '../contracts/actor.js';
import type { AppointmentCommand } from '../modules/appointment/appointment-contracts.js';
import type { VideoRuntime } from '../modules/video/runtime.js';

type Handler=RequestHandler<Record<string,string>,unknown,unknown,Record<string,unknown>,{actor?:Actor;command?:AppointmentCommand}>;
export function createVideoRouter(video?:VideoRuntime){
  const router=Router();
  router.all(['/connection','/oauth/start','/oauth/callback','/generations','/generations/:id'],()=>meetAutomationRetired());
  router.use((_req,_res,next)=>next(video?undefined:new DomainError(503,'VIDEO_OWNER_DISABLED','Video extraction is disabled.')));
  const handle=(run:(actor:Actor,id:string,body:unknown,meta:AppointmentCommand|undefined)=>Promise<unknown>):Handler=>async(req,res)=>{
    const actor=res.locals.actor;if(!actor)throw new DomainError(401,'ACTOR_REQUIRED','Verified actor required.');
    const id=req.params.id??actor.authId;z.uuid().parse(id);
    const data=await run(actor,id,req.body??{},res.locals.command);
    const pending=typeof data==='object'&&data!==null&&'status' in data&&['creating','uncertain'].includes(String(data.status));
    if(pending)res.set('Retry-After','5');
    res.status(pending?202:200).json({success:true,contractVersion:1,data});
  };
  router.get('/resources/appointments/:id',handle((actor,id)=>video!.resource(actor,id)));
  return router;
}
