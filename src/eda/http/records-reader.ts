import jwt from "jsonwebtoken";
import { z } from "zod";
import { DomainError,type Actor } from "../contracts/actor.js";

// Invoke only after the ordinary mTLS/asymmetric assertion verifier succeeds.
export function recordsReaderDelegation(token:string,actor:Actor,method:string,path:string):boolean {
  const decoded=jwt.decode(token);
  if(!decoded||typeof decoded==='string'||!('delegation'in decoded))return false;
  try{
    const claims=z.object({system:z.literal('ehr'),roles:z.array(z.enum(['nurse','doctor','admin'])).max(3),isSuperAdmin:z.boolean()}).strict().parse(decoded.delegation);
    const url=new URL(path,'https://internal.invalid');
    const allowed=method==='GET'&&/^\/internal\/v1\/records\/documents(?:\/[a-f0-9-]{36})?$/.test(url.pathname)||method==='POST'&&/^\/internal\/v1\/records\/files\/[a-f0-9-]{36}\/link$/.test(url.pathname);
    if(!allowed||actor.role!=='service'||actor.resource!=='records:integration'||actor.scopes.length!==1||actor.scopes[0]!=='records.integration.read'||actor.isSuperAdmin!==claims.isSuperAdmin||!claims.isSuperAdmin&&!claims.roles.length)throw new Error('DENIED');
    return true;
  }catch{throw new DomainError(403,'RECORDS_INTEGRATION_DELEGATION_DENIED','Authorized EHR clinical delegation required.');}
}
