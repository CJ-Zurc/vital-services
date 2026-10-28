import 'dotenv/config';
import { createDatabases } from '../infrastructure/databases.js';
import { backfillAppointmentAccess } from '../modules/appointment/access-backfill.js';
if(process.env.VITAL_APPOINTMENT_ACCESS_MAINTENANCE!=='confirmed-writers-stopped')throw Error('EXPLICIT_APPOINTMENT_ACCESS_MAINTENANCE_REQUIRED');
const databases=createDatabases("worker");
void backfillAppointmentAccess(databases.corePool).then(result=>{process.stdout.write(JSON.stringify(result)+'\n');}).finally(async()=>{await databases.corePool.end();await databases.integrationsPool.end();});
