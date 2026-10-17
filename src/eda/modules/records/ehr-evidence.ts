import jwt from "jsonwebtoken";
import { createHash,createPublicKey } from "node:crypto";
import { z } from "zod";
import { DomainError } from "../../contracts/actor.js";

export interface EhrEvidenceConfig { keys: Readonly<Record<string,string>> }
export const evidenceClaims=z.object({kind:z.enum(["snapshot","treatment"]),workflowId:z.uuid(),actorAuthId:z.uuid(),patientId:z.uuid(),caseId:z.uuid(),
  payloadHash:z.string().regex(/^[a-f0-9]{64}$/),externalSystemRef:z.string().max(128).nullable(),
  iss:z.literal("uhse-ehr"),aud:z.literal("vital-services.records"),iat:z.number().int(),exp:z.number().int(),jti:z.uuid() }).strict();
export type EhrEvidence = z.infer<typeof evidenceClaims>;
export function verifyEhrEvidence(token:string,config:EhrEvidenceConfig,expected:Pick<EhrEvidence,"kind"|"workflowId"|"actorAuthId"|"patientId"|"payloadHash"> & {caseId?:string|null},now=Math.floor(Date.now()/1000)) {
  try{
    if(token.length>8192)throw new Error("LIMIT");
    const header=jwt.decode(token,{complete:true})?.header;
    if(!header||header.alg!=="RS256"||typeof header.kid!=="string"||!Object.hasOwn(config.keys,header.kid))throw new Error("KEY");
    const key=createPublicKey(config.keys[header.kid]!);
    if(key.asymmetricKeyType!=='rsa'||(key.asymmetricKeyDetails?.modulusLength??0)<2048)throw new Error('WEAK_KEY');
    const claims=evidenceClaims.parse(jwt.verify(token,config.keys[header.kid]!,{algorithms:["RS256"],issuer:"uhse-ehr",audience:"vital-services.records",clockTimestamp:now,clockTolerance:0}));
    if(claims.exp<=claims.iat||claims.exp-claims.iat>60||claims.iat>now||claims.kind!==expected.kind||claims.workflowId!==expected.workflowId||claims.actorAuthId!==expected.actorAuthId
      ||claims.patientId!==expected.patientId||claims.payloadHash!==expected.payloadHash||expected.caseId&&claims.caseId!==expected.caseId)throw new Error("BINDING");
    return {claims,metadata:{kind:claims.kind,receiptId:claims.jti,proofHash:createHash("sha256").update(token).digest("hex"),keyId:header.kid,
      actorAuthId:claims.actorAuthId,patientId:claims.patientId,caseId:claims.caseId,payloadHash:claims.payloadHash,externalSystemRef:claims.externalSystemRef,verifiedAt:new Date(now*1000).toISOString(),expiresAt:new Date(claims.exp*1000).toISOString()}};
  }catch{throw new DomainError(403,"EHR_RECORDS_EVIDENCE_INVALID","Verified EHR authority is required.");}
}
