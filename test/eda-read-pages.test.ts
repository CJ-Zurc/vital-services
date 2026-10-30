import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import type { Actor } from '../src/eda/contracts/actor.js';
import { DomainError } from '../src/eda/contracts/actor.js';
import { prepareReadPage, readCollectionPage, collectReadPages, readPageInput } from '../src/eda/infrastructure/read-pages.js';
import { z } from 'zod';

function fixture(size=2601){
  const actor:Actor={authId:randomUUID(),role:'patient',serviceId:'vital-web',resource:randomUUID(),scopes:['appointments.read'],correlationId:randomUUID(),isSuperAdmin:false};
  const rows=Array.from({length:size},(_,index)=>({id:String(index).padStart(6,'0'),value:'fixture'}));
  const calls:{sql:string;values:unknown[]}[]=[];let revision=0;
  const tx={release(){},async query(sql:string,values:unknown[]=[]){calls.push({sql,values});
    if(/^(BEGIN|COMMIT|ROLLBACK)/.test(sql))return{rows:[]};
    if(sql.startsWith('SELECT\n')&&sql.includes(' AS revision'))return{rows:[{revision:createHash('md5').update(String(revision)).digest('hex'),total:String(rows.length)}]};
    if(sql.startsWith('SELECT r.*')){const after=values.length>2?String(values[1]):undefined;
      return{rows:rows.filter(row=>after===undefined||row.id>after).slice(0,Number(values.at(-1)))};}
    throw new Error('Unexpected fixture query');
  }};
  const pool={connect:async()=>tx} as unknown as Pool;
  const read=(input:{limit:number;cursor?:string})=>readCollectionPage<{id:string;value:string}>(pool,prepareReadPage(actor,'appointments',{status:'all'},input,()=>1700000000000),
    {sql:'SELECT id,value FROM fixture_rows WHERE owner=$1',values:[actor.authId],order:[{key:'id',direction:'ASC',cast:'text'}]});
  return{actor,rows,calls,pool,read,change:()=>{revision++;}};
}
test('read pages exhaust histories beyond old caps with bounded bound queries',async()=>{
  const f=fixture(),items=await collectReadPages(f.read);
  assert.equal(items.length,2601);assert.deepEqual(items.map(item=>item.id),f.rows.map(item=>item.id));
  for(const call of f.calls.filter(call=>call.sql.startsWith('SELECT r.*'))){assert.ok(Number(call.values.at(-1))<=11);assert.ok(!call.sql.includes(f.actor.authId));}
  assert.ok(f.calls.some(call=>call.sql.startsWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')));
  assert.ok(f.calls.every(call=>! /INSERT|UPDATE|DELETE/.test(call.sql)));
});
test('read cursors bind actor role filters collection and thirty second snapshot',async()=>{
  const f=fixture(),page=await f.read({limit:10}),cursor=page.meta.nextCursor!;
  for(const [actor,collection,filters,now]of[
    [{...f.actor,authId:randomUUID()},'appointments',{status:'all'},1700000000000],
    [{...f.actor,role:'doctor'},'appointments',{status:'all'},1700000000000],
    [f.actor,'other',{status:'all'},1700000000000],
    [f.actor,'appointments',{status:'cancelled'},1700000000000],
    [f.actor,'appointments',{status:'all'},1700000030001],
  ]as const)assert.throws(()=>prepareReadPage(actor,collection,filters,{limit:10,cursor},()=>now),error=>error instanceof DomainError&&error.status===400);
});
test('read validation cursor rechecks the whole snapshot without advancing',async()=>{
  const f=fixture(),first=await f.read({limit:10});
  const checked=await f.read({limit:1,cursor:first.meta.validationCursor});assert.equal(checked.meta.snapshot,first.meta.snapshot);assert.equal(checked.items[0]!.id,'000000');
  f.change();await assert.rejects(f.read({limit:1,cursor:first.meta.validationCursor}),error=>error instanceof DomainError&&error.code==='APPOINTMENT_READ_SNAPSHOT_CHANGED');
});
test('read page SQL seek identifiers are closed while all cursor values stay bound',async()=>{
  const f=fixture(2),first=await f.read({limit:1});await f.read({limit:1,cursor:first.meta.nextCursor!});
  const seek=f.calls.find(call=>call.sql.includes('WHERE ('))!;assert.match(seek.sql,/r\."id"::text > \$2::text/);assert.ok(seek.values.includes('000000'));
  await assert.rejects(readCollectionPage(f.pool,prepareReadPage(f.actor,'x',{}, {limit:10}),{sql:'SELECT id FROM fixture_rows',values:[],
    order:[{key:'id; DROP TABLE appointments',direction:'ASC',cast:'text'}]}),/INVALID_READ_SPECIFICATION/);
  for(const limit of[0,51,'10;DROP'])assert.equal(z.object(readPageInput).safeParse({limit}).success,false);
});
test('read pagination casts projected date and time columns consistently',async()=>{
  const f=fixture(2),calls:string[]=[];
  const rows=[{id:'a',slotDate:'2026-10-30',startTime:'09:00:00'},{id:'b',slotDate:'2026-10-30',startTime:'10:00:00'}];
  const pool={connect:async()=>({release(){},async query(sql:string){
    calls.push(sql);
    if(sql.includes(' AS revision'))return{rows:[{revision:'stable',total:'2'}]};
    if(sql.startsWith('SELECT r.*'))return{rows:sql.includes('WHERE (')?rows.slice(1):rows};
    return{rows:[]};
  }})} as unknown as Pool;
  const read=(cursor?:string)=>readCollectionPage(pool,prepareReadPage(f.actor,'slots',{}, {limit:1,cursor}),{
    sql:'SELECT id,"slotDate"::text,"startTime"::text FROM schedules',values:[],
    order:[{key:'slotDate',direction:'ASC',cast:'date'},{key:'startTime',direction:'ASC',cast:'time'},{key:'id',direction:'ASC',cast:'text'}]});
  const first=await read();await read(first.meta.nextCursor!);
  const seek=calls.find(sql=>sql.includes('WHERE ('))!;
  assert.match(seek,/r\."slotDate"::date > \$1::date/);
  assert.match(seek,/r\."slotDate"::date IS NOT DISTINCT FROM \$1::date/);
  assert.match(seek,/r\."startTime"::time > \$2::time/);
  assert.match(seek,/r\."startTime"::time IS NOT DISTINCT FROM \$2::time/);
  assert.match(seek,/ORDER BY r\."slotDate"::date ASC NULLS LAST,r\."startTime"::time ASC NULLS LAST,r\."id"::text ASC NULLS LAST/);
});

test('read composition rejects duplicate cursors items revisions and oversized results',async()=>{
  const f=fixture(2),first=await f.read({limit:1});
  await assert.rejects(collectReadPages(async()=>first),error=>error instanceof DomainError&&error.code==='APPOINTMENT_READ_SNAPSHOT_CHANGED');
  await assert.rejects(collectReadPages(async()=>({...first,items:[{id:'one',body:'x'.repeat(64)}]}),32),error=>error instanceof DomainError&&error.code==='APPOINTMENT_READ_BUDGET_EXCEEDED');
  let calls=0;
  await assert.rejects(collectReadPages(async()=>({...first,items:[{id:String(calls)}],meta:{...first.meta,snapshot:String(++calls).padStart(64,'0')}})),
    error=>error instanceof DomainError&&error.code==='APPOINTMENT_READ_SNAPSHOT_CHANGED');
});
