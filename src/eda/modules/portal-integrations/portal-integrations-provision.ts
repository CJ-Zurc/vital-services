import { z } from 'zod';
import type { Prisma } from '../../generated/core/client.js';
import { DomainError, type Actor } from '../../contracts/actor.js';
import type { CorePrismaClient } from '../../infrastructure/databases.js';
import { requestHash } from '../../infrastructure/security.js';
import { createProfileCommandGuard } from '../profile/profile-commands.js';
import { recordProfileEffects } from '../profile/profile-effects.js';
import { doctorPatchSchema, doctorSelect, userSelect, type ProfileCommandMetadata } from '../profile/profile.js';
import { authorizePortalIntegration, requirePortalStaffSource, type PortalSource } from './portal-integrations-contracts.js';

export const portalDoctorInput = z.object(doctorPatchSchema.shape).omit({ isDoctorOnboardingComplete: true, terms_accepted: true }).extend({
  specialty: z.string().trim().min(1).max(160), prcLicense: z.string().trim().min(1).max(80),
  availabilityType: z.enum(['virtual', 'in_person', 'both']),
}).strict();
const prepareInput = z.object({ workflowId: z.uuid(), targetAuthId: z.uuid(), input: portalDoctorInput }).strict();
const receiptSchema = z.object({ workflowId: z.uuid(), actorAuthId: z.uuid(), targetAuthId: z.uuid(),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/), expectedVersion: z.number().int().min(-1),
  department: z.object({ id: z.string().trim().min(1).max(160), name: z.string().trim().min(1).max(160) }).strict(),
}).strict();
const commitInput = z.object({ targetAuthId: z.uuid(), input: portalDoctorInput, receipt: receiptSchema }).strict();
const kind = 'portal.doctor.provision';
const conflict = (): never => { throw new DomainError(409, 'PORTAL_DOCTOR_WORKFLOW_CONFLICT', 'Provisioning binding or Profile revision changed.'); };
type Workflow = Prisma.ProfileWorkflowGetPayload<Record<string, never>>;
const status = (row: Workflow) => ({ workflowId: row.id, targetAuthId: row.targetAuthId, inputHash: row.inputHash,
  expectedVersion: row.expectedVersion, state: row.state });

