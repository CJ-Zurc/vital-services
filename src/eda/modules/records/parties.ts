import type { Pool } from "pg";
import { z } from "zod";
import { recordsDenied } from "./authorization.js";
import { boundedJsonReceipt } from "../../infrastructure/http-receipt.js";

export function createRecordsPartyResolver(pool:Pool,config:{baseUrl:string;key:string},fetcher:typeof fetch=fetch) {
  const target=new URL(config.baseUrl);
  if(!config.key||target.username||target.password||!["http:","https:"].includes(target.protocol)||process.env.NODE_ENV==='production'&&target.protocol!=='https:')throw new Error("RECORDS_AUTH_CONFIGURATION_INVALID");
  const identity=z.object({id:z.uuid(),first_name:z.string().max(255),middle_name:z.string().max(255).nullable(),last_name:z.string().max(255),extension_name:z.string().max(64).nullable()}).passthrough();
  async function name(authId:string){
    const response=await fetcher(new URL('/internal/users/'+z.uuid().parse(authId)+'/profile',target),{method:'GET',redirect:'error',headers:{'X-Internal-Service':'vital-services','X-Internal-Service-Key':config.key},signal:AbortSignal.timeout(10000)});
    if(!response.ok)recordsDenied(503,"RECORDS_AUTH_PROFILE_UNAVAILABLE");
    const result=z.object({success:z.literal(true),data:identity}).passthrough().parse(await boundedJsonReceipt(response));
    if(result.data.id!==authId)recordsDenied(503,"RECORDS_AUTH_PROFILE_MISMATCH");
    const value=[result.data.first_name,result.data.middle_name,result.data.last_name,result.data.extension_name].map(x=>x?.trim()).filter(Boolean).join(' ');
    if(!value)recordsDenied(503,"RECORDS_AUTH_PROFILE_UNAVAILABLE");return value;
  }
  return async(patientAuthId:string,doctorAuthId:string,doctorId:string)=>{
    // Auth transport runs before the Core issuance transaction; Core membership is rechecked at commit.
    const patientName=await name(patientAuthId),doctorName=await name(doctorAuthId);
    const doctor=(await pool.query<{prcLicense:string|null}>(`SELECT "prc_license" AS "prcLicense" FROM vital_doctors WHERE "userId"=$1 AND "authId"=$2`,[doctorId,doctorAuthId])).rows[0];
    if(!doctor)recordsDenied(403,"RECORDS_DOCTOR_REVOKED");
    return{patientName,doctorName,doctorLicense:doctor.prcLicense??''};
  };
}
