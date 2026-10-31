import { accessRow,knownReviewIdentities } from '../appointment/appointment-access.js';
import { restrictedBrief } from '../appointment/appointment-summary.js';
import { appointmentPayloadCrypto } from '../appointment/access-crypto.js';
import { reviewText } from '../appointment/review-sanitizer.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool,PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError,requireScope,type Actor } from '../../contracts/actor.js';
import { hasCurrentNormalization,confirmationSchema,intakePayloadSchema,intelligenceEnabled,patientIntelligenceEnabled,sessionSchema,type Concept } from './contracts.js';
import { intakeCrypto } from './crypto.js';
import { intakeBrief } from './summary.js';
export const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=(status:number,code:string):never=>{throw new DomainError(status,code,'The intake operation could not be completed.');};
const draftInput=z.object({chiefComplaint:z.string().max(2000).nullable().optional(),primarySymptom:z.object({id:z.string().max(96).nullable(),name:z.string().max(200)}).strict(),opqrst:z.record(z.string(),z.unknown())}).strict();
type Draft={id:string;version:number;payload:unknown;analysis:unknown;confirmation:unknown;expiresAt:Date;confirmedAt:Date|null;ageYears:number|null;sandbox:boolean};
export type IntelligenceModule=ReturnType<typeof createIntelligence>;
export function createIntelligence(pool:Pool,environment:NodeJS.ProcessEnv=process.env){
  const crypto=intakeCrypto(environment);
  async function authority(actor:Actor,action:string,sandbox=false){
    if(!intelligenceEnabled(environment))fail(503,'AI_DISABLED');
    requireScope(actor,'ai.'+action,actor.authId);
    if(sandbox){if(environment.VITAL_AI_SANDBOX_ENABLED!=='true'||!['doctor','admin'].includes(actor.role))fail(403,'AI_SANDBOX_DENIED');}
    else if(actor.role!=='patient'||!patientIntelligenceEnabled(environment))fail(403,'AI_PATIENT_DISABLED');
    const table=actor.role==='admin'?'vital_admins':actor.role==='doctor'?'vital_doctors':'vital_patients';
    if(!(await pool.query(`SELECT 1 FROM ${table} WHERE "authId"=$1`,[actor.authId])).rowCount)fail(403,'AI_MEMBERSHIP_REQUIRED');
  }
  function session(raw:unknown){const s=sessionSchema.parse(raw);if(Date.parse(s.expiresAt)<=Date.now()||Date.parse(s.expiresAt)>Date.now()+86400000)fail(401,'AI_SESSION_EXPIRED');return s;}
  async function draft(db:Pool|PoolClient,actor:Actor,binding:string,lock=false){
    const row=(await db.query<Draft>('SELECT * FROM ai_intake_drafts WHERE "patientAuthId"=$1 AND "sessionBinding"=$2 AND "expiresAt">NOW()'+(lock?' FOR UPDATE':''),[actor.authId,binding])).rows[0];
    if(!row)throw new DomainError(404,'AI_DRAFT_NOT_FOUND','Draft not found.');return row;
  }
  function view(row:Draft){const analysis=row.analysis?crypto.decrypt(row.analysis,row.id):null;return{id:row.id,version:row.version,payload:crypto.decrypt(row.payload,row.id),
    analysis:hasCurrentNormalization(analysis)?analysis:null,reanalysisRequired:Boolean(analysis&&!hasCurrentNormalization(analysis)),confirmation:row.confirmation?crypto.decrypt(row.confirmation,row.id):null,
    confirmedAt:row.confirmedAt,expiresAt:row.expiresAt,...(row.sandbox?{syntheticAge:row.ageYears}:{})};}
  async function transaction<T>(fn:(db:PoolClient)=>Promise<T>){const db=await pool.connect();try{await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
  return{
    async execute(actor:Actor,action:string,raw:unknown){
      if(action==='intakes/recommendations')fail(410,'AI_RECOMMENDATIONS_RETIRED');
      const input=z.record(z.string(),z.unknown()).parse(raw);const sandbox=input.sandbox===true;
      if(action.startsWith('admin/')){
        requireScope(actor,'ai.admin',actor.authId);
        if(!intelligenceEnabled(environment)||actor.role!=='admin'||!(await pool.query('SELECT 1 FROM vital_admins WHERE "authId"=$1',[actor.authId])).rowCount)fail(403,'AI_ADMIN_DENIED');
        if(environment.VITAL_AI_ANALYTICS_ENABLED!=='true')fail(503,'AI_ANALYTICS_DISABLED');
        if(action==='admin/dashboard')return dashboard(pool,input);
        if(action==='admin/refresh'){await pool.query("UPDATE ai_jobs SET status='pending',attempts=0,\"availableAt\"=NOW() WHERE kind='submission' AND status='failed' AND \"resourceId\" IN (SELECT id::text FROM ai_submissions WHERE \"expiresAt\">NOW())");await pool.query("INSERT INTO ai_jobs(id,kind,\"resourceId\",\"sourceVersion\") VALUES($1,'clusters','refresh',$2) ON CONFLICT DO NOTHING",[randomUUID(),Math.floor(Date.now()/60000)]);return{status:'queued'};}
        if(action==='admin/clusters/label'){
          const v=z.object({versionId:z.string().max(96),clusterId:z.string().max(96),label:z.string().trim().min(1).max(600)}).strict().parse(raw);
          // Labels describe features only; never accept disease/outbreak claims as cluster labels.
          if(/diagnos|outbreak|epidemic|disease/i.test(v.label))fail(400,'AI_CLUSTER_LABEL_INVALID');
          const version=(await pool.query('SELECT payload FROM ai_cluster_versions WHERE id=$1',[v.versionId])).rows[0];
          const cluster=version?.payload?.clusters?.find((c:{id:string})=>c.id===v.clusterId);if(!cluster)fail(404,'AI_CLUSTER_NOT_FOUND');if(v.label!==cluster.suggestedLabel)fail(400,'AI_CLUSTER_LABEL_INVALID');
          await pool.query('INSERT INTO ai_cluster_labels("versionId","clusterId",label,"reviewerAuthId") VALUES($1,$2,$3,$4) ON CONFLICT("versionId","clusterId") DO UPDATE SET label=EXCLUDED.label,"reviewerAuthId"=EXCLUDED."reviewerAuthId","reviewedAt"=NOW()',[v.versionId,v.clusterId,v.label,actor.authId]);return{status:'reviewed'};
        }
        fail(404,'AI_ACTION_UNKNOWN');
      }
      if(action==='brief/read'||action==='brief/approve'){
        const v=z.object({appointmentId:z.uuid(),expectedVersion:z.number().int().nonnegative().optional(),text:z.string().trim().min(1).max(2000).optional()}).strict().parse(raw);
        requireScope(actor,'ai.brief',v.appointmentId);
        if(actor.role!=='doctor')fail(403,'AI_BRIEF_DENIED');
        return transaction(async db=>{
          const a=(await db.query('SELECT a.version,a.status,a."paperworkLockedAt",a."doctorConfirmedAt",d."authId",pc."aiSubmissionId" FROM appointments a JOIN vital_doctors d ON d."userId"=a."doctorId" JOIN vital_users u ON u.id=d."userId" AND u."authId"=d."authId" AND u.role=\'doctor\' JOIN pre_consultations pc ON pc."appointmentId"=a.id WHERE a.id=$1 FOR UPDATE OF a',[v.appointmentId])).rows[0];
          if(!a||a.authId!==actor.authId||!['pending','approved','confirmed'].includes(a.status)||a.paperworkLockedAt||a.doctorConfirmedAt)fail(403,'AI_BRIEF_DENIED');
          const access=await accessRow(db,v.appointmentId);if(!access||access.revokedAt)fail(403,'AI_BRIEF_DENIED');
          const s=(await db.query('SELECT * FROM appointment_intake_briefs WHERE "appointmentId"=$1 FOR UPDATE',[v.appointmentId])).rows[0];if(!s)fail(404,'AI_SUBMISSION_NOT_FOUND');
          const content=appointmentPayloadCrypto(environment).decrypt(s.summary,'appointment-brief:'+v.appointmentId) as {brief:string;payload:ReturnType<typeof intakePayloadSchema.parse>;concepts:Concept[]};
          if(action==='brief/read')return{version:a.version,intakeVersion:s.intakeVersion,brief:restrictedBrief(content.payload,content.concepts,await knownReviewIdentities(db,v.appointmentId)),approved:s.approvedHash===s.sourceHash,approvedText:s.approvedText?reviewText(s.approvedText).text:null};
          if(v.expectedVersion!==a.version||!v.text||!['pending','approved','confirmed'].includes(a.status)||a.paperworkLockedAt||a.doctorConfirmedAt)fail(409,'AI_BRIEF_STALE');
          if((await db.query("SELECT 1 FROM appointment_workflows WHERE \"appointmentId\"=$1 AND state='prepared'",[v.appointmentId])).rowCount)fail(409,'APPOINTMENT_PROCESSING');
          await db.query('UPDATE appointment_intake_briefs SET "approvedText"=$2,"approvedBy"=$3,"approvedAt"=NOW(),"approvedHash"="sourceHash" WHERE "appointmentId"=$1',[v.appointmentId,v.text,actor.authId]);
          return{status:'approved',intakeVersion:s.intakeVersion};
        });
      }
      if(action==='intakes/lease'){
        requireScope(actor,'ai.intakes/lease',actor.authId);const lease=session(input.session);
        await pool.query('UPDATE ai_intake_drafts SET "expiresAt"=$3 WHERE "patientAuthId"=$1 AND "sessionBinding"=$2 AND "expiresAt">NOW()',[actor.authId,lease.binding,lease.expiresAt]);return{renewed:true};
      }
      if(action==='intakes/delete'){
        requireScope(actor,'ai.intakes/delete',actor.authId);const binding=sessionSchema.parse(input.session).binding;
        return transaction(async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[actor.authId+':'+binding]);
          await db.query('INSERT INTO ai_intake_sessions("patientAuthId","sessionBinding","expiresAt") VALUES($1,$2,NOW()+INTERVAL \'24 hours\') ON CONFLICT("patientAuthId","sessionBinding") DO UPDATE SET "expiresAt"=EXCLUDED."expiresAt"',[actor.authId,binding]);
          await db.query('DELETE FROM ai_intake_drafts WHERE "patientAuthId"=$1 AND "sessionBinding"=$2',[actor.authId,binding]);return{deleted:true};});
      }
      await authority(actor,action,sandbox);
      if(action==='catalog'){
        const q=z.string().max(100).parse(input.query??'').toLowerCase();
        const catalog=z.array(z.object({id:z.string(),name:z.string()})).parse(JSON.parse(readFileSync(environment.VITAL_AI_CATALOG_FILE??'/app/assets/ai/symptoms.json','utf8')));
        return{items:catalog.filter(c=>Boolean(c.id.trim()&&c.name.trim())&&(!q||c.name.toLowerCase().includes(q))).slice(0,40)};
      }
      const s=session(input.session);
      if(action==='intakes/delete'){await pool.query('DELETE FROM ai_intake_drafts WHERE "patientAuthId"=$1 AND "sessionBinding"=$2',[actor.authId,s.binding]);return{deleted:true};}
      if(action==='intakes/read'){const row=await draft(pool,actor,s.binding);return view(row);}
      if(action==='intakes/save'){
        const v=z.object({session:sessionSchema,sandbox:z.boolean().optional(),expectedVersion:z.number().int().nonnegative().nullable(),payload:draftInput,ageYears:z.number().int().min(0).max(150).nullable()}).strict().parse(input);
        return transaction(async db=>{
          await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[actor.authId+':'+s.binding]);
          if((await db.query('SELECT 1 FROM ai_intake_sessions WHERE "patientAuthId"=$1 AND "sessionBinding"=$2 AND "expiresAt">NOW()',[actor.authId,s.binding])).rowCount)fail(401,'AI_SESSION_REVOKED');
          await db.query('DELETE FROM ai_intake_drafts WHERE "patientAuthId"=$1 AND "sessionBinding"=$2 AND "expiresAt"<=NOW()',[actor.authId,s.binding]);
          const row=(await db.query<Draft>('SELECT * FROM ai_intake_drafts WHERE "patientAuthId"=$1 AND "sessionBinding"=$2 FOR UPDATE',[actor.authId,s.binding])).rows[0];
          if(row&&row.version!==v.expectedVersion||!row&&v.expectedVersion!==null)fail(409,'AI_DRAFT_VERSION_CHANGED');
          const id=row?.id??randomUUID(),version=row?row.version+1:0;
          await db.query('INSERT INTO ai_intake_drafts(id,"patientAuthId","sessionBinding",payload,"expiresAt",version,"ageYears",sandbox) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT("patientAuthId","sessionBinding") DO UPDATE SET payload=EXCLUDED.payload,version=EXCLUDED.version,"expiresAt"=EXCLUDED."expiresAt","ageYears"=EXCLUDED."ageYears",analysis=NULL,confirmation=NULL,"confirmedAt"=NULL,"updatedAt"=NOW()',
            [id,actor.authId,s.binding,JSON.stringify(crypto.encrypt(v.payload,id)),s.expiresAt,version,v.ageYears,sandbox]);
          return view(await draft(db,actor,s.binding));
        });
      }
      if(action==='intakes/analyze')return transaction(async db=>{
        const row=await draft(db,actor,s.binding,true);if(row.version!==input.expectedVersion)fail(409,'AI_DRAFT_VERSION_CHANGED');intakePayloadSchema.parse(crypto.decrypt(row.payload,row.id));
        if(row.analysis&&!hasCurrentNormalization(crypto.decrypt(row.analysis,row.id)))await db.query('UPDATE ai_intake_drafts SET analysis=NULL WHERE id=$1',[row.id]);
        const id=randomUUID();const job=(await db.query(`INSERT INTO ai_jobs(id,kind,"resourceId","sourceVersion") VALUES($1,'interactive',$2,$3)
          ON CONFLICT(kind,"resourceId","sourceVersion") DO UPDATE SET
          attempts=CASE WHEN ai_jobs.status IN ('completed','failed','stale') THEN 0 ELSE ai_jobs.attempts END,
          "availableAt"=CASE WHEN ai_jobs.status IN ('completed','failed','stale') THEN NOW() ELSE ai_jobs."availableAt" END,
          "createdAt"=CASE WHEN ai_jobs.status IN ('completed','failed','stale') THEN NOW() ELSE ai_jobs."createdAt" END,
          "completedAt"=CASE WHEN ai_jobs.status IN ('completed','failed','stale') THEN NULL ELSE ai_jobs."completedAt" END,
          "errorCode"=CASE WHEN ai_jobs.status IN ('completed','failed','stale') THEN NULL ELSE ai_jobs."errorCode" END,
          "leaseOwner"=CASE WHEN ai_jobs.status IN ('completed','failed','stale') THEN NULL ELSE ai_jobs."leaseOwner" END,
          "leaseUntil"=CASE WHEN ai_jobs.status IN ('completed','failed','stale') THEN NULL ELSE ai_jobs."leaseUntil" END,
          status=CASE WHEN ai_jobs.status IN ('completed','failed','stale') THEN 'pending' ELSE ai_jobs.status END
          RETURNING id,status`,[id,row.id,row.version])).rows[0];return{jobId:job.id,status:job.status,draftVersion:row.version};
      });
      if(action==='intakes/status'){
        const row=await draft(pool,actor,s.binding);const job=(await pool.query('SELECT id,status,"errorCode","createdAt" FROM ai_jobs WHERE kind=\'interactive\' AND "resourceId"=$1 AND "sourceVersion"=$2',[row.id,row.version])).rows[0];
        return{...view(row),job:job??null,manualContinuation:job&&Date.now()-new Date(job.createdAt).getTime()>60000};
      }
      if(action==='intakes/confirm')return transaction(async db=>{
        const v=confirmationSchema.parse({expectedVersion:input.expectedVersion,concepts:input.concepts}),row=await draft(db,actor,s.binding,true);
        if(row.version!==v.expectedVersion)fail(409,'AI_DRAFT_VERSION_CHANGED');const payload=intakePayloadSchema.parse(crypto.decrypt(row.payload,row.id));
        // Corrections select catalog concepts; arbitrary IDs cannot become normalized symptoms.
        const catalog=z.array(z.object({id:z.string(),name:z.string()})).parse(JSON.parse(readFileSync(environment.VITAL_AI_CATALOG_FILE??'/app/assets/ai/symptoms.json','utf8')));
        for(const c of v.concepts)if(!catalog.some(x=>x.id===c.id&&x.name===c.name))fail(400,'AI_CONCEPT_INVALID');
        await db.query('UPDATE ai_intake_drafts SET confirmation=$2,"confirmedAt"=NOW(),"expiresAt"=$3 WHERE id=$1',[row.id,JSON.stringify(crypto.encrypt(v.concepts,row.id)),s.expiresAt]);
        return{...view(await draft(db,actor,s.binding)),brief:intakeBrief(payload,v.concepts)};
      });
      fail(404,'AI_ACTION_UNKNOWN');
    },
    pool,crypto,environment,
  };
}

