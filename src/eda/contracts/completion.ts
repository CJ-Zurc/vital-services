import { z } from 'zod';
import { DomainError, requireScope, type Actor } from './actor.js';
import type { AppointmentReadSnapshot } from '../modules/appointment/appointment-reads.js';

export const ANALYTICS_EXPORT_SUBJECT = 'c9b49b21-ff40-5aec-a93b-47b89c23a933';

export const ANALYTICS_EXPORT_RESOURCE = 'analytics:pre-consultations';

export interface ExportQuery { limit: number; cursor: { updatedAt: string; id: string } | null; upperBound: string | null }

export interface ExportPage {
  data: { preConsultationId: string; chiefComplaint: string | null; submittedAt: string | null; scheduledAt: string; sourceUpdatedAt: string }[];
  meta: { nextCursor: string | null; lastCursor: string | null; hasMore: boolean; upperBound: string | null };
}

export interface CompletionAppointmentOwner {
  patient(actor: Actor): Promise<{ patientId: string; appointments: AppointmentReadSnapshot[]; statusCounts: Record<string, number>;
    associations: CompletionAssociation[]; validate(): Promise<void> }>;
  statusCounts(actor: Actor): Promise<Record<string, number>>;
  exportSubmitted(actor: Actor, query: ExportQuery): Promise<ExportPage>;
}

export interface CompletionRecordsOwner {
  patientSummary(actor: Actor, patientId: string): Promise<{ documents: number; files: number }>;
}

export interface CompletionAssociation { id: string; billingLineageId: string; associationVersion: number; doctorAuthId: string;
  paymentVersion?: number | null }

export interface CompletionFinancialOwner {
  summary(actor: Actor): Promise<{ paymentCounts: Record<string, number>; paidVolume: number }>;
  patientSummary(actor: Actor, patientId: string, associations: CompletionAssociation[]): Promise<{ paid: number; validate(): Promise<void> }>;
}

export interface CompletionOwners {
  appointments?: CompletionAppointmentOwner;
  records?: CompletionRecordsOwner;
  financial?: CompletionFinancialOwner;
}

export function completionUnavailable(owner: string): never {
  throw new DomainError(503, 'COMPLETION_' + owner + '_UNAVAILABLE', 'Required completion owner is unavailable.');
}

export function completionRole(actor: Actor, role: Actor['role'], scope: string) {
  requireScope(actor, scope, actor.authId);
  if (actor.role !== role) throw new DomainError(403, 'COMPLETION_ROLE_DENIED', role === 'admin' || role === 'patient' ? 'Forbidden' : 'Forbidden.');
}

export function authorizeExport(actor: Actor) {
  requireScope(actor, 'analytics.pre-consultations.export', ANALYTICS_EXPORT_RESOURCE);
  if (actor.role !== 'service' || actor.authId !== ANALYTICS_EXPORT_SUBJECT || actor.isSuperAdmin)
    throw new DomainError(403, 'COMPLETION_EXPORT_DENIED', 'Forbidden.');
}

export const completionCount = (value: unknown) => z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(value);
