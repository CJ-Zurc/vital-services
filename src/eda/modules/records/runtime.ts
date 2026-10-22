import { createDoctorSigning } from "./signing.js";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Pool } from "pg";
import type { PaymentModule } from "../../http/payment-router.js";
import { recordsKeyring } from "./protection.js";
import { createRecordsModule } from "./records.js";
import { createRecordsFiles } from "./files.js";
import { createRecordsLifecycle } from "./lifecycle.js";
import { createRecordsPartyResolver } from "./parties.js";
import { S3RecordsStorage } from "./storage.js";
import { createFileInspector, FILE_INSPECTION_POLICY } from "./inspection.js";
import { RecordsArtifactWorker } from "./artifacts.js";
import { createArtifactRepository,canonicalArtifactData } from "./artifact-repository.js";

export type RecordsRuntime=NonNullable<ReturnType<typeof recordsRuntime>>;
export function recordsRuntime(databases:{corePool:Pool},payment:PaymentModule|undefined,environment:NodeJS.ProcessEnv=process.env){
  if(environment.VITAL_EDA_RECORDS_ENABLED!=='true'){
    if(environment.VITAL_EDA_RECORDS_ARTIFACTS_ENABLED==='true')throw new Error('RECORDS_ARTIFACTS_WITHOUT_OWNER');return undefined;
  }
  if(environment.VITAL_EDA_ENABLED!=='true')throw new Error('RECORDS_RUNTIME_DISABLED');
  const required=(name:string)=>{const value=environment[name];if(!value)throw new Error('RECORDS_CONFIGURATION_MISSING:'+name);return value;};
  const keyring=recordsKeyring(JSON.parse(readFileSync(required('VITAL_RECORDS_KEYRING_FILE'),'utf8')));
  const evidence={keys:z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),z.string().min(64).max(8192)).refine(v=>Object.keys(v).length>=1&&Object.keys(v).length<=3).parse(JSON.parse(readFileSync(required('VITAL_EHR_RECORDS_PUBLIC_KEYS_FILE'),'utf8')))};
  const storage=new S3RecordsStorage({endpoint:required('VITAL_RECORDS_STORAGE_ENDPOINT'),publicEndpoint:required('VITAL_RECORDS_STORAGE_PUBLIC_ENDPOINT'),bucket:required('VITAL_RECORDS_STORAGE_BUCKET'),region:required('VITAL_RECORDS_STORAGE_REGION'),
    accessKeyId:required('VITAL_RECORDS_STORAGE_ACCESS_KEY'),secretAccessKey:required('VITAL_RECORDS_STORAGE_SECRET_KEY'),quarantinePrefix:environment.VITAL_RECORDS_QUARANTINE_PREFIX??'quarantine/records/',finalPrefix:environment.VITAL_RECORDS_FINAL_PREFIX??'records/final/'});
  const config={appOrigin:required('VITAL_PAYMENT_APP_ORIGIN'),keyring,evidence,...(payment?{financial:{verifyPaid:payment.verifyAppointmentPaid}}:{}),parties:createRecordsPartyResolver(databases.corePool,{baseUrl:required('VITAL_AUTH_INTERNAL_URL'),key:required('VITAL_SERVICES_AUTH_PROFILE_KEY')})};
  const module=createRecordsModule(databases.corePool,config),files=createRecordsFiles(databases.corePool,config,storage),lifecycle=createRecordsLifecycle(keyring);
  let artifacts:RecordsArtifactWorker|undefined;
  if(environment.VITAL_EDA_RECORDS_ARTIFACTS_ENABLED==='true'){
    const scanner=createFileInspector(()=>({socketPath:required('VITAL_RECORDS_CLAMAV_SOCKET'),daemonConfigPath:required('VITAL_RECORDS_CLAMAV_CONFIG'),deadlineMs:15000,maxDatabaseAgeMs:24*3600000}));
    const fonts={regularPath:required('VITAL_RECORDS_FONT_REGULAR_FILE'),boldPath:required('VITAL_RECORDS_FONT_BOLD_FILE')};
    artifacts=new RecordsArtifactWorker({repository:createArtifactRepository(databases.corePool,FILE_INSPECTION_POLICY),storage,scanner,decryptCanonicalData:canonicalArtifactData(databases.corePool,config),fonts},{enabled:true});
  }
  const signing=createDoctorSigning(databases.corePool,keyring,createFileInspector(()=>({socketPath:required('VITAL_RECORDS_CLAMAV_SOCKET'),daemonConfigPath:required('VITAL_RECORDS_CLAMAV_CONFIG'),deadlineMs:15000,maxDatabaseAgeMs:86400000})));
  return{module,files,lifecycle,signing,artifactTick:(signal?:AbortSignal)=>artifacts?.runOnce(signal)??Promise.resolve(0)};
}
