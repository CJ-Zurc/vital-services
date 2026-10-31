import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError, requireScope, type Actor } from '../../contracts/actor.js';
import { appendSqlOutbox } from '../../infrastructure/outbox.js';
import { appointmentCommand, assertCalendarAvailable, calendarLock, membership } from './appointment.js';
import { blockSelection, selectedBlockDates } from './date-selection.js';
import { scheduleInput, slotInterval, type AppointmentCommand } from './appointment-contracts.js';

export const slotBatchInput=z.object({selection:blockSelection,
  times:z.array(scheduleInput.pick({startTime:true,endTime:true})).min(1).max(10),
  consultationType:z.enum(['virtual','in_person','both']),isPublished:z.boolean()}).strict();
export function expandSlotBatch(raw:unknown,now=Date.now()) {
  const input=slotBatchInput.parse(raw);
  if(input.selection.dates && new Set(input.selection.dates).size!==input.selection.dates.length)
    throw new DomainError(400,'SCHEDULE_DUPLICATE_DATE','Select each date once.');
  const dates=selectedBlockDates(input.selection,now);
  if(dates.length*input.times.length>1000)throw new DomainError(400,'SCHEDULE_BATCH_LIMIT','Create at most 1,000 slots at once.');
  return dates.flatMap(slotDate=>input.times.map(time=>{
    const slot=scheduleInput.parse({...time,slotDate,consultationType:input.consultationType,isPublished:input.isPublished});
    return {...slot,...slotInterval(slotDate,time.startTime,time.endTime)};
  })).sort((a,b)=>a.startsAt.getTime()-b.startsAt.getTime());
}
async function review(tx:PoolClient,actor:Actor,raw:unknown,now:number) {
  const input=slotBatchInput.parse(raw),doctor=await membership(tx,actor,'doctor');
  await calendarLock(tx,doctor.userId);
  if(!doctor.specialty?.trim())throw new DomainError(422,'DOCTOR_SPECIALTY_REQUIRED','Configure your specialty first.');
  if(!doctor.availabilityType || doctor.availabilityType!=='both' && doctor.availabilityType!==input.consultationType)
    throw new DomainError(422,'SCHEDULE_CARE_MODE_UNAVAILABLE','Select a consultation mode supported by your profile.');
  const slots=expandSlotBatch(input,now),conflicts:{slotDate:string;startTime:string;endTime:string;code:string}[]=[];
  for(let index=0;index<slots.length;index++) {
    const slot=slots[index]!;
    let code=slot.startsAt.getTime()<=now?'SLOT_IN_PAST':null;
    if(index && slots[index-1]!.endsAt>slot.startsAt)code='SCHEDULE_BATCH_OVERLAP';
    if(!code){
      const existing=await tx.query(`SELECT id FROM schedules WHERE "doctorId"=$1 AND
        ("slotDate"+"startTime") AT TIME ZONE 'Asia/Manila'<$3 AND
        ("slotDate"+"endTime"+CASE WHEN "endTime"<="startTime" THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END) AT TIME ZONE 'Asia/Manila'>$2 LIMIT 1`,[doctor.userId,slot.startsAt,slot.endsAt]);
      if(existing.rows.length)code='SCHEDULE_OVERLAP';
    }
    if(!code)try{await assertCalendarAvailable(tx,doctor.userId,slot.startsAt,slot.endsAt);}catch(error){if(error instanceof DomainError)code=error.code;else throw error;}
    if(code)conflicts.push({slotDate:slot.slotDate,startTime:slot.startTime,endTime:slot.endTime,code});
  }
  return {doctor,slots,conflicts};
}
export async function previewSlotBatch(pool:Pool,actor:Actor,raw:unknown,now=Date.now()) {
  requireScope(actor,'appointments.schedule.write',actor.authId);
  const tx=await pool.connect();
  try{await tx.query('BEGIN');const result=await review(tx,actor,raw,now);await tx.query('COMMIT');
    return {slots:result.slots.map(({startsAt,endsAt,...slot})=>slot),conflicts:result.conflicts};
  }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
}
export async function createSlotBatch(pool:Pool,actor:Actor,meta:AppointmentCommand,raw:unknown,now=Date.now()) {
  const input=slotBatchInput.parse(raw);
  return appointmentCommand(pool,actor,'schedule.write',actor.authId,meta,input,async tx=>{
    const result=await review(tx,actor,input,now);
    if(result.conflicts.length)return {createdCount:0,slotIds:[],conflicts:result.conflicts};
    const slotIds:string[]=[];
    for(const slot of result.slots){const id=randomUUID();
      await tx.query(`INSERT INTO schedules(id,"doctorId","slotDate","startTime","endTime","consultationType","isPublished","createdAt",version)
        VALUES($1,$2,$3::date,$4::time,$5::time,$6::"ConsultationType",$7,NOW(),0)`,[id,result.doctor.userId,slot.slotDate,slot.startTime,slot.endTime,slot.consultationType,slot.isPublished]);
      await appendSqlOutbox(tx,{producer:'appointment',eventType:'vital.audit.requested',aggregateId:id,aggregateVersion:0,
        correlationId:actor.correlationId,causationId:meta.operationId,data:{auditType:'vital.appointment.schedule_created',actorAuthId:actor.authId,resourceId:id,resourceType:'appointment'}});
      slotIds.push(id);
    }
    return {slotIds,createdCount:slotIds.length,conflicts:[]};
  });
}
