import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { createDatabases } from '../infrastructure/databases.js';
import { intelligenceWorker } from '../modules/intelligence/worker.js';
async function main(){
  if(process.env.VITAL_AI_ENABLED!=='true')throw Error('AI_DISABLED');
  const databases=createDatabases('worker'),worker=intelligenceWorker(databases.corePool);let closing=false;
  const stop=()=>{closing=true;};process.once('SIGTERM',stop);process.once('SIGINT',stop);
  await databases.verifyPrivileges();let nextMaintenance=0;
  // Maintenance is independent of inference so expiry cleanup is never delayed by a model call.
  const cleanup=setInterval(()=>{void worker.maintenance().catch(()=>undefined);},30000);
  try{while(!closing){try{if(Date.now()>=nextMaintenance){await worker.maintenance();nextMaintenance=Date.now()+30000;}if(!await worker.tick())await sleep(1000);}catch{console.error(JSON.stringify({event:'vital.ai.worker_unavailable'}));await sleep(5000);}}}finally{clearInterval(cleanup);await databases.close();}
}
void main().catch(()=>{console.error(JSON.stringify({event:'vital.ai.worker_startup_failed'}));process.exitCode=1;});
