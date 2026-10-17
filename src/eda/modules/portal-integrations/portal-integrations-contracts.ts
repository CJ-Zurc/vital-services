import { z } from 'zod';
import { DomainError, type Actor } from '../../contracts/actor.js';

export const portalSourceSchema = z.object({
  subject: z.uuid(), system: z.string().min(1).max(64),
  systems: z.array(z.string().min(1).max(64)).max(32),
  roles: z.array(z.string().min(1).max(64)).max(32),
  isAdmin: z.boolean(), isSuperAdmin: z.boolean(), expiresAt: z.number().int().positive(),
}).strict();
export type PortalSource = z.infer<typeof portalSourceSchema>;
export function requirePortalStaffSource(input: unknown, manager = false): PortalSource {
  const source = portalSourceSchema.parse(input);
  if (source.expiresAt <= Math.floor(Date.now() / 1000) || !source.isSuperAdmin && !(source.system === 'ehr'
    && source.systems.includes('ehr') && (source.isAdmin || !manager && source.roles.some(role => ['nurse', 'doctor'].includes(role)))))
    throw new DomainError(403, 'PORTAL_INTEGRATION_DELEGATION_DENIED', 'Current foreign staff authority required.');
  return source;
}
export const portalStatuses = ['pending', 'approved', 'rejected', 'pending_patient_confirmation',
  'pending_payment_verification', 'confirmed', 'rescheduled', 'cancelled', 'completed'] as const;
export const portalActiveStatuses = ['pending', 'approved', 'pending_patient_confirmation',
  'pending_payment_verification', 'confirmed', 'rescheduled'] as const;
export type PortalRoute = 'doctors' | 'patients' | 'appointments' | 'patient/appointments' | 'patient/bootstrap';
const queryKeys: Record<PortalRoute, string[]> = {
  doctors: ['page', 'pageSize', 'search', 'specialty', 'onboarding'],
  patients: ['page', 'pageSize', 'search', 'ehrLinked', 'onboarding'],
  appointments: ['page', 'pageSize', 'status', 'patientId', 'doctorId', 'dateFrom', 'dateTo'],
  'patient/appointments': ['page', 'pageSize', 'status'], 'patient/bootstrap': [],
};
export function portalIntegrationRoute(path: string, method: string) {
  const url = new URL(path, 'https://internal.invalid');
  if (url.origin !== 'https://internal.invalid' || url.hash || url.pathname !== path.split('?')[0]) return null;
  const suffix = url.pathname.replace(/^\/internal\/v1\/portal-integrations\//, '');
  const workflow = /^doctors\/workflows(?:\/([0-9a-f-]{36})(\/commit)?)?$/.exec(suffix);
  if (workflow && (workflow[1] ? z.uuid().safeParse(workflow[1]).success : true)
    && method === (!workflow[1] || workflow[2] ? 'POST' : 'GET') && !url.search) {
    return { route: suffix, scope: 'portal.integration.' + suffix.replaceAll('/', '.'), resource: 'portal:' + suffix };
  }
  const route = suffix as PortalRoute;
  if (!Object.hasOwn(queryKeys, route) || method !== (route === 'patient/bootstrap' ? 'POST' : 'GET')) return null;
  if ([...url.searchParams.keys()].some(key => !queryKeys[route].includes(key) || url.searchParams.getAll(key).length !== 1)) return null;
  return { route, scope: 'portal.integration.' + route.replaceAll('/', '.'), resource: 'portal:' + route };
}

// The caller must first verify the process mTLS and asymmetric assertion, including its action/hash.
export function authorizePortalIntegration(actor: Actor, sourceInput: unknown, method: string, path: string, now = Math.floor(Date.now() / 1000)) {
  const deny = () => new DomainError(403, 'PORTAL_INTEGRATION_DELEGATION_DENIED', 'Route-scoped portal authority required.');
  const parsed = portalSourceSchema.safeParse(sourceInput), rule = portalIntegrationRoute(path, method);
  if (!parsed.success || !rule) throw deny();
  const source = parsed.data;
  if (actor.role !== 'service' || actor.serviceId !== 'vital-web' || actor.isSuperAdmin
    || actor.authId !== source.subject || actor.scopes.length !== 1 || actor.scopes[0] !== rule.scope
    || actor.resource !== rule.resource || source.expiresAt <= now) throw deny();
  if (rule.route.startsWith('patient/')) {
    const patient = source.system === 'ehr' && source.roles.includes('patient')
      || source.system === 'uhse' && source.roles.includes('guest')
      || source.system === 'vital' && (source.roles.includes('patient')
        || rule.route === 'patient/bootstrap' && source.roles.includes('guest'));
    if (!source.systems.includes('vital') || !patient) throw deny();
  } else if (rule.route.startsWith('doctors/workflows')) {
    if (!source.isSuperAdmin && !(source.system === 'ehr' && source.isAdmin && source.systems.includes('ehr'))) throw deny();
  } else if (!source.isSuperAdmin && !(source.system === 'ehr'
    && (source.isAdmin || source.roles.some(role => ['nurse', 'doctor'].includes(role))))) throw deny();
  return { ...rule, source };
}

export function portalPagination(input: Record<string, unknown>, defaultSize = 50) {
  const rawPage = Number(input.page ?? '1'), rawSize = Number(input.pageSize ?? String(defaultSize));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const pageSize = Number.isInteger(rawSize) && rawSize > 0 ? Math.min(rawSize, 100) : defaultSize;
  const skip = (page - 1) * pageSize;
  if (!Number.isSafeInteger(skip)) throw new DomainError(400, 'PORTAL_PAGINATION_INVALID', 'Invalid page.');
  return { page, pageSize, skip };
}
export function portalMeta(page: ReturnType<typeof portalPagination>, total: number) {
  return { page: page.page, pageSize: page.pageSize, total, totalPages: Math.max(1, Math.ceil(total / page.pageSize)) };
}
export const portalUnavailable = (code: string): never => {
  throw new DomainError(503, code, 'Required portal owner contract is unavailable.');
};