export const safeCount=(n:number)=>n>0&&n<5?null:n;
export async function dashboard(pool:Pool,input:Record<string,unknown>){
  const today=new Date().toISOString().slice(0,10),start=z.iso.date().parse(input.from??new Date(Date.now()-29*86400000).toISOString().slice(0,10)),end=z.iso.date().parse(input.to??today);
  if(start>end||(Date.parse(end)-Date.parse(start))/86400000>365)fail(400,'AI_RANGE_INVALID');
  const rows=(await pool.query('SELECT "reportDate"::text AS date,status,features FROM ai_submissions WHERE "reportDate" BETWEEN $1 AND $2 AND "expiresAt">NOW() AND NOT synthetic',[start,end])).rows;
  const symptoms=new Map<string,{id:string;name:string;count:number}>(),days=new Map<string,{submissions:number;analyzed:number}>();let analyzed=0,failed=0,noPositive=0;
  for(const r of rows){const d=days.get(r.date)??{submissions:0,analyzed:0};d.submissions++;days.set(r.date,d);if(r.status==='failed')failed++;if(r.status!=='completed')continue;analyzed++;d.analyzed++;
    const list=r.features?.symptoms??[];if(!list.length)noPositive++;for(const c of list){const item=symptoms.get(c.id)??{id:c.id,name:c.name,count:0};item.count++;symptoms.set(c.id,item);}}
  const denominator=safeCount(analyzed);const cluster=(await pool.query('SELECT id,payload FROM ai_cluster_versions WHERE "expiresAt">NOW() ORDER BY "createdAt" DESC LIMIT 1')).rows[0];
  const labels=cluster?(await pool.query('SELECT "clusterId",label FROM ai_cluster_labels WHERE "versionId"=$1',[cluster.id])).rows:[];
  return{contractVersion:2,range:{from:start,to:end},population:'reported booking complaints; latest reviewed information',suppressionThreshold:5,
    totals:{submissions:safeCount(rows.length),analyzed:denominator,failed:safeCount(failed),noPositive:safeCount(noPositive),coverage:denominator!==null&&safeCount(rows.length)!==null&&rows.length?analyzed/rows.length:null},
    symptoms:[...symptoms.values()].sort((a,b)=>b.count-a.count||a.id.localeCompare(b.id)).map(c=>({...c,count:safeCount(c.count),percentage:safeCount(c.count)!==null&&denominator?c.count/denominator:null})),
    daily:[...days].sort(([a],[b])=>a.localeCompare(b)).map(([date,d])=>({date,submissions:safeCount(d.submissions),analyzed:safeCount(d.analyzed)})),
    clusters:cluster?{version:cluster.id,featureVersion:cluster.payload.featureVersion,boundedSnapshot:true,windowDays:90,capPerCohort:2000,cohorts:cluster.payload.cohorts.map((c:{cohort:string;status:string;count:number;noise:number})=>({...c,count:safeCount(c.count),noise:safeCount(c.noise)})),clusters:cluster.payload.clusters.map((c:{id:string;count:number;suggestedLabel:string})=>({id:c.id,count:safeCount(c.count),suggestedLabel:c.count>=5?c.suggestedLabel:null,label:labels.find(l=>l.clusterId===c.id)?.label??'Awaiting staff label review'}))}:null};
}
