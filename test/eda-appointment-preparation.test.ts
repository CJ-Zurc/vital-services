import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import type { Actor } from '../src/eda/contracts/actor.js';
import { DomainError } from '../src/eda/contracts/actor.js';
import { createAppointmentCommandPreparation } from '../src/eda/modules/appointment/appointment-command-preparation.js';

function fixture(){
  const authId=randomUUID(),commandId=randomUUID(),resource=randomUUID(),userId=randomUUID();
  const actor:Actor={authId,role:'doctor',resource:commandId,scopes:['appointments.command.prepare'],serviceId:'vital-web',correlationId:randomUUID(),isSuperAdmin:false};
  let stored:Record<string,unknown>|undefined,version=3,revoked=false;const calls:string[]=[];
  const tx={release(){},async query(sql:string,args:unknown[]=[]){calls.push(sql);
    if(/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)||sql.includes('pg_advisory_xact_lock'))return{rows:[]};
    if(sql.includes('SELECT * FROM appointment_command_preparations'))return{rows:stored?[stored]:[]};
    if(sql.includes('SELECT p.* FROM vital_'))return{rows:revoked?[]:[{userId}]};
    if(sql.includes('SELECT version FROM schedules'))return{rows:[{version}]};
    if(sql.includes('INSERT INTO appointment_command_preparations')){
      stored={actorRole:args[2],commandId:args[3],action:args[4],resource:args[5],browserHash:args[6],bindingHash:args[7],
        expectedVersion:args[8],expectedSourceVersion:args[9],sourceAppointmentId:args[10]};return{rows:[]};
    }
    throw new Error('Unexpected preparation query');
  }};
  const module=createAppointmentCommandPreparation({connect:async()=>tx} as unknown as Pool);
  const input={commandId,resource,action:'schedule.write',browserHash:'a'.repeat(64)};
  return{actor,input,module,calls,change(){version++;},revoke(){revoked=true;}};
}

test('appointment command preparation pins omitted versions across retries and rejects changed binding',async()=>{
  const f=fixture(),first=await f.module.prepare(f.actor,f.input);assert.equal(first.expectedVersion,3);f.change();
  assert.deepEqual(await f.module.prepare(f.actor,f.input),first);
  const readActor={...f.actor,scopes:['appointments.command.read']};assert.deepEqual(await f.module.read(readActor,f.input.commandId),first);
  await assert.rejects(f.module.prepare(f.actor,{...f.input,browserHash:'b'.repeat(64)}),error=>error instanceof DomainError&&error.code==='COMMAND_REPLAY_CONFLICT');
  assert.equal(f.calls.filter(sql=>sql.includes('INSERT INTO appointment_command_preparations')).length,1);
});

test('appointment command preparation rechecks current membership and explicit stale revisions',async()=>{
  const f=fixture();await assert.rejects(f.module.prepare(f.actor,{...f.input,expectedVersion:1}),error=>error instanceof DomainError&&error.code==='APPOINTMENT_VERSION_CHANGED');
  await f.module.prepare(f.actor,f.input);f.revoke();
  await assert.rejects(f.module.prepare(f.actor,f.input),error=>error instanceof DomainError&&error.code==='APPOINTMENT_MEMBERSHIP_REVOKED');
  await assert.rejects(f.module.read({...f.actor,scopes:['appointments.command.read']},f.input.commandId),error=>error instanceof DomainError&&error.code==='APPOINTMENT_MEMBERSHIP_REVOKED');
  await assert.rejects(f.module.prepare({...f.actor,resource:randomUUID()},f.input),error=>error instanceof DomainError&&error.code==='ACTOR_SCOPE_DENIED');
});
