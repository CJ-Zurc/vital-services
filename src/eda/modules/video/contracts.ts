import type { Actor } from '../../contracts/actor.js';
import type { AppointmentRow,AppointmentParticipant,ParticipantReceipt,RescheduleIntent } from '../appointment/appointment-contracts.js';
import { requestHash } from '../../infrastructure/security.js';
import { z } from 'zod';

export const meetPurpose=z.enum(['approval','follow_up']);
export type MeetPurpose=z.infer<typeof meetPurpose>;
export const videoSelection=z.object({meetingProvider:z.literal('gmeet').optional(),meetingUrl:z.string().trim().max(2048).optional(),meetingGenerationId:z.uuid().optional()}).strict()
  .refine(v=>!(v.meetingUrl&&v.meetingGenerationId),{message:'Select one meeting source.'});
export type VideoSelection=z.infer<typeof videoSelection>;
export function selectionHash(input:VideoSelection){return requestHash('VIDEO-SELECTION','gmeet',{meetingUrl:input.meetingUrl??null,meetingGenerationId:input.meetingGenerationId??null});}
export interface VideoAppointment extends AppointmentRow {activeFollowUp:boolean;videoResourceId?:string|null;videoResourceVersion?:number|null}
export interface VideoWorkflowIntent {
  workflowId:string;sourceAppointmentId:string;targetAppointmentId:string;doctorId:string;doctorAuthId:string;patientAuthId:string;
  kind:'approve'|'follow-up';consultationType:string;billingLineageId:string;quotaLineageId:string;
  expectedSourceVersion:number;expectedTargetVersion:number;associationVersion:number;selectionHash:string;
  state:'prepared'|'committed'|'abandoned';expiresAt:Date;externalStartedAt:Date|null;
  videoProcessingState:string;receipt:VideoPreparationReceipt|null;correlationId:string;
}
export interface VideoPreparationReceipt {
  workflowId:string;sourceAppointmentId:string;targetAppointmentId:string;expectedSourceVersion:number;expectedTargetVersion:number;
  billingLineageId:string;associationVersion:number;selectionHash:string;resourceId:string|null;resourceVersion:number|null;freezeToken:string;
}
export interface VideoSagaIntent extends RescheduleIntent {doctorId:string;sourceConsultationType:string;replacementConsultationType:string}
export interface VideoAuthority {
  doctor(actor:Actor):Promise<{doctorId:string}>;
  appointment(actor:Actor,id:string):Promise<VideoAppointment>;
  generation(actor:Actor,id:string,purpose:MeetPurpose):Promise<VideoAppointment>;
  workflow(id:string):Promise<VideoWorkflowIntent>;
  saga(id:string):Promise<VideoSagaIntent>;
  completeWorkflow(id:string,receipt:VideoPreparationReceipt):Promise<void>;
  abandonExpiredWorkflow(id:string):Promise<boolean>;
  expiredWorkflows():Promise<string[]>;
}
export interface VideoAssociations {
  prepareWorkflow(id:string,input:VideoSelection):Promise<VideoPreparationReceipt>;
  finalizeWorkflow(id:string):Promise<VideoPreparationReceipt>;
  validate(row:AppointmentRow):Promise<void>;
  participant:AppointmentParticipant;
  recover():Promise<number>;
}
export type VideoParticipantReceipt=ParticipantReceipt;
