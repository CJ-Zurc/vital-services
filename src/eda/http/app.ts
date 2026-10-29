import type { AuditRuntime } from '../modules/audit/runtime.js';
import { observeRequest } from '../infrastructure/observation.js';
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { createIntelligenceRouter } from './intelligence-router.js';
import type { IntelligenceModule } from '../modules/intelligence/module.js';
import type { TLSSocket } from "node:tls";
import jwt from "jsonwebtoken";
import { z, ZodError } from "zod";
import { DomainError, AppointmentPendingConflictsError } from "../contracts/actor.js";
import { verifyActorAssertion, type AssertionConfig } from "../infrastructure/security.js";
import type { CorePrismaClient } from "../infrastructure/databases.js";
import { createProfileRouter } from "./profile-router.js";
import { createProfileCommandGuard } from "../modules/profile/profile-commands.js";
import type { ProfileSyncStatuses } from "../modules/profile/profile-contracts.js";
import { createPaymentRouter, type PaymentModule } from "./payment-router.js";
import { createAppointmentRouters, type AppointmentRuntime } from "./appointment-router.js";
import { createRecordsRouter } from "./records-router.js";
import { recordsReaderDelegation } from "./records-reader.js";
import { uploadDescriptor } from "../modules/records/files.js";
import type { RecordsRuntime } from "../modules/records/runtime.js";
import type { VideoRuntime } from '../modules/video/runtime.js';
import { createVideoRouter } from './video-router.js';
import { createMessagingRouter } from './messaging-router.js';
import type { MessagingRuntime } from '../modules/messaging/runtime.js';
import { createStreamRouter, type StreamOwners } from './stream-router.js';
import { createCompletionRouter } from './completion-router.js';
import type { CompletionReads } from '../modules/composition/completion-reads.js';
import { createProfileQrRouter, createProfileQrUploadIngress } from './profile-qr-router.js';
import type { ProfileQrModule } from '../modules/profile/profile-qr.js';
import { createAppointmentExtrasRouter } from './appointment-extras-router.js';
import type { AppointmentExtras } from '../modules/appointment/appointment-extras.js';
import { createPortalIntegrationsRouter, portalIntegrationDelegation } from './portal-integrations-router.js';
import type { PortalIntegrations } from '../modules/portal-integrations/portal-integrations.js';
import { createAppointmentCommandPreparationRouter, type AppointmentCommandPreparationRuntime } from './appointment-command-preparation-router.js';

