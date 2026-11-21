import type { Pool } from 'pg';
import { completionCount, completionRole, type AdminAppointmentOverview } from '../../contracts/completion.js';
import { createCompletionProfileOwner } from '../profile/profile-completion.js';

export function philippineMonth(now: number) {
  const local = new Date(now + 8 * 3600000);
  return { from: new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - 8 * 3600000),
    to: new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - 8 * 3600000), asOf: new Date(now) };
}

export function createAdminAppointmentOverview(pool: Pool, clock = Date.now) {
  const profile = createCompletionProfileOwner(pool);
  return async (actor: Parameters<typeof completionRole>[0]): Promise<AdminAppointmentOverview> => {
    completionRole(actor, 'admin', 'completion.admin.dashboard');
    const period = philippineMonth(clock()), tx = await pool.connect();
    try {
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await profile.admin(actor, tx);
      const counts = (await tx.query<{status:string;consultationType:string;count:string}>(
        'SELECT status,"consultationType",COUNT(*)::text AS count FROM appointments GROUP BY status,"consultationType"')).rows;
      const statusCounts: Record<string,number> = {}, consultationCounts = {virtual:0,in_person:0};
      for (const row of counts) { const n=completionCount(row.count);statusCounts[row.status]=(statusCounts[row.status]??0)+n;
        if(row.consultationType==='virtual'||row.consultationType==='in_person')consultationCounts[row.consultationType]+=n; }
      const times=[period.from,period.to,period.asOf];
      const outcomes=(await tx.query<{completed:string;cancelled:string;noShow:string}>(`SELECT
        (SELECT COUNT(*) FROM appointments WHERE status='completed' AND "completedAt">=$1 AND "completedAt"<$2 AND "completedAt"<=$3)::text AS completed,
        COUNT(DISTINCT "appointmentId") FILTER (WHERE "toStatus"='cancelled')::text AS cancelled,
        COUNT(DISTINCT "appointmentId") FILTER (WHERE "toStatus"='no_show')::text AS "noShow"
        FROM appointment_logs WHERE "changedAt">=$1 AND "changedAt"<$2 AND "changedAt"<=$3`,times)).rows[0]!;
      const leaders=(await tx.query<{id:string;authId:string;specialty:string|null;completedCount:string;rating:string|null;reviewCount:string}>(`WITH volumes AS (
        SELECT d."userId" AS id,d."authId",d.specialty,COUNT(a.id) AS volume
        FROM vital_doctors d JOIN vital_users u ON u.id=d."userId" AND u."authId"=d."authId" AND u.role='doctor'
        JOIN appointments a ON a."doctorId"=d."userId" AND a.status='completed' AND a."completedAt">=$1 AND a."completedAt"<$2 AND a."completedAt"<=$3
        WHERE d."isDoctorOnboardingComplete" GROUP BY d."userId",d."authId",d.specialty
      ) SELECT v.id,v."authId",v.specialty,v.volume::text AS "completedCount",f.rating::text,f.count::text AS "reviewCount"
        FROM volumes v LEFT JOIN LATERAL (
          SELECT AVG(f."starRating") AS rating,COUNT(*) AS count FROM feedback f JOIN appointments a ON a.id=f."appointmentId" AND a.status='completed'
          WHERE f."doctorId"=v.id AND f."starRating" BETWEEN 1 AND 5
        ) f ON TRUE WHERE v.volume=(SELECT MAX(volume) FROM volumes) ORDER BY v.id`,times)).rows;
      await profile.admin(actor,tx);await tx.query('COMMIT');
      return {statusCounts,consultationCounts,monthly:{from:period.from.toISOString(),to:period.to.toISOString(),asOf:period.asOf.toISOString(),
        completed:completionCount(outcomes.completed),cancelled:completionCount(outcomes.cancelled),noShow:completionCount(outcomes.noShow)},
        doctorSpotlight:{leaders:leaders.map(row=>({...row,completedCount:completionCount(row.completedCount),reviewCount:completionCount(row.reviewCount),rating:row.rating===null?null:Number(row.rating)}))}};
    } catch(error){await tx.query('ROLLBACK');throw error;} finally{tx.release();}
  };
}
