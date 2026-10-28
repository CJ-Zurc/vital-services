import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { analysisSchema,hasCurrentNormalization,intakePayloadSchema,type Concept,FEATURE_VERSION } from './contracts.js';
import { createIntelligence,hash } from './module.js';
export function derivedFeatures(payload:ReturnType<typeof intakePayloadSchema.parse>,concepts:Concept[],age:number|null){
  const denied=new Set(concepts.filter(c=>c.assertion==='denied').map(c=>c.id));
  const x=payload.opqrst,unique=new Map(concepts.filter(c=>c.assertion==='present'&&!denied.has(c.id)).map(c=>[c.id,{id:c.id,name:c.name}]));
  return{version:FEATURE_VERSION,symptoms:[...unique.values()].sort((a,b)=>a.id.localeCompare(b.id)),cohort:age===null?null:age<18?'pediatric':'adult',
    region:x.symptomLocation.kind==='BODY_MAP'?String(x.symptomLocation.partId):x.symptomLocation.kind==='GENERALIZED'?'GENERALIZED':null,
    quality:x.symptomQuality.filter(q=>q!=='Other'),onset:x.onsetType,timing:x.timingPattern,severity:x.severity};
}
export function intelligenceWorker(pool:Pool,environment:NodeJS.ProcessEnv=process.env,fetcher:typeof fetch=fetch){
  const module=createIntelligence(pool,environment);
  async function runtime(path:string,payload:unknown){
    const url=new URL(environment.VITAL_AI_RUNTIME_URL??'http://vital-ai-runtime:8020');
    if(url.protocol!=='http:'||url.hostname!=='vital-ai-runtime'||url.port!=='8020'||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw Error('AI_RUNTIME_ORIGIN_INVALID');
    const key=environment.VITAL_AI_RUNTIME_KEY;if(!key||key.length<32)throw Error('AI_RUNTIME_KEY_REQUIRED');
    const response=await fetcher(new URL(path,url),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(125000)});
    if(response.status===429)throw Error('AI_CAPACITY_BUSY');if(!response.ok)throw Error('AI_RUNTIME_UNAVAILABLE');const text=await response.text();if(text.length>4*1024*1024)throw Error('AI_RUNTIME_RESPONSE_LIMIT');return JSON.parse(text);
  }
  return{
    async maintenance(){
      await pool.query('DELETE FROM ai_intake_sessions WHERE "expiresAt"<=NOW()');
      await pool.query('DELETE FROM ai_jobs WHERE kind=\'interactive\' AND "resourceId" IN (SELECT id::text FROM ai_intake_drafts WHERE "expiresAt"<=NOW())');
      await pool.query('DELETE FROM ai_intake_drafts WHERE "expiresAt"<=NOW()');
      await pool.query('UPDATE pre_consultations SET "aiSubmissionId"=NULL WHERE "aiSubmissionId" IN (SELECT id FROM ai_submissions WHERE "expiresAt"<=NOW())');
      await pool.query('DELETE FROM ai_submissions WHERE "expiresAt"<=NOW()');await pool.query('DELETE FROM ai_daily_aggregates WHERE "expiresAt"<=NOW()');await pool.query('DELETE FROM ai_cluster_versions WHERE "expiresAt"<=NOW()');
      await pool.query("DELETE FROM ai_jobs WHERE \"createdAt\"<NOW()-INTERVAL '30 days' AND status IN ('completed','failed','stale')");
      if(environment.VITAL_AI_ANALYTICS_ENABLED==='true')await pool.query("INSERT INTO ai_settings(id) VALUES('symptom-analytics') ON CONFLICT DO NOTHING");
      const date=(await pool.query("SELECT (NOW() AT TIME ZONE 'Asia/Manila')::date::text AS date,EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Manila') AS hour")).rows[0];
      if(environment.VITAL_AI_ANALYTICS_ENABLED==='true'&&Number(date.hour)>=2)await pool.query("INSERT INTO ai_jobs(id,kind,\"resourceId\",\"sourceVersion\") VALUES($1,'clusters',$2,0) ON CONFLICT DO NOTHING",[randomUUID(),date.date]);
    },
    async tick(){
      const owner=randomUUID();
      const job=(await pool.query(`WITH next AS (SELECT id FROM ai_jobs WHERE (status='pending' OR status='running' AND "leaseUntil"<=NOW()) AND attempts<3 AND "availableAt"<=NOW()
        ORDER BY CASE kind WHEN 'interactive' THEN 0 WHEN 'submission' THEN 1 ELSE 2 END,"createdAt",id LIMIT 1 FOR UPDATE SKIP LOCKED)
        UPDATE ai_jobs j SET status='running',"leaseOwner"=$1,"leaseUntil"=NOW()+INTERVAL '150 seconds',attempts=attempts+1 FROM next WHERE j.id=next.id RETURNING j.*`,[owner])).rows[0];
      if(!job)return false;
      try{
        if(job.kind==='clusters'){
          if(environment.VITAL_AI_ANALYTICS_ENABLED!=='true')throw Error('AI_ANALYTICS_DISABLED');
          const rows=(await pool.query(`WITH ranked AS(SELECT id,features,"submittedAt",ROW_NUMBER() OVER(PARTITION BY features->>'cohort' ORDER BY "submittedAt" DESC,id) AS n FROM ai_submissions WHERE status='completed' AND NOT synthetic AND "expiresAt">NOW() AND "submittedAt">NOW()-INTERVAL '90 days' AND features->>'cohort' IN ('adult','pediatric')) SELECT id,features FROM ranked WHERE n<=2000 ORDER BY "submittedAt" DESC,id`)).rows;
          const fingerprint=hash(rows);
          if(!(await pool.query('SELECT 1 FROM ai_cluster_versions WHERE "inputHash"=$1',[fingerprint])).rowCount){
            const result=await runtime('/cluster',{rows});if(!Array.isArray(result.clusters)||!Array.isArray(result.cohorts))throw Error('AI_CLUSTER_RESULT_INVALID');
            await pool.query('INSERT INTO ai_cluster_versions(id,"inputHash",payload,"expiresAt") VALUES($1,$2,$3,NOW()+INTERVAL \'12 months\') ON CONFLICT DO NOTHING',[fingerprint,fingerprint,JSON.stringify(result)]);
          }
          await pool.query(`INSERT INTO ai_daily_aggregates("date",payload,"expiresAt") SELECT "reportDate",jsonb_build_object('submissions',COUNT(*),'analyzed',COUNT(*) FILTER(WHERE status='completed')),MAX("expiresAt") FROM ai_submissions WHERE NOT synthetic AND "expiresAt">NOW() GROUP BY "reportDate" ON CONFLICT("date") DO UPDATE SET payload=EXCLUDED.payload,"computedAt"=NOW(),"expiresAt"=EXCLUDED."expiresAt"`);
        }else{
          const interactive=job.kind==='interactive';
          const row=(await pool.query(interactive?'SELECT * FROM ai_intake_drafts WHERE id=$1 AND version=$2 AND "expiresAt">NOW()':'SELECT * FROM ai_submissions WHERE id=$1 AND "intakeVersion"=$2 AND "expiresAt">NOW()',[job.resourceId,job.sourceVersion])).rows[0];
          if(!row||interactive&&Date.now()-new Date(job.createdAt).getTime()>60000){await pool.query('UPDATE ai_jobs SET status=\'stale\',"completedAt"=NOW() WHERE id=$1 AND "leaseOwner"=$2',[job.id,owner]);return true;}
          const payload=intakePayloadSchema.parse(module.crypto.decrypt(row.payload,row.id));
          const result=analysisSchema.parse(await runtime('/analyze',{payload,candidates:false,...(interactive&&row.confirmation?{confirmedConcepts:module.crypto.decrypt(row.confirmation,row.id)}:{})}));
          if(interactive){
            if(!hasCurrentNormalization(result))throw Error('AI_NORMALIZATION_REANALYSIS_REQUIRED');
            if(Date.now()-new Date(job.createdAt).getTime()>60000){await pool.query('UPDATE ai_jobs SET status=\'stale\',"completedAt"=NOW() WHERE id=$1 AND "leaseOwner"=$2',[job.id,owner]);return true;}
            const updated=await pool.query('UPDATE ai_intake_drafts SET analysis=$3 WHERE id=$1 AND version=$2 AND "expiresAt">NOW() AND EXISTS(SELECT 1 FROM ai_jobs WHERE id=$4 AND "leaseOwner"=$5 AND status=\'running\')',[row.id,job.sourceVersion,JSON.stringify(module.crypto.encrypt(result,row.id)),job.id,owner]);if(!updated.rowCount)throw Error('AI_DRAFT_STALE');
          }else{
            const overrides:Concept[]=(row.concepts??[]).filter((c:Concept)=>c.method==='corrected'||c.method==='selected');
            const ids=new Set(overrides.map(c=>c.id));const concepts:Concept[]=row.concepts!==null&&row.processedHash===null?row.concepts:[...result.concepts.filter(c=>!ids.has(c.id)),...overrides];
            await pool.query('UPDATE ai_submissions SET analysis=$3,features=$4,status=\'completed\',"processedHash"="sourceHash" WHERE id=$1 AND "intakeVersion"=$2',[row.id,job.sourceVersion,JSON.stringify({versions:result.versions,flags:result.flags}),JSON.stringify(derivedFeatures(payload,concepts,row.ageYears))]);
          }
        }
        await pool.query('UPDATE ai_jobs SET status=\'completed\',"completedAt"=NOW(),"leaseUntil"=NULL WHERE id=$1 AND "leaseOwner"=$2',[job.id,owner]);
      }catch(error){
        if(error instanceof Error&&error.message==='AI_CAPACITY_BUSY'){
          await pool.query('UPDATE ai_jobs SET status=\'pending\',attempts=GREATEST(attempts-1,0),"availableAt"=NOW()+INTERVAL \'5 seconds\',"leaseUntil"=NULL WHERE id=$1 AND "leaseOwner"=$2',[job.id,owner]);return true;
        }
        await pool.query('UPDATE ai_jobs SET status=CASE WHEN attempts>=3 THEN \'failed\' ELSE \'pending\' END,"leaseUntil"=NULL,"availableAt"=NOW()+INTERVAL \'10 seconds\',"errorCode"=\'AI_PROCESSING_UNAVAILABLE\' WHERE id=$1 AND "leaseOwner"=$2',[job.id,owner]);
        if(job.kind==='submission')await pool.query('UPDATE ai_submissions SET status=CASE WHEN $3>=3 THEN \'failed\' ELSE \'pending\' END WHERE id=$1 AND "intakeVersion"=$2',[job.resourceId,job.sourceVersion,job.attempts]);
      }
      return true;
    }
  };
}