export function createEdaApp(core: CorePrismaClient, assertion: AssertionConfig, profileWrites = false, syncStatuses?: ProfileSyncStatuses, payment?: PaymentModule, appointment?: AppointmentRuntime, records?: RecordsRuntime,video?:VideoRuntime,messaging?:MessagingRuntime,streams?:StreamOwners,completion?:CompletionReads,profileQr?:ProfileQrModule,appointmentExtras?:AppointmentExtras,portal?:PortalIntegrations,commandPreparations?:AppointmentCommandPreparationRuntime,intelligence?:IntelligenceModule,audit?:AuditRuntime) {
  const app = express();
  app.use(observeRequest);
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(createProfileQrUploadIngress(assertion));
  let activeUploads=0;
  app.post('/internal/v1/records/uploads',(req,res,next)=>{
    try{const raw=req.get('X-Vital-Upload-Descriptor')??'';if(raw.length>8192)throw new DomainError(413,'UPLOAD_DESCRIPTOR_LIMIT','Upload descriptor too large.');
      const descriptor=uploadDescriptor.parse(JSON.parse(Buffer.from(raw,'base64url').toString('utf8')));
      const peer=req.socket as TLSSocket,peerName=peer.getPeerCertificate?.().subject?.CN;
      // Authenticate the bound descriptor before allocating the binary body.
      verifyActorAssertion({token:req.get('X-Vital-Actor-Assertion')??'',peerAuthorized:peer.authorized===true,peerName:typeof peerName==='string'?peerName:'',method:req.method,path:req.originalUrl,body:descriptor,config:assertion});
      if(req.get('Content-Type')!=='application/octet-stream'||req.get('Transfer-Encoding')||req.get('Content-Encoding')||req.get('Content-Length')!==String(descriptor.byteLength))throw new DomainError(400,'UPLOAD_ENVELOPE_INVALID','Bounded upload body required.');
      if(activeUploads>=2){res.set('Retry-After','2');throw new DomainError(429,'UPLOAD_CAPACITY_LIMIT','Upload capacity is currently occupied.');}
      activeUploads++;let released=false;const release=()=>{if(!released){released=true;activeUploads--;}};res.once('finish',release);res.once('close',release);
      res.locals.uploadDescriptor=descriptor;next();
    }catch(error){next(error);}
  },express.raw({type:'application/octet-stream',limit:10*1024*1024,inflate:false}));
  app.post('/internal/v1/records/snapshot-workflows/:id/capture',express.json({limit:'2112kb',strict:true}));
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use((_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
  app.get("/health", (_req, res) => res.json({ success: true, data: { service: "vital-services-eda", mode: "api", migrationComplete: false } }));
  const delegation: RequestHandler = (req, res, next) => {
    try {
      const peer = req.socket as TLSSocket;
      const token = req.get("X-Vital-Actor-Assertion") ?? "";
      const peerName = peer.getPeerCertificate?.().subject?.CN;
      res.locals.actor = verifyActorAssertion({ token, peerAuthorized: peer.authorized === true,
        peerName: typeof peerName === "string" ? peerName : "", method: req.method,
        path: req.originalUrl, body: res.locals.uploadDescriptor ?? req.body ?? null, config: assertion });
      if (req.path.startsWith('/portal-integrations/')) res.locals.portalDelegation = portalIntegrationDelegation(token, res.locals.actor, req.method, req.originalUrl);
      else res.locals.recordsReader=recordsReaderDelegation(token,res.locals.actor,req.method,req.originalUrl);
      const verifiedClaims = jwt.decode(token);
      if (!verifiedClaims || typeof verifiedClaims === 'string' || !Number.isInteger(verifiedClaims.exp)) throw new DomainError(401, 'INVALID_ACTOR_ASSERTION', 'Fresh authorization required.');
      res.locals.assertionExpiresAt = verifiedClaims.exp;
      res.set("X-Correlation-ID", res.locals.actor.correlationId);
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        const claims = jwt.decode(token);
        if (!claims || typeof claims === "string") throw new DomainError(401, "INVALID_COMMAND", "Verified command ID required.");
        res.locals.command = { operationId: z.uuid().parse(claims.jti), requestHash: z.string().regex(/^[a-f0-9]{64}$/).parse(claims.requestHash) };
      }
      next();
    } catch (error) { next(error); }
  };
  app.use("/internal/v1", delegation);
  app.post('/internal/v1/audit/denials',async(req,res)=>{
    if(!audit)throw new DomainError(503,'AUDIT_UNAVAILABLE','Audit recording unavailable.');
    res.json({success:true,contractVersion:1,data:await audit.boundary(res.locals.actor,req.body)});
  });
  app.post('/internal/v1/audit/intents',async(req,res)=>{
    if(!audit)throw new DomainError(503,'AUDIT_UNAVAILABLE','Audit recording unavailable.');
    if(!res.locals.command)throw new DomainError(401,'COMMAND_METADATA_REQUIRED','Signed command required.');
    const result=await audit.intent(res.locals.actor,res.locals.command.operationId,res.locals.command.requestHash,req.body);
    res.json({success:true,contractVersion:1,data:result});
  });
  app.use('/internal/v1/ai',createIntelligenceRouter(intelligence));
  app.use('/internal/v1', createStreamRouter(streams));
  app.use('/internal/v1/completion', createCompletionRouter(completion));
  app.use('/internal/v1/portal-integrations', createPortalIntegrationsRouter(portal));
  app.use('/internal/v1/profile/doctor/payment-qr', createProfileQrRouter(profileQr));
  app.use("/internal/v1/profile", createProfileRouter(core, { commandGuard: profileWrites ? createProfileCommandGuard() : undefined, syncStatuses }));
  app.use("/internal/v1/payments", createPaymentRouter(payment));
  app.use('/internal/v1/appointments', createAppointmentExtrasRouter(appointmentExtras));
  app.use('/internal/v1/appointments/command-preparations', createAppointmentCommandPreparationRouter(commandPreparations));
  const appointmentRouters=createAppointmentRouters(appointment);
  app.use("/internal/v1/appointments",appointmentRouters.appointments);
  app.use("/internal/v1/schedules",appointmentRouters.schedules);
  app.use("/internal/v1/date-blocks",appointmentRouters.blocks);
  app.use("/internal/v1/records",createRecordsRouter(records));
  app.use('/internal/v1/video',createVideoRouter(video));
  app.use('/internal/v1/messaging', createMessagingRouter(messaging));
  app.use((_req, res) => res.status(404).json({ success: false, code: "ROUTE_NOT_EXTRACTED", message: "This route has not passed extraction acceptance." }));
  const errors: ErrorRequestHandler = async (error: unknown, _req, res, _next) => {
    if (res.headersSent) { res.destroy(); return; }
    if(audit&&(error instanceof DomainError||error instanceof ZodError)&&res.locals.actor){
      const template=typeof _req.route?.path==='string'?_req.baseUrl.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,'{id}')+_req.route.path.replace(/:([A-Za-z]+)/g,'{$1}'):null;
      if(template&&/^\/[a-zA-Z0-9_/{}/.-]{0,240}$/.test(template))await audit.denied(res.locals.actor,template,_req.method,error instanceof DomainError?error.status:400).catch(()=>console.error(JSON.stringify({event:'vital.audit.persistence_failed'})));
    }
    if(error instanceof AppointmentPendingConflictsError){res.status(409).json({success:false,code:error.code,message:error.message,data:{conflictIds:error.conflictIds}});return;}
    if (error instanceof DomainError) {if(error.status===429||error.status===503||/PENDING/.test(error.code))res.set('Retry-After',error.code==='MESSAGE_RATE_LIMIT'?'60':'5');res.status(error.status).json({ success: false, code: error.code, message: error.message });}
    else if (error instanceof ZodError) res.status(400).json({ success: false, code: "INVALID_INPUT", message: "Invalid request." });
    else if (typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large") res.status(413).json({ success: false, code: "BODY_TOO_LARGE" });
    else res.status(500).json({ success: false, code: "REQUEST_FAILED", message: "VITAL request failed." });
  };
  app.use(errors);
  return app;
}
