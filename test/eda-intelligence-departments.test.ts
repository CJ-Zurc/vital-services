import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { departmentCatalogSchema,loadDepartmentCatalog,resolveDepartmentBindings } from '../src/eda/modules/intelligence/department-catalog.js';

const catalog=loadDepartmentCatalog();
test('final department catalog has exactly 19 entries and uses actual BODHI IDs and labels',()=>{
  assert.equal(catalog.departments.length,19);assert.equal(new Set(catalog.departments.map(d=>d.key)).size,19);
  const csv=readFileSync('runtimes/nlp/vendor/bodhi-s/csv/nodes_speciality.csv','utf8').trim().split(/\r?\n/).slice(1);
  const source=new Map(csv.map(line=>{const split=line.indexOf(',');return[line.slice(0,split),line.slice(split+1)];}));
  for(const entry of catalog.departments)for(const specialty of entry.bodhiSpecialties)assert.equal(source.get(specialty.id),specialty.name);
  for(const excluded of catalog.excludedSources)assert.equal(source.get(excluded.id),excluded.name);
  assert.equal(catalog.version,'vital-departments-v2');
  assert.ok(!catalog.departments.some(d=>d.name==='Dermatology'));
  const trace=JSON.parse(readFileSync('test/fixtures/trace-clinical-specialties.json','utf8'));
  assert.deepEqual(catalog.departments.map(d=>d.name).sort(),trace.names.sort());
  assert.ok(!catalog.departments.some(d=>d.name==='General Surgery'||d.bodhiSpecialties.some(s=>s.id==='17')));
  assert.ok(catalog.departments.every(d=>d.traceDepartmentId===null));
  for(const [alias,name] of [['Opthalmology','Ophthalmology'],['Gastroentrology','Gastroenterology'],['Nephrologoy','Nephrology'],['Obesterics and Gynecology','Obstetrics and Gynecology']])
    assert.ok(catalog.departments.find(d=>d.name===name)?.aliases.includes(alias!));
});

test('catalog rejects duplicate keys, aliases, source IDs and invalid explicit bindings',()=>{
  for(const change of ['key','alias','source','uuid','excluded']){
    const copy=structuredClone(catalog),a=copy.departments[0]!,b=copy.departments[1]!;
    if(change==='key')b.key=a.key;
    if(change==='alias')b.aliases.push(a.name.toUpperCase());
    if(change==='source')b.bodhiSpecialties.push(a.bodhiSpecialties[0]!);
    if(change==='uuid')a.traceDepartmentId='not-a-uuid';
    if(change==='excluded')a.bodhiSpecialties.push({id:'6',name:'General Physician'});
    assert.equal(departmentCatalogSchema.safeParse(copy).success,false,change);
  }
});

test('TRACE resolver uses exact names and explicit aliases, never fuzzy or generic medical matches',()=>{
  const id=randomUUID();
  assert.equal(resolveDepartmentBindings(catalog,[{id,name:' TRACE Cardiology ',category:'specialty'}]).find(d=>d.key==='cardiology')!.traceDepartmentId,id);
  assert.equal(resolveDepartmentBindings(catalog,[{id,name:'Trace Cardiology Service',category:'specialty'}]).find(d=>d.key==='cardiology')!.status,'missing');
  assert.equal(resolveDepartmentBindings(catalog,[{id,name:'TRACE General Medicine',category:'specialty'}]).find(d=>d.key==='internal-medicine')!.status,'missing');
  assert.equal(resolveDepartmentBindings(catalog,[]).filter(d=>d.status==='resolved').length,0);
});

test('duplicate lookup names and invalid explicit bindings stay unresolved',()=>{
  const id=randomUUID(),extra={id:randomUUID(),name:'Cardiology Department',category:'specialty' as const};
  const lookup=[{id,name:'Cardiology',category:'specialty' as const},extra];
  const binding=(rows:typeof lookup,reference=catalog)=>resolveDepartmentBindings(reference,rows).find(d=>d.key==='cardiology')!;
  assert.equal(binding(lookup).status,'ambiguous');
  const pinned=structuredClone(catalog);pinned.departments.find(d=>d.key==='cardiology')!.traceDepartmentId=id;
  assert.equal(binding(lookup,pinned).traceDepartmentId,id);
  assert.equal(binding([extra],pinned).status,'invalid_binding');
});
test('hospital, uncategorized and malformed lookup rows cannot resolve clinical bindings',()=>{
  for(const row of [{id:randomUUID(),name:'Cardiology'},
    {id:randomUUID(),name:'Cardiology',category:'hospital'},
    {id:'invalid',name:'Cardiology',category:'specialty'}]){
    const result=resolveDepartmentBindings(catalog,[row] as unknown as Parameters<typeof resolveDepartmentBindings>[1]);
    assert.ok(result.every(d=>d.status==='invalid_binding'&&d.traceDepartmentId===null));
  }
});
