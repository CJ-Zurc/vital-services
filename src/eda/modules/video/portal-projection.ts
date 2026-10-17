import type { Pool } from 'pg';
import { DomainError } from '../../contracts/actor.js';
import { requirePortalStaffSource, type PortalSource } from '../portal-integrations/portal-integrations-contracts.js';
import type { PortalAppointmentReference } from '../portal-integrations/portal-integrations-appointments.js';

// Private module interface only. Public Video doctor/patient authorization is unchanged.
export function createPortalVideoProjection(core: Pool, integrations: Pool) {
  return async (source: PortalSource, reference: PortalAppointmentReference) => {
    requirePortalStaffSource(source);
    const context = (await core.query(`SELECT a.version,a."associationVersion",a."billingLineageId",a."doctorId",a.status,
      c."videoResourceId",c."videoResourceVersion" FROM appointments a LEFT JOIN consultations c ON c."appointmentId"=a.id WHERE a.id=$1`, [reference.id])).rows[0];
    const stale = () => new DomainError(409, 'PORTAL_VIDEO_ASSOCIATION_CHANGED', 'Video association changed.');
    if (!context || context.version !== reference.version || context.associationVersion !== reference.associationVersion
      || context.billingLineageId !== reference.billingLineageId || context.doctorId !== reference.doctorId) throw stale();
    const row = context.videoResourceId
      ? (await integrations.query(`SELECT * FROM video_resources WHERE id=$1 AND "doctorId"=$2 AND "billingLineageId"=$3`,
        [context.videoResourceId, reference.doctorId, reference.billingLineageId])).rows[0]
      : (await integrations.query(`SELECT * FROM video_resources WHERE "appointmentId"=$1 AND "doctorId"=$2 AND "billingLineageId"=$3 AND "associationVersion"=$4`,
        [reference.id, reference.doctorId, reference.billingLineageId, reference.associationVersion])).rows[0];
    if (!row) throw new DomainError(503, 'PORTAL_VIDEO_RESOURCE_NOT_FINALIZED', 'Video resource is not finalized.');
    if (row.preparedWorkflowId || row.retiredAt || context.videoResourceVersion != null && row.version < context.videoResourceVersion
      || context.status !== 'rescheduled' && (row.appointmentId !== reference.id || row.associationVersion !== reference.associationVersion)) throw stale();
    requirePortalStaffSource(source);
    return { meetingProvider: row.provider as 'gmeet', meetingUrl: row.meetingUrl as string | null,
      normalizedMeetingUrl: row.normalizedMeetingUrl as string | null,
      meetingValidationStatus: row.validationStatus === 'validated' ? 'valid' : row.validationStatus as string | null };
  };
}
export type PortalVideoProjection = ReturnType<typeof createPortalVideoProjection>;
