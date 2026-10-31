import { patientDoctorRatings } from './patient-ratings.js';
import { isDeepStrictEqual } from 'node:util';
import { appointmentPayloadCrypto } from './access-crypto.js';
import { restrictedBrief } from './appointment-summary.js';
import type { IntakePayload,Concept } from '../intelligence/contracts.js';
import { knownReviewIdentities,appointmentAccessState } from './appointment-access.js';
import { reviewIntake,reviewText } from './review-sanitizer.js';
import type { Pool } from 'pg';
import { readDoctorDashboard } from './doctor-dashboard.js';
import { z } from 'zod';
import { DomainError, requireScope, type Actor } from '../../contracts/actor.js';
import { membership,readAppointment } from './appointment.js';
import { dateOnly, slotInterval, type AppointmentRow } from './appointment-contracts.js';
import type { PaymentStore } from '../payment/payment-store.js';
import type { VideoRuntime } from '../video/runtime.js';
import { prepareReadPage, readCollectionPage, readPageInput, collectReadPages } from '../../infrastructure/read-pages.js';

const states = ['pending','approved','confirmed','pending_patient_confirmation','pending_payment_verification','rejected','rescheduled','cancelled','completed'] as const;
const filters = z.object({status:z.enum([...states,'all','expired']).optional(),dateFrom:dateOnly.optional(),dateTo:dateOnly.optional(),...readPageInput}).strict()
  .refine(x=>!x.dateFrom||!x.dateTo||x.dateFrom<=x.dateTo);
const active = ['pending','approved','confirmed','pending_patient_confirmation'];
const label = (type:string) => type==='both'?'Virtual or In-Person':type==='in_person'?'In-Person':'Virtual';
interface SlotBooking {id:string;status:string;consultationType:string;patientId:string}
interface SlotRow {id:string;version:number;slotDate:string;startTime:string;endTime:string;consultationType:string;isPublished:boolean;appointments:SlotBooking[];pendingCount?:number;bookedCount?:number}
interface CalendarFields {slotDate:string|null;startTime:string|null;endTime:string|null}
interface RelatedRow extends CalendarFields {id:string;status:string;sourceAppointmentId:string|null;followUpOfAppointmentId:string|null;scheduledAt:Date;proposedEndAt:Date|null;updatedAt:Date;cancellationReason:string|null;statusLogs:{note:string|null;changedAt:string}[]}
interface ReadRow extends AppointmentRow,CalendarFields {specialty:string|null;followUpOfAppointmentId:string|null;cancellationReason:string|null;rejectionReason:string|null;createdAt:Date;updatedAt:Date;autoCompletedAt:Date|null;chiefComplaint:string|null;opqrst:unknown;sessionStartedAt:Date|null;sessionEndedAt:Date|null;ownRating:number|null;ratingSubmittedAt:Date|null;ratingPaymentEligible:boolean}
interface DoctorRow {id:string;authId:string;specialty:string|null;bio:string|null;education:string|null;availabilityType:string|null;virtualFee:string|null;inPersonFee:string|null;starRating:number;hospitals:string[]}
interface DateBlockRow {id:string;version:number;startDate:string;endDate:string;weekday:number|null}
interface LogRow {id:string;fromStatus:string|null;toStatus:string;changedByRole:string|null;note:string|null;changedAt:Date}
const paging = z.object(readPageInput).strict();
export interface AppointmentReadOwners { payment?:Pick<PaymentStore,'byAppointment'>; video?:Pick<VideoRuntime,'resource'> }
export function serializeReadSlot(row:SlotRow, now=Date.now(), publicView=false) {
  const slotDate=String(row.slotDate).slice(0,10),startTime=String(row.startTime).slice(0,5),endTime=String(row.endTime).slice(0,5);
  const appointments=row.appointments??[];
  const bookings=appointments.filter(a=>['approved','confirmed'].includes(a.status));
  const pending=appointments.filter(a=>a.status==='pending');
  const isExpired=slotInterval(slotDate,startTime,endTime).endsAt.getTime()<=now;
  const item=(a:SlotBooking)=>({id:a.id,status:a.status,consultationType:a.consultationType,patientId:null});
  const booked=(row.bookedCount??bookings.length)>0,hasPending=(row.pendingCount??pending.length)>0;
  return {id:row.id,version:row.version,slotDate,startTime,endTime,endsNextDay:endTime<=startTime,consultationType:row.consultationType,
    consultationTypeLabel:label(row.consultationType),isPublished:row.isPublished,isExpired,hasPendingRequest:hasPending,
    hasActiveBooking:booked,isBooked:booked,isSelectable:row.isPublished&&!isExpired&&!booked,
    appointments:publicView?[]:bookings.map(item),pendingAppointments:publicView?[]:pending.map(item)};
}
function unavailable(owner:string):never {throw new DomainError(503,'APPOINTMENT_'+owner+'_READ_UNAVAILABLE','Required read owner is unavailable.');}

