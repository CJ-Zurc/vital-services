import { z } from 'zod';
import { DomainError } from '../../contracts/actor.js';
import type { CorePrismaClient } from '../../infrastructure/databases.js';
import { portalActiveStatuses, portalMeta, portalPagination, portalStatuses, requirePortalStaffSource } from './portal-integrations-contracts.js';
import type { PortalSource } from './portal-integrations-contracts.js';
import { dateOnly } from '../appointment/appointment-contracts.js';

const select = { id: true, patientId: true, appointmentKind: true, consultationType: true, status: true,
  scheduledAt: true, proposedEndAt: true, updatedAt: true,
  doctor: { select: { userId: true, authId: true, specialty: true } },
  scheduleSlot: { select: { slotDate: true, startTime: true, endTime: true } } } as const;

export function createPortalAppointmentHistory(db: CorePrismaClient, now = () => new Date()) {
  return async (patientId: string, query: Record<string, unknown>) => {
    const page = portalPagination(query, 20), status = typeof query.status === 'string' ? query.status.trim().toLowerCase() : '';
    if (status && status !== 'all' && !portalStatuses.includes(status as typeof portalStatuses[number]))
      throw new DomainError(400, 'PORTAL_APPOINTMENT_STATUS_INVALID', 'Invalid appointment status.');
    const where = { patientId: z.uuid().parse(patientId),
      ...(status && status !== 'all' ? { status: z.enum(portalStatuses).parse(status) } : {}) };
    return db.$transaction(async tx => {
      const total = await tx.appointment.count({ where });
      const data = await tx.appointment.findMany({ where, skip: page.skip, take: page.pageSize,
        orderBy: [{ scheduledAt: 'desc' }, { updatedAt: 'desc' }], select });
      const groups = await tx.appointment.groupBy({ by: ['status'], where: { patientId }, _count: { _all: true } });
      const nextAppointment = await tx.appointment.findFirst({ where: { patientId,
        status: { in: [...portalActiveStatuses] }, scheduledAt: { gte: now() } },
        orderBy: [{ scheduledAt: 'asc' }, { updatedAt: 'desc' }], select });
      const statusTotals = Object.fromEntries(portalStatuses.map(state => [state, groups.find(row => row.status === state)?._count._all ?? 0]));
      return { data, summary: { statusTotals, nextAppointment }, meta: { ...portalMeta(page, total), patientReady: true } };
    }, { isolationLevel: 'RepeatableRead' });
  };
}
export type PortalAppointmentHistory = ReturnType<typeof createPortalAppointmentHistory>;

export interface PortalAppointmentReference {
  id: string; version: number; patientId: string; doctorId: string; billingLineageId: string; associationVersion: number;
}
// The composer is an owning-module interface: it must preserve the legacy staff DTO and validate Payment/Video associations.
// Never adapt ordinary patient/admin APIs by inventing a local role for the foreign clinician.
export function createPortalStaffAppointmentReader(db: CorePrismaClient,
  compose: (source: PortalSource, references: PortalAppointmentReference[]) => Promise<unknown[]>) {
  return async (source: PortalSource, query: Record<string, unknown>) => {
    requirePortalStaffSource(source);
    const page = portalPagination(query);
    const state = typeof query.status === 'string' ? query.status : '';
    const dateFrom = query.dateFrom ? dateOnly.parse(query.dateFrom) : undefined;
    const dateTo = query.dateTo ? dateOnly.parse(query.dateTo) : undefined;
    const where = { ...(state ? { status: z.enum(portalStatuses).parse(state) } : {}),
      ...(query.patientId ? { patientId: z.uuid().parse(query.patientId) } : {}),
      ...(query.doctorId ? { doctorId: z.uuid().parse(query.doctorId) } : {}),
      ...(dateFrom || dateTo ? { scheduledAt: { ...(dateFrom ? { gte: new Date(dateFrom + 'T00:00:00+08:00') } : {}),
        ...(dateTo ? { lte: new Date(dateTo + 'T23:59:59+08:00') } : {}) } } : {}) };
    const selection = await db.$transaction(async tx => ({
      total: await tx.appointment.count({ where }),
      references: await tx.appointment.findMany({ where, skip: page.skip, take: page.pageSize,
        orderBy: [{ scheduledAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        select: { id: true, version: true, patientId: true, doctorId: true, billingLineageId: true, associationVersion: true } }),
    }), { isolationLevel: 'RepeatableRead' });
    const data = await compose(source, selection.references);
    if (data.length !== selection.references.length || data.some((row, index) => typeof row !== 'object' || row === null
      || !('id' in row) || row.id !== selection.references[index]!.id))
      throw new DomainError(503, 'PORTAL_STAFF_COMPOSITION_UNAVAILABLE', 'Incomplete staff projection.');
    const current = await db.appointment.findMany({ where: { id: { in: selection.references.map(row => row.id) } },
      select: { id: true, version: true } });
    if (current.length !== selection.references.length || selection.references.some(row => !current.some(item => item.id === row.id && item.version === row.version)))
      throw new DomainError(409, 'PORTAL_APPOINTMENT_READ_CHANGED', 'Appointment changed during composition.');
    requirePortalStaffSource(source);
    return { data, meta: portalMeta(page, selection.total) };
  };
}
