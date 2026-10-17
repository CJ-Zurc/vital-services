import { z } from 'zod';
import type { Pool } from 'pg';
import type { CorePrismaClient } from '../../infrastructure/databases.js';
import { boundedJsonReceipt } from '../../infrastructure/http-receipt.js';
import { getProfileSyncStatuses } from '../profile/profile-delivery.js';
import { createPortalIntegrations } from './portal-integrations.js';
import { createPortalProfileReaders, createPortalPatientCounts, type PortalIdentityLookup } from './portal-integrations-profile.js';
import { createPortalAppointmentHistory, createPortalStaffAppointmentReader } from './portal-integrations-appointments.js';
import { createPortalStaffComposer } from './portal-integrations-staff.js';
import { createPaymentStore } from '../payment/payment-store.js';
import { createPortalVideoProjection } from '../video/portal-projection.js';
import { createPortalDoctorProvision } from './portal-integrations-provision.js';

export function createPortalDoctorIdentityVerifier(environment: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch) {
  return async (authId: string) => {
    z.uuid().parse(authId);
    let base: URL;
    try {
      base = new URL(environment.VITAL_AUTH_INTERNAL_URL ?? '');
      if (!environment.VITAL_SERVICES_AUTH_PROFILE_KEY || base.username || base.password || base.pathname !== '/'
        || base.search || base.hash || !['https:', 'http:'].includes(base.protocol)
        || environment.NODE_ENV === 'production' && base.protocol !== 'https:') throw new Error();
    } catch { return portalUnavailable('PORTAL_AUTH_CONFIGURATION_REQUIRED'); }
    try {
      const response = await fetcher(new URL('/internal/users/' + authId + '/profile', base), {
        redirect: 'error', signal: AbortSignal.timeout(5000), headers: {
          'X-Internal-Service': 'vital-services', 'X-Internal-Service-Key': environment.VITAL_SERVICES_AUTH_PROFILE_KEY!,
        },
      });
      if (!response.ok) { await response.body?.cancel(); return portalUnavailable('PORTAL_AUTH_IDENTITY_UNAVAILABLE'); }
      const receipt = z.object({ success: z.literal(true), data: z.object({
        id: z.uuid(), is_active: z.literal(true), is_deleted: z.literal(false), is_banned: z.literal(false),
      }).passthrough() }).passthrough().safeParse(await boundedJsonReceipt(response));
      if (!receipt.success || receipt.data.data.id !== authId) return portalUnavailable('PORTAL_AUTH_IDENTITY_UNVERIFIED');
      // Auth-created staff accounts can legitimately be awaiting OTP verification.
    } catch { return portalUnavailable('PORTAL_AUTH_IDENTITY_UNAVAILABLE'); }
  };
}
import { portalUnavailable } from './portal-integrations-contracts.js';

export function createPortalIdentityLookup(environment: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): PortalIdentityLookup {
  const profile = z.object({ id: z.uuid(), first_name: z.string(), middle_name: z.string().nullable().optional(), last_name: z.string(),
    extension_name: z.string().nullable().optional(), email: z.string().email().nullable().optional() }).passthrough();
  return async authIds => {
    if (authIds.length > 200) return portalUnavailable('PORTAL_IDENTITY_BATCH_LIMIT');
    let target: URL;
    try {
      target = new URL(environment.VITAL_AUTH_INTERNAL_URL ?? '');
      if (!environment.VITAL_SERVICES_AUTH_PROFILE_KEY || target.username || target.password || target.pathname !== '/' || target.search || target.hash
        || !['http:', 'https:'].includes(target.protocol) || environment.NODE_ENV === 'production' && target.protocol !== 'https:') throw new Error();
    } catch { return portalUnavailable('PORTAL_AUTH_CONFIGURATION_REQUIRED'); }
    const result: Awaited<ReturnType<PortalIdentityLookup>> = new Map();
    const ids = [...new Set(authIds.map(id => z.uuid().parse(id)))], deadline = Date.now() + 7500;
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100), remaining = deadline - Date.now();
      if (remaining <= 0) return portalUnavailable('PORTAL_AUTH_PROFILE_UNAVAILABLE');
      const response = await fetcher(new URL('/internal/users/profiles/batch', target), { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Service': 'vital-services', 'X-Internal-Service-Key': environment.VITAL_SERVICES_AUTH_PROFILE_KEY! },
        body: JSON.stringify({ user_ids: batch }), signal: AbortSignal.timeout(Math.min(5000, remaining)) });
      if (!response.ok) return portalUnavailable('PORTAL_AUTH_PROFILE_UNAVAILABLE');
      const parsed = z.object({ success: z.literal(true), data: z.object({ profiles: z.array(profile).max(100), missing_ids: z.array(z.uuid()).max(100) }).strict() }).passthrough().safeParse(await boundedJsonReceipt(response));
      if (!parsed.success) return portalUnavailable('PORTAL_AUTH_PROFILE_MISMATCH');
      const returned = [...parsed.data.data.profiles.map(value => value.id), ...parsed.data.data.missing_ids];
      if (new Set(returned).size !== returned.length || returned.length !== batch.length || returned.some(id => !batch.includes(id))) return portalUnavailable('PORTAL_AUTH_PROFILE_MISMATCH');
      for (const value of parsed.data.data.profiles) result.set(value.id, { name: [value.first_name, value.middle_name, value.last_name, value.extension_name].filter(Boolean).join(' ') || null, email: value.email ?? null });
    }
    return result;
  };
}
export function portalIntegrationsRuntime(databases: { core: CorePrismaClient; corePool: Pool; integrationsPool: Pool }, environment = process.env) {
  if (environment.VITAL_EDA_COMPLETION_ENABLED !== 'true') return undefined;
  if (environment.VITAL_EDA_ENABLED !== 'true') throw new Error('PORTAL_INTEGRATION_RUNTIME_DISABLED');
  return createPortalIntegrations({
    doctorProvision: createPortalDoctorProvision(databases.core, {
      writes: environment.VITAL_EDA_PROFILE_WRITES_ENABLED === 'true', verifyIdentity: createPortalDoctorIdentityVerifier(environment),
      syncStatus: async authId => (await getProfileSyncStatuses(databases.corePool, databases.integrationsPool, [authId])).get(authId) ?? 'pending',
    }),
    profile: createPortalProfileReaders(databases.core, {
      identities: createPortalIdentityLookup(environment), patientCounts: createPortalPatientCounts(databases.core),
      syncStatuses: ids => getProfileSyncStatuses(databases.corePool, databases.integrationsPool, ids),
    }, { writes: environment.VITAL_EDA_PROFILE_WRITES_ENABLED === 'true' }),
    history: environment.VITAL_EDA_APPOINTMENT_ENABLED === 'true' ? createPortalAppointmentHistory(databases.core) : undefined,
    staffAppointments: environment.VITAL_EDA_APPOINTMENT_ENABLED === 'true' && environment.VITAL_EDA_PAYMENT_ENABLED === 'true'
      && environment.VITAL_EDA_VIDEO_ENABLED === 'true'
      ? createPortalStaffAppointmentReader(databases.core, createPortalStaffComposer(databases.corePool, {
        payment: createPaymentStore(databases.integrationsPool), video: createPortalVideoProjection(databases.corePool, databases.integrationsPool),
      })) : undefined,
  });
}
