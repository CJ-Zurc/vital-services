import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { DomainError, AppointmentPendingConflictsError, requireScope, type Actor } from "../../contracts/actor.js";
import { requestHash } from "../../infrastructure/security.js";
import { appendSqlOutbox } from "../../infrastructure/outbox.js";
import { acknowledgementInput, appointmentExpired, appointmentFactData, dateBlockInput, reasonInput,
  requireOwner, scheduleInput, slotInterval, versionSchema, effectiveCompletionDeadline, type AppointmentRow, type AppointmentCommand,
  type AppointmentOwners } from "./appointment-contracts.js";
import { complaintSchema, emergencyContactSchema, intakeSchema } from "./appointment-intake.js";
import { saveBookingContact } from "../profile/profile-booking.js";
import { upgradeScheduleAvailability } from '../profile/profile-schedule.js';
import { videoSelection,selectionHash,type VideoSelection } from '../video/contracts.js';

const selectAppointment = `SELECT a.*, p."authId" AS "patientAuthId", d."authId" AS "doctorAuthId",
  CASE WHEN s.id IS NOT NULL THEN (s."slotDate"+s."endTime"+CASE WHEN s."endTime"<=s."startTime" THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END) AT TIME ZONE 'Asia/Manila' END AS "slotEndsAt",
  (SELECT "changedByRole" FROM appointment_logs WHERE "appointmentId"=a.id ORDER BY "changedAt",id LIMIT 1) AS "proposalRole"
  FROM appointments a JOIN vital_patients p ON p."userId"=a."patientId"
  JOIN vital_doctors d ON d."userId"=a."doctorId" LEFT JOIN schedules s ON s.id=a."scheduleSlotId"`;
const bookingInput = z.object({ doctorId: z.uuid().optional(), scheduleSlotId: z.uuid().optional(), consultationType: z.enum(["virtual","in_person"]),
  slotDate: scheduleInput.shape.slotDate.optional(), startTime: scheduleInput.shape.startTime.optional(), endTime: scheduleInput.shape.endTime.optional(),
  consentAccepted: z.literal(true), chiefComplaint: complaintSchema, opqrst: intakeSchema, emergencyContact: emergencyContactSchema,
  ehrPatientId: z.uuid() }).strict().refine(input=>!!input.doctorId||!!input.scheduleSlotId,{message:"A doctor or published schedule is required."});
const proposalInput = z.object({ expectedVersion: versionSchema, reason: z.string().trim().min(1).max(2000),
  slotDate: scheduleInput.shape.slotDate, startTime: scheduleInput.shape.startTime, endTime: scheduleInput.shape.endTime }).strict();
const preparedInput = z.object({ workflowId: z.uuid(), appointmentId: z.uuid(), expectedVersion: versionSchema,
  kind: z.enum(["approve","follow-up"]),consultationType:z.enum(["virtual","in_person"]).optional(),confirmConflicts:z.boolean().optional(),
  ...videoSelection.shape,
  slotDate:scheduleInput.shape.slotDate.optional(),startTime:scheduleInput.shape.startTime.optional(),endTime:scheduleInput.shape.endTime.optional() }).strict();
const commitInput = z.object({ inputHash: z.string().regex(/^[a-f0-9]{64}$/), receipt: z.object({
  ehrPatientId: z.uuid(), ehrCaseId: z.uuid(), externalSystemRef: z.string().max(96), requestHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict() }).strict();
function fail(status: number, code: string): never { throw new DomainError(status, code, "Appointment operation is unavailable."); }
export async function calendarLock(tx: PoolClient, doctorId: string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["appointment-calendar:"+doctorId]);
}
export async function patientRetentionLock(tx: PoolClient, patientId: string) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['messaging-patient-retention:' + patientId]);
}
export async function readAppointment(tx: Pick<PoolClient,"query">, id: string, locked = false): Promise<AppointmentRow> {
  z.uuid().parse(id);
  const row = (await tx.query<AppointmentRow>(selectAppointment + ` WHERE a.id=$1 ${locked ? "FOR UPDATE OF a" : ""}`, [id])).rows[0];
  if (!row) fail(404,"APPOINTMENT_NOT_FOUND");
  return row;
}
export async function lockAppointment(tx: PoolClient, id: string) {
  const prior = await readAppointment(tx,id);
  await calendarLock(tx,prior.doctorId);
  return readAppointment(tx,id,true);
}
export function appointmentOwn(actor: Actor, row: AppointmentRow) {
  if (actor.role === "patient" ? actor.authId !== row.patientAuthId : actor.role === "doctor" ? actor.authId !== row.doctorAuthId : true) fail(403,"APPOINTMENT_OWNER_DENIED");
}
export async function membership(tx: Pick<PoolClient,"query">, actor: Actor, role = actor.role) {
  if (actor.role !== role || !["patient","doctor"].includes(role)) fail(403,"APPOINTMENT_ROLE_DENIED");
  const table = role === "patient" ? "vital_patients" : "vital_doctors";
  const row = (await tx.query<{ userId: string; ehrPatientId?: string; isRecordAvailable?: boolean; isOnboardingComplete?: boolean;
    specialty?: string; availabilityType?: string; virtualFee?: string; inPersonFee?: string }>(
    `SELECT p.* FROM ${table} p JOIN vital_users u ON u.id=p."userId" AND u."authId"=p."authId" WHERE p."authId"=$1 AND u.role=$2`, [actor.authId, role])).rows[0];
  if (!row) fail(403,"APPOINTMENT_MEMBERSHIP_REVOKED");
  return row;
}
export async function assertCalendarAvailable(tx: PoolClient, doctorId: string, start: Date, end: Date, exclude: string[] = [], operationId?: string) {
  if (!(end > start)) fail(400,"SLOT_INTERVAL_INVALID");
  const blocked = await tx.query(`SELECT id FROM doctor_date_blocks WHERE doctor_id=$1 AND EXISTS(
    SELECT 1 FROM generate_series(($2::timestamptz AT TIME ZONE 'Asia/Manila')::date,
      (($3::timestamptz-INTERVAL '1 microsecond') AT TIME ZONE 'Asia/Manila')::date,INTERVAL '1 day') day
    WHERE day::date BETWEEN start_date AND end_date AND (weekday IS NULL OR weekday=EXTRACT(DOW FROM day))) LIMIT 1`,[doctorId,start,end]);
  if (blocked.rows.length) fail(409,"CALENDAR_DATE_BLOCKED");
  const occupied = await tx.query(`SELECT a.id FROM appointments a LEFT JOIN schedules s ON s.id=a."scheduleSlotId"
    WHERE a."doctorId"=$1 AND a.status IN ('approved','confirmed') AND NOT(a.id=ANY($4::text[])) AND a."scheduledAt"<$3
    AND COALESCE((s."slotDate"+s."endTime"+CASE WHEN s."endTime"<=s."startTime" THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END) AT TIME ZONE 'Asia/Manila',a."proposedEndAt",a."scheduledAt")>$2 LIMIT 1`,[doctorId,start,end,exclude]);
  const holds = await tx.query(`SELECT id FROM slot_reservations WHERE "doctorId"=$1 AND status='reserved'
    AND "leaseUntil">CURRENT_TIMESTAMP AND "startsAt"<$3 AND "endsAt">$2 AND ($4::text IS NULL OR "operationId"<>$4) LIMIT 1`,[doctorId,start,end,operationId ?? null]);
  if (occupied.rows.length || holds.rows.length) fail(409,"CALENDAR_INTERVAL_OCCUPIED");
}
export async function appointmentCommand<T>(pool: Pool, actor: Actor, action: string, resource: string, meta: AppointmentCommand, input: unknown,
  run: (tx: PoolClient) => Promise<T>) {
  requireScope(actor,"appointments."+action,resource); z.uuid().parse(meta.operationId); z.string().regex(/^[a-f0-9]{64}$/).parse(meta.requestHash);
  const hash=requestHash("APPOINTMENT-COMMAND",action,{ role: actor.role, resource, input, transportHash: meta.requestHash });
  const tx=await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["appointment-command:"+actor.authId+":"+meta.operationId]);
    await membership(tx,actor);
    const old=(await tx.query<{ action:string; resourceId:string; requestHash:string; status:string; result:T }>(
      'SELECT * FROM command_operations WHERE "actorId"=$1 AND "operationId"=$2',[actor.authId,meta.operationId])).rows[0];
    if(old) {
      if(old.action!==action || old.resourceId!==resource || old.requestHash!==hash) fail(409,"COMMAND_REPLAY_CONFLICT");
      if(old.status!=="completed") fail(409,"COMMAND_PENDING");
      await tx.query("COMMIT"); return old.result;
    }
    const result=await run(tx);
    await tx.query(`INSERT INTO command_operations (id,"actorId","operationId",action,"resourceId","requestHash",status,result,"createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,'completed',$7::jsonb,NOW(),NOW())`,[randomUUID(),actor.authId,meta.operationId,action,resource,hash,JSON.stringify(result)]);
    await tx.query("COMMIT"); return result;
  } catch(error) {await tx.query("ROLLBACK");throw error;} finally{tx.release();}
}
export async function appointmentTransition(tx: PoolClient,row: AppointmentRow,status:string,actor: Actor|null,operationId:string,correlationId:string,note:string|null=null,extra:Record<string,unknown>={}) {
  if (status === 'completed') await patientRetentionLock(tx, row.patientId);
  const logId=randomUUID(); const changedAt=new Date(); const prior=row.status;
  const result=await tx.query('UPDATE appointments SET status=$2::"AppointmentStatus",version=version+1,"updatedAt"=$3 WHERE id=$1 AND version=$4 RETURNING version',[row.id,status,changedAt,row.version]);
  if(result.rowCount!==1) fail(409,"APPOINTMENT_VERSION_CHANGED");
  row.version=result.rows[0].version;row.status=status;
  await tx.query(`INSERT INTO appointment_logs (id,"appointmentId","fromStatus","toStatus","changedByRole",note,"changedAt") VALUES ($1,$2,$3,$4,$5,$6,$7)`,[logId,row.id,prior,status,actor?.role??"service",note,changedAt]);
  const action=status==="pending"||status==="pending_patient_confirmation"?"requested":status;
  await appendSqlOutbox(tx,{producer:"appointment",eventType:("vital.appointment."+action) as Parameters<typeof appendSqlOutbox>[1]["eventType"],aggregateId:row.id,
    aggregateVersion:row.version,correlationId,causationId:operationId,data:{...appointmentFactData(row,actor?.authId??null,operationId),...extra}});
  await appendSqlOutbox(tx,{producer:"appointment",eventType:"vital.audit.requested",aggregateId:row.id,aggregateVersion:row.version,correlationId,causationId:operationId,
    data:{auditType:"vital.appointment."+action,actorAuthId:actor?.authId??null,resourceId:row.id,resourceType:"appointment"}});
  return {logId,changedAt};
}

