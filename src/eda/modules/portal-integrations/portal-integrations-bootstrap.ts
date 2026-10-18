import { z } from 'zod';
import { DomainError, type Actor } from '../../contracts/actor.js';
import type { CorePrismaClient } from '../../infrastructure/databases.js';
import { createProfileCommandGuard } from '../profile/profile-commands.js';
import { recordProfileEffects } from '../profile/profile-effects.js';
import { userSelect, type ProfileCommandMetadata } from '../profile/profile.js';
import { authorizePortalIntegration, type PortalSource } from './portal-integrations-contracts.js';

export function createPortalProfileBootstrap(db: CorePrismaClient, options: { writes?: boolean } = {}) {
  const guard = createProfileCommandGuard();
  return async (actor: Actor, source: PortalSource, metadata: ProfileCommandMetadata) => {
    authorizePortalIntegration(actor, source, 'POST', '/internal/v1/portal-integrations/patient/bootstrap');
    z.object({ operationId: z.uuid(), requestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(metadata);
    // Policy chooses exactly the patient marker. A source's administrator/doctor roles are never provisioning inputs.
    const patientActor: Actor = { ...actor, role: 'patient', resource: actor.authId, scopes: ['profile.materialize'], isSuperAdmin: false };
    for (let attempt = 0; ; attempt++) {
      try {
        return await db.$transaction(async tx => {
          const existing = await tx.vitalUser.findUnique({ where: { authId: actor.authId }, select: userSelect });
          // Recheck even before journal replay so later privilege changes invalidate a prior patient operation.
          if (existing && (existing.role !== 'patient' || existing.doctor || existing.admin))
            throw new DomainError(409, 'PORTAL_PATIENT_IDENTITY_CONFLICT', 'Portal bootstrap cannot replace a privileged marker.');
          if (existing?.patient && (existing.patient.authId !== actor.authId || existing.patient.userId !== existing.id))
            throw new DomainError(409, 'PORTAL_PATIENT_IDENTITY_CONFLICT', 'Patient marker identity mismatch.');
          if (!options.writes) {
            if (existing?.patient) return { patientReady: true as const, onboardingComplete: existing.patient.isOnboardingComplete };
            throw new DomainError(503, 'PROFILE_PORTAL_BOOTSTRAP_WRITES_DISABLED', 'Profile writes disabled.');
          }
          await guard(tx, { actor: patientActor, operation: 'materialize', input: { purpose: 'portal.patient.bootstrap' }, metadata }, async () => {
            if (existing?.patient) return { patientReady: true as const, onboardingComplete: existing.patient.isOnboardingComplete };
            const user = existing ?? await tx.vitalUser.create({ data: { authId: actor.authId, role: 'patient' } });
            await tx.vitalPatient.create({ data: { userId: user.id, authId: actor.authId, isRecordAvailable: false, isOnboardingComplete: false } });
            const changed = await tx.vitalUser.update({ where: { id: user.id }, data: { version: { increment: 1 } } });
            await recordProfileEffects(tx, patientActor, changed, 'materialize');
            return { patientReady: true as const, onboardingComplete: false };
          });
          // The stable bootstrap command may be revisited after onboarding; do not replay a stale display flag.
          const patient = await tx.vitalPatient.findUnique({ where: { authId: actor.authId }, select: { isOnboardingComplete: true } });
          if (!patient) throw new DomainError(409, 'PORTAL_PATIENT_IDENTITY_CONFLICT', 'Patient marker unavailable.');
          return { patientReady: true as const, onboardingComplete: patient.isOnboardingComplete };
        }, { isolationLevel: 'Serializable' });
      } catch (error) {
        if (attempt >= 2 || !error || typeof error !== 'object' || !('code' in error)
          || !['P2034', 'P2002'].includes(String(error.code))) throw error;
      }
    }
  };
}
