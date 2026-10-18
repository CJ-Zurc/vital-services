import { z } from "zod";
import { DomainError } from "../../../contracts/actor.js";
import { boundedJsonReceipt } from "../../../infrastructure/http-receipt.js";
import { trustedInternalOrigin } from "../../../infrastructure/private-transport.js";
const receipt=z.object({appointment_id:z.uuid(),case_id:z.uuid(),patient_id:z.uuid(),doctor_auth_id:z.uuid().nullable(),external_system_ref:z.string().max(96)}).strict();
export function createEhrCaseRecovery(config:{baseUrl:string;key:string},fetcher:typeof fetch=fetch){
  const base=new URL(config.baseUrl);
  if(base.username||base.password||!trustedInternalOrigin(base)||config.key.length<16)throw new Error("EHR_RECOVERY_CONFIGURATION_INVALID");
  return async(appointmentId:string)=>{
    z.uuid().parse(appointmentId);
    const response=await fetcher(new URL("/internal/vital/v1/appointment-cases/"+appointmentId,base),{method:"GET",redirect:"error",
      headers:{"X-Internal-Service":"vital-services","X-Internal-Service-Key":config.key},signal:AbortSignal.timeout(10000)});
    if(response.status===404)return null;
    if(!response.ok)throw new DomainError(503,"EHR_RECOVERY_UNAVAILABLE","Existing case receipt is unavailable.");
    const parsed=z.object({success:z.literal(true),data:receipt}).passthrough().parse(await boundedJsonReceipt(response));
    if(parsed.data.appointment_id!==appointmentId||parsed.data.external_system_ref!=="vital:appointment:"+appointmentId)throw new DomainError(409,"EHR_RECOVERY_RECEIPT_INVALID","Case reference mismatch.");
    return{caseId:parsed.data.case_id,patientId:parsed.data.patient_id,doctorAuthId:parsed.data.doctor_auth_id,externalSystemRef:parsed.data.external_system_ref};
  };
}
