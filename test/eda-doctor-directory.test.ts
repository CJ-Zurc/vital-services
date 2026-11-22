import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {CorePrismaClient} from '../src/eda/infrastructure/databases.js';
import type {Actor} from '../src/eda/contracts/actor.js';
import {createDoctorDirectoryWorker,directoryGeneration} from '../src/eda/modules/profile/doctor-directory.js';
import {createProfileModule} from '../src/eda/modules/profile/profile.js';
import {createAppointmentReads} from '../src/eda/modules/appointment/appointment-reads.js';

function fixture(){
 let generation:string|null=null,version='1',now=Date.parse('2026-11-22T00:00:00Z');
 const doctors=Array.from({length:205},()=>({doctorId:randomUUID(),authId:randomUUID()})).sort((a,b)=>a.doctorId.localeCompare(b.doctorId));
 const staged=new Map<string,unknown[]>(),calls:{sql:string;args:unknown[]}[]=[],batches:number[]=[];
 let fail=false,rollover=false,refreshedAt:Date|null=null,publishedVersion='0',locked=true;
 const tx={query:async(sql:string,args:unknown[]=[])=>{calls.push({sql,args});
  if(sql.includes('pg_try_advisory_lock'))return{rows:[{locked}]};
  if(sql.startsWith('SELECT generation'))return{rows:[{generation}]};
  if(sql.startsWith('SELECT * FROM doctor_directory_state'))return{rows:[{requestedVersion:version,publishedVersion,refreshedAt}]};
  if(sql.startsWith('SELECT d.'))return{rows:doctors.filter(d=>d.doctorId>String(args[0])).slice(0,100)};
  if(sql.startsWith('INSERT INTO doctor_directory_entries')){const key=String(args[0]);staged.set(key,[...(staged.get(key)??[]),args[1]]);}
  if(sql.startsWith('UPDATE doctor_directory_state')){if(rollover)return{rowCount:0,rows:[]};generation=String(args[0]);publishedVersion=String(args[1]);refreshedAt=args[2] as Date;return{rowCount:1,rows:[{id:1}]};}
  return{rowCount:1,rows:[]};},release(){}};
 const pool={...tx,connect:async()=>tx} as unknown as Pool;
 const lookup=async(ids:string[])=>{batches.push(ids.length);if(fail)throw Error('Auth unavailable');return new Map(ids.map(id=>[id,{name:'Doctor Name',email:'doctor@example.test'}]));};
 return{pool,calls,batches,staged,tick:createDoctorDirectoryWorker(pool,lookup,()=>now),generation:()=>generation,fail:()=>{fail=true;},advance:()=>{now+=300001;},rollover:()=>{rollover=true;},unlock:()=>{locked=false;}};
}

test('directory starts unavailable, refreshes in bounded batches and retains published data on Auth failure',async()=>{
 const f=fixture();await assert.rejects(directoryGeneration(f.pool),{code:'DOCTOR_DIRECTORY_INITIALIZING'});await f.tick();
 assert.deepEqual(f.batches,[100,100,5]);const first=await directoryGeneration(f.pool);assert.equal(f.staged.get(first)!.length,205);
 await f.tick();assert.deepEqual(f.batches,[100,100,5]);
 f.fail();f.advance();const before=console.error;console.error=()=>{};try{await f.tick();}finally{console.error=before;}
 assert.equal(await directoryGeneration(f.pool),first);assert(f.calls.some(c=>c.sql.includes('generation IS DISTINCT FROM')));
});
test('directory never publishes a competing or superseded build',async()=>{
 const f=fixture();f.rollover();await f.tick();assert.equal(f.generation(),null);
 const g=fixture();g.unlock();await g.tick();assert.equal(g.batches.length,0);
});
test('admin search and pagination are applied to the authoritative owner query before selecting rows',async()=>{
 const authId=randomUUID(),id=randomUUID(),calls:any[]=[];
 const actor={authId,role:'admin',resource:authId,scopes:['profile.admin.read']} as Actor;
 const tx={vitalAdmin:{findUnique:async()=>({authId,userId:id,user:{id,authId}})},doctorDirectoryState:{findUnique:async()=>({generation:'published'})},vitalDoctor:{count:async(q:any)=>{calls.push(q);return 31;},findMany:async(q:any)=>{calls.push(q);return[];}}};
 const db={$transaction:async(run:any)=>run(tx)} as unknown as CorePrismaClient;
 const result=await createProfileModule(db).adminDoctors(actor,{page:3,pageSize:10,search:'Ana'});
 assert.equal(result.total,31);assert.equal(result.page,3);assert.equal(calls[1].skip,20);assert.equal(calls[1].take,10);
 assert.equal(calls[1].where.OR[2].directoryEntries.some.generation,'published');assert(calls[1].where.OR.some((c:any)=>c.prcLicense));
 await assert.rejects(createProfileModule(db).adminDoctors(actor,{pageSize:51}));
 await assert.rejects(createProfileModule(db).adminDoctors({...actor,role:'patient'}));
});
test('patient search binds global name and hospital filters before the bounded result query and never uses email',async()=>{
 const calls:{sql:string;args:unknown[]}[]=[];const authId=randomUUID();
 const query=async(sql:string,args:unknown[]=[])=>{calls.push({sql,args});
 if(sql.startsWith('SELECT generation'))return{rows:[{generation:'published'}]};
 if(sql.includes('SELECT p.*'))return{rows:[{userId:authId}]};
 if(sql.includes('SELECT md5(jsonb_build_array'))return{rows:[{revision:'a'.repeat(32)}]};
 if(sql.includes('AS revision,COUNT'))return{rows:[{revision:'empty',total:'0'}]};
 return{rows:[]};};
 const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
 const actor={authId,role:'patient',resource:authId,scopes:['appointments.discovery.read']} as Actor;
 const result=await createAppointmentReads(pool).discovery(actor,{q:'Ana',limit:12,availabilityFirst:'true'});assert.equal(result.doctors.length,0);
 const page=calls.find(c=>c.sql.startsWith('SELECT r.*'))!;assert.match(page.sql,/de.name ILIKE/);assert.match(page.sql,/hospitalName/);assert.doesNotMatch(page.sql,/de.email/);assert.equal(page.args[4],'%Ana%');assert.equal(page.args.at(-1),13);assert.match(page.sql,/availabilityRank/);
});
