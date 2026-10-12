import { z } from "zod";
import type { Prisma } from "../../generated/core/client.js";
import { requireScope, type Actor } from "../../contracts/actor.js";
import type { CorePrismaClient } from "../../infrastructure/databases.js";
import { appendOutbox } from "../../infrastructure/outbox.js";

export type ProfileRole = "patient" | "doctor" | "admin";
export type ProfileOperation = "materialize" | "patient.update" | "patient.onboarding" | "doctor.update" | "doctor.onboarding";

export class ProfileError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

const uuid = z.string().uuid();
const requiredText = (max: number) => z.string().trim().min(1).max(max);
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const emergencyPhone = z.string().max(40).transform((value) => {
  const compact = value.trim().replace(/[\s()-]/g, "");
  return /^09\d{9}$/.test(compact) ? `+63${compact.slice(1)}` : compact;
}).pipe(z.string().regex(/^\+639\d{9}$/, "Enter a valid Philippine mobile number (for example, 09123456789)."));

// These are validation inputs, not Auth/EHR columns or a client-selected record ID.
const patientOnboardingSchema = z.object({
  consent_accepted: z.literal(true),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
      && date.getTime() < new Date().setHours(0, 0, 0, 0);
  }, "Enter a valid past date."),
  sex: z.enum(["male", "female"]),
  contact_number: z.string().trim().max(40).transform((value) => {
    const compact = value.replace(/[\s()-]/g, "");
    return /^9\d{9}$/.test(compact) ? `+63${compact}` : compact;
  }).pipe(z.string().regex(/^(?:09\d{9}|\+[1-9]\d{6,14})$/)),
  address_island_group: requiredText(80),
  address_province_region: requiredText(160),
  address_province: z.string().trim().max(160),
  address_city_municipality: requiredText(160),
  address_barangay: requiredText(160),
  address_barangay_psgc: z.string().trim().max(20).optional(),
  address_street: z.string().trim().min(5).max(180),
  address_postal_code: z.string().trim().regex(/^(?:\d{4,5})?$/),
  address_country: requiredText(80),
  blood_type: z.string().trim().max(10).optional(),
  philhealth_identification_number: z.string().trim().regex(/^(?:\d{2}-\d{9}-\d|\d{12})?$/),
  religion: z.string().trim().max(100).optional(),
}).strict().refine((value) => /(national capital region|\bncr\b)/i.test(value.address_province_region)
  || value.address_province.length > 0, "Province is required.");

export const patientPatchSchema = z.object({
  emergencyContactName: requiredText(160).optional(),
  emergencyContactRelationship: requiredText(80).optional(),
  emergencyContactPhone: emergencyPhone.optional(),
  isOnboardingComplete: z.literal(true).optional(),
  onboarding: patientOnboardingSchema.optional(),
}).strict().refine((value) => value.isOnboardingComplete === true
  ? value.onboarding !== undefined : value.onboarding === undefined,
"Onboarding details and completion must be submitted together.")
  .refine((value) => Object.keys(value).length > 0, "No profile fields supplied.");

const fee = z.union([
  z.number().finite().nonnegative().max(99999999.99).refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001),
  z.string().trim().regex(/^\d{1,8}(?:\.\d{1,2})?$/),
]).nullable().optional();

export const doctorPatchSchema = z.object({
  title: nullableText(80),
  specialty: nullableText(160),
  prcLicense: nullableText(80),
  availabilityType: z.enum(["virtual", "in_person", "both"]).optional(),
  virtualFee: fee,
  inPersonFee: fee,
  bio: nullableText(5000),
  education: nullableText(3000),
  isDoctorOnboardingComplete: z.literal(true).optional(),
  terms_accepted: z.literal(true).optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "terms_accepted"), "No profile fields supplied.")
  .refine((value) => value.isDoctorOnboardingComplete !== true || value.terms_accepted === true,
    "You must accept the terms of agreement to continue.");

export type PatientPatch = z.infer<typeof patientPatchSchema>;
export type DoctorPatch = z.infer<typeof doctorPatchSchema>;

export interface ProfileCommand {
  actor: Actor;
  operation: ProfileOperation;
  input?: PatientPatch | DoctorPatch;
  metadata?: ProfileCommandMetadata;
}

