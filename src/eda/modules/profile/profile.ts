import { z } from "zod";
import type { Prisma } from "../../generated/core/client.js";
import { requireScope, type Actor } from "../../contracts/actor.js";
import type { CorePrismaClient } from "../../infrastructure/databases.js";
import { recordProfileEffects } from "./profile-effects.js";
import { createProfileWorkflows } from "./profile-workflows.js";
import type { ProfileReceipt, ProfileWorkflowKind } from "./profile-contracts.js";
import type { RegistrationAuthority } from './registration-authority.js';

export type ProfileRole = "patient" | "doctor" | "admin";
export type ProfileOperation = "materialize" | "registration.bootstrap" | "patient.update" | "patient.notice.dismiss" | ProfileWorkflowKind | "workflow.prepare" | "workflow.commit";

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
  s2License: nullableText(80),
  s2ValidFrom: z.iso.date().optional(),
  s2ValidUntil: z.iso.date().optional(),
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
  input?: unknown;
  targetAuthId?: string;
  metadata?: ProfileCommandMetadata;
}

const commandMetadataSchema = z.object({ operationId: uuid, requestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ProfileCommandMetadata = z.infer<typeof commandMetadataSchema>;

export interface ProfileVerification {
  patientRecord?: { ehrPatientId: string; ehrRecordOrigin: "preexisting" | "created_by_vital" };
  specialty?: string;
  department?: { id: string; name: string };
}

// Parent owns command claims/replay and trusted integration verification. No guard means no writes.
export type ProfileCommandGuard = <T>(tx: Prisma.TransactionClient, command: ProfileCommand,
  execute: (verified?: ProfileVerification) => Promise<T>) => Promise<T>;

export const patientSelect = {
  userId: true, authId: true, profilePic: true, isRecordAvailable: true, ehrPatientId: true,
  ehrRecordOrigin: true, existingEhrRecordNoticeDismissedAt: true, isOnboardingComplete: true,
  emergencyContactName: true, emergencyContactRelationship: true, emergencyContactPhone: true,
} satisfies Prisma.VitalPatientSelect;
export const doctorSelect = {
  userId: true, authId: true, role: true, s2License: true, s2ValidFrom: true, s2ValidUntil: true, signatureAssetId: true, specialty: true, departmentExternalId: true,
  departmentName: true, prcLicense: true, availabilityType: true, virtualFee: true, inPersonFee: true,
  starRating: true, changedAt: true, bio: true, education: true, isDoctorOnboardingComplete: true,
  termsAgreedAt: true,
} satisfies Prisma.VitalDoctorSelect;
export const userSelect = {
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

export async function requireProfileAdmin(tx: Pick<Prisma.TransactionClient, "vitalAdmin">, actor: Actor) {
  uuid.parse(actor.authId);
  if (actor.role !== "admin") throw new ProfileError(403, "Forbidden.");
  const marker = await tx.vitalAdmin.findUnique({ where: { authId: actor.authId }, select: {
    userId: true, authId: true, user: { select: { id: true, authId: true } },
  } });
  if (!marker || marker.authId !== actor.authId || marker.user.authId !== actor.authId || marker.userId !== marker.user.id) {
    throw new ProfileError(403, "An independent Core admin membership is required.");
  }
}

export function createProfileModule(db: CorePrismaClient, commandGuard?: ProfileCommandGuard, registrationAuthority?: RegistrationAuthority) {
  async function mutate<T>(command: ProfileCommand, run: (tx: Prisma.TransactionClient, verified?: ProfileVerification) => Promise<T>): Promise<T> {
    if (!commandGuard) throw new ProfileError(503, "Profile mutations are inactive during extraction.");
    // Serializable reads protect onboarding/specialty checks and role bootstrap races.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await db.$transaction(async (tx) => {
          if (command.actor.role === "admin" && command.operation !== "materialize") await requireProfileAdmin(tx, command.actor);
          if (command.operation === "patient.notice.dismiss") {
            const current = await ownedUser(tx, command.actor);
            if (!current.patient || current.patient.authId !== command.actor.authId || current.patient.userId !== current.id) {
              throw new ProfileError(403, "Current patient membership required.");
            }
          }
          if (command.operation === 'registration.bootstrap') {
            const current = await tx.vitalUser.findUnique({ where: { authId: command.actor.authId }, select: userSelect });
            if (current && (current.role !== 'patient' || current.doctor || current.admin)) throw new ProfileError(409, 'Registration authority changed.');
          }
          return commandGuard(tx, command, (verified) => run(tx, verified));
        }, { isolationLevel: "Serializable" });
      } catch (error: unknown) {
        const retryable = typeof error === "object" && error !== null && "code" in error
          && (error.code === "P2034" || error.code === "P2002");
        if (!retryable || attempt >= 2) throw error;
      }
    }
  }

  async function changed(tx: Prisma.TransactionClient, actor: Actor, userId: string, operation: ProfileOperation,
    metadata?: { departmentExternalId?: string | null; departmentName?: string | null; doctorMirror?: boolean }) {
    const user = await tx.vitalUser.update({ where: { id: userId }, data: { version: { increment: 1 } } });
    await recordProfileEffects(tx, actor, user, operation, metadata);
  }

  async function ownedUser(tx: Prisma.TransactionClient, actor: Actor) {
    const user = await tx.vitalUser.findUnique({ where: { authId: actor.authId }, select: userSelect });
    if (!user) throw new ProfileError(404, "Profile not materialized.");
    if (user.role !== actor.role) throw new ProfileError(409, "Materialize the verified canonical role first.");
    return user;
  }

  async function applyPatient(tx: Prisma.TransactionClient, actor: Actor, body: unknown, verified?: ProfileVerification) {
    const input = patientPatchSchema.parse(body);
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
      if (!verified?.patientRecord) throw new ProfileError(409, "Prepared patient onboarding receipt required.");
      data.ehrPatientId = verified.patientRecord.ehrPatientId;
      data.ehrRecordOrigin = verified.patientRecord.ehrRecordOrigin;
      data.isRecordAvailable = true;
      data.isOnboardingComplete = true;
    }
    const result = await tx.vitalPatient.update({ where: { userId: patient.userId }, data, select: patientSelect });
    await changed(tx, actor, user.id, input.isOnboardingComplete ? "patient.onboarding" : "patient.update");
    return result;
  }

  function doctorData(input: DoctorPatch, doctor?: { s2License?: string | null; s2ValidFrom?: Date | null; s2ValidUntil?: Date | null; signatureAssetId?: string | null; specialty: string | null;
    prcLicense: string | null; bio: string | null; availabilityType: string | null; isDoctorOnboardingComplete: boolean },
    verified?: ProfileVerification, admin = false): Prisma.VitalDoctorUpdateInput {
    const { terms_accepted: _terms, ...fields } = input;
    const data: Prisma.VitalDoctorUpdateInput = { ...fields,
      ...(input.s2ValidFrom ? {s2ValidFrom:new Date(input.s2ValidFrom+'T00:00:00Z')} : {}),
      ...(input.s2ValidUntil ? {s2ValidUntil:new Date(input.s2ValidUntil+'T00:00:00Z')} : {}),changedAt: new Date() };
    const from=input.s2ValidFrom??doctor?.s2ValidFrom?.toISOString().slice(0,10),until=input.s2ValidUntil??doctor?.s2ValidUntil?.toISOString().slice(0,10);
    if(from&&until&&from>until)throw new ProfileError(400,'S2 validity end must follow its start.');
    if (input.specialty !== undefined) {
      if (!admin && doctor?.isDoctorOnboardingComplete && input.specialty !== doctor.specialty) {
        throw new ProfileError(403, "Specialty is locked after verification. Please contact an admin to update it.");
      }
      if (!verified?.department) throw new ProfileError(409, "Prepared specialty receipt required.");
      data.specialty = verified.department.name;
      data.departmentExternalId = verified.department.id;
      data.departmentName = verified.department.name;
    }
    if(doctor?.isDoctorOnboardingComplete&&(input.prcLicense===null||input.s2License===null))throw new ProfileError(400,'Required credentials cannot be cleared.');
    if (input.isDoctorOnboardingComplete) {
      if (doctor?.isDoctorOnboardingComplete) throw new ProfileError(409, "Onboarding already completed.");
      requiredText(80).parse(input.s2License ?? doctor?.s2License);
      if(!from||!until||!doctor?.signatureAssetId)throw new ProfileError(400,'S2 validity dates and saved signature are required.');
      requiredText(160).parse(input.specialty ?? doctor?.specialty);
      requiredText(80).parse(input.prcLicense ?? doctor?.prcLicense);
      requiredText(5000).parse(input.bio ?? doctor?.bio);
      z.enum(["virtual", "in_person", "both"]).parse(input.availabilityType ?? doctor?.availabilityType);
      if (!verified?.department) throw new ProfileError(409, "Prepared doctor onboarding receipt required.");
      data.specialty = verified.department.name;
      data.departmentExternalId = verified.department.id;
      data.departmentName = verified.department.name;
      data.termsAgreedAt = new Date();
    }
    return data;
  }

  async function applyDoctor(tx: Prisma.TransactionClient, actor: Actor, body: unknown, verified?: ProfileVerification) {
    const input = doctorPatchSchema.parse(body);
    const user = await ownedUser(tx, actor);
    const doctor = user.doctor;
    if (!doctor || doctor.authId !== actor.authId || doctor.userId !== user.id) throw new ProfileError(404, "Doctor profile not found.");
    const result = await tx.vitalDoctor.update({ where: { userId: doctor.userId },
      data: doctorData(input, doctor, verified), select: doctorSelect });
    await changed(tx, actor, user.id, input.isDoctorOnboardingComplete ? "doctor.onboarding" : "doctor.update", {
      doctorMirror: Boolean(verified?.department), departmentExternalId: result.departmentExternalId, departmentName: result.departmentName,
    });
    return result;
  }

  function validateWorkflow(kind: ProfileWorkflowKind, input: unknown) {
    if (kind === "patient.onboarding") {
      const fields = patientPatchSchema.parse(input);
      if (!fields.isOnboardingComplete) throw new ProfileError(400, "Patient completion input required.");
      return fields;
    }
    const fields = kind === "doctor.specialty"
      ? z.object({ specialty: requiredText(160) }).strict().parse(input) : doctorPatchSchema.parse(input);
    requiredText(160).parse(fields.specialty);
    if (kind === "doctor.onboarding" && !("isDoctorOnboardingComplete" in fields && fields.isDoctorOnboardingComplete)) {
      throw new ProfileError(400, "Doctor completion input required.");
    }
    if (kind !== "doctor.onboarding" && ("isDoctorOnboardingComplete" in fields || "terms_accepted" in fields)) {
      throw new ProfileError(400, "Completion fields require doctor onboarding.");
    }
    return fields;
  }

  const workflows = createProfileWorkflows(db, {
    mutate,
    validate: validateWorkflow,
    async inspect(tx, actor, kind, targetAuthId, input) {
      if (actor.role === "admin") await requireProfileAdmin(tx, actor);
      const user = await tx.vitalUser.findUnique({ where: { authId: targetAuthId }, select: userSelect });
      if (kind === "doctor.provision") {
        if (user?.admin || user?.role === "admin") throw new ProfileError(409, "Cannot provision an administrator as a doctor.");
        if (user?.doctor && (user.doctor.authId !== targetAuthId || user.doctor.userId !== user.id)) {
          throw new ProfileError(409, "Inconsistent profile marker.");
        }
        return user?.version ?? -1;
      }
      if (!user) throw new ProfileError(404, "Profile not materialized.");
      const marker = kind === "patient.onboarding" ? user.patient : user.doctor;
      if (!marker || marker.authId !== targetAuthId || marker.userId !== user.id) throw new ProfileError(404, "Profile marker not found.");
      if (actor.role !== "admin" && user.role !== actor.role) throw new ProfileError(409, "Materialize the verified canonical role first.");
      if (input !== undefined) {
        const fields = validateWorkflow(kind, input);
        if (kind === "patient.onboarding" && user.patient?.isOnboardingComplete) throw new ProfileError(409, "Onboarding already completed.");
        if (kind === "doctor.onboarding" && user.doctor?.isDoctorOnboardingComplete) throw new ProfileError(409, "Onboarding already completed.");
        if (kind !== "patient.onboarding" && user.doctor) {
          const specialty = (fields as DoctorPatch).specialty!;
          // Validate prerequisites without writing or contacting TRACE in the transaction.
          doctorData(fields as DoctorPatch, user.doctor, { department: { id: "validated-at-commit", name: specialty } }, actor.role === "admin");
        }
      }
      return user.version;
    },
    async apply(tx, actor, kind, targetAuthId, input, receipt: ProfileReceipt) {
      if ("ehrPatientId" in receipt) return applyPatient(tx, actor, input, { patientRecord: receipt });
      const verification = { department: receipt.department };
      if (actor.role !== "admin") return applyDoctor(tx, actor, input, verification);
      await requireProfileAdmin(tx, actor);
      const fields = validateWorkflow(kind, input) as DoctorPatch;
      let user = await tx.vitalUser.findUnique({ where: { authId: targetAuthId }, select: userSelect });
      if (kind === "doctor.provision") {
        const profile = user ? await tx.vitalUser.update({ where: { id: user.id }, data: { role: "doctor" } })
          : await tx.vitalUser.create({ data: { authId: targetAuthId, role: "doctor" } });
        await tx.vitalDoctor.upsert({ where: { authId: targetAuthId },
          create: { userId: profile.id, authId: targetAuthId, role: "doctor" }, update: { role: "doctor" } });
        user = await tx.vitalUser.findUniqueOrThrow({ where: { id: profile.id }, select: userSelect });
      }
      if (!user?.doctor) throw new ProfileError(404, "Doctor profile not found.");
      const result = await tx.vitalDoctor.update({ where: { userId: user.id },
        data: doctorData(fields, user.doctor, verification, true), select: doctorSelect });
      await changed(tx, actor, user.id, kind, { doctorMirror: true,
        departmentExternalId: result.departmentExternalId, departmentName: result.departmentName });
      return result;
    },
  });

  return {
    workflows,
    async bootstrapRegistration(actor: Actor, body: unknown, metadata?: ProfileCommandMetadata) {
      let input: { consent_accepted: true; registrationId?: string };
      if (actor.role === 'service') {
        requireScope(actor, 'profile.registration.receipt', actor.authId);
        if (actor.isSuperAdmin || actor.scopes.length !== 1) throw new ProfileError(403, 'Registration delegation denied.');
        input = z.object({ consent_accepted: z.literal(true), registrationId: z.uuid() }).strict().parse(body);
        if (!commandGuard || !registrationAuthority) throw new ProfileError(503, 'Registration authority unavailable.');
        // Online Auth resolution precedes every transaction/replay, never inside a retried transaction.
        await registrationAuthority(actor.authId, input.registrationId!, actor.correlationId);
      } else {
        ownRole(actor, "patient");
        requireScope(actor, "profile.registration", actor.authId);
        input = z.object({ consent_accepted: z.literal(true) }).strict().parse(body);
      }
      return mutate({ actor, operation: "registration.bootstrap", input,
        metadata: metadata && commandMetadataSchema.parse(metadata) }, async (tx) => {
        let user = await tx.vitalUser.findUnique({ where: { authId: actor.authId }, select: userSelect });
        // Registration must never demote another marker or manufacture canonical authority.
        if (user && (user.role !== "patient" || user.doctor || user.admin)) {
          throw new ProfileError(409, "Registration cannot replace an existing role.");
        }
        if (!user) user = await tx.vitalUser.create({ data: { authId: actor.authId, role: "patient" }, select: userSelect });
        if (user.patient && (user.patient.authId !== actor.authId || user.patient.userId !== user.id)) {
          throw new ProfileError(409, "Inconsistent profile marker.");
        }
        const createdMarker = !user.patient;
        if (createdMarker) await tx.vitalPatient.create({ data: { userId: user.id, authId: actor.authId,
          isRecordAvailable: false, isOnboardingComplete: false } });
        // Serializable isolation (and the enclosing bounded retry) protects consent deduplication.
        const consent = await tx.consentRecord.findFirst({ where: { patientId: user.id,
          consentType: "registration", appointmentId: null }, orderBy: [{ consentedAt: "desc" }, { id: "desc" }] });
        if (consent && !consent.accepted) throw new ProfileError(409, "Registration consent requires review.");
        if (!consent) await tx.consentRecord.create({ data: { patientId: user.id, consentType: "registration",
          accepted: true, consentedAt: new Date() } });
        if (createdMarker || !consent) await changed(tx, actor, user.id, "registration.bootstrap");
        return tx.vitalUser.findUniqueOrThrow({ where: { id: user.id }, select: userSelect });
      });
    },
    async adminDoctors(actor: Actor) {
      ownRole(actor, "admin");
      requireScope(actor, "profile.admin.read", actor.authId);
      return db.$transaction(async (tx) => {
        await requireProfileAdmin(tx, actor);
        const items = await tx.vitalDoctor.findMany({ orderBy: [{ isDoctorOnboardingComplete: "desc" }, { userId: "asc" }], select: doctorSelect });
        return { items, total: items.length };
      }, { isolationLevel: "Serializable" });
    },
    async adminMembership(actor: Actor) {
      ownRole(actor, "admin");
      requireScope(actor, "profile.admin.read", actor.authId);
      return db.$transaction(async (tx) => {
        await requireProfileAdmin(tx, actor);
        const patients = await tx.vitalPatient.findMany({ select: { authId: true } });
        const doctors = await tx.vitalDoctor.findMany({ select: { authId: true } });
        const admins = await tx.vitalAdmin.findMany({ select: { authId: true } });
        return { memberships: { patient: patients.map((row) => row.authId), doctor: doctors.map((row) => row.authId), admin: admins.map((row) => row.authId) },
          counts: { patients: patients.length, doctors: doctors.length, admins: admins.length, accounts: patients.length + doctors.length } };
      }, { isolationLevel: "Serializable" });
    },
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

    async dismissPatientNotice(actor: Actor, body: unknown, metadata?: ProfileCommandMetadata) {
      authorizeOwn(actor, "profile.write", "patient");
      const input = z.object({}).strict().parse(body);
      return mutate({ actor, operation: "patient.notice.dismiss", input, metadata: metadata && commandMetadataSchema.parse(metadata) }, async (tx) => {
        const user = await ownedUser(tx, actor);
        if (!user.patient) throw new ProfileError(404, "Patient profile not found.");
        if (!user.patient.existingEhrRecordNoticeDismissedAt) {
          await tx.vitalPatient.update({ where: { userId: user.id }, data: { existingEhrRecordNoticeDismissedAt: new Date() } });
          await changed(tx, actor, user.id, "patient.notice.dismiss");
        }
        return { dismissed: true as const };
      });
    },

    async patchPatient(actor: Actor, body: unknown, metadata?: ProfileCommandMetadata) {
      authorizeOwn(actor, "profile.write", "patient");
      const input = patientPatchSchema.parse(body);
      if (input.isOnboardingComplete) throw new ProfileError(409, "Use the prepared onboarding workflow.");
      return mutate({ actor, operation: "patient.update", input, metadata: metadata && commandMetadataSchema.parse(metadata) },
        (tx) => applyPatient(tx, actor, input));
    },

    async patchDoctor(actor: Actor, body: unknown, metadata?: ProfileCommandMetadata) {
      authorizeOwn(actor, "profile.write", "doctor");
      const input = doctorPatchSchema.parse(body);
      if (input.isDoctorOnboardingComplete || input.specialty !== undefined) throw new ProfileError(409, "Use a prepared doctor workflow.");
      return mutate({ actor, operation: "doctor.update", input, metadata: metadata && commandMetadataSchema.parse(metadata) },
        (tx) => applyDoctor(tx, actor, input));
    },
  };
}
