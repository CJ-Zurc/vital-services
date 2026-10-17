import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import { requireScope,type Actor } from "../../contracts/actor.js";
import { appendSqlOutbox } from "../../infrastructure/outbox.js";
import { requestHash } from "../../infrastructure/security.js";
import { lockAppointment,readAppointment,membership } from "../appointment/appointment.js";
import type { AppointmentCommand,AppointmentRow } from "../appointment/appointment-contracts.js";
import { assertPaperwork,assertRecordsIdle,assignedDoctor,currentPaid,medicalConsent,normalizeEhrSnapshot,paperworkDeadline,recordsDenied } from "./authorization.js";
import { recordsCommand } from "./commands.js";
import { certificateData,documentPrepare,prescriptionData,snapshotPrepare,type RecordsConfig,type RecordsWorkflowRow } from "./contracts.js";
import { clinicalHash,protectPayload,unprotectPayload } from "./protection.js";
import { verifyEhrEvidence } from "./ehr-evidence.js";
import { createRecordsCollections } from './collection-reads.js';

type Patient={userId:string;authId:string;ehrPatientId:string|null;version:number};
const payloadBinding=(patientId:string,resourceId:string,schema:string)=>({patientId,resourceId,schema});
export function createRecordsModule(pool:Pool,config:RecordsConfig,clock=Date.now) {
  const collections=createRecordsCollections(pool,{authorize:owningRead,patient},clock);
  const mutate=<T>(actor:Actor,action:string,resource:string,meta:AppointmentCommand,input:unknown,run:(tx:PoolClient)=>Promise<T>)=>recordsCommand(pool,actor,action,resource,meta,input,run);
  async function patient(db:Pick<PoolClient,"query">,id:string,locked=false):Promise<Patient>{
    z.uuid().parse(id);const row=(await db.query<Patient>(`SELECT p."userId",p."authId",p."ehrPatientId",u.version FROM vital_patients p JOIN vital_users u ON u.id=p."userId" AND u."authId"=p."authId" WHERE p."userId"=$1`+(locked?' FOR SHARE OF u,p':''),[id])).rows[0];
    if(!row)recordsDenied(404,"RECORDS_PATIENT_NOT_FOUND");return row;
  }
  async function eligibility(tx:PoolClient,actor:Actor,row:AppointmentRow,recovery=false) {
    assignedDoctor(actor,row);await medicalConsent(tx,row.patientId,row.id);await assertRecordsIdle(tx,row);
    if(row.status!=="confirmed")recordsDenied(409,"RECORDS_LIVE_ACCESS_DENIED");
    if(!recovery)assertPaperwork(row,clock());
    else if(row.doctorConfirmedAt||row.paperworkLockedAt)recordsDenied(409,"RECORDS_RECOVERY_ALREADY_FROZEN");
    await currentPaid(tx,row,config.financial);
    const episode=(await tx.query<{status:string;frozenSnapshotId:string|null}>(`SELECT status,"frozenSnapshotId" FROM records_episode_grants WHERE "appointmentId"=$1 AND "patientId"=$2 AND "doctorId"=$3 AND "associationVersion"=$4 FOR UPDATE`,[row.id,row.patientId,row.doctorId,row.associationVersion])).rows[0];
    if(!episode||episode.status!=="live"||episode.frozenSnapshotId)recordsDenied(409,"RECORDS_EPISODE_ACCESS_DENIED");
  }
  async function audit(tx:PoolClient,actor:Actor,id:string,version:number,operationId:string,kind:string){
    await appendSqlOutbox(tx,{producer:"records",eventType:"vital.audit.requested",aggregateId:id,aggregateVersion:version,correlationId:actor.correlationId,causationId:operationId,
      data:{auditType:"vital.records."+kind,actorAuthId:actor.authId,resourceId:id,resourceType:"document"}});
  }
  async function workflow(tx:Pick<PoolClient,"query">,actor:Actor,id:string,locked=false):Promise<RecordsWorkflowRow>{
    const row=(await tx.query<RecordsWorkflowRow>('SELECT * FROM records_workflows WHERE id=$1::uuid AND "actorAuthId"=$2'+(locked?' FOR UPDATE':''),[id,actor.authId])).rows[0];
    if(!row)recordsDenied(404,"RECORDS_WORKFLOW_NOT_FOUND");return row;
  }
  function publicWorkflow(row:RecordsWorkflowRow){return{workflowId:row.id,appointmentId:row.appointmentId,expectedVersion:row.expectedVersion,ehrPatientId:row.ehrPatientId,ehrCaseId:row.ehrCaseId,
    doctorAuthId:row.actorAuthId,inputHash:row.inputHash,payloadHash:row.inputHash,state:row.state,kind:row.kind,recovery:row.recovery,
    ...(row.state==='committed'?{resourceId:row.resourceId,operationId:row.commitOperationId}:{}),expiresAt:row.expiresAt.toISOString()};}
  async function saveWorkflow(tx:PoolClient,actor:Actor,meta:AppointmentCommand,input:{workflowId:string;patientId:string;doctorId:string;appointmentId:string|null;expectedVersion:number;associationVersion:number|null;ehrPatientId:string;ehrCaseId:string|null;kind:string;inputHash:string;recovery:boolean}){
    const old=(await tx.query<RecordsWorkflowRow>('SELECT * FROM records_workflows WHERE id=$1::uuid FOR UPDATE',[input.workflowId])).rows[0];
    if(old){if(old.actorAuthId!==actor.authId||old.inputHash!==input.inputHash||old.kind!==input.kind||old.patientId!==input.patientId||old.appointmentId!==input.appointmentId||old.expectedVersion!==input.expectedVersion||old.recovery!==input.recovery)
      recordsDenied(409,"RECORDS_WORKFLOW_CONFLICT");return publicWorkflow(old);}
    await tx.query(`INSERT INTO records_workflows (id,"actorAuthId","patientId","doctorId","appointmentId","expectedVersion","associationVersion","ehrPatientId","ehrCaseId",kind,"inputHash",recovery,state,"prepareOperationId","expiresAt","createdAt","updatedAt")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'prepared',$13,$14,NOW(),NOW())`,[input.workflowId,actor.authId,input.patientId,input.doctorId,input.appointmentId,input.expectedVersion,input.associationVersion,input.ehrPatientId,input.ehrCaseId,input.kind,input.inputHash,input.recovery,meta.operationId,new Date(clock()+300000)]);
    return{workflowId:input.workflowId,appointmentId:input.appointmentId,expectedVersion:input.expectedVersion,ehrPatientId:input.ehrPatientId,ehrCaseId:input.ehrCaseId,doctorAuthId:actor.authId,
      inputHash:input.inputHash,payloadHash:input.inputHash,state:"prepared",kind:input.kind,recovery:input.recovery};
  }
  async function owningRead(actor:Actor,scope:string,resource:string){requireScope(actor,"records."+scope,resource);return membership(pool,actor);}
  async function workflowLock(tx:PoolClient,id:string){await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['records-workflow:'+id]);}
  return {
    async document(actor:Actor,id:string,integration=false){
      if(integration)requireScope(actor,'records.integration.read','records:integration');else requireScope(actor,'records.document.read',id);
      const member=integration?null:await membership(pool,actor);
      const doc=(await pool.query<{id:string;patientId:string;doctorId:string;appointmentId:string|null;kind:string;assetId:string;accessCode:string;protectedPayload:unknown;issuedAt:Date;state:string;assetVersion:number}>(`SELECT d.*,a.state,a.version AS "assetVersion" FROM records_documents d JOIN records_file_assets a ON a.id=d."assetId" WHERE d.id=$1::uuid`,[z.uuid().parse(id)])).rows[0];
      if(!doc)recordsDenied(404,'RECORDS_DOCUMENT_NOT_FOUND');
      if(!integration&&(actor.role==='patient'?member!.userId!==doc.patientId:actor.role!=='doctor'||member!.userId!==doc.doctorId))recordsDenied(403,'RECORDS_DOCUMENT_DENIED');
      if(!integration&&actor.role==='doctor')await medicalConsent(pool,doc.patientId,doc.appointmentId);
      const data=unprotectPayload<Record<string,unknown>>(config.keyring,payloadBinding(doc.patientId,doc.id,'document.v1'),doc.protectedPayload);
      return{id:doc.id,patientId:doc.patientId,doctorId:doc.doctorId,appointmentId:doc.appointmentId,kind:doc.kind,assetId:doc.assetId,accessCode:doc.accessCode,version:doc.assetVersion,...data,
        issuedAt:doc.issuedAt.toISOString(),generatedAt:doc.issuedAt.toISOString(),processingState:doc.state,operationStatus:doc.state==='ready'?'completed':doc.state};
    },
    episodes:collections.episodes,
    async patientContext(actor:Actor,id:string){
      if(!['patient','doctor'].includes(actor.role))recordsDenied(403,'RECORDS_READER_DENIED');
      await owningRead(actor,"context",id);const p=await patient(pool,id);
      if(actor.role==="patient"&&actor.authId!==p.authId)recordsDenied(403,"RECORDS_PATIENT_DENIED");
      if(actor.role==="doctor"){
        const d=await membership(pool,actor,"doctor");const grants=await pool.query(`SELECT g."appointmentId" FROM records_episode_grants g WHERE g."patientId"=$1 AND g."doctorId"=$2
          AND (g.status='live' OR g."snapshotId" IS NOT NULL) AND COALESCE((SELECT c.accepted FROM consent_records c WHERE c."patientId"=g."patientId"
            AND c."consentType"='medical_record' AND (c."appointmentId" IS NULL OR c."appointmentId"=g."appointmentId") ORDER BY c."consentedAt" DESC,c.id DESC LIMIT 1),false) LIMIT 1`,[id,d.userId]);
        if(!grants.rows.length)recordsDenied(403,"RECORDS_DOCTOR_DENIED");
      }
      return{patientId:p.userId,authId:p.authId,ehrPatientId:p.ehrPatientId,version:p.version};
    },
    async accessPlan(actor:Actor,meta:AppointmentCommand,body:unknown){const input=z.object({appointmentId:z.uuid(),expectedVersion:z.number().int().nonnegative(),recovery:z.boolean().default(false)}).strict().parse(body);
      const plan=async(tx:PoolClient)=>{const row=await lockAppointment(tx,input.appointmentId);if(row.version!==input.expectedVersion)recordsDenied(409,"APPOINTMENT_VERSION_CHANGED");
        await eligibility(tx,actor,row,input.recovery);const p=await patient(tx,row.patientId);if(!p.ehrPatientId||!row.ehrCaseId)recordsDenied(409,"RECORDS_EHR_LINK_REQUIRED");
        return{appointmentId:row.id,patientId:p.userId,ehrPatientId:p.ehrPatientId,ehrCaseId:row.ehrCaseId,version:row.version,associationVersion:row.associationVersion,recovery:input.recovery,paperworkDeadlineAt:paperworkDeadline(row).toISOString()};};
      return recordsCommand(pool,actor,'access',input.appointmentId,meta,input,plan,tx=>plan(tx));},
    async prepareSnapshot(actor:Actor,meta:AppointmentCommand,body:unknown){const input=snapshotPrepare.parse(body);
      return mutate(actor,"snapshot.prepare",input.appointmentId,meta,input,async tx=>{
        await workflowLock(tx,input.workflowId);
        const row=await lockAppointment(tx,input.appointmentId);if(row.version!==input.expectedVersion)recordsDenied(409,"APPOINTMENT_VERSION_CHANGED");await eligibility(tx,actor,row,input.recovery);
        const p=await patient(tx,row.patientId,true);if(!p.ehrPatientId||!row.ehrCaseId)recordsDenied(409,"RECORDS_EHR_LINK_REQUIRED");
        const inputHash=requestHash("SNAPSHOT-WORKFLOW",input.workflowId,{appointmentId:row.id,version:row.version,associationVersion:row.associationVersion,ehrPatientId:p.ehrPatientId,ehrCaseId:row.ehrCaseId,recovery:input.recovery});
        return saveWorkflow(tx,actor,meta,{...input,patientId:p.userId,doctorId:row.doctorId,associationVersion:row.associationVersion,ehrPatientId:p.ehrPatientId,ehrCaseId:row.ehrCaseId,kind:"snapshot",inputHash});
      });},
    async workflowStatus(actor:Actor,id:string){await owningRead(actor,"workflow.read",id);return publicWorkflow(await workflow(pool,actor,z.uuid().parse(id)));},
    async captureSnapshot(actor:Actor,id:string,meta:AppointmentCommand,body:unknown){
      const input=z.object({inputHash:z.string().regex(/^[a-f0-9]{64}$/),payload:z.unknown(),receipt:z.string().min(1).max(8192)}).strict().parse(body);
      return mutate(actor,"snapshot.capture",id,meta,{inputHash:input.inputHash,payloadHash:clinicalHash(input.payload),receiptHash:clinicalHash(input.receipt)},async tx=>{
        await workflowLock(tx,id);
        const preview=await workflow(tx,actor,id);if(!preview.appointmentId)recordsDenied(409,'RECORDS_WORKFLOW_CONFLICT');
        const row=await lockAppointment(tx,preview.appointmentId);
        const w=await workflow(tx,actor,id,true);if(w.kind!=="snapshot"||w.inputHash!==input.inputHash||w.appointmentId!==preview.appointmentId)recordsDenied(409,"RECORDS_WORKFLOW_CONFLICT");assignedDoctor(actor,row);
        if(w.state==="committed"){
          const evidence=(await tx.query<{sourceHash:string}>('SELECT "sourceHash" FROM records_snapshots WHERE id=$1::uuid AND "workflowId"=$2::uuid',[w.resourceId,w.id])).rows[0];
          if(!evidence||evidence.sourceHash!==clinicalHash(input.payload))recordsDenied(409,'RECORDS_WORKFLOW_REPLAY_CONFLICT');
          return{snapshotId:w.resourceId,appointmentId:row.id,operationStatus:"completed"};
        }
        if(w.state!=="prepared"||w.expiresAt.getTime()<=clock()||row.version!==w.expectedVersion||row.associationVersion!==w.associationVersion||row.ehrCaseId!==w.ehrCaseId)
          recordsDenied(409,"RECORDS_WORKFLOW_STALE");
        await eligibility(tx,actor,row,w.recovery);const p=await patient(tx,row.patientId,true);if(p.ehrPatientId!==w.ehrPatientId)recordsDenied(409,"RECORDS_EHR_LINK_CHANGED");
        const evidence=verifyEhrEvidence(input.receipt,config.evidence,{kind:"snapshot",workflowId:w.id,actorAuthId:actor.authId,patientId:w.ehrPatientId,caseId:w.ehrCaseId,payloadHash:clinicalHash(input.payload)},Math.floor(clock()/1000));
        const cutoff=new Date(Math.min(clock(),paperworkDeadline(row).getTime()));
        const docs=(await tx.query<{id:string;assetId:string;kind:string;protectedPayload:unknown;issuedAt:Date}>(`SELECT id,"assetId",kind,"protectedPayload","issuedAt" FROM records_documents WHERE "patientId"=$1 AND "issuedAt"<=$2 ORDER BY "issuedAt",id LIMIT 257`,[row.patientId,cutoff])).rows;
        const files=(await tx.query<{id:string;kind:string;protectedPayload:unknown;createdAt:Date}>(`SELECT id,kind,"protectedPayload","createdAt" FROM records_file_assets WHERE "patientId"=$1 AND kind='upload' AND state='ready' AND "createdAt"<=$2 ORDER BY "createdAt",id LIMIT 257`,[row.patientId,cutoff])).rows;
        if(docs.length>256||files.length>256)recordsDenied(413,'RECORDS_EVIDENCE_COLLECTION_LIMIT');
        const snapshotId=randomUUID();const localDocuments=docs.map(doc=>({id:doc.id,assetId:doc.assetId,kind:doc.kind,issuedAt:doc.issuedAt.toISOString(),...unprotectPayload<Record<string,unknown>>(config.keyring,payloadBinding(row.patientId,doc.id,"document.v1"),doc.protectedPayload)}));
        const localFiles=files.map(file=>({id:file.id,assetId:file.id,createdAt:file.createdAt.toISOString(),...unprotectPayload<Record<string,unknown>>(config.keyring,payloadBinding(row.patientId,file.id,"file.v1"),file.protectedPayload)}));
        const payload=protectPayload(config.keyring,payloadBinding(row.patientId,snapshotId,"snapshot.v1"),{ehr:normalizeEhrSnapshot(input.payload),documents:localDocuments,files:localFiles,documentCutoffAt:cutoff.toISOString()});
        await tx.query(`INSERT INTO records_snapshots (id,"workflowId","appointmentId","patientId","doctorId","appointmentVersion","associationVersion","ehrPatientId","ehrCaseId","sourceHash","normalizationVersion","protectedPayload","receiptMetadata","capturedAt")
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11::jsonb,$12::jsonb,$13)`,[snapshotId,w.id,row.id,row.patientId,row.doctorId,row.version,row.associationVersion,w.ehrPatientId,w.ehrCaseId,evidence.claims.payloadHash,JSON.stringify(payload),JSON.stringify(evidence.metadata),new Date(clock())]);
        for(const assetId of new Set([...docs.map(d=>d.assetId),...files.map(f=>f.id)]))await tx.query('INSERT INTO records_snapshot_assets ("snapshotId","assetId") VALUES($1::uuid,$2::uuid)',[snapshotId,assetId]);
        await tx.query('UPDATE records_episode_grants SET "snapshotId"=$2::uuid,"updatedAt"=NOW() WHERE "appointmentId"=$1 AND "frozenSnapshotId" IS NULL',[row.id,snapshotId]);
        await tx.query(`UPDATE records_workflows SET state='committed',"resourceId"=$2::uuid,"receiptMetadata"=$3::jsonb,"commitOperationId"=$4::uuid,"updatedAt"=NOW() WHERE id=$1::uuid`,[id,snapshotId,JSON.stringify(evidence.metadata),meta.operationId]);
        await tx.query('UPDATE appointments SET "recordsBlockCode"=NULL,"maintenanceDueAt"=NOW() WHERE id=$1',[row.id]);
        await appendSqlOutbox(tx,{producer:"records",eventType:"vital.records.snapshot.captured",aggregateId:snapshotId,aggregateVersion:1,correlationId:actor.correlationId,causationId:meta.operationId,
          data:{snapshotId,appointmentId:row.id,patientId:row.patientId,operationId:meta.operationId}});
        await audit(tx,actor,snapshotId,1,meta.operationId,"snapshot_captured");return{snapshotId,appointmentId:row.id,operationStatus:"completed"};
      });},
    async snapshot(actor:Actor,id:string){const member=await owningRead(actor,"snapshot.read",id);
      const s=(await pool.query<{id:string;patientId:string;doctorId:string;appointmentId:string;protectedPayload:unknown;capturedAt:Date}>(`SELECT s.* FROM records_snapshots s JOIN records_episode_grants g ON g."appointmentId"=s."appointmentId"
        WHERE s.id=$1::uuid AND s.id=COALESCE(g."frozenSnapshotId",g."snapshotId")`,[id])).rows[0];
      if(!s||(actor.role==="patient"?member.userId!==s.patientId:actor.role!=="doctor"||member.userId!==s.doctorId))recordsDenied(403,"RECORDS_SNAPSHOT_ACCESS_DENIED");
      await medicalConsent(pool,s.patientId,s.appointmentId);
      const payload=unprotectPayload<Record<string,unknown>>(config.keyring,payloadBinding(s.patientId,s.id,"snapshot.v1"),s.protectedPayload);
      const frozen=(await pool.query<{protectedPayload:unknown}>(`SELECT "protectedPayload" FROM records_episode_freezes WHERE "appointmentId"=$1 AND "snapshotId"=$2::uuid`,[s.appointmentId,s.id])).rows[0];
      return{snapshotId:s.id,appointmentId:s.appointmentId,capturedAt:s.capturedAt.toISOString(),payload:{...payload,...(frozen?unprotectPayload<Record<string,unknown>>(config.keyring,payloadBinding(s.patientId,s.appointmentId,"freeze.v1"),frozen.protectedPayload):{})}};
    },
    async prepareDocument(actor:Actor,meta:AppointmentCommand,body:unknown){const input=documentPrepare.parse(body);const data=input.kind==="prescription"?prescriptionData.parse(input.data):certificateData.parse(input.data);
      return mutate(actor,"document.prepare",input.appointmentId??input.patientId??input.patientAuthId!,meta,{...input,data},async tx=>{
        await workflowLock(tx,input.workflowId);
        const doctor=await membership(tx,actor,"doctor");
        const resolved=input.patientId??(await tx.query<{userId:string}>('SELECT "userId" FROM vital_patients WHERE "authId"=$1',[input.patientAuthId])).rows[0]?.userId;
        if(!resolved)recordsDenied(404,'RECORDS_PATIENT_NOT_FOUND');
        const p=await patient(tx,resolved,true);if(!p.ehrPatientId)recordsDenied(409,"RECORDS_EHR_LINK_REQUIRED");
        let associationVersion:number|null=null,ehrCaseId:string|null=null;
        if(input.appointmentId){const row=await lockAppointment(tx,input.appointmentId);if(row.patientId!==p.userId||row.version!==input.expectedVersion)recordsDenied(409,"RECORDS_APPOINTMENT_MISMATCH");await eligibility(tx,actor,row);associationVersion=row.associationVersion;ehrCaseId=row.ehrCaseId;}
        else {if(input.patientAuthId?input.expectedVersion!==0:p.version!==input.expectedVersion)recordsDenied(409,"RECORDS_PROFILE_VERSION_CHANGED");await medicalConsent(tx,p.userId);}
        // Auth-ID callers prepare a new aggregate at version zero; Core captures
        // the actual Profile revision so commit still detects identity changes.
        const expectedVersion=!input.appointmentId&&input.patientAuthId?p.version:input.expectedVersion;
        return saveWorkflow(tx,actor,meta,{...input,expectedVersion,patientId:p.userId,doctorId:doctor.userId,associationVersion,ehrPatientId:p.ehrPatientId,ehrCaseId,inputHash:clinicalHash(data),recovery:false});
      });},
    async issueDocument(actor:Actor,meta:AppointmentCommand,body:unknown){
      const input=z.object({workflowId:z.uuid(),inputHash:z.string().regex(/^[a-f0-9]{64}$/),data:z.unknown(),receipt:z.string().min(1).max(8192)}).strict().parse(body);
      requireScope(actor,"records.document.issue",input.workflowId);await membership(pool,actor,"doctor");const prior=await workflow(pool,actor,input.workflowId);
      const data=prior.kind==="prescription"?prescriptionData.parse(input.data):prior.kind==="medical-certificate"?certificateData.parse(input.data):recordsDenied(409,"RECORDS_WORKFLOW_KIND_INVALID");
      const p=await patient(pool,prior.patientId);const parties=prior.state==='committed'?null:await config.parties(p.authId,actor.authId,prior.doctorId);
      return mutate(actor,"document.issue",input.workflowId,meta,{workflowId:input.workflowId,inputHash:input.inputHash,data,receiptHash:clinicalHash(input.receipt)},async tx=>{
        await workflowLock(tx,input.workflowId);
        const w=await workflow(tx,actor,input.workflowId,true);if(w.inputHash!==input.inputHash||clinicalHash(data)!==w.inputHash)recordsDenied(409,"RECORDS_WORKFLOW_CONFLICT");
        if(w.state==="committed"){const saved=(await tx.query('SELECT id,kind,"assetId","accessCode" FROM records_documents WHERE id=$1::uuid',[w.resourceId])).rows[0];if(!saved)recordsDenied(503,"RECORDS_OPERATION_UNAVAILABLE");return{...saved,operationId:w.commitOperationId??meta.operationId,operationStatus:"pending"};}
        if(w.state!=="prepared"||w.expiresAt.getTime()<=clock())recordsDenied(409,"RECORDS_WORKFLOW_STALE");
        const current=await patient(tx,w.patientId,true);if(current.ehrPatientId!==w.ehrPatientId)recordsDenied(409,"RECORDS_EHR_LINK_CHANGED");
        if(!w.appointmentId&&current.version!==w.expectedVersion)recordsDenied(409,'RECORDS_PROFILE_VERSION_CHANGED');
        const evidence=verifyEhrEvidence(input.receipt,config.evidence,{kind:"treatment",workflowId:w.id,actorAuthId:actor.authId,patientId:w.ehrPatientId,caseId:w.ehrCaseId,payloadHash:w.inputHash},Math.floor(clock()/1000));
        let appointmentId=w.appointmentId;let appointment:AppointmentRow|null=null;
        if(!appointmentId){
          // Omitting the browser appointment ID cannot hide a VITAL-linked case.
          const linked=(await tx.query<{id:string}>('SELECT id FROM appointments WHERE "ehrCaseId"=$1',[evidence.claims.caseId])).rows[0];
          const ref=evidence.claims.externalSystemRef;
          if(ref?.startsWith("vital:appointment:"))appointmentId=z.uuid().parse(ref.slice("vital:appointment:".length));
          else if(ref?.startsWith("vital:"))recordsDenied(409,"RECORDS_VITAL_CASE_REFERENCE_INVALID");
          if(linked){if(appointmentId&&appointmentId!==linked.id){const historic=await readAppointment(tx,appointmentId);if(historic.billingLineageId!==(await readAppointment(tx,linked.id)).billingLineageId)recordsDenied(409,"RECORDS_EHR_CASE_MISMATCH");}appointmentId=linked.id;}
          if(!appointmentId&&current.version!==w.expectedVersion)recordsDenied(409,"RECORDS_PROFILE_VERSION_CHANGED");
        }
        if(appointmentId){const row=await lockAppointment(tx,appointmentId);appointment=row;if(row.patientId!==w.patientId||row.doctorId!==w.doctorId||row.ehrCaseId!==evidence.claims.caseId)recordsDenied(409,"RECORDS_EHR_CASE_MISMATCH");
          if(w.appointmentId&&(row.version!==w.expectedVersion||row.associationVersion!==w.associationVersion))recordsDenied(409,"RECORDS_WORKFLOW_STALE");await eligibility(tx,actor,row);
        }else await medicalConsent(tx,w.patientId);
        const id=randomUUID(),assetId=randomUUID(),issuedAt=new Date(clock()),accessCode=(w.kind==="prescription"?"RX-":"MC-")+randomUUID().slice(0,8).toUpperCase();
        if(!parties)recordsDenied(503,'RECORDS_PARTIES_REQUIRED');
        const doctor=(await tx.query<{prcLicense:string|null}>(`SELECT "prc_license" AS "prcLicense" FROM vital_doctors WHERE "userId"=$1 AND "authId"=$2 FOR UPDATE`,[w.doctorId,actor.authId])).rows[0];
        if(!doctor||parties.doctorLicense!==(doctor.prcLicense??''))recordsDenied(409,'RECORDS_DOCTOR_PROFILE_CHANGED');
        const clinicalData=w.kind==='medical-certificate'&&!(data as {consultationDate?:string|null}).consultationDate&&appointment?
          {...data,consultationDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(appointment.scheduledAt)}:data;
        const canonical={...clinicalData,...parties,issuedAt:issuedAt.toISOString(),accessCode};const payload=protectPayload(config.keyring,payloadBinding(w.patientId,id,"document.v1"),canonical);
        const filePayload=protectPayload(config.keyring,payloadBinding(w.patientId,assetId,"file.v1"),{documentId:id});
        await tx.query(`INSERT INTO records_file_assets (id,"patientId","appointmentId",kind,version,state,"protectedPayload","objectKey","mimeType","byteLength","createdAt")
          VALUES($1,$2,$3,$4,0,'processing',$5::jsonb,$6,'application/pdf',0,$7)`,[assetId,w.patientId,appointmentId,w.kind,JSON.stringify(filePayload),"quarantine/records/"+assetId+".pdf",issuedAt]);
        await tx.query(`INSERT INTO records_documents (id,"patientId","doctorId","appointmentId",kind,"accessCode","protectedPayload","assetId","issuedAt") VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,[id,w.patientId,w.doctorId,appointmentId,w.kind,accessCode,JSON.stringify(payload),assetId,issuedAt]);
        await tx.query(`INSERT INTO record_operations (id,"resourceId","actorAuthId","patientId",kind,state,version,attempts,"nextAttemptAt","createdAt","updatedAt") VALUES($1,$2,$3,$4,'artifact','pending',0,0,NOW(),NOW(),NOW())`,[meta.operationId,assetId,actor.authId,w.patientId]);
        await tx.query(`UPDATE records_workflows SET state='committed',"resourceId"=$2,"receiptMetadata"=$3::jsonb,"commitOperationId"=$4,"updatedAt"=NOW() WHERE id=$1::uuid`,[w.id,id,JSON.stringify(evidence.metadata),meta.operationId]);
        await appendSqlOutbox(tx,{producer:"records",eventType:"vital.records.artifact.requested",aggregateId:assetId,aggregateVersion:0,correlationId:actor.correlationId,causationId:meta.operationId,data:{assetId,operationId:meta.operationId}});
        await audit(tx,actor,id,0,meta.operationId,"document_issued");return{id,kind:w.kind,assetId,operationId:meta.operationId,operationStatus:"pending",accessCode};
      });},
    async operations(actor:Actor,id:string){await owningRead(actor,"operation.read",id);
      const row=(await pool.query('SELECT id,"resourceId",state,version,"errorCode" FROM record_operations WHERE id=$1::uuid AND "actorAuthId"=$2',[z.uuid().parse(id),actor.authId])).rows[0];
      if(!row)recordsDenied(404,"RECORDS_OPERATION_NOT_FOUND");return{operationId:row.id,assetId:row.resourceId,operationStatus:row.state,version:row.version,errorCode:row.errorCode};
    },
    listPatients:collections.patients,
    async listDocuments(actor:Actor,query:unknown,integration=false){
      const filter=z.object({kind:z.enum(["prescription","medical-certificate"]).optional(),patientId:z.uuid().optional(),patientAuthId:z.uuid().optional(),doctorId:z.uuid().optional(),appointmentId:z.uuid().optional(),accessCode:z.string().max(64).optional(),dateFrom:z.iso.date().optional(),dateTo:z.iso.date().optional(),page:z.coerce.number().int().min(1).max(100000).default(1),limit:z.coerce.number().int().min(1).max(100).default(20)}).strict().refine(v=>!v.dateFrom||!v.dateTo||v.dateFrom<=v.dateTo).parse(query);
      let patientId=filter.patientId??null,doctorId=filter.doctorId??null;
      if(!integration){const member=await owningRead(actor,"documents.read",actor.authId);if(actor.role==='patient'){if(patientId&&patientId!==member.userId||filter.patientAuthId&&filter.patientAuthId!==actor.authId)recordsDenied(403,"RECORDS_PATIENT_DENIED");patientId=member.userId;}
        else if(actor.role==='doctor'){if(doctorId&&doctorId!==member.userId)recordsDenied(403,"RECORDS_DOCTOR_DENIED");doctorId=member.userId;}else recordsDenied(403,"RECORDS_READER_DENIED");}
      else requireScope(actor,"records.integration.read","records:integration");
      if(filter.patientAuthId){const target=(await pool.query<{userId:string}>('SELECT "userId" FROM vital_patients WHERE "authId"=$1',[filter.patientAuthId])).rows[0];if(!target)return{items:[],total:0,page:filter.page,limit:filter.limit};if(patientId&&patientId!==target.userId)recordsDenied(400,"RECORDS_PATIENT_FILTER_CONFLICT");patientId=target.userId;}
      const where=` WHERE ($1::text IS NULL OR d."patientId"=$1) AND ($2::text IS NULL OR d."doctorId"=$2) AND ($3::text IS NULL OR d.kind=$3) AND ($4::text IS NULL OR d."appointmentId"=$4) AND ($5::text IS NULL OR d."accessCode"=$5)
        AND ($6::date IS NULL OR d."issuedAt">=($6::date::timestamp AT TIME ZONE 'Asia/Manila')) AND ($7::date IS NULL OR d."issuedAt"<(($7::date+1)::timestamp AT TIME ZONE 'Asia/Manila'))
        AND (NOT $8::boolean OR COALESCE((SELECT c.accepted FROM consent_records c WHERE c."patientId"=d."patientId" AND c."consentType"='medical_record'
          AND (c."appointmentId" IS NULL OR c."appointmentId"=d."appointmentId") ORDER BY c."consentedAt" DESC,c.id DESC LIMIT 1),FALSE))`;
      const args=[patientId,doctorId,filter.kind??null,filter.appointmentId??null,filter.accessCode??null,filter.dateFrom??null,filter.dateTo??null,!integration&&actor.role==='doctor'];
      const total=Number((await pool.query('SELECT COUNT(*)::int AS total FROM records_documents d'+where,args)).rows[0]?.total??0);
      const docs=(await pool.query<{id:string;patientId:string;doctorId:string;appointmentId:string|null;kind:string;assetId:string;accessCode:string;protectedPayload:unknown;issuedAt:Date;state:string;assetVersion:number}>(`SELECT d.*,a.state,a.version AS "assetVersion" FROM records_documents d JOIN records_file_assets a ON a.id=d."assetId"`+where+' ORDER BY d."issuedAt" DESC,d.id LIMIT $9 OFFSET $10',[...args,filter.limit,(filter.page-1)*filter.limit])).rows;
      return{items:docs.map(d=>{const data=unprotectPayload<Record<string,unknown>>(config.keyring,payloadBinding(d.patientId,d.id,"document.v1"),d.protectedPayload);const lines=data.lines as Array<Record<string,unknown>>|undefined,first=lines?.[0];return{id:d.id,patientId:d.patientId,doctorId:d.doctorId,appointmentId:d.appointmentId,kind:d.kind,type:d.kind,assetId:d.assetId,version:d.assetVersion,accessCode:d.accessCode,issuedAt:d.issuedAt.toISOString(),generatedAt:d.issuedAt.toISOString(),...data,
        medicationName:first?.medicineName??null,dosage:first?[first.dosageAmount,first.dosageUnit].join(' '):null,frequency:first?.frequency??null,medicineLines:lines??null,
        duration:first?.duration??null,specialInstructions:lines?.map(line=>line.instructions).filter(Boolean).join('\n')||null,
        validUntil:typeof data.validityLimit==='string'?data.validityLimit+'T00:00:00.000Z':null,prescriptionValidityLimit:data.validityLimit??null,
        doctorNameSnapshot:data.doctorName,doctorLicenseSnapshot:data.doctorLicense,filePath:null,processingState:d.state,operationStatus:d.state==='ready'?'completed':d.state};}),total,page:filter.page,limit:filter.limit};
    },
  };
}