export async function abandonExpiredAppointmentWorkflow(pool:Pool,id:string,clock=Date.now){
  z.uuid().parse(id);const tx=await pool.connect();try{await tx.query('BEGIN');
    const preview=(await tx.query('SELECT "appointmentId" FROM appointment_workflows WHERE id=$1::uuid',[id])).rows[0];
    if(!preview){await tx.query('COMMIT');return false;}
    const source=await lockAppointment(tx,preview.appointmentId);
    const abandoned=(await tx.query(`UPDATE appointment_workflows SET state='abandoned',"updatedAt"=NOW() WHERE id=$1::uuid AND state='prepared' AND "externalStartedAt" IS NULL AND "expiresAt"<=$2 RETURNING "targetAppointmentId","videoCorrelationId"`,[id,new Date(clock())])).rows[0];
    if(abandoned?.targetAppointmentId&&abandoned.targetAppointmentId!==source.id){const draft=await readAppointment(tx,abandoned.targetAppointmentId,true);
      if(draft.status==='pending')await appointmentTransition(tx,draft,'rejected',null,id,abandoned.videoCorrelationId??randomUUID(),'workflow_abandoned');}
    await tx.query('COMMIT');return!!abandoned;
  }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
}
async function noTransition(tx: PoolClient,row:AppointmentRow) {
  if((await tx.query(`SELECT id FROM saga_operations WHERE "billingLineageId"=$1 AND status NOT IN ('completed','compensated','cancelled','failed') LIMIT 1`,[row.billingLineageId])).rows.length) fail(409,"APPOINTMENT_TRANSITION_PENDING");
  if((await tx.query(`SELECT id FROM appointment_workflows WHERE "targetAppointmentId"=$1 AND state='committed' AND "videoProcessingState"<>'finalized' LIMIT 1`,[row.id])).rows.length)fail(409,'APPOINTMENT_VIDEO_FINALIZATION_PENDING');
}
async function noProposal(tx:PoolClient,row:AppointmentRow) {
  if((await tx.query(`SELECT id FROM appointments WHERE "sourceAppointmentId"=$1 AND status IN ('pending','pending_patient_confirmation') LIMIT 1`,[row.id])).rows.length) fail(409,"APPOINTMENT_PROPOSAL_PENDING");
}
export async function resolveOpenProposals(tx:PoolClient,row:AppointmentRow,actor:Actor|null,operationId:string,correlationId:string,reason:string){
  const proposals=(await tx.query<AppointmentRow>(selectAppointment+` WHERE a."sourceAppointmentId"=$1 AND a.status IN ('pending','pending_patient_confirmation') FOR UPDATE OF a`,[row.id])).rows;
  for(const proposal of proposals)await appointmentTransition(tx,proposal,"rejected",actor,operationId,correlationId,reason);
}
function expected(row:AppointmentRow,version:number) { if(row.version!==version) fail(409,"APPOINTMENT_VERSION_CHANGED"); }
async function calendarAudit(tx:PoolClient,id:string,version:number,actor:Actor,operationId:string,action:string){
  await appendSqlOutbox(tx,{producer:'appointment',eventType:'vital.audit.requested',aggregateId:id,aggregateVersion:version,correlationId:actor.correlationId,causationId:operationId,
    data:{auditType:'vital.appointment.'+action,actorAuthId:actor.authId,resourceId:id,resourceType:'appointment'}});
}