export function createAppointmentReads(pool:Pool, owners:AppointmentReadOwners={}, clock=Date.now) {
  async function authorizeItem(actor:Actor,id:string,scope='appointments.read') {
    requireScope(actor,scope,id);const member=await membership(pool,actor);
    const row=(await pool.query<{id:string;patientId:string;doctorId:string}>(
      'SELECT id,"patientId","doctorId" FROM appointments WHERE id=$1',[z.uuid().parse(id)])).rows[0];
    if(!row||(actor.role==='patient'?row.patientId:row.doctorId)!==member.userId)throw new DomainError(403,'APPOINTMENT_OWNER_DENIED','Appointment access denied.');
    return row;
  }
  async function historyPage(actor:Actor,id:string,input:unknown={},check=true) {
    if(check)await authorizeItem(actor,id);
    const query=paging.parse(input),page=prepareReadPage(actor,'appointments:'+id+':history',{},query,clock);
    const result=await readCollectionPage<LogRow>(pool,page,{sql:'SELECT id,"fromStatus","toStatus","changedByRole",note,"changedAt" FROM appointment_logs WHERE "appointmentId"=$1',
      values:[id],order:[{key:'changedAt',direction:'ASC',cast:'timestamp'},{key:'id',direction:'ASC',cast:'text'}]});
    if(check)await authorizeItem(actor,id);if(actor.role==='doctor'&&!(await appointmentAccessState(pool,await readAppointment(pool,id))).identityUnlocked)return{...result,items:result.items.map(l=>({...l,note:null}))};return result;
  }
  async function relatedPage(actor:Actor,row:{id:string;sourceAppointmentId:string|null;patientId:string;doctorId:string},input:unknown={}) {
    const query=paging.parse(input),page=prepareReadPage(actor,'appointments:'+row.id+':relationships',{patientId:row.patientId,doctorId:row.doctorId},query,clock);
    return readCollectionPage<RelatedRow>(pool,page,{sql:`SELECT a.id,a.status,a."sourceAppointmentId",a."followUpOfAppointmentId",a."scheduledAt",a."proposedEndAt",a."updatedAt",a."cancellationReason",
      s."slotDate"::text AS "slotDate",s."startTime"::text AS "startTime",s."endTime"::text AS "endTime",'[]'::jsonb AS "statusLogs"
      FROM appointments a LEFT JOIN schedules s ON s.id=a."scheduleSlotId" WHERE (a.id=$2 OR a."sourceAppointmentId"=$1 OR a."followUpOfAppointmentId"=$1)
      AND a."patientId"=$3 AND a."doctorId"=$4`,values:[row.id,row.sourceAppointmentId,row.patientId,row.doctorId],
      order:[{key:'updatedAt',direction:'DESC',cast:'timestamp'},{key:'id',direction:'ASC',cast:'text'}]});
  }
  async function calendarRevision(doctorId:string) {
    const row=(await pool.query<{revision:string}>(`SELECT md5(jsonb_build_array(
      (SELECT row_to_json(d) FROM vital_doctors d WHERE d."userId"=$1),
      (SELECT COALESCE(string_agg(s.id||':'||s.version::text,',' ORDER BY s.id),'') FROM schedules s WHERE s."doctorId"=$1),
      (SELECT COALESCE(string_agg(row_to_json(b)::text,',' ORDER BY b.id),'') FROM doctor_date_blocks b WHERE b.doctor_id=$1),
      (SELECT COALESCE(string_agg(a.id||':'||a.version::text,',' ORDER BY a.id),'') FROM appointments a WHERE a."doctorId"=$1)
      )::text) AS revision`,[doctorId])).rows[0];
    return row!.revision;
  }
  async function slots(actor:Actor,doctorId:string,input:unknown={},publicView=false) {
    const query=paging.parse(input),page=prepareReadPage(actor,'schedules:'+doctorId,{publicView},query,clock),revision=await calendarRevision(doctorId);
    const result=await readCollectionPage<SlotRow>(pool,page,{sql:`SELECT s.id,s.version,s."slotDate"::text,s."startTime"::text,s."endTime"::text,s."consultationType",s."isPublished",
      '[]'::jsonb AS appointments,
      (SELECT COUNT(*)::int FROM appointments a WHERE a."scheduleSlotId"=s.id AND a.status IN ('approved','confirmed')) AS "bookedCount",
      (SELECT COUNT(*)::int FROM appointments a WHERE a."scheduleSlotId"=s.id AND a.status='pending') AS "pendingCount",
      $3::text AS "calendarRevision"
      FROM schedules s WHERE s."doctorId"=$1 AND (s."isPublished" OR EXISTS(SELECT 1 FROM appointments a WHERE a."scheduleSlotId"=s.id AND a.status::text=ANY($2::text[])))`,
      values:[doctorId,publicView?['approved','confirmed']:active,revision],
      order:[{key:'slotDate',direction:'ASC',cast:'date'},{key:'startTime',direction:'ASC',cast:'time'},{key:'id',direction:'ASC',cast:'text'}]});
    if(await calendarRevision(doctorId)!==revision)throw new DomainError(409,'APPOINTMENT_READ_SNAPSHOT_CHANGED','Calendar changed during composition.');
    return {items:result.items.map(slot=>serializeReadSlot(slot,page.at,publicView)),meta:{...result.meta,calendarRevision:revision}};
  }
  async function blocksPage(actor:Actor,doctorId:string,input:unknown={},future=false) {
    const query=paging.parse(input),page=prepareReadPage(actor,'date-blocks:'+doctorId,{future},query,clock),revision=await calendarRevision(doctorId);
    const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila'}).format(new Date(page.at));
    const result=await readCollectionPage<DateBlockRow>(pool,page,{sql:`SELECT id,version,start_date::text AS "startDate",end_date::text AS "endDate",weekday,$3::text AS "calendarRevision"
      FROM doctor_date_blocks WHERE FALSE AND doctor_id=$1 AND ($2::date IS NULL OR end_date>=$2::date)`,values:[doctorId,future?day:null,revision],
      order:[{key:'startDate',direction:'ASC',cast:'date'},{key:'id',direction:'ASC',cast:'text'}]});
    if(await calendarRevision(doctorId)!==revision)throw new DomainError(409,'APPOINTMENT_READ_SNAPSHOT_CHANGED','Calendar changed during composition.');
    return {...result,meta:{...result.meta,calendarRevision:revision}};
  }
  async function list(actor:Actor,input:unknown={},requests=false,dashboard=false,ids?:string[],nested=false) {
    requireScope(actor,dashboard?'appointments.dashboard.read':requests?'appointments.requests.read':'appointments.read',actor.authId);
    const member=await membership(pool,actor,requests?'doctor':actor.role);
    const filter=filters.parse(input);
    const page=prepareReadPage(actor,requests?'appointment-requests':dashboard?'doctor-dashboard-cards':'appointments',
      {status:requests?'pending':filter.status??'all',dateFrom:filter.dateFrom??null,dateTo:filter.dateTo??null,ids:ids??null},filter,clock);
    const expiring=filter.status==='expired'?` AND a.status IN ('pending','approved','confirmed','pending_patient_confirmation')
      AND COALESCE((s."slotDate"+s."endTime"+CASE WHEN s."endTime"<=s."startTime" THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END) AT TIME ZONE 'Asia/Manila',
        a."proposedEndAt" AT TIME ZONE 'UTC',a."scheduledAt" AT TIME ZONE 'UTC')<=$6::timestamptz`:'';
    const pageResult=await readCollectionPage<ReadRow>(pool,page,{sql:`SELECT a.*,p."authId" AS "patientAuthId",d."authId" AS "doctorAuthId",d.specialty,
      s."slotDate"::text AS "slotDate",s."startTime"::text AS "startTime",s."endTime"::text AS "endTime",s."isPublished",s."consultationType" AS "slotType",
      (SELECT f."starRating" FROM feedback f WHERE f."appointmentId"=a.id AND f."patientId"=a."patientId") AS "ownRating",
      (SELECT f."submittedAt" FROM feedback f WHERE f."appointmentId"=a.id AND f."patientId"=a."patientId") AS "ratingSubmittedAt",
      EXISTS(SELECT 1 FROM appointment_payment_projections pp WHERE pp."appointmentId"=a.id AND pp.status='paid' AND NOT pp."reviewRequired"
        AND pp."billingLineageId"=a."billingLineageId" AND pp."associationVersion"=a."associationVersion") AND NOT EXISTS(SELECT 1 FROM saga_operations sg WHERE sg."billingLineageId"=a."billingLineageId"
          AND sg.status NOT IN ('completed','compensated','cancelled','failed')) AS "ratingPaymentEligible",
      pc."chiefComplaint",pc.opqrst,c."sessionStartedAt",c."sessionEndedAt",
      (SELECT md5(COALESCE(string_agg(row_to_json(l)::text,',' ORDER BY l.id),'')) FROM appointment_logs l WHERE l."appointmentId"=a.id) AS "historyRevision",
      (SELECT md5(COALESCE(string_agg(r.id||':'||r.version::text,',' ORDER BY r.id),'')) FROM appointments r WHERE
        (r.id=a."sourceAppointmentId" OR r."sourceAppointmentId"=a.id OR r."followUpOfAppointmentId"=a.id)
        AND r."patientId"=a."patientId" AND r."doctorId"=a."doctorId") AS "relationshipsRevision"
      FROM appointments a JOIN vital_patients p ON p."userId"=a."patientId" JOIN vital_doctors d ON d."userId"=a."doctorId"
      LEFT JOIN schedules s ON s.id=a."scheduleSlotId" LEFT JOIN pre_consultations pc ON pc."appointmentId"=a.id
      LEFT JOIN consultations c ON c."appointmentId"=a.id
      WHERE a."${actor.role==='patient'?'patientId':'doctorId'}"=$1
      AND ($2::text IS NULL OR a.status::text=$2) AND ($3::timestamp IS NULL OR a."scheduledAt">=$3)
      AND ($4::timestamp IS NULL OR a."scheduledAt"<$4)
      AND ($5::text[] IS NULL OR a.id=ANY($5::text[]))
      AND $6::timestamptz IS NOT NULL`+expiring,
      values:[member.userId,requests?'pending':filter.status&& !['all','expired'].includes(filter.status)?filter.status:null,
        filter.dateFrom?new Date(filter.dateFrom+'T00:00:00+08:00'):null,filter.dateTo?new Date(new Date(filter.dateTo+'T00:00:00+08:00').getTime()+86400000):null,ids??null,new Date(page.at)],
      order:requests?[{key:'createdAt',direction:'DESC',cast:'timestamp'},{key:'id',direction:'ASC',cast:'text'}]:
        [{key:'updatedAt',direction:'DESC',cast:'timestamp'},{key:'createdAt',direction:'DESC',cast:'timestamp'},{key:'id',direction:'ASC',cast:'text'}]});
    const selected=pageResult.items;
    const result=[];
    for(const row of selected) {
      const logs:LogRow[]=nested?await collectReadPages(input=>historyPage(actor,row.id,input,false)):[];
      const related:RelatedRow[]=nested?await collectReadPages(input=>relatedPage(actor,row,input)):[];
      if(nested)for(const relation of related){
        if(relation.id!==row.sourceAppointmentId&&relation.sourceAppointmentId!==row.id)continue;
        relation.statusLogs=(await collectReadPages(input=>historyPage(actor,relation.id,input,false))).reverse()
          .map(log=>({note:log.note,changedAt:log.changedAt.toISOString()}));
      }
      if(!owners.payment)unavailable('PAYMENT');
      const financial=await owners.payment.byAppointment(row.id);
      if(financial&&(financial.appointmentId!==row.id||financial.billingLineageId!==row.billingLineageId||financial.associationVersion!==row.associationVersion||financial.patientAuthId!==row.patientAuthId||financial.doctorAuthId!==row.doctorAuthId))
        throw new DomainError(409,'APPOINTMENT_PAYMENT_READ_STALE','Payment association changed.');
      let video:Awaited<ReturnType<VideoRuntime['resource']>>|null=null;
      if(row.consultationType==='virtual'&&!['pending','pending_patient_confirmation','rejected'].includes(row.status)) {
        if(!owners.video)unavailable('VIDEO');
        video=await owners.video.resource({...actor,scopes:['video.resource.read'],resource:row.id},row.id);
        if(video.appointmentId!==row.id||video.associationVersion!==row.associationVersion)unavailable('VIDEO_ASSOCIATION');
      }
      const schedule=(r:CalendarFields)=>r.slotDate?{slotDate:r.slotDate,startTime:r.startTime!.slice(0,5),endTime:r.endTime!.slice(0,5)}:null;
      const relation=(r:RelatedRow)=>({id:r.id,status:r.status,scheduledAt:r.scheduledAt,proposedEndAt:r.proposedEndAt,updatedAt:r.updatedAt,cancellationReason:r.cancellationReason,scheduleSlot:schedule(r),statusLogs:r.statusLogs});
      const access=await appointmentAccessState(pool,row,page.at);
      const knownIdentities=await knownReviewIdentities(pool,row.id);
      const restricted=actor.role==='doctor'&&!access.identityUnlocked;
      const noIntake=restricted&&['locked','historical_only'].includes(access.state);
      const stored=(await pool.query('SELECT summary FROM appointment_intake_briefs WHERE "appointmentId"=$1',[row.id])).rows[0];
      const brief=stored?appointmentPayloadCrypto().decrypt(stored.summary,'appointment-brief:'+row.id) as {brief:string;payload:IntakePayload;concepts:Concept[]}:null;
      const summary=noIntake?null:brief?(restricted?restrictedBrief(brief.payload,brief.concepts,knownIdentities):brief.brief):null;
      result.push({access,id:row.id,version:row.version,patientId:restricted?null:row.patientId,doctorId:row.doctorId,patientAuthId:restricted?null:row.patientAuthId,doctorAuthId:row.doctorAuthId,
        specialty:row.specialty,status:row.status,consultationType:row.consultationType,scheduleSlotId:row.scheduleSlotId,
        scheduleSlot:schedule(row),sourceAppointmentId:row.sourceAppointmentId,appointmentKind:row.appointmentKind,followUpOfAppointmentId:row.followUpOfAppointmentId,
        patientRescheduleCount:row.patientRescheduleCount,doctorRescheduleCount:row.doctorRescheduleCount,cancellationReason:restricted?reviewText(row.cancellationReason,knownIdentities).text:row.cancellationReason,rejectionReason:restricted?reviewText(row.rejectionReason,knownIdentities).text:row.rejectionReason,
        ehrCaseId:restricted?null:row.ehrCaseId,scheduledAt:row.scheduledAt,proposedEndAt:row.proposedEndAt,createdAt:row.createdAt,updatedAt:row.updatedAt,
        doctorConfirmedAt:row.doctorConfirmedAt,patientConfirmedAt:row.patientConfirmedAt,completionDeadlineAt:row.completionDeadlineAt,autoCompletedAt:row.autoCompletedAt,paperworkLockedAt:row.paperworkLockedAt,
        rating:actor.role==='patient'&&row.status==='completed'&&row.ownRating!=null&&row.ownRating>=1&&row.ownRating<=5?{rating:row.ownRating,submittedAt:row.ratingSubmittedAt}:null,
        canRate:actor.role==='patient'&&row.status==='completed'&&row.ownRating==null&&row.ratingPaymentEligible===true,
        preConsultation:{summary,privacyWithheld:restricted&&(reviewText(row.chiefComplaint,knownIdentities).withheld||!isDeepStrictEqual(reviewIntake(row.opqrst,knownIdentities),row.opqrst)),chiefComplaint:noIntake?null:restricted?reviewText(row.chiefComplaint,knownIdentities).text:row.chiefComplaint??null,opqrst:noIntake?null:restricted?reviewIntake(row.opqrst,knownIdentities):row.opqrst??null},statusLogs:restricted?logs.map(l=>({...l,note:null})):logs,
        sourceAppointment:restricted?null:related.find(r=>r.id===row.sourceAppointmentId)?relation(related.find(r=>r.id===row.sourceAppointmentId)!):null,
        rescheduleProposals:restricted?[]:related.filter(r=>r.sourceAppointmentId===row.id).map(relation),followUpAppointments:restricted?[]:related.filter(r=>r.followUpOfAppointmentId===row.id).map(r=>({id:r.id,status:r.status})),
        payment:financial?{status:financial.status,amount:financial.amount,checkoutUrl:restricted?null:financial.checkoutUrl,paidAt:financial.paidAt,refundEligible:financial.refundEligible}:null,
        consultation:row.sessionStartedAt||row.sessionEndedAt||video?{meetingProvider:video?.meetingProvider??null,meetingUrl:video?.meetingUrl??null,normalizedMeetingUrl:video?.normalizedMeetingUrl??null,
          meetingValidationStatus:video?.meetingValidationStatus??null,sessionStartedAt:row.sessionStartedAt??null,sessionEndedAt:row.sessionEndedAt??null}:null});
    }
    if(result.length){
      const current=(await pool.query<{id:string;version:number}>('SELECT id,version FROM appointments WHERE id=ANY($1::text[])',[selected.map(row=>row.id)])).rows;
      if(current.length!==selected.length||selected.some(row=>!current.some(now=>now.id===row.id&&now.version===row.version)))
        throw new DomainError(409,'APPOINTMENT_READ_CHANGED','Appointment changed during composition.');
    }
    await membership(pool,actor,requests?'doctor':actor.role);
    return {appointments:result,meta:pageResult.meta,children:Object.fromEntries(selected.map(row=>[row.id,{
      history:'historyRevision' in row&&row.historyRevision!=='d41d8cd98f00b204e9800998ecf8427e',
      relationships:'relationshipsRevision' in row&&row.relationshipsRevision!=='d41d8cd98f00b204e9800998ecf8427e'}]))};
  }
  return {
    async list(actor:Actor,input:unknown={}){return list(actor,input);},
    async listRequests(actor:Actor,input:unknown={}){const result=await list(actor,input,true);return {requests:result.appointments,meta:result.meta,children:result.children};},
    async streamRequests(actor:Actor){const requests=await collectReadPages(async input=>{
      const result=await list(actor,input,true,false,undefined,true);return {items:result.appointments,meta:result.meta};
    },1024*1024);return {requests};},
    history:(actor:Actor,id:string,input:unknown={})=>historyPage(actor,id,input),
    async relationships(actor:Actor,id:string,input:unknown={}){
      const row=await authorizeItem(actor,id),source=(await pool.query<{sourceAppointmentId:string|null}>('SELECT "sourceAppointmentId" FROM appointments WHERE id=$1',[id])).rows[0]!;
      const result=await relatedPage(actor,{...row,...source},input);await authorizeItem(actor,id);if(actor.role==='doctor'&&!(await appointmentAccessState(pool,await readAppointment(pool,id))).identityUnlocked)return{...result,items:[]};return result;
    },
    async dashboard(actor:Actor){requireScope(actor,'appointments.dashboard.read',actor.authId);const doctor=await membership(pool,actor);
      if(actor.role!=='doctor')unavailable('DASHBOARD_RECORDS_NOTIFICATIONS');
      return readDoctorDashboard(pool,doctor.userId,clock(),async ids=>(await list(actor,{},false,true,ids,true)).appointments,()=>membership(pool,actor,'doctor'));},
    availability:(actor:Actor,id:string,input:unknown={})=>availability(actor,id,input),
    async discovery(actor:Actor,input:unknown={}){
      requireScope(actor,'appointments.discovery.read',actor.authId);await membership(pool,actor,'patient');
      const f=z.object({specialty:z.string().trim().max(160).optional(),consultationType:z.enum(['virtual','in_person']).optional(),availableDate:dateOnly.optional(),departments:z.string().max(120).optional().transform(v=>v?z.array(z.uuid()).max(3).parse(v.split(',')):[]),availabilityFirst:z.enum(['true','false']).optional(),...readPageInput}).strict().parse(input);
      const revision=await discoveryRevision(),page=prepareReadPage(actor,'doctor-discovery',{specialty:f.specialty??null,consultationType:f.consultationType??null,availableDate:f.availableDate??null,departments:f.departments,availabilityFirst:f.availabilityFirst??'false'},f,clock);
      const doctors=await readCollectionPage<{id:string;specialty:string|null;departmentExternalId:string|null}>(pool,page,{sql:`SELECT d."userId" AS id,d.specialty,d.department_external_id AS "departmentExternalId",$3::text AS "discoveryRevision" FROM vital_doctors d JOIN vital_users u ON u.id=d."userId" AND u."authId"=d."authId"
        WHERE d."isDoctorOnboardingComplete"=true AND u.role='doctor' AND ($1::text IS NULL OR d.specialty ILIKE '%'||$1||'%')
        AND ($2::text IS NULL OR d."availabilityType"::text IN ($2,'both')) AND (cardinality($4::text[])=0 OR d.department_external_id=ANY($4::text[]))`,values:[f.specialty??null,f.consultationType??null,revision,f.departments],
        order:[{key:'specialty',direction:'ASC',cast:'text'},{key:'id',direction:'ASC',cast:'text'}]});
      const results=[];
      for(const d of doctors.items){
        const doctor=await doctorDetails(d.id);
        const summary=(await pool.query<{count:string;average:string|null}>(`SELECT COUNT(*)::text AS count,AVG(f."starRating")::text AS average FROM feedback f
          JOIN appointments a ON a.id=f."appointmentId" WHERE COALESCE(f."doctorId",a."doctorId")=$1 AND a.status='completed' AND f."starRating" BETWEEN 1 AND 5`,[d.id])).rows[0]!;
        const earliest=(await pool.query<SlotRow>(`SELECT s.id,s.version,s."slotDate"::text,s."startTime"::text,s."endTime"::text,s."consultationType",s."isPublished",'[]'::jsonb AS appointments
          FROM schedules s WHERE s."doctorId"=$1 AND s."isPublished" AND ($2::date IS NULL OR s."slotDate"=$2::date)
          AND ($3::text IS NULL OR s."consultationType"::text IN ($3,'both')) AND ($5::boolean=false OR ((s."slotDate"+s."startTime") AT TIME ZONE 'Asia/Manila'>$4::timestamptz AND ($2::date IS NOT NULL OR s."slotDate"<=($4::timestamptz AT TIME ZONE 'Asia/Manila')::date+30)))
          AND (s."slotDate"+s."endTime"+CASE WHEN s."endTime"<=s."startTime" THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END) AT TIME ZONE 'Asia/Manila'>$4::timestamptz
          AND NOT EXISTS(SELECT 1 FROM appointments a WHERE a."scheduleSlotId"=s.id AND a.status IN ('approved','confirmed'))
 ORDER BY s."slotDate",s."startTime",s.id LIMIT 1`,
          [d.id,f.availableDate??null,f.consultationType??null,new Date(page.at),f.availabilityFirst==='true'])).rows[0];
        const first=earliest?serializeReadSlot(earliest,page.at,true):null;
        results.push({...doctor,...(f.departments.length?{departmentExternalId:d.departmentExternalId}:{}),starRating:summary.average===null?0:Number(summary.average),reviewCount:z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(summary.count),
          earliestSlot:first?{id:first.id,date:first.slotDate,startTime:first.startTime,endTime:first.endTime,endsNextDay:first.endsNextDay,consultationType:first.consultationType,consultationTypeLabel:first.consultationTypeLabel}:null});
      }
      if(await discoveryRevision()!==revision)throw new DomainError(409,'APPOINTMENT_READ_SNAPSHOT_CHANGED','Discovery changed during composition.');
      await membership(pool,actor,'patient');return {doctors:results,meta:doctors.meta};
    },
    async schedules(actor:Actor,input:unknown={}){requireScope(actor,'appointments.schedule.read',actor.authId);const d=await membership(pool,actor,'doctor');
      const qr=(await pool.query('SELECT EXISTS(SELECT 1 FROM doctor_qr_codes WHERE "doctorId"=$1 AND "isActive"=true) AS active',[d.userId])).rows[0];
      const result=await slots(actor,d.userId,input);await membership(pool,actor,'doctor');
      return {doctor:{specialty:d.specialty??null,availabilityType:d.availabilityType??null,hasActivePaymentQr:qr.active},slots:result.items,meta:result.meta};},
    patientRatings:(actor:Actor,id:string,input:unknown={})=>patientDoctorRatings(pool,actor,id,input,clock),
    async blocks(actor:Actor,input:unknown={}){requireScope(actor,'appointments.blocks.read',actor.authId);const member=await membership(pool,actor,'doctor');
      const result=await blocksPage(actor,member.userId,input);await membership(pool,actor,'doctor');return {blocks:result.items.map(({id,version,startDate,endDate,weekday})=>({id,version,startDate,endDate,weekday})),meta:result.meta};},
    async bookings(actor:Actor,id:string,input:unknown={}){requireScope(actor,'appointments.schedule.read',id);const member=await membership(pool,actor,'doctor');
      const query=paging.parse(input),page=prepareReadPage(actor,'schedules:'+id+':bookings',{},query,clock);
      const result=await readCollectionPage<SlotBooking>(pool,page,{sql:`SELECT a.id,a.status,a."consultationType",NULL::text AS "patientId" FROM schedules s JOIN appointments a ON a."scheduleSlotId"=s.id
        WHERE s.id=$1 AND s."doctorId"=$2 AND a.status::text=ANY($3::text[])`,values:[z.uuid().parse(id),member.userId,active],order:[{key:'id',direction:'ASC',cast:'text'}]});
      await membership(pool,actor,'doctor');return{...result,items:result.items.map(item=>({...item,patientId:null}))};},
  };
  async function discoveryRevision(){
    return(await pool.query<{revision:string}>(`SELECT md5(jsonb_build_array(
      (SELECT COALESCE(string_agg(row_to_json(d)::text,',' ORDER BY d."userId"),'') FROM vital_doctors d),
      (SELECT COALESCE(string_agg(u.id||':'||u.role::text||':'||u.version::text,',' ORDER BY u.id),'') FROM vital_users u),
      (SELECT COALESCE(string_agg(s.id||':'||s.version::text,',' ORDER BY s.id),'') FROM schedules s),
      (SELECT COALESCE(string_agg(row_to_json(b)::text,',' ORDER BY b.id),'') FROM doctor_date_blocks b),
      (SELECT COALESCE(string_agg(row_to_json(f)::text,',' ORDER BY f.id),'') FROM feedback f),
      (SELECT COALESCE(string_agg(a.id||':'||a.version::text,',' ORDER BY a.id),'') FROM appointments a)
      )::text) AS revision`)).rows[0]!.revision;
  }
  async function doctorDetails(id:string){
    const doctor=(await pool.query<DoctorRow>(`SELECT d."userId" AS id,d."authId",d.specialty,d.bio,d.education,d."availabilityType",d."virtualFee"::text,d."inPersonFee"::text,d."starRating",
      COALESCE((SELECT jsonb_agg(h."hospitalName" ORDER BY h.id) FROM hospital_affiliations h WHERE h."doctorId"=d."userId"),'[]'::jsonb) AS hospitals
      FROM vital_doctors d JOIN vital_users u ON u.id=d."userId" AND u."authId"=d."authId" WHERE d."userId"=$1 AND d."isDoctorOnboardingComplete"=true AND u.role='doctor'`,[id])).rows[0];
    if(!doctor)throw new DomainError(404,'APPOINTMENT_DOCTOR_NOT_FOUND','Doctor not found.');
    return {...doctor,availabilityTypeLabel:doctor.availabilityType==='both'?'Virtual and in-person':label(doctor.availabilityType??'virtual')};
  }
  async function availability(actor:Actor,id:string,input:unknown={}){
    z.uuid().parse(id);requireScope(actor,'appointments.discovery.read',id);await membership(pool,actor,'patient');
    const query=z.object({...readPageInput,collection:z.enum(['slots','dateBlocks']).default('slots')}).strict().parse(input),doctor=await doctorDetails(id);
    const pageArgs={limit:query.limit,...(query.cursor?{cursor:query.cursor}:{})};
    if(query.collection==='dateBlocks'){
      const result=await blocksPage(actor,id,pageArgs,true);await membership(pool,actor,'patient');
      return {doctor,slots:[],dateBlocks:[],meta:result.meta,collection:query.collection};
    }
    const result=await slots(actor,id,pageArgs,true),calendar=[];
    for(const s of result.items){
      const isBlocked=false;
      calendar.push({...s,isBlocked,isSelectable:s.isSelectable&&!isBlocked});
    }
    if(await calendarRevision(id)!==result.meta.calendarRevision)throw new DomainError(409,'APPOINTMENT_READ_SNAPSHOT_CHANGED','Calendar changed during composition.');
    await membership(pool,actor,'patient');return {doctor,slots:calendar,dateBlocks:[],meta:result.meta,collection:query.collection};
  }
}
export type AppointmentReads=ReturnType<typeof createAppointmentReads>;
export type AppointmentReadSnapshot=Awaited<ReturnType<AppointmentReads['listRequests']>>['requests'][number];
