import { z } from 'zod';

const account = z.object({
  authId: z.uuid(), email: z.email(), firstName: z.string(), middleName: z.string(), lastName: z.string(),
  systems: z.record(z.string(), z.string()), metadata: z.record(z.string(), z.unknown()),
  ehrUserId: z.uuid().optional(), ehrPatientId: z.uuid().optional(), medicalRecordNumber: z.string().optional(),
  hospitalDepartmentId: z.uuid().optional(), hospitalDepartmentName: z.string().optional(),
  specialtyId: z.uuid().optional(), specialtyName: z.string().optional(),
}).strict();

export function validateSeedManifest(input: unknown) {
  const manifest = z.object({ version: z.literal(2), accounts: z.array(account).min(1).max(100),
    catalog: z.array(z.object({ id: z.uuid(), name: z.string().min(1), category: z.enum(['hospital', 'specialty']),
      aliases: z.array(z.string()) }).strict()).min(1) }).strict().parse(input);
  if (new Set(manifest.accounts.map(a => a.authId)).size !== manifest.accounts.length
    || new Set(manifest.accounts.map(a => a.email.toLowerCase())).size !== manifest.accounts.length) {
    throw new Error('BASELINE_DUPLICATE_IDENTITY');
  }
  for (const a of manifest.accounts) {
    const role = a.systems.vital;
    if (role && !['admin', 'doctor', 'patient'].includes(role)) throw new Error('BASELINE_ROLE_INVALID');
    if (role === 'patient' && (!a.ehrPatientId || !a.ehrUserId)) throw new Error('BASELINE_EHR_LINK_MISSING');
    if (role === 'doctor' && (!a.ehrUserId || !a.specialtyId || !a.specialtyName)) throw new Error('BASELINE_DEPARTMENT_MISSING');
  }
  const byId = new Map(manifest.catalog.map(row => [row.id, row]));
  for (const a of manifest.accounts) {
    for (const [id, name, category] of [[a.hospitalDepartmentId, a.hospitalDepartmentName, 'hospital'],
      [a.specialtyId, a.specialtyName, 'specialty']] as const) {
      if ((id || name) && (!id || !name || byId.get(id)?.category !== category || byId.get(id)?.name !== name)) {
        throw new Error('BASELINE_CATALOG_LINK_INVALID');
      }
    }
  }
  return manifest;
}

type SeedAccount = z.infer<typeof account>;
type SeedProfile = { role: string; patient?: { ehrPatientId: string | null; isRecordAvailable: boolean } | null;
  doctor?: { departmentExternalId: string | null; departmentName: string | null } | null; admin?: unknown };

export function baselineLinksMatch(expected: SeedAccount, user: SeedProfile | null): boolean {
  if (!user || user.role !== expected.systems.vital) return false;
  if (user.role === 'patient') return user.patient?.ehrPatientId === expected.ehrPatientId && user.patient?.isRecordAvailable === true;
  if (user.role === 'doctor') return user.doctor?.departmentExternalId === expected.specialtyId && user.doctor?.departmentName === expected.specialtyName;
  return user.role === 'admin' && !!user.admin;
}
