import { auditCatalog } from './audit-catalog.js';
import { z } from 'zod';

export const auditFields=['specialty','schedule','chief_complaint','signature','consent','meeting','rating','status','availability'] as const;
export const auditMetadataSchema=z.object({
  actor_id:z.union([z.uuid(),z.string().regex(/^(?:system|service):[a-zA-Z0-9_.:-]{1,80}$/)]).transform(id=>id.includes(':')?id:id.toLowerCase()),actor_type:z.enum(['user','system','service','anonymous']),
  entity_type:z.enum(['profile','appointment','payment','document','message','video','audit_history']),
  entity_id:z.uuid().transform(id=>id.toLowerCase()).optional(),action:z.enum(['read','create','update','delete','export','verify']),
  outcome:z.enum(['success','failed','denied','rejected','attempted']),
  changed_fields:z.array(z.enum(auditFields)).max(16).optional(),
  route:z.string().regex(/^\/[a-zA-Z0-9_/{}/.-]{0,240}$/).optional(),
  method:z.enum(['GET','POST','PATCH','PUT','DELETE']).optional(),
  reason_category:z.enum(['verification_failed','consent_withdrawal','invalid_audit_contract']).optional(),
  result_count:z.number().int().nonnegative().optional(),
}).strict();
export type AuditMetadata=z.infer<typeof auditMetadataSchema>;

/** Only called when creating a new intent. Legacy persisted intents stay legacy. */
export function auditMetadata(data:{auditType:string;actorAuthId:string|null;resourceId:string|null;resourceType:string}):AuditMetadata{
 const type=data.auditType,actor=data.actorAuthId??'system:worker';
 const catalog=auditCatalog[type];if(!catalog||catalog.entity!==data.resourceType)throw Error('AUDIT_EVENT_UNREVIEWED');
 const changed:Partial<Record<string,typeof auditFields[number]>>={complaint_updated:'chief_complaint',specialty_updated:'specialty',signature_saved:'signature',schedule_updated:'schedule',status_changed:'status'};
 const suffix=type.split('.').at(-1)!;
 return auditMetadataSchema.parse({actor_id:actor,actor_type:data.actorAuthId?'user':'system',entity_type:data.resourceType,
  ...(data.resourceId?{entity_id:data.resourceId}:{}),
  action:/access_withdrawn$/.test(type)?'update':/code_reissued$/.test(type)?'create':/access_|code_|security/.test(type)?'verify':/export/.test(type)?'export':/accessed|viewed|read|downloaded|retrieved|link_issued/.test(type)?'read':/deleted|purged/.test(type)?'delete':/created|requested|uploaded|issued|materialized/.test(type)?'create':'update',
  outcome:/failed|incorrect|locked/.test(suffix)?'failed':/denied|throttled/.test(suffix)?'denied':/rejected/.test(suffix)?'rejected':/requested|started|prepared|uncertain/.test(suffix)?'attempted':'success',
  ...(changed[suffix]?{changed_fields:[changed[suffix]]}:{}),
  ...(type.endsWith('.access_withdrawn')?{changed_fields:['consent'],reason_category:'consent_withdrawal'}:{}),
 });
}
