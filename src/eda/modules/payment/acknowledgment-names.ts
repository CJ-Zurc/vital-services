import { z } from 'zod';
import { boundedJsonReceipt } from '../../infrastructure/http-receipt.js';
import { trustedInternalOrigin } from '../../infrastructure/private-transport.js';
export function acknowledgmentNames(environment:NodeJS.ProcessEnv){
 return async(patientId:string,doctorId:string)=>{
  const target=new URL(environment.VITAL_AUTH_INTERNAL_URL??'');
  const key=environment.VITAL_SERVICES_AUTH_PROFILE_KEY;
  if(!key||!trustedInternalOrigin(target))throw new Error('ACKNOWLEDGMENT_IDENTITY_CONFIGURATION_REQUIRED');
  const name=async(id:string)=>{
   const response=await fetch(new URL('/internal/users/'+z.uuid().parse(id)+'/profile',target),{headers:{'X-Internal-Service':'vital-services','X-Internal-Service-Key':key},redirect:'error',signal:AbortSignal.timeout(10000)});
   if(!response.ok)throw new Error('ACKNOWLEDGMENT_IDENTITY_UNAVAILABLE');
   const row=z.object({success:z.literal(true),data:z.object({id:z.literal(id),first_name:z.string(),middle_name:z.string().nullable(),last_name:z.string(),extension_name:z.string().nullable()})}).parse(await boundedJsonReceipt(response)).data;
   const value=[row.first_name,row.middle_name,row.last_name,row.extension_name].filter(Boolean).join(' ').trim();if(!value)throw new Error('ACKNOWLEDGMENT_IDENTITY_UNAVAILABLE');return value;
  };
  return{patientName:await name(patientId),doctorName:await name(doctorId)};
 };
}