export function createAppointmentModule(pool: Pool, owners: AppointmentOwners = {}, clock=Date.now) {
  const mutate=<T>(actor:Actor,action:string,resource:string,meta:AppointmentCommand,input:unknown,run:(tx:PoolClient)=>Promise<T>)=>appointmentCommand(pool,actor,action,resource,meta,input,run);
  async function finalizeVideo<T extends {operationStatus:string}>(id:string,result:T):Promise<T>{
    const video=requireOwner(owners.video,'video');
    try{await video.finalizeWorkflow(id);return{...result,operationStatus:'completed'};}
    catch{return{...result,operationStatus:'processing'};}
  }
  async function applyCancellation(tx:PoolClient,row:AppointmentRow,actor:Actor,operationId:string,reason:string) {
    const records=requireOwner(owners.records,"records"); await noTransition(tx,row);
    if(actor.role==="doctor" ? !["approved","confirmed"].includes(row.status) : !["pending","approved","confirmed"].includes(row.status)) fail(409,"APPOINTMENT_CANCEL_INVALID");
    await records.apply(tx,row,"cancel",{operationId,beforeState:row.status,afterState:"cancelled",effectiveAt:new Date(clock())});
    await resolveOpenProposals(tx,row,actor,operationId,actor.correlationId,"source_cancelled");
    await tx.query('UPDATE appointments SET "cancellationReason"=$2 WHERE id=$1',[row.id,reason]);
    const receipt=await appointmentTransition(tx,row,"cancelled",actor,operationId,actor.correlationId,reason);
    await billingIntent(tx,row,actor,operationId,receipt,"refund");
    await billingIntent(tx,row,actor,operationId,receipt,"expire");
    await appendSqlOutbox(tx,{producer:"appointment",eventType:"vital.notification.requested",aggregateId:row.id,aggregateVersion:row.version,correlationId:actor.correlationId,
      data:{requestId:randomUUID(),recipientAuthId:actor.role==="doctor"?row.patientAuthId:row.doctorAuthId,appointmentId:row.id,template:"appointment.cancelled",parameters:{}}});
  }
  async function billingIntent(tx:PoolClient,row:AppointmentRow,actor:Actor,operationId:string,receipt:{logId:string;changedAt:Date},kind:string) {
    const quote=(await tx.query('SELECT "billingLineageId" FROM appointment_billing_quotes WHERE "billingLineageId"=$1',[row.billingLineageId])).rows[0];
    if(!quote) return;
    const projection=kind==='complete'?(await tx.query('SELECT "sourceVersion" FROM appointment_payment_projections WHERE "appointmentId"=$1',[row.id])).rows[0]:null;
    // Each financial participant command has its own stable ID, bound to one owner log.
    await tx.query(`INSERT INTO appointment_billing_intents
      (id,"appointmentId","billingLineageId","appointmentVersion","associationVersion","actorAuthId","operationId","requestHash",kind,state,"expiresAt","committedAt","ownerLogId","expectedPaymentVersion","createdAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'committed',$10,$10,$11,$12,NOW())`,[randomUUID(),row.id,row.billingLineageId,row.version,row.associationVersion,actor.authId,randomUUID(),requestHash("OWNER-INTENT",kind,{operationId,logId:receipt.logId}),kind,receipt.changedAt,receipt.logId,projection?.sourceVersion??null]);
  }
  return {
    owners,
    async read(actor:Actor,id:string) {requireScope(actor,"appointments.read",id);await membership(pool,actor);const row=await readAppointment(pool,id);appointmentOwn(actor,row);return row;},
    async createSchedule(actor:Actor,meta:AppointmentCommand,body:unknown) {const input=scheduleInput.parse(body);
      return mutate(actor,"schedule.write",actor.authId,meta,input,async tx=>{const member=await membership(tx,actor,"doctor");await calendarLock(tx,member.userId);
        if(!member.specialty?.trim()) fail(422,"DOCTOR_SPECIALTY_REQUIRED");
        const interval=slotInterval(input.slotDate,input.startTime,input.endTime); if(interval.startsAt.getTime()<=clock()) fail(400,"SLOT_IN_PAST");
        await assertCalendarAvailable(tx,member.userId,interval.startsAt,interval.endsAt);
        const overlapping=await tx.query(`SELECT id FROM schedules WHERE "doctorId"=$1 AND ("slotDate"+"startTime") AT TIME ZONE 'Asia/Manila'<$3
          AND ("slotDate"+"endTime"+CASE WHEN "endTime"<="startTime" THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END) AT TIME ZONE 'Asia/Manila'>$2 LIMIT 1`,[member.userId,interval.startsAt,interval.endsAt]);
        if(overlapping.rows.length) fail(409,"SCHEDULE_OVERLAP");
        await upgradeScheduleAvailability(tx,actor,{doctorId:member.userId,consultationType:input.consultationType,resource:actor.authId});
        const id=randomUUID();await tx.query(`INSERT INTO schedules (id,"doctorId","slotDate","startTime","endTime","consultationType","isPublished","createdAt",version) VALUES($1,$2,$3::date,$4::time,$5::time,$6::"ConsultationType",$7,NOW(),0)`,[id,member.userId,input.slotDate,input.startTime,input.endTime,input.consultationType,input.isPublished]);
        await calendarAudit(tx,id,0,actor,meta.operationId,'schedule_created');
        return {id,version:0,...input};});},
    async changeSchedule(actor:Actor,id:string,meta:AppointmentCommand,body:unknown,remove=false) {
      const input=remove?acknowledgementInput.extend({cancellationReason:z.string().trim().min(1).max(2000).optional()}).strict().parse(body):scheduleInput.partial().extend({expectedVersion:versionSchema,cancellationReason:z.string().trim().min(1).max(2000).optional()}).strict().parse(body);
      return mutate(actor,"schedule.write",id,meta,{...input,remove},async tx=>{const member=await membership(tx,actor,"doctor");await calendarLock(tx,member.userId);
        const slot=(await tx.query('SELECT * FROM schedules WHERE id=$1 AND "doctorId"=$2 FOR UPDATE',[id,member.userId])).rows[0];
        if(!slot) fail(404,"SCHEDULE_NOT_FOUND");if(slot.version!==input.expectedVersion) fail(409,"SCHEDULE_VERSION_CHANGED");
        const affected=(await tx.query<AppointmentRow>(selectAppointment+" WHERE a.\"scheduleSlotId\"=$1 FOR UPDATE OF a",[id])).rows;
        const holds=await tx.query(`SELECT id FROM slot_reservations WHERE "doctorId"=$1 AND status='reserved' AND "leaseUntil">NOW() LIMIT 1`,[member.userId]);
        if(holds.rows.length) fail(409,"CALENDAR_TRANSITION_PENDING");
        const patch=input as Partial<z.infer<typeof scheduleInput>>&{expectedVersion:number;cancellationReason?:string};
        const next={slotDate:slot.slotDate.toISOString().slice(0,10),startTime:slot.startTime.slice(0,5),endTime:slot.endTime.slice(0,5),consultationType:slot.consultationType,isPublished:slot.isPublished,...patch};
        const changesBooking=remove||next.slotDate!==slot.slotDate.toISOString().slice(0,10)||next.startTime!==slot.startTime.slice(0,5)||next.endTime!==slot.endTime.slice(0,5)||next.consultationType!==slot.consultationType;
        const cancellations=changesBooking?affected.filter(row=>["approved","confirmed"].includes(row.status)):[];
        if(cancellations.length){requireOwner(owners.records,"records");if(!patch.cancellationReason)fail(400,"CANCELLATION_REASON_REQUIRED");}
        for(const row of cancellations) await applyCancellation(tx,row,actor,meta.operationId,patch.cancellationReason!);
        // Editing occupied history changes the calendar only after cancellation; preserve its original appointment timing.
        if(changesBooking)for(const row of affected) await tx.query('UPDATE appointments SET "scheduleSlotId"=NULL,"proposedEndAt"=COALESCE("proposedEndAt",$2) WHERE id=$1',[row.id,row.slotEndsAt]);
        if(remove){await tx.query('DELETE FROM schedules WHERE id=$1',[id]);await calendarAudit(tx,id,slot.version+1,actor,meta.operationId,'schedule_deleted');return{id,deleted:true};}
        scheduleInput.parse({slotDate:next.slotDate,startTime:next.startTime,endTime:next.endTime,consultationType:next.consultationType,isPublished:next.isPublished});
        const range=slotInterval(next.slotDate,next.startTime,next.endTime);
        if(changesBooking&&range.startsAt.getTime()<=clock())fail(400,"SLOT_IN_PAST");
        if(changesBooking)await assertCalendarAvailable(tx,member.userId,range.startsAt,range.endsAt);
        const overlap=await tx.query(`SELECT id FROM schedules WHERE "doctorId"=$1 AND id<>$4 AND ("slotDate"+"startTime") AT TIME ZONE 'Asia/Manila'<$3
          AND ("slotDate"+"endTime"+CASE WHEN "endTime"<="startTime" THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END) AT TIME ZONE 'Asia/Manila'>$2 LIMIT 1`,[member.userId,range.startsAt,range.endsAt,id]);
        if(overlap.rows.length)fail(409,"SCHEDULE_OVERLAP");
        await upgradeScheduleAvailability(tx,actor,{doctorId:member.userId,consultationType:next.consultationType,resource:id});
        await tx.query(`UPDATE schedules SET "slotDate"=$2::date,"startTime"=$3::time,"endTime"=$4::time,"consultationType"=$5::"ConsultationType","isPublished"=$6,version=version+1 WHERE id=$1`,[id,next.slotDate,next.startTime,next.endTime,next.consultationType,next.isPublished]);
        await calendarAudit(tx,id,slot.version+1,actor,meta.operationId,'schedule_updated');
        return{id,slotDate:next.slotDate,startTime:next.startTime,endTime:next.endTime,consultationType:next.consultationType,isPublished:next.isPublished,version:slot.version+1};});},
    async createDateBlock(actor:Actor,meta:AppointmentCommand,body:unknown){const input=dateBlockInput.parse(body);return mutate(actor,"blocks.write",actor.authId,meta,input,async tx=>{
      const member=await membership(tx,actor,"doctor");await calendarLock(tx,member.userId);
      const duplicate=await tx.query('SELECT id FROM doctor_date_blocks WHERE doctor_id=$1 AND start_date=$2::date AND end_date=$3::date AND weekday IS NOT DISTINCT FROM $4',[member.userId,input.startDate,input.endDate,input.weekday]);
      if(duplicate.rows.length)fail(409,"DATE_BLOCK_EXISTS");
      const count=Number((await tx.query(`SELECT count(*) FROM appointments a LEFT JOIN schedules s ON s.id=a."scheduleSlotId"
        WHERE a."doctorId"=$1 AND a.status IN ('pending','approved','confirmed','pending_patient_confirmation') AND EXISTS(
          SELECT 1 FROM generate_series(((a."scheduledAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Manila')::date,
            (COALESCE((s."slotDate"+s."endTime"+CASE WHEN s."endTime"<=s."startTime" THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END),
              ((COALESCE(a."proposedEndAt",a."scheduledAt") AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Manila'))
              -CASE WHEN s.id IS NOT NULL OR a."proposedEndAt" IS NOT NULL THEN INTERVAL '1 microsecond' ELSE INTERVAL '0 day' END)::date,INTERVAL '1 day') day
          WHERE day::date BETWEEN $2::date AND $3::date AND ($4::int IS NULL OR EXTRACT(DOW FROM day)=$4))`,[member.userId,input.startDate,input.endDate,input.weekday])).rows[0].count);
      if(count>0&&input.confirmedAppointmentCount!==count)fail(409,"DATE_BLOCK_ACKNOWLEDGEMENT_REQUIRED");
      const holds=await tx.query(`SELECT id FROM slot_reservations WHERE "doctorId"=$1 AND status='reserved' AND "leaseUntil">NOW() AND EXISTS(
        SELECT 1 FROM generate_series((("startsAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Manila')::date,
          (((("endsAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Manila')-INTERVAL '1 microsecond'))::date,INTERVAL '1 day') day
        WHERE day::date BETWEEN $2::date AND $3::date AND ($4::int IS NULL OR EXTRACT(DOW FROM day)=$4)) LIMIT 1`,[member.userId,input.startDate,input.endDate,input.weekday]);
      if(holds.rows.length)fail(409,"CALENDAR_TRANSITION_PENDING");const id=randomUUID();
      await tx.query('INSERT INTO doctor_date_blocks (id,doctor_id,start_date,end_date,weekday,created_at,version) VALUES($1,$2,$3::date,$4::date,$5,NOW(),0)',[id,member.userId,input.startDate,input.endDate,input.weekday]);await calendarAudit(tx,id,0,actor,meta.operationId,'date_block_created');return{block:{id,version:0,startDate:input.startDate,endDate:input.endDate,weekday:input.weekday},appointmentCount:count};});},
    async deleteDateBlock(actor:Actor,id:string,meta:AppointmentCommand,body:unknown){const input=acknowledgementInput.parse(body);return mutate(actor,"blocks.write",id,meta,input,async tx=>{
      const member=await membership(tx,actor,"doctor");await calendarLock(tx,member.userId);const result=await tx.query('DELETE FROM doctor_date_blocks WHERE id=$1 AND doctor_id=$2 AND version=$3 RETURNING id',[id,member.userId,input.expectedVersion]);if(result.rowCount!==1)fail(409,"DATE_BLOCK_VERSION_CHANGED");await calendarAudit(tx,id,input.expectedVersion+1,actor,meta.operationId,'date_block_deleted');return{id,deleted:true};});},
    async book(actor:Actor,meta:AppointmentCommand,body:unknown){const input=bookingInput.parse(body);return mutate(actor,"book",actor.authId,meta,input,async tx=>{
      const patient=await membership(tx,actor,"patient");if(!patient.isRecordAvailable||!patient.isOnboardingComplete||patient.ehrPatientId!==input.ehrPatientId)fail(409,"PATIENT_EHR_IDENTITY_UNVERIFIED");
      const selectedSlot=input.scheduleSlotId?(await tx.query('SELECT "doctorId" FROM schedules WHERE id=$1 AND "isPublished"=true',[input.scheduleSlotId])).rows[0]:null;
      if(input.scheduleSlotId&&(!selectedSlot||input.doctorId&&input.doctorId!==selectedSlot.doctorId))fail(409,"SCHEDULE_UNAVAILABLE");
      const doctorId=input.doctorId??selectedSlot.doctorId;
      const doctor=(await tx.query('SELECT d.* FROM vital_doctors d JOIN vital_users u ON u.id=d."userId" AND u."authId"=d."authId" WHERE d."userId"=$1',[doctorId])).rows[0];
      if(!doctor||!doctor.isDoctorOnboardingComplete||!doctor.specialty?.trim()||![input.consultationType,"both"].includes(doctor.availabilityType))fail(409,"DOCTOR_UNAVAILABLE");await calendarLock(tx,doctor.userId);
      let scheduleSlotId=input.scheduleSlotId??null;let range:{startsAt:Date;endsAt:Date};
      if(scheduleSlotId){const slot=(await tx.query('SELECT * FROM schedules WHERE id=$1 AND "doctorId"=$2 AND "isPublished"=true FOR UPDATE',[scheduleSlotId,doctorId])).rows[0];
        if(!slot||![input.consultationType,"both"].includes(slot.consultationType))fail(409,"SCHEDULE_UNAVAILABLE");range=slotInterval(slot.slotDate.toISOString().slice(0,10),slot.startTime.slice(0,5),slot.endTime.slice(0,5));}
      else{if(!input.slotDate||!input.startTime||!input.endTime)fail(400,"SCHEDULE_REQUIRED");range=slotInterval(input.slotDate,input.startTime,input.endTime);}
      if(range.startsAt.getTime()<=clock())fail(400,"SLOT_IN_PAST");await assertCalendarAvailable(tx,doctorId,range.startsAt,range.endsAt);
      const duplicate=await tx.query(`SELECT id FROM appointments WHERE "patientId"=$1 AND "doctorId"=$2 AND "scheduledAt"=$3 AND status IN ('pending','approved','confirmed') LIMIT 1`,[patient.userId,doctorId,range.startsAt]);if(duplicate.rows.length)fail(409,"APPOINTMENT_REQUEST_EXISTS");
      const id=randomUUID();await tx.query(`INSERT INTO appointments (id,"patientId","doctorId","scheduleSlotId","consultationType",status,"scheduledAt","proposedEndAt","billingLineageId","createdAt","updatedAt")
        VALUES($1,$2,$3,$4,$5::"ConsultationType",'pending',$6,$7,$8,NOW(),NOW())`,[id,patient.userId,doctorId,scheduleSlotId,input.consultationType,range.startsAt,range.endsAt,randomUUID()]);
      await tx.query('INSERT INTO pre_consultations (id,"appointmentId","chiefComplaint",opqrst,"isSubmitted","submittedAt") VALUES($1,$2,$3,$4::jsonb,true,NOW())',[randomUUID(),id,input.chiefComplaint,JSON.stringify(input.opqrst)]);
      await tx.query(`INSERT INTO consent_records (id,"patientId","appointmentId","consentType",accepted,"consentedAt") VALUES($1,$2,$3,'medical_record',true,NOW())`,[randomUUID(),patient.userId,id]);
      await saveBookingContact(tx,actor,patient.userId,input.emergencyContact);
      const row=await readAppointment(tx,id);await appointmentTransition(tx,row,"pending",actor,meta.operationId,actor.correlationId);
      return{id,version:row.version,status:row.status,operationStatus:"completed"};});},
    async reject(actor:Actor,id:string,meta:AppointmentCommand,body:unknown){const input=reasonInput.parse(body);return mutate(actor,"reject",id,meta,input,async tx=>{
      await membership(tx,actor,"doctor");const row=await lockAppointment(tx,id);appointmentOwn(actor,row);expected(row,input.expectedVersion);await noTransition(tx,row);
      if(row.status!=="pending"||appointmentExpired(row,clock()))fail(409,"APPOINTMENT_REJECT_INVALID");await tx.query('UPDATE appointments SET "rejectionReason"=$2 WHERE id=$1',[id,input.reason]);await appointmentTransition(tx,row,"rejected",actor,meta.operationId,actor.correlationId,input.reason);return{id,version:row.version,status:row.status,operationStatus:"completed"};});},
    async propose(actor:Actor,id:string,meta:AppointmentCommand,body:unknown){const input=proposalInput.parse(body);return mutate(actor,"reschedule",id,meta,input,async tx=>{
      const row=await lockAppointment(tx,id);appointmentOwn(actor,row);expected(row,input.expectedVersion);await noTransition(tx,row);await noProposal(tx,row);
      if(!["approved","confirmed"].includes(row.status)||appointmentExpired(row,clock()))fail(409,"RESCHEDULE_INVALID");if((actor.role==="patient"?row.patientRescheduleCount:row.doctorRescheduleCount)>=2)fail(409,"RESCHEDULE_LIMIT_REACHED");
      const range=slotInterval(input.slotDate,input.startTime,input.endTime);if(range.startsAt.getTime()<=clock())fail(400,"SLOT_IN_PAST");await assertCalendarAvailable(tx,row.doctorId,range.startsAt,range.endsAt,[row.id]);
      const next=randomUUID();await tx.query(`INSERT INTO appointments (id,"patientId","doctorId","sourceAppointmentId","consultationType",status,"scheduledAt","proposedEndAt","billingLineageId","associationVersion","patientRescheduleCount","doctorRescheduleCount","createdAt","updatedAt")
        VALUES($1,$2,$3,$4,$5::"ConsultationType",$6::"AppointmentStatus",$7,$8,$9,$10,$11,$12,NOW(),NOW())`,[next,row.patientId,row.doctorId,row.id,row.consultationType,actor.role==="doctor"?"pending_patient_confirmation":"pending",range.startsAt,range.endsAt,row.billingLineageId,row.associationVersion,row.patientRescheduleCount,row.doctorRescheduleCount]);
      const proposal=await readAppointment(tx,next);await appointmentTransition(tx,proposal,proposal.status,actor,meta.operationId,actor.correlationId,input.reason);return{id:next,version:proposal.version,status:proposal.status,operationStatus:"completed"};});},
    async decline(actor:Actor,id:string,meta:AppointmentCommand,body:unknown){const input=reasonInput.parse(body);return mutate(actor,"decline-reschedule",id,meta,input,async tx=>{
      const row=await lockAppointment(tx,id);appointmentOwn(actor,row);expected(row,input.expectedVersion);await noTransition(tx,row);
      if(!row.sourceAppointmentId||row.status!=="pending_patient_confirmation"||actor.role!=="patient")fail(409,"RESCHEDULE_DECLINE_INVALID");await appointmentTransition(tx,row,"rejected",actor,meta.operationId,actor.correlationId,input.reason);return{id,version:row.version,status:row.status,operationStatus:"completed"};});},
    async cancel(actor:Actor,id:string,meta:AppointmentCommand,body:unknown){const input=reasonInput.parse(body);return mutate(actor,"cancel",id,meta,input,async tx=>{
      const row=await lockAppointment(tx,id);appointmentOwn(actor,row);expected(row,input.expectedVersion);if(appointmentExpired(row,clock()))fail(409,"APPOINTMENT_EXPIRED");await applyCancellation(tx,row,actor,meta.operationId,input.reason);return{id,version:row.version,status:row.status,operationStatus:"processing"};});},
    async prepareWorkflow(actor:Actor,meta:AppointmentCommand,body:unknown){const input=preparedInput.parse(body);
      const selection:VideoSelection=videoSelection.parse({...(input.meetingProvider?{meetingProvider:input.meetingProvider}:{}),...(input.meetingUrl?{meetingUrl:input.meetingUrl}:{}),...(input.meetingGenerationId?{meetingGenerationId:input.meetingGenerationId}:{})});
      const selectedHash=selectionHash(selection);
      const result=await mutate(actor,"workflow.prepare",input.appointmentId,meta,input,async tx=>{
      await membership(tx,actor,"doctor");const row=await lockAppointment(tx,input.appointmentId);appointmentOwn(actor,row);expected(row,input.expectedVersion);await noTransition(tx,row);
      requireOwner(owners.records,"records");requireOwner(owners.video,"video");
      const type=input.kind==='follow-up'?input.consultationType:row.consultationType;
      if(type==='virtual'?Number(Boolean(selection.meetingUrl))+Number(Boolean(selection.meetingGenerationId))!==1:Boolean(selection.meetingUrl||selection.meetingGenerationId))fail(400,'APPOINTMENT_MEETING_SELECTION_INVALID');
      const abandoned=(await tx.query(`UPDATE appointment_workflows SET state='abandoned',"updatedAt"=NOW() WHERE "appointmentId"=$1 AND state='prepared'
        AND "externalStartedAt" IS NULL AND "expiresAt"<=NOW() RETURNING "targetAppointmentId"`,[row.id])).rows;
      for(const old of abandoned)if(old.targetAppointmentId&&old.targetAppointmentId!==row.id){
        const draft=await readAppointment(tx,old.targetAppointmentId,true);
        if(draft.status==='pending')await appointmentTransition(tx,draft,'rejected',actor,meta.operationId,actor.correlationId,'workflow_abandoned');
      }
      let target=row;
      if(input.kind==="follow-up"){
        if(input.confirmConflicts!==undefined)fail(400,'APPOINTMENT_WORKFLOW_FIELDS_INVALID');
        if(row.status!=="completed"||!input.consultationType||!input.slotDate||!input.startTime||!input.endTime)fail(409,"FOLLOW_UP_SOURCE_INVALID");
        const existing=await tx.query(`SELECT id FROM appointments WHERE "followUpOfAppointmentId"=$1 AND status NOT IN ('cancelled','rejected') LIMIT 1`,[row.id]);
        if(existing.rows.length)fail(409,"FOLLOW_UP_ALREADY_EXISTS");
        const doctor=(await tx.query('SELECT "availabilityType","virtualFee"::text,"inPersonFee"::text FROM vital_doctors WHERE "userId"=$1',[row.doctorId])).rows[0];
        if(!doctor||![input.consultationType,"both"].includes(doctor.availabilityType))fail(422,"FOLLOW_UP_TYPE_UNAVAILABLE");
        const fee=input.consultationType==="virtual"?doctor.virtualFee:doctor.inPersonFee;
        if(typeof fee!=="string"||!/^\d+(?:\.\d{1,2})?$/.test(fee)||Number(fee)<=0)fail(422,"FOLLOW_UP_FEE_REQUIRED");
        const range=slotInterval(input.slotDate,input.startTime,input.endTime);if(range.startsAt.getTime()<=clock())fail(400,"SLOT_IN_PAST");await assertCalendarAvailable(tx,row.doctorId,range.startsAt,range.endsAt);
        const childId=randomUUID();await tx.query(`INSERT INTO appointments (id,"patientId","doctorId","appointmentKind","followUpOfAppointmentId","consultationType",status,"scheduledAt","proposedEndAt","billingLineageId","createdAt","updatedAt")
          VALUES($1,$2,$3,'follow_up',$4,$5::"ConsultationType",'pending',$6,$7,$8,NOW(),NOW())`,[childId,row.patientId,row.doctorId,row.id,input.consultationType,range.startsAt,range.endsAt,randomUUID()]);
        const intake=(await tx.query('SELECT "chiefComplaint",opqrst FROM pre_consultations WHERE "appointmentId"=$1',[row.id])).rows[0];
        await tx.query('INSERT INTO pre_consultations (id,"appointmentId","chiefComplaint",opqrst,"isSubmitted","submittedAt") VALUES($1,$2,$3,$4::jsonb,true,NOW())',[randomUUID(),childId,"Follow-up: "+(intake?.chiefComplaint??"consultation"),JSON.stringify(intake?.opqrst??null)]);
        const copiedConsent=await tx.query(`INSERT INTO consent_records (id,"patientId","appointmentId","consentType",accepted,"consentedAt")
          SELECT $1,"patientId",$2,"consentType",accepted,"consentedAt" FROM consent_records WHERE "appointmentId"=$3 AND "consentType"='medical_record' AND accepted=true ORDER BY "consentedAt" DESC LIMIT 1`,[randomUUID(),childId,row.id]);
        if(copiedConsent.rowCount!==1)fail(409,"FOLLOW_UP_CONSENT_REQUIRED");
        target=await readAppointment(tx,childId);await appointmentTransition(tx,target,"pending",actor,meta.operationId,actor.correlationId);
      }else{
        if(input.consultationType||input.slotDate||input.startTime||input.endTime)fail(400,"APPOINTMENT_WORKFLOW_FIELDS_INVALID");
        if(row.sourceAppointmentId)fail(409,"RESCHEDULE_SAGA_REQUIRED");
        if(row.status!=="pending"||appointmentExpired(row,clock()))fail(409,"APPOINTMENT_APPROVAL_INVALID");
        await assertCalendarAvailable(tx,row.doctorId,row.scheduledAt,row.slotEndsAt??row.proposedEndAt??row.scheduledAt,[row.id]);
        if(!input.confirmConflicts){
          const conflicts=(await tx.query<{id:string}>(`SELECT a.id FROM appointments a LEFT JOIN schedules s ON s.id=a."scheduleSlotId"
            WHERE a."doctorId"=$1 AND a.id<>$2 AND a.status='pending' AND a."scheduledAt"<$4
            AND COALESCE((s."slotDate"+s."endTime"+CASE WHEN s."endTime"<=s."startTime" THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END)
              AT TIME ZONE 'Asia/Manila',a."proposedEndAt",a."scheduledAt")>$3 ORDER BY a."createdAt",a.id`,
          [row.doctorId,row.id,row.scheduledAt,row.slotEndsAt??row.proposedEndAt??row.scheduledAt])).rows;
          if(conflicts.length)throw new AppointmentPendingConflictsError(conflicts.map(value=>value.id));
        }
      }
      const inputHash=requestHash("APPOINTMENT-WORKFLOW",input.kind,{id:row.id,targetId:target.id,version:row.version,scheduledAt:target.scheduledAt.toISOString(),videoSelectionHash:selectedHash});
      await tx.query(`INSERT INTO appointment_workflows (id,"appointmentId","actorAuthId",kind,"inputHash","expectedVersion","prepareOperationId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())`,[input.workflowId,row.id,actor.authId,input.kind,inputHash,row.version,meta.operationId,new Date(clock()+300000)]);
      await tx.query('UPDATE appointment_workflows SET "targetAppointmentId"=$2 WHERE id=$1::uuid',[input.workflowId,target.id]);
      await tx.query(`UPDATE appointment_workflows SET "videoSelectionHash"=$2,"videoTargetVersion"=$3,"videoCorrelationId"=$4 WHERE id=$1::uuid`,[input.workflowId,selectedHash,target.version,actor.correlationId]);
      return{workflowId:input.workflowId,inputHash,appointmentId:row.id,targetAppointmentId:target.id,expectedVersion:row.version,operationStatus:"prepared"};});
      const receipt=await requireOwner(owners.video,'video').prepareWorkflow(result.workflowId,selection);
      if(receipt.workflowId!==result.workflowId||receipt.selectionHash!==selectedHash||receipt.targetAppointmentId!==result.targetAppointmentId)fail(409,'APPOINTMENT_VIDEO_RECEIPT_INVALID');
      const changed=await pool.query(`UPDATE appointment_workflows SET "videoReceipt"=$2::jsonb,"videoProcessingState"='prepared',"updatedAt"=NOW() WHERE id=$1::uuid AND state='prepared' AND "videoSelectionHash"=$3`,[result.workflowId,JSON.stringify(receipt),selectedHash]);
      if(changed.rowCount!==1){const prior=(await pool.query('SELECT state,"videoReceipt" FROM appointment_workflows WHERE id=$1::uuid',[result.workflowId])).rows[0];if(!prior||prior.state!=='committed'||!isDeepStrictEqual(prior.videoReceipt,receipt))fail(409,'APPOINTMENT_VIDEO_PREPARATION_CHANGED');}
      return result;},
    async workflow(actor:Actor,id:string){requireScope(actor,"appointments.workflow.read",id);await membership(pool,actor,"doctor");const row=(await pool.query('SELECT id,"appointmentId","targetAppointmentId",kind,"inputHash",state,"expectedVersion","expiresAt","externalStartedAt",receipt,"videoProcessingState","videoReceipt" FROM appointment_workflows WHERE id=$1::uuid AND "actorAuthId"=$2',[id,actor.authId])).rows[0];if(!row)fail(404,"APPOINTMENT_WORKFLOW_NOT_FOUND");
      const appointment=await readAppointment(pool,row.appointmentId);appointmentOwn(actor,appointment);
      if(row.state==='prepared'){
        if(row.videoProcessingState!=='prepared'||!row.videoReceipt)fail(409,'APPOINTMENT_VIDEO_PREPARATION_PENDING');
        expected(appointment,row.expectedVersion);if(row.expiresAt.getTime()<=clock()&&!row.externalStartedAt)fail(409,"APPOINTMENT_WORKFLOW_STALE");
        const target=row.targetAppointmentId&&row.targetAppointmentId!==appointment.id?await readAppointment(pool,row.targetAppointmentId):appointment;appointmentOwn(actor,target);
        await requireOwner(owners.video,"video").validate(target);
        const patient=(await pool.query('SELECT "ehrPatientId" FROM vital_patients WHERE "userId"=$1',[target.patientId])).rows[0];
        const intake=(await pool.query('SELECT "chiefComplaint" FROM pre_consultations WHERE "appointmentId"=$1 AND "isSubmitted"=true',[target.id])).rows[0];
        if(!patient?.ehrPatientId||!intake?.chiefComplaint)fail(409,"APPOINTMENT_EHR_PREPARATION_INVALID");
        if(row.externalStartedAt){
          const recovered=await requireOwner(owners.ehrRecovery,"ehr_recovery")(target.id);
          if(recovered){
            if(recovered.patientId!==patient.ehrPatientId||recovered.doctorAuthId!==appointment.doctorAuthId)fail(409,"EHR_RECOVERY_RECEIPT_INVALID");
            row.receipt={ehrPatientId:recovered.patientId,ehrCaseId:recovered.caseId,externalSystemRef:recovered.externalSystemRef,requestHash:row.inputHash};
          }
        }else row.ehrTransport={patientId:patient.ehrPatientId,appointmentId:target.id,scheduledAt:target.scheduledAt.toISOString(),chiefComplaint:intake.chiefComplaint};
      }return row;},
    async startExternal(actor:Actor,id:string,meta:AppointmentCommand,body:unknown){const input=z.object({inputHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(body);
      return mutate(actor,"workflow.external-start",id,meta,input,async tx=>{await membership(tx,actor,"doctor");const workflow=(await tx.query('SELECT * FROM appointment_workflows WHERE id=$1::uuid AND "actorAuthId"=$2 FOR UPDATE',[id,actor.authId])).rows[0];
        if(!workflow||workflow.state!=='prepared'||workflow.inputHash!==input.inputHash||workflow.expiresAt.getTime()<=clock())fail(409,"APPOINTMENT_WORKFLOW_STALE");
        const row=await lockAppointment(tx,workflow.appointmentId);appointmentOwn(actor,row);expected(row,workflow.expectedVersion);requireOwner(owners.records,"records");requireOwner(owners.video,"video");
        if(workflow.videoProcessingState!=='prepared'||!workflow.videoReceipt)fail(409,'APPOINTMENT_VIDEO_PREPARATION_PENDING');
        const target=workflow.targetAppointmentId&&workflow.targetAppointmentId!==row.id?await readAppointment(tx,workflow.targetAppointmentId,true):row;
        await requireOwner(owners.video,'video').validate(target);
        appointmentOwn(actor,target);if(target.status!=="pending"||appointmentExpired(target,clock()))fail(409,"APPOINTMENT_APPROVAL_INVALID");
        if(workflow.externalStartedAt)fail(409,"APPOINTMENT_EHR_OUTCOME_UNKNOWN");await tx.query('UPDATE appointment_workflows SET "externalStartedAt"=$2,"updatedAt"=NOW() WHERE id=$1::uuid',[id,new Date(clock())]);return{workflowId:id,operationStatus:"completed"};});},
    async commitWorkflow(actor:Actor,id:string,meta:AppointmentCommand,body:unknown){const input=commitInput.parse(body);
      requireScope(actor,"appointments.workflow.commit",id);await membership(pool,actor,"doctor");
      const prepared=(await pool.query('SELECT * FROM appointment_workflows WHERE id=$1::uuid AND "actorAuthId"=$2',[id,actor.authId])).rows[0];
      if(!prepared||prepared.inputHash!==input.inputHash||input.receipt.requestHash!==prepared.inputHash)fail(409,"EHR_RECEIPT_BINDING_INVALID");
      if(prepared.state==='committed')return finalizeVideo(id,await mutate(actor,"workflow.commit",id,meta,input,async()=>fail(409,"APPOINTMENT_WORKFLOW_COMMITTED")) as {id:string;version:number;status:string;operationStatus:string;checkoutWarning:string});
      const source=await readAppointment(pool,prepared.appointmentId);appointmentOwn(actor,source);
      requireOwner(owners.records,"records");requireOwner(owners.video,"video");
      const target=prepared.targetAppointmentId&&prepared.targetAppointmentId!==source.id?await readAppointment(pool,prepared.targetAppointmentId):source;appointmentOwn(actor,target);
      await requireOwner(owners.video,"video").validate(target);
      const verified=await requireOwner(owners.ehrRecovery,"ehr_recovery")(target.id);
      if(!verified||verified.caseId!==input.receipt.ehrCaseId||verified.patientId!==input.receipt.ehrPatientId||verified.doctorAuthId!==source.doctorAuthId
        ||verified.externalSystemRef!==input.receipt.externalSystemRef)fail(409,"EHR_RECEIPT_BINDING_INVALID");
      const result=await mutate(actor,"workflow.commit",id,meta,input,async tx=>{
      await membership(tx,actor,"doctor");const workflow=(await tx.query('SELECT * FROM appointment_workflows WHERE id=$1::uuid AND "actorAuthId"=$2 FOR UPDATE',[id,actor.authId])).rows[0];if(!workflow)fail(404,"APPOINTMENT_WORKFLOW_NOT_FOUND");
      if(workflow.state!=="prepared"||!workflow.externalStartedAt||workflow.inputHash!==input.inputHash)fail(409,"APPOINTMENT_WORKFLOW_STALE");
      if(workflow.videoProcessingState!=='prepared'||!workflow.videoReceipt)fail(409,'APPOINTMENT_VIDEO_PREPARATION_PENDING');
      const original=await lockAppointment(tx,workflow.appointmentId);appointmentOwn(actor,original);expected(original,workflow.expectedVersion);await noTransition(tx,original);
      const row=workflow.targetAppointmentId&&workflow.targetAppointmentId!==original.id?await readAppointment(tx,workflow.targetAppointmentId,true):original;
      if(workflow.kind==='follow-up'&&(original.status!=='completed'||(row as AppointmentRow&{followUpOfAppointmentId:string}).followUpOfAppointmentId!==original.id))fail(409,"FOLLOW_UP_SOURCE_INVALID");
      const records=requireOwner(owners.records,"records");requireOwner(owners.video,"video");if(row.status!=="pending"||appointmentExpired(row,clock()))fail(409,"APPOINTMENT_APPROVAL_INVALID");
      const patient=(await tx.query('SELECT "ehrPatientId" FROM vital_patients WHERE "userId"=$1',[row.patientId])).rows[0];
      if(patient?.ehrPatientId!==input.receipt.ehrPatientId||input.receipt.externalSystemRef!=="vital:appointment:"+row.id||input.receipt.requestHash!==workflow.inputHash)fail(409,"EHR_RECEIPT_BINDING_INVALID");
      await assertCalendarAvailable(tx,row.doctorId,row.scheduledAt,row.slotEndsAt??row.proposedEndAt??row.scheduledAt,[row.id]);await records.apply(tx,row,"approve",{operationId:meta.operationId,beforeState:row.status,afterState:"approved",effectiveAt:new Date(clock())});
      await tx.query('UPDATE appointments SET "ehrCaseId"=$2,"ehrCaseCreatedAt"=NOW() WHERE id=$1',[row.id,input.receipt.ehrCaseId]);await appointmentTransition(tx,row,"approved",actor,meta.operationId,actor.correlationId);
      const competitors=(await tx.query<AppointmentRow>(selectAppointment+` WHERE a."doctorId"=$1 AND a.id<>$2 AND a."scheduledAt"=$3 AND a.status='pending' FOR UPDATE OF a`,[row.doctorId,row.id,row.scheduledAt])).rows;
      for(const competing of competitors)await appointmentTransition(tx,competing,"rejected",actor,meta.operationId,actor.correlationId,"slot_taken");
      await tx.query('UPDATE appointment_workflows SET state=\'committed\',receipt=$2::jsonb,"commitOperationId"=$3,"updatedAt"=NOW() WHERE id=$1::uuid',[id,JSON.stringify(input.receipt),meta.operationId]);
      await appendSqlOutbox(tx,{producer:'appointment',eventType:'vital.video.workflow.finalization.requested',aggregateId:row.id,aggregateVersion:row.version,
        correlationId:actor.correlationId,causationId:meta.operationId,data:{workflowId:id,appointmentId:row.id,appointmentVersion:row.version,operationId:meta.operationId}});
      if(workflow.kind==='follow-up'){
        await tx.query('UPDATE appointments SET "followUpFlagged"=true,"followUpTimeframe"=($2::timestamptz AT TIME ZONE \'Asia/Manila\')::date,version=version+1,"updatedAt"=NOW() WHERE id=$1',[original.id,row.scheduledAt]);
        await appendSqlOutbox(tx,{producer:"appointment",eventType:"vital.notification.requested",aggregateId:row.id,aggregateVersion:row.version,correlationId:actor.correlationId,
          data:{requestId:randomUUID(),recipientAuthId:row.patientAuthId,appointmentId:row.id,template:"appointment.follow_up",parameters:{scheduledAt:row.scheduledAt.toISOString()}}});
      }
      return{id:row.id,version:row.version,status:row.status,operationStatus:"processing",checkoutWarning:"CHECKOUT_PREPARATION_PENDING"};});
      return finalizeVideo(id,result);},
    async complete(actor:Actor,id:string,meta:AppointmentCommand,body:unknown){const input=acknowledgementInput.parse(body);return mutate(actor,"complete",id,meta,input,async tx=>{
      const row=await lockAppointment(tx,id);appointmentOwn(actor,row);expected(row,input.expectedVersion);await noTransition(tx,row);await noProposal(tx,row);
      if(row.status==='confirmed'&&(actor.role==='doctor'?row.doctorConfirmedAt:row.patientConfirmedAt))return{id,version:row.version,status:row.status,operationStatus:"completed"};
      const records=requireOwner(owners.records,"records");const financial=requireOwner(owners.financial,"financial");const projection=(await tx.query('SELECT * FROM appointment_payment_projections WHERE "appointmentId"=$1',[id])).rows[0];
      if(row.status!=="confirmed"||row.scheduledAt.getTime()>clock()||!projection||projection.status!=="paid"||projection.reviewRequired||projection.billingLineageId!==row.billingLineageId||projection.associationVersion!==row.associationVersion)fail(409,"APPOINTMENT_COMPLETION_INVALID");
      await financial.verifyPaid(row,projection);
      if(effectiveCompletionDeadline(row).getTime()<=clock())fail(409,"APPOINTMENT_COMPLETION_DEADLINE");
      const deadline=row.completionDeadlineAt??new Date(clock()+86400000);
      const context={operationId:meta.operationId,beforeState:row.status,afterState:"confirmed",effectiveAt:new Date(clock()),financialEvidence:projection};
      if(actor.role==="doctor"){
        if(!records.beforeDoctorAcknowledgement)fail(503,"RECORDS_SNAPSHOT_OWNER_UNAVAILABLE");
        await records.beforeDoctorAcknowledgement(tx,row,context);row.doctorConfirmedAt??=new Date(clock());
      }else row.patientConfirmedAt??=new Date(clock());
      if(row.doctorConfirmedAt&&row.patientConfirmedAt)await records.apply(tx,row,"complete",{...context,afterState:"completed"});
      await tx.query('UPDATE appointments SET "doctorConfirmedAt"=$2,"patientConfirmedAt"=$3,"completionDeadlineAt"=$4,"paperworkLockedAt"=CASE WHEN $2::timestamp IS NOT NULL THEN COALESCE("paperworkLockedAt",$2) ELSE "paperworkLockedAt" END,version=version+1,"updatedAt"=NOW() WHERE id=$1',[id,row.doctorConfirmedAt,row.patientConfirmedAt,deadline]);row.version++;
      if(row.doctorConfirmedAt&&row.patientConfirmedAt){await tx.query('UPDATE appointments SET "completedAt"=$2 WHERE id=$1',[id,new Date(clock())]);const receipt=await appointmentTransition(tx,row,"completed",actor,meta.operationId,actor.correlationId);await billingIntent(tx,row,actor,meta.operationId,receipt,"complete");}
      else{
        await appendSqlOutbox(tx,{producer:"appointment",eventType:"vital.appointment.completion_acknowledged",aggregateId:row.id,aggregateVersion:row.version,correlationId:actor.correlationId,causationId:meta.operationId,data:appointmentFactData(row,actor.authId,meta.operationId)});
        await appendSqlOutbox(tx,{producer:"appointment",eventType:"vital.audit.requested",aggregateId:row.id,aggregateVersion:row.version,correlationId:actor.correlationId,causationId:meta.operationId,
          data:{auditType:"vital.appointment.completion_acknowledged",actorAuthId:actor.authId,resourceId:row.id,resourceType:"appointment"}});
      }
      return{id,version:row.version,status:row.status,operationStatus:"completed"};});},
    async confirmPayment(tx:PoolClient,evidence:{appointmentId:string;paymentId:string;paymentVersion:number;billingLineageId:string;associationVersion:number;reviewRequired:boolean;status:string;correlationId:string;eventId:string}){
      const row=await lockAppointment(tx,evidence.appointmentId);if(row.billingLineageId!==evidence.billingLineageId||row.associationVersion!==evidence.associationVersion)fail(409,"PAYMENT_ASSOCIATION_CHANGED");
      if(evidence.status!=="paid"||evidence.reviewRequired||!["approved","pending_payment_verification"].includes(row.status)||appointmentExpired(row,clock()))return;
      await requireOwner(owners.video,'video').validate(row);
      await noTransition(tx,row);await noProposal(tx,row);const records=requireOwner(owners.records,"records");await records.apply(tx,row,"confirm",{
        operationId:evidence.eventId,beforeState:row.status,afterState:"confirmed",effectiveAt:new Date(clock()),
        financialEvidence:{paymentId:evidence.paymentId,sourceVersion:evidence.paymentVersion,status:evidence.status,billingLineageId:evidence.billingLineageId,associationVersion:evidence.associationVersion}});
      await appointmentTransition(tx,row,"confirmed",null,evidence.eventId,evidence.correlationId);
      const competitors=(await tx.query<AppointmentRow>(selectAppointment+` WHERE a."doctorId"=$1 AND a.id<>$2 AND a."scheduledAt"=$3 AND a.status='pending'
        AND a."sourceAppointmentId" IS NULL FOR UPDATE OF a`,[row.doctorId,row.id,row.scheduledAt])).rows;
      for(const competing of competitors)await appointmentTransition(tx,competing,"rejected",null,evidence.eventId,evidence.correlationId,"slot_taken");
    },
  };
}
