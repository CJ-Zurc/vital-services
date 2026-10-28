import { z } from 'zod';
import { intakeSchema, complaintSchema } from '../appointment/appointment-intake.js';

export const assertionSchema = z.enum(['present','denied','uncertain','historical','other_person','unresolved']);
export const conceptSchema = z.object({ id:z.string().min(1).max(96), name:z.string().min(1).max(200),
  assertion:assertionSchema, field:z.string().max(80), method:z.enum(['selected','nlp','corrected']),
  similarity:z.number().min(-1).max(1).optional() }).strict();
export type Concept = z.infer<typeof conceptSchema>;
export const intakePayloadSchema = z.object({ chiefComplaint:complaintSchema, opqrst:intakeSchema,
  primarySymptom:z.object({ id:z.string().max(96).nullable(), name:z.string().trim().min(1).max(200) }).strict(),
}).strict();
export type IntakePayload = z.infer<typeof intakePayloadSchema>;
export const confirmationSchema = z.object({ expectedVersion:z.number().int().nonnegative(),
  concepts:z.array(conceptSchema).max(50) }).strict();
export const analysisSchema = z.object({ concepts:z.array(conceptSchema).max(50),
  versions:z.record(z.string(),z.string()), candidates:z.array(z.object({discipline:z.string().max(160),score:z.number(),
    sourceSpecialtyIds:z.array(z.string().regex(/^\d+$/)).min(1).max(39)}).strict()).max(20),
  flags:z.array(z.string().max(96)).max(30) }).strict();
export type Analysis = z.infer<typeof analysisSchema>;
export function hasCurrentNormalization(value:unknown):value is Analysis{const parsed=analysisSchema.safeParse(value);return parsed.success&&parsed.data.versions.normalization==='symptom-normalization-v2'&&parsed.data.candidates.length===0;}
export const sessionSchema = z.object({ binding:z.string().regex(/^[a-f0-9]{64}$/), expiresAt:z.iso.datetime() }).strict();
export const intelligenceEnabled = (e:NodeJS.ProcessEnv=process.env)=>e.VITAL_AI_ENABLED==='true';
export const patientIntelligenceEnabled = (e:NodeJS.ProcessEnv=process.env)=>intelligenceEnabled(e)&&e.VITAL_AI_PATIENT_ENABLED==='true';
export const FEATURE_VERSION='symptom-features-v1';
