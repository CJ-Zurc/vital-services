import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool,PoolClient } from 'pg';
import { DomainError } from '../../contracts/actor.js';
import { appendSqlOutbox } from '../../infrastructure/outbox.js';
import type { AppointmentRow,ParticipantReceipt } from '../appointment/appointment-contracts.js';
import { selectionHash,videoSelection,type VideoAuthority,type VideoAssociations,type VideoPreparationReceipt,type VideoWorkflowIntent,type VideoSagaIntent } from './contracts.js';
import { validateMeetingUrl } from './links.js';

type Resource={id:string;appointmentId:string;doctorId:string;billingLineageId:string;associationVersion:number;version:number;provider:string;meetingUrl:string|null;normalizedMeetingUrl:string|null;meetingUrlHash:string|null;validationStatus:string;googleSpaceName:string|null;generationId:string|null;preparedWorkflowId:string|null;retiredAt:Date|null};
type WorkflowHold={workflowId:string;state:string;receipt:VideoPreparationReceipt;resourceId:string|null;resourceVersion:number|null};
type SagaHold={operationId:string;state:string;receipt:ParticipantReceipt;freezeToken:string;videoResourceId:string|null;videoResourceVersion:number|null};
function fail(code:string):never{throw new DomainError(409,'VIDEO_'+code,'Meeting association is unavailable.');}
export function createVideoAssociations(pool:Pool,authority:VideoAuthority,clock=Date.now):VideoAssociations{
  async function local<T>(lineage:string,run:(tx:PoolClient)=>Promise<T>){const tx=await pool.connect();try{await tx.query('BEGIN');await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['video-lineage:'+lineage]);const result=await run(tx);await tx.query('COMMIT');return result;}catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}}
  const resource=async(tx:Pick<PoolClient,'query'>,id:string)=>(await tx.query<Resource>('SELECT * FROM video_resources WHERE id=$1 FOR UPDATE',[id])).rows[0];
  const workflowHold=async(tx:Pick<PoolClient,'query'>,id:string)=>(await tx.query<WorkflowHold>('SELECT * FROM video_workflow_holds WHERE "workflowId"=$1 FOR UPDATE',[id])).rows[0];
  const sagaHold=async(tx:Pick<PoolClient,'query'>,id:string)=>(await tx.query<SagaHold>('SELECT * FROM video_association_holds WHERE "operationId"=$1 FOR UPDATE',[id])).rows[0];
  function workflowBinding(r:VideoPreparationReceipt,i:VideoWorkflowIntent){return r.workflowId===i.workflowId&&r.sourceAppointmentId===i.sourceAppointmentId&&r.targetAppointmentId===i.targetAppointmentId&&r.expectedSourceVersion===i.expectedSourceVersion&&r.expectedTargetVersion===i.expectedTargetVersion&&r.billingLineageId===i.billingLineageId&&r.associationVersion===i.associationVersion&&r.selectionHash===i.selectionHash;}
  function sagaBinding(r:ParticipantReceipt,i:VideoSagaIntent){return r.participant==='video'&&r.operationId===i.operationId&&r.sourceAppointmentId===i.sourceAppointmentId&&r.replacementAppointmentId===i.replacementAppointmentId&&r.expectedSourceVersion===i.expectedSourceVersion&&r.expectedReplacementVersion===i.expectedReplacementVersion&&r.billingLineageId===i.billingLineageId&&r.associationVersion===i.associationVersion&&r.requestHash===i.requestHash;}
  async function changed(tx:PoolClient,r:Resource,i:{correlationId:string},operationId:string,action:'association_finalized'|'association_transferred'){
    await appendSqlOutbox(tx,{producer:'video',eventType:'vital.video.resource.changed',aggregateId:r.id,aggregateVersion:r.version,correlationId:i.correlationId,causationId:operationId,
      data:{appointmentId:r.appointmentId,resourceId:r.id,billingLineageId:r.billingLineageId,associationVersion:r.associationVersion,operationId}});
    await appendSqlOutbox(tx,{producer:'video',eventType:'vital.audit.requested',aggregateId:r.id,aggregateVersion:r.version,correlationId:i.correlationId,causationId:operationId,
      data:{auditType:'vital.video.'+action,actorAuthId:null,resourceId:r.id,resourceType:'video'}});
  }
  async function abortWorkflow(id:string){const intent=await authority.workflow(id);if(intent.state!=='abandoned')fail('WORKFLOW_ABANDONMENT_REQUIRED');
    await local(intent.billingLineageId,async tx=>{const hold=await workflowHold(tx,id);if(!hold||hold.state==='aborted')return;if(hold.state==='finalized'||!workflowBinding(hold.receipt,intent))fail('WORKFLOW_CANNOT_ABORT');
      if(hold.resourceId){const r=await resource(tx,hold.resourceId);if(!r||r.preparedWorkflowId!==id||r.version!==hold.resourceVersion)fail('FROZEN_RESOURCE_CHANGED');
        await tx.query(`UPDATE google_meet_generations SET "reservedWorkflowId"=NULL WHERE id=$1 AND "reservedWorkflowId"=$2 AND "claimedAppointmentId" IS NULL`,[r.generationId,id]);
        await tx.query(`UPDATE video_resources SET "preparedWorkflowId"=NULL,"retiredAt"=NOW(),version=version+1,"updatedAt"=NOW() WHERE id=$1`,[r.id]);}
      await tx.query(`UPDATE video_workflow_holds SET state='aborted',"updatedAt"=NOW() WHERE "workflowId"=$1`,[id]);});}
  const participant={
    async prepare(id:string):Promise<ParticipantReceipt>{const intent=await authority.saga(id);return local(intent.billingLineageId,async tx=>{
      const old=await sagaHold(tx,id);if(old){if(old.state==='aborted'||!sagaBinding(old.receipt,intent))fail('SAGA_PREPARATION_CONFLICT');return old.receipt;}
      if(intent.state!=='preparing'||intent.pivotCommittedAt||intent.deadlineAt.getTime()<=clock()||intent.sourceConsultationType!==intent.replacementConsultationType)fail('SAGA_PREPARATION_INVALID');
      const conflict=await tx.query(`SELECT "operationId" FROM video_association_holds WHERE "billingLineageId"=$1 AND state='prepared'`,[intent.billingLineageId]);if(conflict.rows.length)fail('LINEAGE_ALREADY_FROZEN');
      const r=(await tx.query<Resource>('SELECT * FROM video_resources WHERE "appointmentId"=$1 FOR UPDATE',[intent.sourceAppointmentId])).rows[0];
      if(intent.sourceConsultationType==='virtual'&&(!r||r.retiredAt||r.preparedWorkflowId||r.doctorId!==intent.doctorId||r.billingLineageId!==intent.billingLineageId||r.associationVersion!==intent.associationVersion||r.validationStatus!=='validated'||!r.meetingUrl))fail('SOURCE_RESOURCE_REQUIRED');
      if(intent.sourceConsultationType==='in_person'&&r&&!r.retiredAt)fail('UNEXPECTED_MEETING_RESOURCE');
      const receipt:ParticipantReceipt={operationId:id,participant:'video',freezeToken:randomUUID(),requestHash:intent.requestHash,billingLineageId:intent.billingLineageId,associationVersion:intent.associationVersion,
        sourceAppointmentId:intent.sourceAppointmentId,replacementAppointmentId:intent.replacementAppointmentId,expectedSourceVersion:intent.expectedSourceVersion,expectedReplacementVersion:intent.expectedReplacementVersion,resourceId:r?.id??null,resourceVersion:r?.version??null};
      await tx.query(`INSERT INTO video_association_holds ("operationId","billingLineageId","sourceAppointmentId","replacementAppointmentId","requestHash","expectedSourceVersion","expectedReplacementVersion","associationVersion","videoResourceId","videoResourceVersion","freezeToken",state,receipt,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'prepared',$12::jsonb,$13,NOW(),NOW())`,[id,intent.billingLineageId,intent.sourceAppointmentId,intent.replacementAppointmentId,intent.requestHash,intent.expectedSourceVersion,intent.expectedReplacementVersion,intent.associationVersion,receipt.resourceId,receipt.resourceVersion,receipt.freezeToken,JSON.stringify(receipt),intent.deadlineAt]);return receipt;
    });},
    async abort(id:string,token?:string){const intent=await authority.saga(id);if(intent.pivotCommittedAt||intent.state!=='compensating')fail('SAGA_ABORT_INTENT_REQUIRED');await local(intent.billingLineageId,async tx=>{
      const hold=await sagaHold(tx,id);if(!hold)return;if(hold.state==='finalized'||token!==undefined&&token!==hold.freezeToken||!sagaBinding(hold.receipt,intent))fail('SAGA_FREEZE_RECEIPT_INVALID');
      if(hold.state==='aborted')return;await tx.query(`UPDATE video_association_holds SET state='aborted',"updatedAt"=NOW() WHERE "operationId"=$1`,[id]);});},
    async finalize(id:string,token:string){const intent=await authority.saga(id);if(!intent.pivotCommittedAt)fail('SAGA_PIVOT_REQUIRED');await local(intent.billingLineageId,async tx=>{
      const hold=await sagaHold(tx,id);if(!hold||hold.state==='aborted'||hold.freezeToken!==token||!sagaBinding(hold.receipt,intent)||!isDeepStrictEqual(intent.receipt,hold.receipt))fail('SAGA_FREEZE_RECEIPT_INVALID');if(hold.state==='finalized')return;
      if(hold.videoResourceId){const r=await resource(tx,hold.videoResourceId);if(!r||r.version!==hold.videoResourceVersion||r.appointmentId!==intent.sourceAppointmentId||r.associationVersion!==intent.associationVersion||r.preparedWorkflowId||r.retiredAt)fail('FROZEN_RESOURCE_CHANGED');
        const updated=(await tx.query<Resource>(`UPDATE video_resources SET "providerOriginAppointmentId"=COALESCE("providerOriginAppointmentId","appointmentId"),"appointmentId"=$2,"associationVersion"=$3,version=version+1,"updatedAt"=NOW() WHERE id=$1 RETURNING *`,[r.id,intent.replacementAppointmentId,intent.associationVersion+1])).rows[0]!;await changed(tx,updated,intent,id,'association_transferred');}
      await tx.query(`UPDATE video_association_holds SET state='finalized',"finalizedAt"=NOW(),"updatedAt"=NOW() WHERE "operationId"=$1`,[id]);});},
  };
  const api:VideoAssociations={
    participant,
    async prepareWorkflow(id,body){const selection=videoSelection.parse(body),intent=await authority.workflow(id);if(selectionHash(selection)!==intent.selectionHash)fail('SELECTION_BINDING_INVALID');
      return local(intent.billingLineageId,async tx=>{const old=await workflowHold(tx,id);if(old){if(old.state==='aborted'||!workflowBinding(old.receipt,intent))fail('WORKFLOW_PREPARATION_CONFLICT');return old.receipt;}
        if(intent.state!=='prepared'||intent.expiresAt.getTime()<=clock())fail('WORKFLOW_PREPARATION_EXPIRED');
        if(intent.consultationType==='virtual'?Boolean(selection.meetingUrl)===Boolean(selection.meetingGenerationId):Boolean(selection.meetingUrl||selection.meetingGenerationId))fail('SELECTION_REQUIRED');
        let r:Resource|undefined;
        if(intent.consultationType==='virtual'){
          let url=selection.meetingUrl??null,spaceName:string|null=null,generatedAt:Date|null=null;
          if(selection.meetingGenerationId){const generation=(await tx.query('SELECT * FROM google_meet_generations WHERE id=$1 FOR UPDATE',[selection.meetingGenerationId])).rows[0];
            if(!generation||generation.doctorId!==intent.doctorId||generation.appointmentId!==intent.sourceAppointmentId||generation.billingLineageId!==intent.quotaLineageId||generation.purpose!==(intent.kind==='approve'?'approval':'follow_up')||generation.status!=='ready'||generation.claimedAppointmentId||generation.reservedWorkflowId&&generation.reservedWorkflowId!==id||generation.expiresAt.getTime()<=clock()||!generation.spaceName||!generation.meetingUrl)fail('GENERATION_CLAIM_CONFLICT');
            const c=(await tx.query('SELECT status,revision FROM google_meet_connections WHERE id=$1 FOR UPDATE',[generation.connectionId])).rows[0];if(!c||c.status!=='connected'||c.revision!==generation.connectionRevision)fail('RECONNECT_REQUIRED');
            url=generation.meetingUrl;spaceName=generation.spaceName;generatedAt=generation.createdAt;
          }
          const validated=validateMeetingUrl('gmeet',url??'');if(!validated.valid||!validated.normalizedUrl||!validated.urlHash)fail('LINK_INVALID');
          const conflict=(await tx.query<Resource>('SELECT * FROM video_resources WHERE "meetingUrlHash"=$1 FOR UPDATE',[validated.urlHash])).rows[0];
          if(conflict&&conflict.appointmentId!==intent.targetAppointmentId&&(!conflict.retiredAt||conflict.doctorId!==intent.doctorId))fail('LINK_ALREADY_ASSOCIATED');
          const targetPrior=(await tx.query<Resource>('SELECT * FROM video_resources WHERE "appointmentId"=$1 FOR UPDATE',[intent.targetAppointmentId])).rows[0];if(targetPrior&&!targetPrior.retiredAt)fail('TARGET_RESOURCE_EXISTS');
          if(conflict&&targetPrior&&conflict.id!==targetPrior.id)fail('TARGET_RESOURCE_EXISTS');
          const prior=targetPrior??conflict;
          if(prior&&prior.doctorId!==intent.doctorId)fail('RESOURCE_OWNER_CHANGED');
          const resourceId=prior?.id??randomUUID(),version=prior?prior.version+1:0;
          if(prior){r=(await tx.query<Resource>(`UPDATE video_resources SET "appointmentId"=$2,"billingLineageId"=$3,"associationVersion"=$4,version=$5,"meetingUrl"=$6,"normalizedMeetingUrl"=$7,"meetingUrlHash"=$8,"googleSpaceName"=$9,"generationId"=$10,"linkGeneratedAt"=$11,"preparedWorkflowId"=$12,"retiredAt"=NULL,"linkSavedAt"=NULL,"updatedAt"=NOW() WHERE id=$1 AND "retiredAt" IS NOT NULL RETURNING *`,[resourceId,intent.targetAppointmentId,intent.billingLineageId,intent.associationVersion,version,url,validated.normalizedUrl,validated.urlHash,spaceName,selection.meetingGenerationId??null,generatedAt,id])).rows[0];if(!r)fail('FROZEN_RESOURCE_CHANGED');}
          else r=(await tx.query<Resource>(`INSERT INTO video_resources (id,"appointmentId","providerOriginAppointmentId","doctorId","billingLineageId","associationVersion",version,provider,"meetingUrl","normalizedMeetingUrl","meetingUrlHash","validationStatus","googleSpaceName","generationId","linkGeneratedAt","preparedWorkflowId","createdAt","updatedAt") VALUES($1,$2,$2,$3,$4,$5,$6,'gmeet',$7,$8,$9,'validated',$10,$11,$12,$13,NOW(),NOW()) RETURNING *`,[resourceId,intent.targetAppointmentId,intent.doctorId,intent.billingLineageId,intent.associationVersion,version,url,validated.normalizedUrl,validated.urlHash,spaceName,selection.meetingGenerationId??null,generatedAt,id])).rows[0]!;
          if(selection.meetingGenerationId){const reserved=await tx.query(`UPDATE google_meet_generations SET "reservedWorkflowId"=$2 WHERE id=$1 AND status='ready' AND "claimedAppointmentId" IS NULL AND ("reservedWorkflowId" IS NULL OR "reservedWorkflowId"=$2)`,[selection.meetingGenerationId,id]);if(reserved.rowCount!==1)fail('GENERATION_CLAIM_CONFLICT');}
        }
        const receipt:VideoPreparationReceipt={workflowId:id,sourceAppointmentId:intent.sourceAppointmentId,targetAppointmentId:intent.targetAppointmentId,expectedSourceVersion:intent.expectedSourceVersion,expectedTargetVersion:intent.expectedTargetVersion,billingLineageId:intent.billingLineageId,associationVersion:intent.associationVersion,selectionHash:intent.selectionHash,resourceId:r?.id??null,resourceVersion:r?.version??null,freezeToken:randomUUID()};
        await tx.query(`INSERT INTO video_workflow_holds ("workflowId","sourceAppointmentId","targetAppointmentId","doctorId","expectedSourceVersion","expectedTargetVersion","billingLineageId","associationVersion","selectionHash","resourceId","resourceVersion","freezeToken",state,receipt,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'prepared',$13::jsonb,$14,NOW(),NOW())`,[id,intent.sourceAppointmentId,intent.targetAppointmentId,intent.doctorId,intent.expectedSourceVersion,intent.expectedTargetVersion,intent.billingLineageId,intent.associationVersion,intent.selectionHash,receipt.resourceId,receipt.resourceVersion,receipt.freezeToken,JSON.stringify(receipt),intent.expiresAt]);return receipt;});},
    async finalizeWorkflow(id){const intent=await authority.workflow(id);if(intent.state!=='committed'||!intent.receipt)fail('WORKFLOW_COMMIT_REQUIRED');
      const receipt=await local(intent.billingLineageId,async tx=>{const hold=await workflowHold(tx,id);if(!hold||hold.state==='aborted'||!workflowBinding(hold.receipt,intent)||!isDeepStrictEqual(intent.receipt,hold.receipt))fail('WORKFLOW_RECEIPT_INVALID');
        if(hold.state==='finalized'||hold.state==='acknowledged')return hold.receipt;
        if(hold.resourceId){const r=await resource(tx,hold.resourceId);if(!r||r.preparedWorkflowId!==id||r.version!==hold.resourceVersion||r.appointmentId!==intent.targetAppointmentId)fail('FROZEN_RESOURCE_CHANGED');
          if(r.generationId){const claimed=await tx.query(`UPDATE google_meet_generations SET status='claimed',"claimedAppointmentId"=$3,"reservedWorkflowId"=NULL,version=version+1 WHERE id=$1 AND "reservedWorkflowId"=$2 AND status='ready' AND "claimedAppointmentId" IS NULL`,[r.generationId,id,intent.targetAppointmentId]);if(claimed.rowCount!==1)fail('GENERATION_CLAIM_CONFLICT');}
          const updated=(await tx.query<Resource>(`UPDATE video_resources SET "preparedWorkflowId"=NULL,"linkSavedAt"=$2,version=version+1,"updatedAt"=NOW() WHERE id=$1 RETURNING *`,[r.id,new Date(clock())])).rows[0]!;await changed(tx,updated,intent,id,'association_finalized');}
        await tx.query(`UPDATE video_workflow_holds SET state='finalized',"updatedAt"=NOW() WHERE "workflowId"=$1`,[id]);return hold.receipt;});
      await authority.completeWorkflow(id,receipt);
      await pool.query(`UPDATE video_workflow_holds SET state='acknowledged',"updatedAt"=NOW() WHERE "workflowId"=$1 AND state='finalized'`,[id]);return receipt;},
    async validate(row:AppointmentRow){await local(row.billingLineageId,async tx=>{
      const freeze=await tx.query(`SELECT "operationId" FROM video_association_holds WHERE "billingLineageId"=$1 AND state='prepared'`,[row.billingLineageId]);if(freeze.rows.length)fail('LINEAGE_ALREADY_FROZEN');
      const r=(await tx.query<Resource>('SELECT * FROM video_resources WHERE "appointmentId"=$1 FOR UPDATE',[row.id])).rows[0];
      if(r?.preparedWorkflowId){const i=await authority.workflow(r.preparedWorkflowId),hold=await workflowHold(tx,i.workflowId);if(i.state!=='prepared'||!hold||hold.state!=='prepared'||!workflowBinding(hold.receipt,i)||r.version!==hold.resourceVersion||row.version!==i.expectedTargetVersion)fail('WORKFLOW_PREPARATION_STALE');
        if(r.generationId){const generation=(await tx.query('SELECT * FROM google_meet_generations WHERE id=$1 FOR UPDATE',[r.generationId])).rows[0],c=generation?(await tx.query('SELECT status,revision FROM google_meet_connections WHERE id=$1 FOR UPDATE',[generation.connectionId])).rows[0]:null;
          if(!generation||generation.status!=='ready'||generation.reservedWorkflowId!==i.workflowId||generation.expiresAt.getTime()<=clock()||!c||c.status!=='connected'||c.revision!==generation.connectionRevision)fail('GENERATION_CLAIM_CONFLICT');}
      }
      if(row.consultationType==='virtual'){if(!r||r.retiredAt||r.doctorId!==row.doctorId||r.billingLineageId!==row.billingLineageId||r.associationVersion!==row.associationVersion||r.validationStatus!=='validated'||!r.meetingUrl)fail('RESOURCE_REQUIRED');
        if(r.preparedWorkflowId&&row.status!=='pending')fail('RESOURCE_NOT_FINALIZED');
      }else if(r&&!r.retiredAt)fail('UNEXPECTED_MEETING_RESOURCE');
      else if(row.status==='pending'){const holds=(await tx.query<WorkflowHold>(`SELECT * FROM video_workflow_holds WHERE "targetAppointmentId"=$1 AND state='prepared'`,[row.id])).rows;
        if(holds.length!==1)fail('NO_RESOURCE_RECEIPT_REQUIRED');const hold=holds[0]!,intent=await authority.workflow(hold.workflowId);if(intent.state!=='prepared'||hold.resourceId!==null||!workflowBinding(hold.receipt,intent))fail('NO_RESOURCE_RECEIPT_REQUIRED');}
    });},
    async recover(){let count=0;
      for(const id of await authority.expiredWorkflows())await authority.abandonExpiredWorkflow(id);
      const workflows=(await pool.query<{workflowId:string}>(`SELECT "workflowId" FROM video_workflow_holds WHERE state IN ('prepared','finalized') ORDER BY "updatedAt","workflowId" LIMIT 20`)).rows;
      for(const row of workflows){try{await authority.abandonExpiredWorkflow(row.workflowId);const intent=await authority.workflow(row.workflowId);if(intent.state==='committed'){await api.finalizeWorkflow(row.workflowId);count++;}else if(intent.state==='abandoned'){await abortWorkflow(row.workflowId);count++;}}catch{/* Keep ownership until authoritative recovery is possible. */}
        finally{await pool.query(`UPDATE video_workflow_holds SET "updatedAt"=NOW() WHERE "workflowId"=$1 AND state IN ('prepared','finalized')`,[row.workflowId]);}}
      const sagas=(await pool.query<{operationId:string;freezeToken:string}>(`SELECT "operationId","freezeToken" FROM video_association_holds WHERE state='prepared' ORDER BY "updatedAt","operationId" LIMIT 20`)).rows;
      for(const row of sagas){try{const intent=await authority.saga(row.operationId);if(intent.pivotCommittedAt){await participant.finalize(row.operationId,row.freezeToken);count++;}else if(intent.state==='compensating'){await participant.abort(row.operationId,row.freezeToken);count++;}}catch{/* Never release a hold from lease expiry alone. */}
        finally{await pool.query(`UPDATE video_association_holds SET "updatedAt"=NOW() WHERE "operationId"=$1 AND state='prepared'`,[row.operationId]);}}return count;},
  };return api;
}
