import { Router } from "express";
import { z } from "zod";
import { DomainError } from "../contracts/actor.js";
import type { AppointmentCommand } from "../modules/appointment/appointment-contracts.js";
import type { RecordsRuntime } from "../modules/records/runtime.js";

export function createRecordsRouter(runtime?:RecordsRuntime){
  const router=Router();router.use((_req,_res,next)=>next(runtime?undefined:new DomainError(503,'RECORDS_OWNER_DISABLED','Records extraction is disabled.')));
  const meta=(input:AppointmentCommand|undefined)=>{if(!input)throw new DomainError(401,'COMMAND_METADATA_REQUIRED','Signed command ID required.');return input;};
  const handle=(run:(req:import('express').Request,res:import('express').Response)=>Promise<unknown>):import('express').RequestHandler=>async(req,res)=>{
    if(!res.locals.actor)throw new DomainError(401,'ACTOR_REQUIRED','Verified actor required.');
    const data=await run(req,res);const pending=typeof data==='object'&&data!==null&&'operationStatus'in data&&['pending','processing','unknown'].includes(String(data.operationStatus));
    res.status(pending?202:200).json({success:true,contractVersion:1,data});
  };
  router.get('/documents',handle((req,res)=>runtime!.module.listDocuments(res.locals.actor,req.query,res.locals.recordsReader===true)));
  router.get('/documents/:id',handle((req,res)=>runtime!.module.document(res.locals.actor,z.uuid().parse(req.params.id),res.locals.recordsReader===true)));
  router.get('/files',handle((req,res)=>runtime!.files.list(res.locals.actor,req.query)));
  router.get('/files/:id',handle((req,res)=>runtime!.files.read(res.locals.actor,z.uuid().parse(req.params.id))));
  router.get('/patients',handle((req,res)=>runtime!.module.listPatients(res.locals.actor,req.query)));
  router.get('/patients/:id/context',handle((req,res)=>runtime!.module.patientContext(res.locals.actor,z.uuid().parse(req.params.id))));
  router.get('/patients/:id/episodes',handle((req,res)=>runtime!.module.episodes(res.locals.actor,z.uuid().parse(req.params.id),req.query)));
  router.post('/access-plans',handle((req,res)=>runtime!.module.accessPlan(res.locals.actor,meta(res.locals.command),req.body)));
  router.post('/snapshot-workflows',handle((req,res)=>runtime!.module.prepareSnapshot(res.locals.actor,meta(res.locals.command),req.body)));
  router.get('/snapshot-workflows/:id',handle((req,res)=>runtime!.module.workflowStatus(res.locals.actor,z.uuid().parse(req.params.id))));
  router.get('/workflows/:id',handle((req,res)=>runtime!.module.workflowStatus(res.locals.actor,z.uuid().parse(req.params.id))));
  router.get('/document-workflows/:id',handle((req,res)=>runtime!.module.workflowStatus(res.locals.actor,z.uuid().parse(req.params.id))));
  router.post('/snapshot-workflows/:id/capture',handle((req,res)=>runtime!.module.captureSnapshot(res.locals.actor,z.uuid().parse(req.params.id),meta(res.locals.command),req.body)));
  router.get('/snapshots/:id',handle((req,res)=>runtime!.module.snapshot(res.locals.actor,z.uuid().parse(req.params.id))));
  router.post('/document-workflows',handle((req,res)=>runtime!.module.prepareDocument(res.locals.actor,meta(res.locals.command),req.body)));
  router.post('/documents',handle((req,res)=>runtime!.module.issueDocument(res.locals.actor,meta(res.locals.command),req.body)));
  router.get('/operations/:id',handle((req,res)=>runtime!.module.operations(res.locals.actor,z.uuid().parse(req.params.id))));
  router.post('/uploads',handle((req,res)=>{if(!Buffer.isBuffer(req.body))throw new DomainError(400,'UPLOAD_BYTES_REQUIRED','Binary upload required.');return runtime!.files.upload(res.locals.actor,meta(res.locals.command),res.locals.uploadDescriptor,req.body);}));
  router.post('/files/:id/link',handle((req,res)=>runtime!.files.link(res.locals.actor,z.uuid().parse(req.params.id),meta(res.locals.command),req.body,res.locals.recordsReader===true)));
  return router;
}