const commandMetadataSchema = z.object({ operationId: uuid, requestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ProfileCommandMetadata = z.infer<typeof commandMetadataSchema>;

export interface ProfileVerification {
  patientRecord?: { ehrPatientId: string; ehrRecordOrigin: "preexisting" | "created_by_vital" };
  specialty?: string;
}

// Parent owns command claims/replay and trusted integration verification. No guard means no writes.
export type ProfileCommandGuard = <T>(tx: Prisma.TransactionClient, command: ProfileCommand,
  execute: (verified?: ProfileVerification) => Promise<T>) => Promise<T>;

const patientSelect = {
  userId: true, authId: true, profilePic: true, isRecordAvailable: true, ehrPatientId: true,
  ehrRecordOrigin: true, existingEhrRecordNoticeDismissedAt: true, isOnboardingComplete: true,
  emergencyContactName: true, emergencyContactRelationship: true, emergencyContactPhone: true,
} satisfies Prisma.VitalPatientSelect;
const doctorSelect = {
  userId: true, authId: true, role: true, title: true, specialty: true, departmentExternalId: true,
  departmentName: true, prcLicense: true, availabilityType: true, virtualFee: true, inPersonFee: true,
  starRating: true, changedAt: true, bio: true, education: true, isDoctorOnboardingComplete: true,
  termsAgreedAt: true,
} satisfies Prisma.VitalDoctorSelect;
const userSelect = {
  id: true, authId: true, role: true, version: true,
  patient: { select: patientSelect }, doctor: { select: doctorSelect },
  admin: { select: { userId: true, authId: true } },
} satisfies Prisma.VitalUserSelect;

function ownRole(actor: Actor, expected?: ProfileRole): ProfileRole {
  uuid.parse(actor.authId);
  if (actor.role === "service" || (expected !== undefined && actor.role !== expected)) {
    throw new ProfileError(403, "Forbidden.");
  }
  return actor.role;
}

function authorizeOwn(actor: Actor, scope: "profile.read" | "profile.write" | "profile.materialize", expected?: ProfileRole) {
  const role = ownRole(actor, expected);
  requireScope(actor, scope, actor.authId);
  return role;
}

export function createProfileModule(db: CorePrismaClient, commandGuard?: ProfileCommandGuard) {
  async function mutate<T>(command: ProfileCommand, run: (tx: Prisma.TransactionClient, verified?: ProfileVerification) => Promise<T>): Promise<T> {
    if (!commandGuard) throw new ProfileError(503, "Profile mutations are inactive during extraction.");
    // Serializable reads protect onboarding/specialty checks and role bootstrap races.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await db.$transaction(async (tx) => commandGuard(tx, command, (verified) => run(tx, verified)), { isolationLevel: "Serializable" });
      } catch (error: unknown) {
        const retryable = typeof error === "object" && error !== null && "code" in error
          && (error.code === "P2034" || error.code === "P2002");
        if (!retryable || attempt >= 2) throw error;
      }
    }
  }

  async function changed(tx: Prisma.TransactionClient, actor: Actor, userId: string, operation: ProfileOperation) {
    const user = await tx.vitalUser.update({ where: { id: userId }, data: { version: { increment: 1 } } });
    await appendOutbox(tx, {
      eventType: "vital.profile.changed", producer: "profile", aggregateId: user.id,
      aggregateVersion: user.version, correlationId: actor.correlationId,
      data: { authId: actor.authId, role: ownRole(actor),
        operation: operation === "materialize" ? "materialized"
          : operation.endsWith(".onboarding") ? "onboarded" : "profile_updated",
        actorAuthId: actor.authId },
    });
  }

  async function ownedUser(tx: Prisma.TransactionClient, actor: Actor) {
    const user = await tx.vitalUser.findUnique({ where: { authId: actor.authId }, select: userSelect });
    if (!user) throw new ProfileError(404, "Profile not materialized.");
    if (user.role !== actor.role) throw new ProfileError(409, "Materialize the verified canonical role first.");
    return user;
  }

  return {
    async me(actor: Actor) {
      authorizeOwn(actor, "profile.read");
      return db.vitalUser.findUnique({ where: { authId: actor.authId }, select: userSelect });
    },

    async patientMe(actor: Actor) {
      authorizeOwn(actor, "profile.read", "patient");
      return db.vitalPatient.findUnique({ where: { authId: actor.authId }, select: patientSelect });
    },

    async doctorMe(actor: Actor) {
      authorizeOwn(actor, "profile.read", "doctor");
      return db.vitalDoctor.findUnique({ where: { authId: actor.authId }, select: doctorSelect });
    },

    async roles(actor: Actor, authId: string) {
      if (actor.role !== "service") {
        throw new ProfileError(403, "Forbidden.");
      }
      requireScope(actor, "profile.roles.read", authId);
      uuid.parse(authId);
      const user = await db.vitalUser.findUnique({ where: { authId }, select: {
        role: true, patient: { select: { authId: true } }, doctor: { select: { authId: true } }, admin: { select: { authId: true } },
      } });
      const roles = (["admin", "doctor", "patient"] as const)
        .filter((role) => user?.role === role || Boolean(user?.[role]));
      return { system: "vital", user_id: authId, roles };
    },

    async materialize(actor: Actor, body: unknown = {}, metadata?: ProfileCommandMetadata) {
      const role = authorizeOwn(actor, "profile.materialize");
      z.object({}).strict().parse(body);
      return mutate({ actor, operation: "materialize", metadata: metadata && commandMetadataSchema.parse(metadata) }, async (tx) => {
        const existing = await tx.vitalUser.findUnique({ where: { authId: actor.authId }, select: userSelect });
        const marker = existing?.[role];
        if (marker && (marker.authId !== actor.authId || marker.userId !== existing?.id)) {
          throw new ProfileError(409, "Inconsistent profile marker.");
        }
        if (existing?.role === role && marker && (role !== "doctor" || existing.doctor?.role === "doctor")) return existing;
        const user = existing
          ? await tx.vitalUser.update({ where: { id: existing.id }, data: { role } })
          : await tx.vitalUser.create({ data: { authId: actor.authId, role } });
        if (role === "patient") {
          await tx.vitalPatient.upsert({ where: { authId: actor.authId },
            create: { userId: user.id, authId: actor.authId, isRecordAvailable: false, isOnboardingComplete: false }, update: {} });
        } else if (role === "doctor") {
          await tx.vitalDoctor.upsert({ where: { authId: actor.authId },
            create: { userId: user.id, authId: actor.authId, role: "doctor", isDoctorOnboardingComplete: false }, update: { role: "doctor" } });
        } else {
          await tx.vitalAdmin.upsert({ where: { authId: actor.authId }, create: { userId: user.id, authId: actor.authId }, update: {} });
        }
        await changed(tx, actor, user.id, "materialize");
        return tx.vitalUser.findUniqueOrThrow({ where: { id: user.id }, select: userSelect });
      });
    },

    async patchPatient(actor: Actor, body: unknown, metadata?: ProfileCommandMetadata) {
      authorizeOwn(actor, "profile.write", "patient");
      const input = patientPatchSchema.parse(body);
      const operation = input.isOnboardingComplete ? "patient.onboarding" : "patient.update";
      return mutate({ actor, operation, input, metadata: metadata && commandMetadataSchema.parse(metadata) }, async (tx, verified) => {
        const user = await ownedUser(tx, actor);
        const patient = user.patient;
        if (!patient || patient.authId !== actor.authId || patient.userId !== user.id) throw new ProfileError(404, "Patient profile not found.");
        const data: Prisma.VitalPatientUpdateInput = {};
        if (input.emergencyContactName !== undefined || input.emergencyContactRelationship !== undefined || input.emergencyContactPhone !== undefined) {
          data.emergencyContactName = requiredText(160).parse(input.emergencyContactName ?? patient.emergencyContactName);
          data.emergencyContactRelationship = requiredText(80).parse(input.emergencyContactRelationship ?? patient.emergencyContactRelationship);
          data.emergencyContactPhone = emergencyPhone.parse(input.emergencyContactPhone ?? patient.emergencyContactPhone);
        }
        if (input.isOnboardingComplete) {
          if (patient.isOnboardingComplete) throw new ProfileError(409, "Onboarding already completed.");
          const record = verified?.patientRecord;
          if (!record) throw new ProfileError(503, "Verified patient onboarding integration is required.");
          data.ehrPatientId = requiredText(128).parse(record.ehrPatientId);
          data.ehrRecordOrigin = z.enum(["preexisting", "created_by_vital"]).parse(record.ehrRecordOrigin);
          data.isRecordAvailable = true;
          data.isOnboardingComplete = true;
        }
        const result = await tx.vitalPatient.update({ where: { userId: patient.userId }, data, select: patientSelect });
        await changed(tx, actor, user.id, operation);
        return result;
      });
    },

    async patchDoctor(actor: Actor, body: unknown, metadata?: ProfileCommandMetadata) {
      authorizeOwn(actor, "profile.write", "doctor");
      const input = doctorPatchSchema.parse(body);
      const operation = input.isDoctorOnboardingComplete ? "doctor.onboarding" : "doctor.update";
      return mutate({ actor, operation, input, metadata: metadata && commandMetadataSchema.parse(metadata) }, async (tx, verified) => {
        const user = await ownedUser(tx, actor);
        const doctor = user.doctor;
        if (!doctor || doctor.authId !== actor.authId || doctor.userId !== user.id) throw new ProfileError(404, "Doctor profile not found.");
        const { terms_accepted: _terms, ...fields } = input;
        const data: Prisma.VitalDoctorUpdateInput = { ...fields, changedAt: new Date() };
        if (input.specialty !== undefined) {
          const specialty = input.specialty?.trim() || null;
          if (doctor.isDoctorOnboardingComplete && doctor.specialty?.trim() && specialty !== doctor.specialty.trim()) {
            throw new ProfileError(403, "Specialty is locked after verification. Please contact an admin to update it.");
          }
          data.specialty = specialty;
        }
        if (input.isDoctorOnboardingComplete) {
          if (doctor.isDoctorOnboardingComplete) throw new ProfileError(409, "Onboarding already completed.");
          requiredText(80).parse(input.title ?? doctor.title);
          requiredText(160).parse(input.specialty ?? doctor.specialty);
          requiredText(80).parse(input.prcLicense ?? doctor.prcLicense);
          requiredText(5000).parse(input.bio ?? doctor.bio);
          z.enum(["virtual", "in_person", "both"]).parse(input.availabilityType ?? doctor.availabilityType);
          if (!verified?.specialty) throw new ProfileError(503, "Verified specialty integration is required.");
          data.specialty = requiredText(160).parse(verified.specialty);
          data.termsAgreedAt = new Date();
        }
        const result = await tx.vitalDoctor.update({ where: { userId: doctor.userId }, data, select: doctorSelect });
        await changed(tx, actor, user.id, operation);
        return result;
      });
    },
  };
}
