import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createVideoModule } from './module.js';
import { createVideoAuthority } from './authority.js';
import { createVideoAssociations } from './association.js';
import { meetKeyring } from './crypto.js';
import { createMeetProvider } from './provider.js';

export type VideoRuntime=NonNullable<ReturnType<typeof videoRuntime>>;
export function videoRuntime(databases:{corePool:Pool;integrationsPool:Pool},environment:NodeJS.ProcessEnv=process.env){
  if(environment.VITAL_EDA_VIDEO_ENABLED!=='true'){
    if(environment.VITAL_EDA_VIDEO_MAINTENANCE_ENABLED==='true')throw new Error('VIDEO_MAINTENANCE_WITHOUT_OWNER');return undefined;
  }
  if(environment.VITAL_EDA_ENABLED!=='true')throw new Error('VIDEO_RUNTIME_DISABLED');
  const required=(name:string)=>{const value=environment[name];if(!value)throw new Error('VIDEO_CONFIGURATION_MISSING:'+name);return value;};
  const appOrigin=new URL(required('VITAL_VIDEO_APP_ORIGIN'));
  if(appOrigin.username||appOrigin.password||appOrigin.pathname!=='/'||appOrigin.search||appOrigin.hash||
    (appOrigin.protocol!=='https:'&&!(appOrigin.protocol==='http:'&&['localhost','127.0.0.1'].includes(appOrigin.hostname))))throw new Error('VIDEO_ORIGIN_INVALID');
  const googleEnabled=environment.VITAL_VIDEO_GOOGLE_ENABLED==='true';
  const authority=createVideoAuthority(databases.corePool),associations=createVideoAssociations(databases.integrationsPool,authority);
  let google={};
  if(googleEnabled){
    const clientId=required('VITAL_VIDEO_GOOGLE_CLIENT_ID');
    const clientSecret=readFileSync(required('VITAL_VIDEO_GOOGLE_CLIENT_SECRET_FILE'),'utf8').trim();
    z.string().min(8).max(4096).parse(clientSecret);
    const redirectUri=new URL(required('VITAL_VIDEO_GOOGLE_REDIRECT_URI'));
    if(redirectUri.origin!==appOrigin.origin||redirectUri.pathname!=='/api/doctor/google-meet/callback'||redirectUri.search||redirectUri.hash)throw new Error('VIDEO_REDIRECT_INVALID');
    const keyring=meetKeyring(JSON.parse(readFileSync(required('VITAL_VIDEO_KEYRING_FILE'),'utf8')));
    google={clientId,redirectUri:redirectUri.toString(),keyring,provider:createMeetProvider({clientId,clientSecret,redirectUri:redirectUri.toString()})};
  }
  return createVideoModule(databases.integrationsPool,authority,associations,{googleEnabled,appOrigin:appOrigin.origin,...google});
}
