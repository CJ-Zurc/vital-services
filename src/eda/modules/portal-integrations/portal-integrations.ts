import { z } from 'zod';
import { DomainError, type Actor } from '../../contracts/actor.js';
import type { ProfileCommandMetadata } from '../profile/profile.js';
import type { PortalProfileReaders } from './portal-integrations-profile.js';
import type { PortalAppointmentHistory } from './portal-integrations-appointments.js';
import { authorizePortalIntegration, portalMeta, portalPagination, portalStatuses, portalUnavailable, type PortalSource } from './portal-integrations-contracts.js';
import { dateOnly } from '../appointment/appointment-contracts.js';
import type { PortalDoctorProvision } from './portal-integrations-provision.js';

export interface PortalIntegrationOwners {
  profile?: PortalProfileReaders;
  doctorProvision?: PortalDoctorProvision;
  history?: PortalAppointmentHistory;
  // Must be an Appointment-owned, foreign-reader projection, never a local-admin impersonation.
  staffAppointments?: (source: PortalSource, query: Record<string, unknown>) => Promise<{ data: unknown[]; meta: ReturnType<typeof portalMeta> }>;
}
export function createPortalIntegrations(owners: PortalIntegrationOwners) {
  return {
    async execute(actor: Actor, source: unknown, method: string, path: string, query: Record<string, unknown>,
      body?: unknown, command?: ProfileCommandMetadata) {
      const authorized = authorizePortalIntegration(actor, source, method, path);
      if (authorized.route.startsWith('doctors/workflows')) return (owners.doctorProvision
        ?? portalUnavailable('PORTAL_PROFILE_PROVISION_OWNER_UNAVAILABLE')).execute(actor, authorized.source, method, path, body, command);
      if (authorized.route === 'appointments') {
        const fields = z.object({ page: z.string().optional(), pageSize: z.string().optional(),
          status: z.enum(portalStatuses).or(z.literal('')).optional(), patientId: z.uuid().or(z.literal('')).optional(),
          doctorId: z.uuid().or(z.literal('')).optional(), dateFrom: dateOnly.or(z.literal('')).optional(), dateTo: dateOnly.or(z.literal('')).optional() }).strict().parse(query);
        return (owners.staffAppointments ?? portalUnavailable('APPOINTMENT_INTEGRATION_STAFF_READ_UNAVAILABLE'))(authorized.source, fields);
      }
      const profile = owners.profile ?? portalUnavailable('PORTAL_PROFILE_OWNER_UNAVAILABLE');
      if (authorized.route === 'doctors') return profile.doctors(query);
      if (authorized.route === 'patients') return profile.patients(query);
      if (authorized.route === 'patient/bootstrap') {
        z.object({}).strict().parse(body ?? {});
        const metadata = z.object({ operationId: z.uuid(), requestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(command);
        return profile.bootstrap(actor, authorized.source, metadata);
      }
      const marker = await profile.patientMarker(actor.authId);
      const page = portalPagination(query, 20);
      const status = typeof query.status === 'string' ? query.status.trim().toLowerCase() : '';
      if (status && status !== 'all') z.enum(portalStatuses).parse(status);
      if (!marker) return { subjectAuthId: actor.authId, data: [], summary: { statusTotals: Object.fromEntries(portalStatuses.map(state => [state, 0])), nextAppointment: null },
        meta: { ...portalMeta(page, 0), patientReady: false } };
      const result = await (owners.history ?? portalUnavailable('APPOINTMENT_PORTAL_HISTORY_UNAVAILABLE'))(marker.userId, query);
      if ([...result.data, ...(result.summary.nextAppointment ? [result.summary.nextAppointment] : [])].some(row => row.patientId !== marker.userId))
        throw new DomainError(403, 'PORTAL_PATIENT_IDENTITY_CONFLICT', 'Patient history authority mismatch.');
      return { ...result, subjectAuthId: actor.authId };
    },
  };
}
export type PortalIntegrations = ReturnType<typeof createPortalIntegrations>;
