import type { Pool } from 'pg';
import { createVideoModule } from './module.js';
import { createVideoAuthority } from './authority.js';
import { createVideoAssociations } from './association.js';
export type VideoRuntime=NonNullable<ReturnType<typeof videoRuntime>>;
export function videoRuntime(databases:{corePool:Pool;integrationsPool:Pool},environment:NodeJS.ProcessEnv=process.env){
  if(environment.VITAL_EDA_VIDEO_ENABLED!=='true'){
    if(environment.VITAL_EDA_VIDEO_MAINTENANCE_ENABLED==='true')throw new Error('VIDEO_MAINTENANCE_WITHOUT_OWNER');return undefined;
  }
  if(environment.VITAL_EDA_ENABLED!=='true')throw new Error('VIDEO_RUNTIME_DISABLED');
  const authority=createVideoAuthority(databases.corePool),associations=createVideoAssociations(databases.integrationsPool,authority);
  return createVideoModule(databases.integrationsPool,authority,associations);
}