export function createPortalDoctorProvision(db: CorePrismaClient, options: {
  writes: boolean;
  verifyIdentity(authId: string): Promise<void>;
  syncStatus(authId: string): Promise<'pending' | 'failed' | 'synced'>;
}) {
  const guard = createProfileCommandGuard();
  async function inspect(tx: Prisma.TransactionClient, target: string) {
    const user = await tx.vitalUser.findUnique({ where: { authId: target }, select: userSelect });
    if (user?.admin || user?.role === 'admin' || user?.doctor && (user.doctor.authId !== target || user.doctor.userId !== user.id)) conflict();
    return user;
  }
  function binding(row: Workflow | null, actor: Actor):Workflow {
    if (!row || row.kind !== kind || row.actorAuthId !== actor.authId || row.actorRole !== 'service') return conflict();
    return row;
  }
  async function transaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await db.$transaction(run, { isolationLevel: 'Serializable' }); }
      catch (error) {
        if (attempt >= 2 || !error || typeof error !== 'object' || !('code' in error)
          || !['P2034', 'P2002'].includes(String(error.code))) throw error;
      }
    }
  }
  return {
    async execute(actor: Actor, source: PortalSource, method: string, path: string, body?: unknown, metadata?: ProfileCommandMetadata) {
      const rule = authorizePortalIntegration(actor, source, method, path);
      if (!rule.route.startsWith('doctors/workflows')) throw new DomainError(403, 'PORTAL_DOCTOR_WORKFLOW_DENIED', 'Provisioning scope required.');
      if (!options.writes) throw new DomainError(503, 'PROFILE_PORTAL_PROVISION_WRITES_DISABLED', 'Profile writes disabled.');
      const id = rule.route.split('/')[2];
      if (method === 'GET') {
        const row = binding(await db.profileWorkflow.findUnique({ where: { id: id! } }), actor);
        await options.verifyIdentity(row.targetAuthId);
        return transaction(async tx => {
          requirePortalStaffSource(source, true);
          const current = binding(await tx.profileWorkflow.findUnique({ where: { id: id! } }), actor);
          await inspect(tx, current.targetAuthId);
          return status(current);
        });
      }
      const input = id ? commitInput.parse(body) : prepareInput.parse(body);
      const receipt='receipt'in input?input.receipt:undefined;
      if (!metadata || !z.uuid().safeParse(metadata.operationId).success || !/^[a-f0-9]{64}$/.test(metadata.requestHash))
        throw new DomainError(401, 'COMMAND_METADATA_REQUIRED', 'Signed mutation binding required.');
      const workflowId = id ?? ('workflowId' in input ? input.workflowId : conflict());
      if (metadata.operationId === workflowId) conflict();
      // Resolve the Auth UUID before every attempt/replay; no network operations in a retried transaction.
      await options.verifyIdentity(input.targetAuthId);
      const inputHash = requestHash('PROFILE', kind, { targetAuthId: input.targetAuthId, input: input.input });
      const outcome = await transaction(async tx => {
        requirePortalStaffSource(source, true);
        const user = await inspect(tx, input.targetAuthId);
        const existing = await tx.profileWorkflow.findUnique({ where: { id: workflowId } });
        if (existing && (binding(existing, actor).targetAuthId !== input.targetAuthId || existing.inputHash !== inputHash)) conflict();
        if (id && (!existing || metadata.operationId === existing.prepareOperationId)) conflict();
        if ('receipt' in input && (input.receipt.workflowId !== workflowId || input.receipt.actorAuthId !== actor.authId
          || input.receipt.targetAuthId !== input.targetAuthId || input.receipt.inputHash !== inputHash
          || input.receipt.expectedVersion !== existing!.expectedVersion
          || !(input.input.specialty === input.receipt.department.id || input.input.specialty.toLowerCase() === input.receipt.department.name.toLowerCase()))) conflict();
        const result = await guard(tx, { actor, operation: id ? 'doctor.provision' : 'workflow.prepare', targetAuthId: actor.resource,
          input: { workflowId, ...input }, metadata }, async () => {
          if (!id) {
            if (existing) return status(existing);
            return status(await tx.profileWorkflow.create({ data: { id: workflowId, actorAuthId: actor.authId, actorRole: 'service',
              targetAuthId: input.targetAuthId, kind, inputHash, expectedVersion: user?.version ?? -1,
              prepareOperationId: metadata.operationId, state: 'prepared' } }));
          }
          if (!existing || !receipt || existing.state !== 'prepared' || (user?.version ?? -1) !== existing.expectedVersion) return conflict();
          const profile = user ? await tx.vitalUser.update({ where: { id: user.id }, data: { role: 'doctor' } })
            : await tx.vitalUser.create({ data: { authId: input.targetAuthId, role: 'doctor' } });
          const { specialty: _selector, ...fields } = input.input;
          const data = { ...fields, role: 'doctor' as const, specialty: receipt.department.name,
            departmentExternalId: receipt.department.id, departmentName: receipt.department.name,
            isDoctorOnboardingComplete: false, changedAt: new Date() };
          await tx.vitalDoctor.upsert({ where: { authId: input.targetAuthId },
            create: { userId: profile.id, authId: input.targetAuthId, ...data }, update: data });
          const changed = await tx.vitalUser.update({ where: { id: profile.id }, data: { version: { increment: 1 } } });
          await recordProfileEffects(tx, actor, changed, 'doctor.provision', { doctorMirror: true,
            departmentExternalId: data.departmentExternalId, departmentName: data.departmentName });
          await tx.profileWorkflow.update({ where: { id: workflowId }, data: { state: 'committed',
            receipt: receipt as Prisma.InputJsonValue, commitOperationId: metadata.operationId } });
          // The command journal stores references/binding facts, not a stale doctor DTO.
          return { ...status(existing), state: 'committed' };
        });
        const row = binding(await tx.profileWorkflow.findUnique({ where: { id: workflowId } }), actor);
        if (id && row.state === 'committed') {
          const doctor = await tx.vitalDoctor.findUnique({ where: { authId: row.targetAuthId }, select: doctorSelect });
          if (!doctor) return conflict();
          return { ...status(row), doctor: { ...doctor, virtualFee: doctor.virtualFee?.toString() ?? null, inPersonFee: doctor.inPersonFee?.toString() ?? null } };
        }
        return result;
      });
      if ('doctor' in outcome && outcome.doctor) return { ...outcome,
        doctor: { ...outcome.doctor, syncStatus: await options.syncStatus(input.targetAuthId) } };
      return outcome;
    },
  };
}
export type PortalDoctorProvision = ReturnType<typeof createPortalDoctorProvision>;
