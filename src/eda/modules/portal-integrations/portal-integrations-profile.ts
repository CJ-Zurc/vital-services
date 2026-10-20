import type { CorePrismaClient } from '../../infrastructure/databases.js';
import type { ProfileSyncStatuses } from '../profile/profile-contracts.js';
import { portalMeta, portalPagination, portalUnavailable } from './portal-integrations-contracts.js';
import { createPortalProfileBootstrap } from './portal-integrations-bootstrap.js';

export type PortalIdentityLookup = (authIds: string[]) => Promise<Map<string, { name: string | null; email: string | null }>>;
export type PortalPatientCounts = (ids: string[]) => Promise<Map<string, {
  appointments: number; prescriptions: number; medicalCertificates: number;
}>>;
// A bounded, read-only Core projection. Document counts use Records' target authority, not retired plaintext rows.
export function createPortalPatientCounts(db: CorePrismaClient): PortalPatientCounts {
  return async ids => {
    if (ids.length > 100) return portalUnavailable('PORTAL_PATIENT_COUNTS_LIMIT');
    if (!ids.length) return new Map();
    return db.$transaction(async tx => {
      const visits = await tx.appointment.groupBy({ by: ['patientId'], where: { patientId: { in: ids } }, _count: { _all: true } });
      const docs = await tx.recordsDocument.groupBy({ by: ['patientId', 'kind'], where: { patientId: { in: ids } }, _count: { _all: true } });
      return new Map(ids.map(id => [id, { appointments: visits.find(row => row.patientId === id)?._count._all ?? 0,
        prescriptions: docs.find(row => row.patientId === id && row.kind === 'prescription')?._count._all ?? 0,
        medicalCertificates: docs.find(row => row.patientId === id && row.kind === 'medical-certificate')?._count._all ?? 0 }]));
    }, { isolationLevel: 'RepeatableRead' });
  };
}
const value = (input: unknown) => typeof input === 'string' ? input.trim().toLowerCase() : '';

export function createPortalProfileReaders(db: CorePrismaClient, dependencies: {
  identities: PortalIdentityLookup; syncStatuses: ProfileSyncStatuses; patientCounts: PortalPatientCounts;
}, options: { writes?: boolean } = {}) {
  return {
    bootstrap: createPortalProfileBootstrap(db, options),
    async doctors(query: Record<string, unknown>) {
      const page = portalPagination(query), search = value(query.search), specialty = value(query.specialty), onboarding = value(query.onboarding);
      let total = 0, offset = 0;
      const deadline = Date.now() + 8000;
      const data: Record<string, unknown>[] = [];
      // Scan bounded batches because legacy search includes Auth-owned names/email before pagination.
      for (;;) {
        if (Date.now() >= deadline) return portalUnavailable('PORTAL_PROFILE_SCAN_DEADLINE');
        const rows = await db.vitalDoctor.findMany({ skip: offset, take: 200,
          orderBy: [{ changedAt: 'desc' }, { userId: 'asc' }],
          include: { hospitalAffiliations: true, user: { select: { role: true } } } });
        if (!rows.length) break;
        const identities = await dependencies.identities(rows.map(row => row.authId));
        const selected = rows.filter(row => {
          const identity = identities.get(row.authId);
          return (!search || [row.userId, row.authId, identity?.email, identity?.name, row.specialty, row.prcLicense]
            .some(item => item?.toLowerCase().includes(search)))
            && (!specialty || row.specialty?.toLowerCase().includes(specialty))
            && (!onboarding || onboarding === 'complete' && row.isDoctorOnboardingComplete || onboarding === 'incomplete' && !row.isDoctorOnboardingComplete);
        });
        const visible = selected.filter(() => { const index = total++; return index >= page.skip && index < page.skip + page.pageSize; });
        const statuses = await dependencies.syncStatuses(visible.map(row => row.authId));
        for (const row of visible) data.push({ id: row.userId, authId: row.authId, role: row.user.role,
          name: identities.get(row.authId)?.name ?? null, email: identities.get(row.authId)?.email ?? null,
           specialty: row.specialty, departmentExternalId: row.departmentExternalId,
          departmentName: row.departmentName, prcLicense: row.prcLicense, availabilityType: row.availabilityType,
          virtualFee: row.virtualFee ? Number(row.virtualFee) : null, inPersonFee: row.inPersonFee ? Number(row.inPersonFee) : null,
          starRating: row.starRating, onboardingComplete: row.isDoctorOnboardingComplete,
          hospitals: row.hospitalAffiliations.map(item => item.hospitalName), syncStatus: statuses.get(row.authId) ?? 'synced' });
        if (rows.length < 200) break;
        offset += rows.length;
      }
      return { data, meta: portalMeta(page, total) };
    },
    async patients(query: Record<string, unknown>) {
      const page = portalPagination(query), search = value(query.search), ehrLinked = value(query.ehrLinked), onboarding = value(query.onboarding);
      let total = 0, offset = 0;
      const deadline = Date.now() + 8000;
      const data: Record<string, unknown>[] = [];
      for (;;) {
        if (Date.now() >= deadline) return portalUnavailable('PORTAL_PROFILE_SCAN_DEADLINE');
        const rows = await db.vitalPatient.findMany({ skip: offset, take: 200, orderBy: { userId: 'asc' }, include: { user: { select: { role: true } } } });
        if (!rows.length) break;
        const identities = await dependencies.identities(rows.map(row => row.authId));
        const selected = rows.filter(row => {
          const identity = identities.get(row.authId);
          return (!search || [row.userId, row.authId, row.ehrPatientId, identity?.email, identity?.name]
            .some(item => item?.toLowerCase().includes(search)))
            && (!ehrLinked || ehrLinked === 'true' && Boolean(row.ehrPatientId) || ehrLinked === 'false' && !row.ehrPatientId)
            && (!onboarding || onboarding === 'complete' && row.isOnboardingComplete || onboarding === 'incomplete' && !row.isOnboardingComplete);
        });
        const visible = selected.filter(() => { const index = total++; return index >= page.skip && index < page.skip + page.pageSize; });
        const counts = await dependencies.patientCounts(visible.map(row => row.userId));
        for (const row of visible) {
          const count = counts.get(row.userId) ?? portalUnavailable('PORTAL_PATIENT_COUNTS_UNAVAILABLE');
          data.push({ id: row.userId, authId: row.authId, role: row.user.role,
            name: identities.get(row.authId)?.name ?? null, email: identities.get(row.authId)?.email ?? null,
            ehrPatientId: row.ehrPatientId, ehrRecordOrigin: row.ehrRecordOrigin,
            recordAvailable: row.isRecordAvailable, onboardingComplete: row.isOnboardingComplete, counts: count });
        }
        if (rows.length < 200) break;
        offset += rows.length;
      }
      return { data, meta: portalMeta(page, total) };
    },
    async patientMarker(authId: string) {
      const row = await db.vitalPatient.findUnique({ where: { authId }, include: { user: { select: { authId: true, role: true } } } });
      if (!row) return null;
      if (row.authId !== authId || row.user.authId !== authId || row.user.role !== 'patient')
        return portalUnavailable('PORTAL_PATIENT_IDENTITY_CONFLICT');
      return { userId: row.userId, authId: row.authId, onboardingComplete: row.isOnboardingComplete };
    },
  };
}
export type PortalProfileReaders = ReturnType<typeof createPortalProfileReaders>;
