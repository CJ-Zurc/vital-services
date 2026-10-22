import { z } from "zod";
import type { RecordsKeyring } from "./protection.js";
import type { EhrEvidenceConfig } from "./ehr-evidence.js";
import type { AppointmentOwners } from "../appointment/appointment-contracts.js";

const short=z.string().trim().min(1).max(500).regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/);
const optional=z.string().trim().max(2000).regex(/^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]*$/).nullable().optional();
export const prescriptionLine=z.object({medicineId:z.string().max(128).nullable().optional(),medicineName:short,isControlled:z.boolean(),brandName:optional,strength:optional,dosageForm:optional,dosageAmount:short,dosageUnit:short,frequency:short,
  duration:optional,route:optional,quantity:optional,instructions:optional}).strict();
const date=z.iso.date();
export const prescriptionData=z.object({signingConfirmed:z.literal(true),supersedesId:z.uuid().nullable().optional(),correctionReason:optional,lines:z.array(prescriptionLine).min(1).max(50),validityLimit:date.nullable().optional()}).strict();
export const certificateData=z.object({signingConfirmed:z.literal(true),supersedesId:z.uuid().nullable().optional(),correctionReason:optional,purpose:short,diagnosis:z.string().trim().min(1).max(4000),consultationDate:date.nullable().optional(),restStartDate:date.nullable().optional(),restEndDate:date.nullable().optional(),
  recommendation:optional,remarks:optional}).strict().refine(v=>!v.restStartDate||!v.restEndDate||v.restEndDate>=v.restStartDate);
export const snapshotPrepare=z.object({workflowId:z.uuid(),appointmentId:z.uuid(),expectedVersion:z.number().int().nonnegative(),recovery:z.boolean().default(false)}).strict();
export const documentPrepare=z.object({workflowId:z.uuid(),kind:z.enum(["prescription","medical-certificate"]),patientId:z.uuid().optional(),patientAuthId:z.uuid().optional(),appointmentId:z.uuid().nullable().default(null),expectedVersion:z.number().int().nonnegative(),data:z.unknown()}).strict()
  .refine(v=>Boolean(v.patientId)!==Boolean(v.patientAuthId),{message:'Exactly one patient identifier is required.'});
export interface RecordsParties {patientName:string;doctorName:string;doctorLicense:string}
export interface RecordsConfig {appOrigin?:string;keyring:RecordsKeyring;evidence:EhrEvidenceConfig;financial?:AppointmentOwners["financial"];
  parties:(patientAuthId:string,doctorAuthId:string,doctorId:string)=>Promise<RecordsParties>;
}
export interface RecordsWorkflowRow {id:string;actorAuthId:string;patientId:string;doctorId:string;appointmentId:string|null;expectedVersion:number;associationVersion:number|null;ehrPatientId:string;ehrCaseId:string|null;commitOperationId:string|null;
  kind:string;inputHash:string;recovery:boolean;state:string;resourceId:string|null;expiresAt:Date}
export interface RecordsAssetRow {id:string;patientId:string;appointmentId:string|null;kind:string;version:number;state:string;protectedPayload:unknown;objectKey:string;publishedKey:string|null;contentHash:string|null;publishedHash:string|null;mimeType:string;byteLength:string;createdAt:Date;scanEvidence:unknown}
