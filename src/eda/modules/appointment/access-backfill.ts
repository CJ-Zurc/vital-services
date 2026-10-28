import type { Pool } from 'pg';
import { accessCrypto } from './access-crypto.js';
import { ensureAppointmentAccess,issueAppointmentCode } from './appointment-access.js';
import { readAppointment } from './appointment.js';
import { saveOperationalBrief } from './appointment-summary.js';

// Explicit maintenance operation, never an API startup side effect. Run with
// booking/acceptance writers stopped and restore only after paired contract checks.
export async function backfillAppointmentAccess(pool:Pool){
 accessCrypto().assertConfigured();const db=await pool.connect();
 const scheduledEnd=`COALESCE((s."slotDate"+s."endTime"+CASE WHEN s."endTime"<=s."startTime" THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END) AT TIME ZONE 'Asia/Manila',a."proposedEndAt" AT TIME ZONE 'UTC',a."scheduledAt" AT TIME ZONE 'UTC')`;
 try{await db.query('BEGIN');await db.query('LOCK TABLE appointments IN SHARE ROW EXCLUSIVE MODE');
  if((await db.query(`SELECT a.id FROM appointments a LEFT JOIN schedules s ON s.id=a."scheduleSlotId" WHERE a.status IN ('approved','confirmed') AND a."scheduledAt"<=NOW() AND ${scheduledEnd}>NOW() LIMIT 1`)).rowCount)throw Error('APPOINTMENT_ACCESS_ACTIVE_CONSULTATION');
  const rows=(await db.query(`SELECT a.id FROM appointments a LEFT JOIN schedules s ON s.id=a."scheduleSlotId" WHERE a.status IN ('pending','pending_patient_confirmation','approved','confirmed') AND ${scheduledEnd}>NOW() ORDER BY a."createdAt",a.id`)).rows;
  let created=0;
  for(const item of rows){if((await db.query('SELECT 1 FROM appointment_access WHERE "appointmentId"=$1',[item.id])).rowCount)continue;
   const row=await readAppointment(db,item.id,true);await ensureAppointmentAccess(db,row);
   const intake=(await db.query('SELECT "chiefComplaint",opqrst FROM pre_consultations WHERE "appointmentId"=$1',[item.id])).rows[0];
   await saveOperationalBrief(db,item.id,intake?.chiefComplaint??null,intake?.opqrst??null);
   if(['approved','confirmed'].includes(row.status))await issueAppointmentCode(db,row);
   created++;
  }
  await db.query('COMMIT');return{created};
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
