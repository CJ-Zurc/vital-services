import { z } from "zod";
import { DomainError } from "../../contracts/actor.js";
import type { PoolClient } from "pg";
import type { VideoSelection,VideoPreparationReceipt } from "../video/contracts.js";

export const versionSchema = z.number().int().nonnegative();
export const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
export const timeOnly = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const scheduleInput = z.object({ slotDate: dateOnly, startTime: timeOnly, endTime: timeOnly,
  consultationType: z.enum(["virtual", "in_person", "both"]), isPublished: z.boolean().default(true) }).strict();
export function slotInterval(day: string, start: string, end: string) {
  dateOnly.parse(day); timeOnly.parse(start); timeOnly.parse(end);
  if (start === end) throw new DomainError(400, "SLOT_INTERVAL_INVALID", "Start and end must differ.");
  const startsAt = new Date(day + "T" + start + ":00+08:00");
  const endsAt = new Date(day + "T" + end + ":00+08:00");
  if (endsAt <= startsAt) endsAt.setUTCDate(endsAt.getUTCDate() + 1);
  return { startsAt, endsAt };
}
export function appointmentExpired(row: { scheduledAt: Date; proposedEndAt?: Date | null; slotEndsAt?: Date | null }, now: number) {
  return (row.slotEndsAt ?? row.proposedEndAt ?? row.scheduledAt).getTime() <= now;
}
export function effectiveCompletionDeadline(row:{scheduledAt:Date;proposedEndAt:Date|null;completionDeadlineAt:Date|null}) {
  return row.completionDeadlineAt??new Date((row.proposedEndAt??row.scheduledAt).getTime()+86_400_000);
}
export const reasonInput = z.object({ expectedVersion: versionSchema, reason: z.string().trim().min(1).max(2000) }).strict();
export const acknowledgementInput = z.object({ expectedVersion: versionSchema }).strict();
export const dateBlockInput = z.object({ startDate: dateOnly, endDate: dateOnly, weekday: z.number().int().min(0).max(6).nullable().default(null),
  confirmedAppointmentCount: z.number().int().nonnegative().optional() }).strict().refine(x => x.endDate >= x.startDate);
export interface AppointmentRow {
  id: string; doctorId: string; patientId: string; patientAuthId: string; doctorAuthId: string;
  status: string; version: number; billingLineageId: string; associationVersion: number;
  scheduledAt: Date; proposedEndAt: Date | null; slotEndsAt: Date | null; scheduleSlotId: string | null;
  consultationType: string; sourceAppointmentId: string | null; appointmentKind: string;
  patientRescheduleCount: number; doctorRescheduleCount: number; ehrCaseId: string | null;
  doctorConfirmedAt: Date | null; patientConfirmedAt: Date | null; completionDeadlineAt: Date | null;
  paperworkLockedAt: Date | null; completedAt: Date | null;
  proposalRole: string | null;
}
export interface AppointmentCommand { operationId: string; requestHash: string }
export interface ParticipantReceipt {
  operationId: string; participant: string; freezeToken: string; requestHash: string;
  billingLineageId: string; associationVersion: number; sourceAppointmentId: string;
  replacementAppointmentId: string; expectedSourceVersion: number; expectedReplacementVersion: number;
  resourceId: string | null; resourceVersion: number | null;
  verifiedPaid?: boolean;
}
export interface RescheduleIntent {
  correlationId: string;
  patientAuthId: string; doctorAuthId: string; amountCentavos?: number;
  operationId: string; sourceAppointmentId: string; replacementAppointmentId: string;
  expectedSourceVersion: number; expectedReplacementVersion: number; billingLineageId: string;
  associationVersion: number; requestHash: string; deadlineAt: Date; pivotCommittedAt: Date | null;
  state: string; receipt?: ParticipantReceipt;
}
export interface AppointmentParticipant {
  prepare(operationId: string): Promise<ParticipantReceipt>;
  abort(operationId: string, token?: string): Promise<void>;
  finalize(operationId: string, token: string): Promise<void>;
}
export interface AppointmentOwners {
  messaging?: { chainEligibility(appointmentId:string):Promise<{eligible:boolean;lineageId:string;sourceVersion:number}> };
  realtime?: { invalidate(appointmentId:string,sourceVersion:number):Promise<void> };
  ehrRecovery?: (appointmentId:string)=>Promise<{caseId:string;patientId:string;doctorAuthId:string|null;externalSystemRef:string}|null>;
  records?: {
    apply(tx: PoolClient, appointment: AppointmentRow, action: "approve" | "confirm" | "cancel" | "complete" | "reschedule" | "expire", context?: RecordsTransitionContext): Promise<void>;
    beforeDoctorAcknowledgement?(tx: PoolClient, appointment: AppointmentRow, context: RecordsTransitionContext): Promise<void>;
    finalizeReschedule?(tx: PoolClient, source: AppointmentRow, replacement: AppointmentRow, context: RecordsTransitionContext): Promise<void>;
  };
  financial?: { verifyPaid(appointment:AppointmentRow, projection:{paymentId:string;sourceVersion:number}):Promise<void> };
  video?: { validate(appointment: AppointmentRow): Promise<void>; participant: AppointmentParticipant;
    prepareWorkflow:(id:string,selection:VideoSelection)=>Promise<VideoPreparationReceipt>;
    finalizeWorkflow:(id:string)=>Promise<VideoPreparationReceipt> };
  payment?: AppointmentParticipant & { checkoutAfterApproval?(appointment: AppointmentRow): Promise<void> };
}
export interface RecordsTransitionContext {
  operationId: string; beforeState: string; afterState: string;
  replacement?: AppointmentRow;
  financialEvidence?: {paymentId:string;sourceVersion:number;status:string;billingLineageId:string;associationVersion:number};
  effectiveAt: Date;
}
export function requireOwner<T>(owner: T | undefined, name: string): T {
  if (!owner) throw new DomainError(503, "APPOINTMENT_" + name.toUpperCase() + "_OWNER_UNAVAILABLE", "Required appointment owner is unavailable.");
  return owner;
}
export const appointmentFactData = (row: AppointmentRow, actorAuthId: string | null, operationId: string) => ({
  appointmentId: row.id, appointmentVersion: row.version, billingLineageId: row.billingLineageId,
  associationVersion: row.associationVersion, actorAuthId, operationId,
});
