import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const normalizedName=(name:string)=>name.trim().toLowerCase();
export const departmentCatalogSchema=z.object({
  version:z.string().min(1),bodhiSourceCommit:z.string().regex(/^[a-f0-9]{40}$/),
  departments:z.array(z.object({
    key:z.string().regex(/^[a-z]+(?:-[a-z]+)*$/),name:z.string().trim().min(1).max(160),
    aliases:z.array(z.string().trim().min(1).max(160)).max(30),
    bodhiSpecialties:z.array(z.object({id:z.string().regex(/^\d+$/),name:z.string().min(1)}).strict()).min(1).max(39),
    traceDepartmentId:z.uuid().nullable(),
  }).strict()).length(19),
  excludedSources:z.array(z.object({id:z.string().regex(/^\d+$/),name:z.string().min(1),
    status:z.enum(['pending_review','unsupported_subspecialty']),reason:z.string().min(1)}).strict()),
}).strict().superRefine((catalog,ctx)=>{
  const keys=new Set<string>(),names=new Set<string>(),sources=new Set<string>(),bindings=new Set<string>();
  for(const entry of catalog.departments){
    if(keys.has(entry.key))ctx.addIssue({code:'custom',message:'Duplicate specialty key'});keys.add(entry.key);
    for(const name of [entry.name,...entry.aliases].map(normalizedName)){
      if(names.has(name))ctx.addIssue({code:'custom',message:'Duplicate specialty name or alias'});names.add(name);
    }
    for(const source of entry.bodhiSpecialties){
      if(sources.has(source.id))ctx.addIssue({code:'custom',message:'Duplicate BODHI mapping'});sources.add(source.id);
    }
    if(entry.traceDepartmentId){
      const id=entry.traceDepartmentId.toLowerCase();
      if(bindings.has(id))ctx.addIssue({code:'custom',message:'Duplicate TRACE binding'});bindings.add(id);
    }
  }
  for(const source of catalog.excludedSources){
    if(sources.has(source.id))ctx.addIssue({code:'custom',message:'Excluded BODHI source is mapped'});sources.add(source.id);
  }
});
export type DepartmentCatalog=z.infer<typeof departmentCatalogSchema>;
export const verifiedTraceDepartmentSchema=z.object({id:z.uuid(),name:z.string().trim().min(1).max(255),category:z.literal('specialty')}).strict();
export const verifiedTraceDepartmentsSchema=z.array(verifiedTraceDepartmentSchema).max(1000);
export type VerifiedTraceDepartment=z.infer<typeof verifiedTraceDepartmentSchema>;
export function loadDepartmentCatalog(){
  return departmentCatalogSchema.parse(JSON.parse(readFileSync(resolve('assets/ai/department-catalog.json'),'utf8')));
}
export type DepartmentBinding={key:string;name:string;traceDepartmentId:string|null;
  status:'resolved'|'missing'|'ambiguous'|'invalid_binding'};

/** Only exact canonical/explicit alias matches qualify; names are never fuzzy-matched. */
export function resolveDepartmentBindings(catalog:DepartmentCatalog,lookup:VerifiedTraceDepartment[]):DepartmentBinding[]{
  const verified=verifiedTraceDepartmentsSchema.safeParse(lookup);
  if(!verified.success)return catalog.departments.map(entry=>({key:entry.key,name:entry.name,traceDepartmentId:null,status:'invalid_binding'}));
  const bindings=catalog.departments.map(entry=>{
    const names=new Set([entry.name,...entry.aliases].map(normalizedName));
    const matches=verified.data.filter(row=>names.has(normalizedName(row.name)));
    const selected=entry.traceDepartmentId
      ? matches.filter(row=>row.id.toLowerCase()===entry.traceDepartmentId!.toLowerCase()):matches;
    const status:DepartmentBinding['status']=selected.length===1?'resolved':selected.length>1?'ambiguous':entry.traceDepartmentId?'invalid_binding':'missing';
    return{key:entry.key,name:entry.name,traceDepartmentId:status==='resolved'?selected[0]!.id.toLowerCase():null,status};
  });
  // Even manually pinned bindings cannot let one UUID impersonate multiple specialties.
  const counts=new Map<string,number>();
  for(const binding of bindings)if(binding.traceDepartmentId)counts.set(binding.traceDepartmentId,(counts.get(binding.traceDepartmentId)??0)+1);
  return bindings.map(binding=>binding.traceDepartmentId&&counts.get(binding.traceDepartmentId)!>1
    ?{...binding,traceDepartmentId:null,status:'ambiguous'}:binding);
}
