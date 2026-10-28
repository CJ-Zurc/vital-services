import { Router } from 'express';
import { DomainError } from '../contracts/actor.js';
import type { IntelligenceModule } from '../modules/intelligence/module.js';
const actions=new Set(['catalog','intakes/read','intakes/save','intakes/delete','intakes/lease','intakes/analyze','intakes/status','intakes/confirm','intakes/recommendations','admin/dashboard','admin/refresh','admin/clusters/label','brief/read','brief/approve']);
export function createIntelligenceRouter(module?:IntelligenceModule){
  const router=Router();router.post(/.*/,async(req,res,next)=>{try{const action=req.path.slice(1);if(!actions.has(action))throw new DomainError(404,'AI_ACTION_UNKNOWN','Unknown AI operation.');if(!module)throw new DomainError(503,'AI_DISABLED','AI is unavailable.');
    const data=await module.execute(res.locals.actor,action,req.body);res.status(action==='intakes/analyze'||action==='admin/refresh'?202:200).json({success:true,contractVersion:1,data});}catch(e){next(e);}});return router;
}
